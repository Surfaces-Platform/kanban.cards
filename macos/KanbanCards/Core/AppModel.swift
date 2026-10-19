import AuthenticationServices
import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    private static let signOutIntentKey = "macOSNativeSignOutPending"
    let api: KanbanAPIClient
    let drafts: DraftStore
    @ObservationIgnored private var cardEditingSessions: [String: SharedCardEditingSession] = [:]
    @ObservationIgnored private var commentEditingSessions: [String: SharedCommentEditingSession] = [:]
    private let defaults: UserDefaults
    private let passkeys = PasskeySignInCoordinator()
    private var projectMutationGenerations: [String: UUID] = [:]
    private var workspaceMutationGenerations: [String: UUID] = [:]
    private var projectRefreshes: [String: UUID] = [:]
    private var workspaceRefreshes: [String: UUID] = [:]
    private var workspaceLoadID: UUID?
    private var workspaceCreationID: UUID?
    private var uncertainWorkspaceCreationBaselines: [WorkspaceCreationIntent: Set<String>] = [:]
    @ObservationIgnored private var restoreTask: Task<Void, Never>?
    @ObservationIgnored private var sessionExpiryTask: Task<Void, Never>?
    private var demoCreatedCards: [String: (draft: CardDraft, card: Card)] = [:]
    private var demoCreatedProjects: [String: (draft: ProjectDraft, project: Project)] = [:]
    private var demoComments: [String: String] = [:]
    private(set) var sessionID = UUID()
    private(set) var loadingWorkspaces = false
    private(set) var creatingWorkspace = false
    private(set) var workspaceLoadFailed = false
    private(set) var signedIn = false
    private(set) var restoring = true
    private(set) var signingIn = false
    private(set) var endingSession = false
    private(set) var signOutPending = false
    private(set) var workspaces: [Workspace] = []
    private var projectLists: [String: [ProjectSummary]] = [:]
    private var loadedProjects: [String: Project] = [:] {
        didSet {
            for session in cardEditingSessions.values { session.synchronizeIfClean() }
        }
    }
    private var fullSnapshotRevisions: [String: Int] = [:]
    private var loadingProjectLists = Set<String>()
    private var projectListErrors: [String: String] = [:]
    private(set) var workspaceLoadError: String?
    var errorMessage: String?
    let isDemo: Bool

    init(api: KanbanAPIClient? = nil, drafts: DraftStore = DraftStore(),
         defaults: UserDefaults = .standard, demo: Bool? = nil) {
        #if DEBUG
        let demoEnabled = demo ?? ProcessInfo.processInfo.arguments.contains("--demo")
        #else
        let demoEnabled = false
        #endif
        isDemo = demoEnabled
        self.api = api ?? KanbanAPIClient(credentialStore: MacKeychainSessionStore(),
            dataAccessPolicy: demoEnabled ? .unrestricted : LiveDataAccessPolicy(arguments: ProcessInfo.processInfo.arguments))
        self.drafts = drafts
        self.defaults = defaults
        if !isDemo { signOutPending = defaults.bool(forKey: Self.signOutIntentKey) }
        if isDemo {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--reset-demo-drafts") {
                try? drafts.removeAll(ownerID: "demo-owner")
            }
            #endif
            signedIn = true
            restoring = false
            seedDemoWorkspace()
        }
    }

    var ownerID: String { isDemo ? "demo-owner" : api.credential?.owner.id ?? "signed-out" }

    var dataAccessPolicy: LiveDataAccessPolicy { api.dataAccessPolicy }
    var requiredProjectCreationName: String? { dataAccessPolicy.requiredProjectCreationName }

    var canCreateWorkspace: Bool {
        let credentialIsCurrent = isDemo || api.credential.flatMap { ServerTimestamp.date(from: $0.expiresAt) }.map { $0 > .now } == true
        return signedIn && credentialIsCurrent && !restoring && !signingIn
            && !signOutPending && !endingSession && !creatingWorkspace && dataAccessPolicy.canCreateWorkspace
    }

    func createWorkspace(name: String, slug: String) async throws -> Workspace {
        validateSession()
        guard dataAccessPolicy.canCreateWorkspace else {
            throw APIError(message: "Workspace creation is unavailable in this verification session.",
                sessionGeneration: api.sessionGeneration, isLocalPolicyDenial: true)
        }
        guard canCreateWorkspace else { throw CancellationError() }
        let intent = try WorkspaceCreationIntent(name: name, slug: slug)
        let baseline = uncertainWorkspaceCreationBaselines[intent] ?? Set(workspaces.map(\.id))
        let operation = sessionID
        let session = api.sessionGeneration
        let creation = UUID()
        workspaceCreationID = creation
        creatingWorkspace = true
        defer {
            if workspaceCreationID == creation {
                workspaceCreationID = nil
                creatingWorkspace = false
            }
        }
        do {
            let saved: Workspace
            if isDemo {
                guard !workspaces.contains(where: { $0.slug == intent.slug }) else {
                    throw APIError(message: "Workspace address is already in use.", statusCode: 409)
                }
                guard workspaces.count < 10 else {
                    throw APIError(message: "You can create up to 10 Workspaces.", statusCode: 403)
                }
                saved = Workspace(id: UUID().uuidString, slug: intent.slug, name: intent.name,
                    url: URL(string: "https://\(intent.slug).demo.invalid")!)
            } else {
                do { saved = try await api.createWorkspace(name: intent.name, slug: intent.slug) }
                catch let error as APIError {
                    try requireWorkspaceCreationSession(operation, session: session)
                    if error.isAmbiguousMutation, uncertainWorkspaceCreationBaselines[intent] == nil {
                        // Retain the inventory from before the original attempt across
                        // retries. A known Workspace cannot confirm a new creation.
                        uncertainWorkspaceCreationBaselines[intent] = baseline
                    }
                    guard error.isAmbiguousMutation || (error.isConflict && uncertainWorkspaceCreationBaselines[intent] != nil) else { throw error }
                    let incoming: [Workspace]
                    do { incoming = try await api.workspaces() }
                    catch {
                        // A failed read cannot prove that the original create failed.
                        // Preserve its uncertainty so retrying the same address is safe.
                        if (error as? APIError)?.isUnauthorized == true || error is CancellationError { throw error }
                        throw APIError(message: "Workspace creation was not confirmed. Check your connection and retry the same name and address.",
                            isAmbiguousMutation: true, sessionGeneration: session)
                    }
                    try requireWorkspaceCreationSession(operation, session: session)
                    guard let reconciled = incoming.first(where: { $0.slug == intent.slug && $0.name == intent.name && !baseline.contains($0.id) }) else { throw error }
                    replaceWorkspaceInventory(incoming)
                    saved = reconciled
                }
            }
            try requireWorkspaceCreationSession(operation, session: session)
            // Invalidate older AppModel reads as well as the transport's origin list.
            workspaceLoadID = nil
            loadingWorkspaces = false
            workspaceLoadFailed = false
            workspaceLoadError = nil
            if let index = workspaces.firstIndex(where: { $0.id == saved.id }) { workspaces[index] = saved }
            else { workspaces.append(saved) }
            uncertainWorkspaceCreationBaselines.removeValue(forKey: intent)
            return saved
        } catch {
            if operation == sessionID, (error as? APIError)?.isUnauthorized == true { handle(error) }
            throw error
        }
    }

    func canEditProject(id: String, in workspace: Workspace) -> Bool {
        canAccess(workspace) && dataAccessPolicy.canEditProject(id: id, in: workspace.url)
    }

    func canCreateProject(in workspace: Workspace) -> Bool {
        canAccess(workspace) && dataAccessPolicy.canCreateProject(in: workspace.url)
    }

    func projects(in workspace: Workspace) -> [ProjectSummary] {
        guard canAccess(workspace) else { return [] }
        return projectLists[workspaceKey(workspace)] ?? []
    }

    func projectListLoading(in workspace: Workspace) -> Bool {
        canAccess(workspace) && loadingProjectLists.contains(workspaceKey(workspace))
    }

    func projectListError(in workspace: Workspace) -> String? {
        guard canAccess(workspace) else { return nil }
        return projectListErrors[workspaceKey(workspace)]
    }

    /// Refresh inventory before selected content so external additions become discoverable.
    func refreshInventory(workspaceID: String?, projectID: String?) async throws {
        await refreshWorkspaces()
        guard signedIn else { throw CancellationError() }
        if let workspaceLoadError { throw APIError(message: workspaceLoadError) }
        guard let workspace = workspaces.first(where: { $0.id == workspaceID }) ?? workspaces.first else { return }
        try await loadProjects(in: workspace, includeArchived: true)
        let summaries = projects(in: workspace)
        guard let selected = summaries.first(where: { $0.id == projectID })
                ?? summaries.first(where: { $0.archivedAt == nil }) ?? summaries.first else { return }
        try await loadProject(id: selected.id, in: workspace)
    }

    func project(id: String, in workspace: Workspace) -> Project? {
        guard canAccess(workspace) else { return nil }
        return loadedProjects[projectKey(id, in: workspace)]
    }

    func cardEditingSession(workspace: Workspace, projectID: String, card: Card) -> SharedCardEditingSession {
        let key = [ownerID, workspace.id, workspace.url.absoluteString, projectID, card.id]
            .map { "\($0.utf8.count):\($0)" }.joined()
        if let existing = cardEditingSessions[key], existing.sessionIsCurrent { return existing }
        cardEditingSessions[key]?.invalidate()
        let session = SharedCardEditingSession(model: self, workspace: workspace, projectID: projectID, card: card)
        cardEditingSessions[key] = session
        session.load()
        return session
    }

    func commentEditingSession(workspace: Workspace, projectID: String, cardID: String) -> SharedCommentEditingSession {
        let key = ownerID + MacDraftScope.key("shared-comment", workspace: workspace, projectID: projectID, resourceID: cardID)
        if let session = commentEditingSessions[key], session.sessionIsCurrent { return session }
        let session = SharedCommentEditingSession(model: self, workspace: workspace, projectID: projectID, cardID: cardID)
        commentEditingSessions[key] = session
        session.load()
        return session
    }

    func restore() async {
        if let restoreTask {
            await restoreTask.value
            return
        }
        guard restoring, !isDemo else { return }
        // Each restored scene joins the same authentication operation. A second
        // restoreSession call would replace the API generation of the first one.
        let task = Task<Void, Never> { @MainActor [weak self] in
            guard let self else { return }
            await self.performRestore()
        }
        restoreTask = task
        await task.value
        restoreTask = nil
    }

    private func performRestore() async {
        let operation = sessionID
        defer { restoring = false }
        if signOutPending {
            do { _ = try await api.restoreSession() }
            catch {
                guard operation == sessionID else { return }
                guard api.credential != nil else {
                    errorMessage = "Sign-out is still pending. The saved session could not be opened securely. Retry sign-out. \(error.localizedDescription)"
                    return
                }
            }
            guard operation == sessionID else { return }
            await signOut()
            return
        }
        do {
            if let session = try await api.restoreSession(), session.authenticated {
                guard operation == sessionID, !signOutPending, !endingSession else { return }
                clearPrivateState()
                sessionID = UUID()
                signedIn = true
                scheduleSessionExpiry()
                await refreshWorkspaces()
            }
        } catch {
            guard operation == sessionID else { return }
            handle(error)
        }
    }

    func signIn() async {
        guard !signingIn, !signedIn, !restoring, !signOutPending, !endingSession else { return }
        if isDemo {
            clearPrivateState()
            sessionID = UUID()
            seedDemoWorkspace()
            signedIn = true
            errorMessage = nil
            return
        }
        sessionID = UUID()
        let operation = sessionID
        signingIn = true
        errorMessage = nil
        defer { if sessionID == operation { signingIn = false } }
        do {
            let challenge = try await api.beginSignIn()
            guard sessionID == operation, !signOutPending, !endingSession else { throw CancellationError() }
            let assertion = try await passkeys.assertion(for: challenge)
            guard sessionID == operation, !signOutPending, !endingSession else { throw CancellationError() }
            try await completeSignIn(challenge: challenge, assertion: assertion)
        } catch {
            guard sessionID == operation else { return }
            if (error as? ASAuthorizationError)?.code != .canceled { handle(error) }
        }
    }

    func completeSignIn(challenge: NativeSignInChallenge, assertion: NativePasskeyAssertion) async throws {
        guard !signOutPending, !endingSession else { throw CancellationError() }
        let operation = sessionID
        _ = try await api.completeSignIn(challenge: challenge, assertion: assertion)
        guard sessionID == operation, !signOutPending, !endingSession else { throw CancellationError() }
        clearPrivateState()
        sessionID = UUID()
        signingIn = false
        signedIn = true
        errorMessage = nil
        scheduleSessionExpiry()
        await refreshWorkspaces()
    }

    func refreshWorkspaces() async {
        validateSession()
        guard !isDemo, signedIn, !signOutPending, !endingSession else { return }
        let operation = sessionID
        let session = api.sessionGeneration
        let requestID = UUID()
        workspaceLoadID = requestID
        loadingWorkspaces = true
        workspaceLoadFailed = false
        workspaceLoadError = nil
        defer { if workspaceLoadID == requestID { loadingWorkspaces = false } }
        do {
            let incoming = try await api.workspaces()
            guard operation == sessionID, session == api.sessionGeneration,
                  workspaceLoadID == requestID, signedIn, !signOutPending else { return }
            replaceWorkspaceInventory(incoming)
        } catch {
            guard operation == sessionID, !(error is CancellationError) else { return }
            if let generation = (error as? APIError)?.sessionGeneration, generation != api.sessionGeneration { return }
            if (error as? APIError)?.isUnauthorized == true { handle(error); return }
            guard workspaceLoadID == requestID else { return }
            workspaceLoadFailed = true
            workspaceLoadError = error.localizedDescription
        }
    }

    func signOut() async {
        guard !endingSession else { return }
        // Clear every window synchronously, before awaiting Keychain or network work.
        sessionID = UUID()
        passkeys.cancel()
        signingIn = false
        endingSession = true
        signOutPending = true
        if !isDemo { defaults.set(true, forKey: Self.signOutIntentKey) }
        signedIn = false
        clearPrivateState()
        errorMessage = nil
        defer { endingSession = false }
        do {
            if !isDemo {
                if api.credential == nil {
                    do { _ = try await api.restoreSession() }
                    catch { if api.credential == nil { throw error } }
                }
                try await api.signOut()
            }
            signOutPending = false
            if !isDemo { defaults.removeObject(forKey: Self.signOutIntentKey) }
        } catch {
            errorMessage = "The server has not confirmed sign-out. Retry to end this session. \(error.localizedDescription)"
        }
    }

    func loadProjects(in workspace: Workspace, includeArchived: Bool = true) async throws {
        try requireAccess(workspace)
        guard !isDemo else { return }
        let operation = sessionID
        let session = api.sessionGeneration
        let scope = workspaceKey(workspace)
        let mutation = workspaceMutationGenerations[scope]
        let refresh = UUID()
        workspaceRefreshes[scope] = refresh
        loadingProjectLists.insert(scope)
        projectListErrors[scope] = nil
        defer {
            if workspaceRefreshes[scope] == refresh { loadingProjectLists.remove(scope) }
        }
        do {
            let incoming = try await api.projects(in: workspace, includeArchived: includeArchived)
            try requireCurrent(operation, session: session, in: workspace)
            guard mutation == workspaceMutationGenerations[scope], refresh == workspaceRefreshes[scope] else {
                throw CancellationError()
            }
            let previous = Dictionary(uniqueKeysWithValues: (projectLists[scope] ?? []).map { ($0.id, $0) })
            projectLists[scope] = incoming.map { summary in
                if let cached = previous[summary.id], cached.revision > summary.revision { return cached }
                if let project = project(id: summary.id, in: workspace), project.revision > summary.revision {
                    return projectSummary(project)
                }
                return summary
            }
        } catch {
            handleScopeFailure(error, operation: operation, in: workspace)
            if operation == sessionID, workspaceRefreshes[scope] == refresh,
               !(error is CancellationError), canAccess(workspace) {
                projectListErrors[scope] = error.localizedDescription
            }
            throw error
        }
    }

    func loadProject(id: String, in workspace: Workspace) async throws {
        try requireAccess(workspace)
        guard !isDemo else { return }
        let operation = sessionID
        let session = api.sessionGeneration
        let scope = projectKey(id, in: workspace)
        let mutation = projectMutationGenerations[scope]
        let refresh = UUID()
        projectRefreshes[scope] = refresh
        do {
            let incoming = try await api.project(id: id, in: workspace)
            try requireCurrent(operation, session: session, in: workspace)
            guard mutation == projectMutationGenerations[scope], refresh == projectRefreshes[scope] else {
                throw CancellationError()
            }
            guard (loadedProjects[scope]?.revision ?? 0) <= incoming.revision else { return }
            loadedProjects[scope] = incoming
            fullSnapshotRevisions[scope] = incoming.revision
            updateSummary(incoming, in: workspace)
        } catch {
            handleScopeFailure(error, operation: operation, in: workspace, projectID: id)
            throw error
        }
    }

    func saveProject(_ draft: ProjectDraft, in workspace: Workspace, key: String, onConfirmed: (() -> Void)? = nil, onRefreshFailure: ((String) -> Void)? = nil) async throws -> Project {
        try requireAccess(workspace)
        let operation = sessionID
        let session = api.sessionGeneration
        do {
            let saved: Project
            if isDemo {
                if let id = draft.id {
                    guard var current = project(id: id, in: workspace) else { throw AppFailure.missingProject }
                    guard current.archivedAt == nil else { throw AppFailure.readOnlyProject }
                    guard current.revision == draft.revision else { throw AppFailure.conflict }
                    current.name = draft.name
                    current.description = draft.description
                    current.revision += 1
                    current.updatedAt = ServerTimestamp.string()
                    saved = current
                } else {
                    let retryKey = workspaceKey(workspace) + "/create-project/" + key
                    if let retry = demoCreatedProjects[retryKey] {
                        guard retry.draft == draft else { throw AppFailure.changedRetry }
                        onConfirmed?()
                        return project(id: retry.project.id, in: workspace) ?? retry.project
                    }
                    let timestamp = ServerTimestamp.string()
                    saved = Project(id: UUID().uuidString, name: draft.name, description: draft.description,
                        columns: draft.columns ?? Self.defaultColumns, cards: [], activity: [], revision: 1,
                        createdAt: timestamp, updatedAt: timestamp)
                    demoCreatedProjects[retryKey] = (draft, saved)
                }
            } else if draft.id == nil {
                saved = try await api.createProject(draft, in: workspace, idempotencyKey: key)
            } else {
                saved = try await api.updateProject(draft, in: workspace)
            }
            try requireCurrent(operation, session: session, in: workspace)
            cacheConfirmedProject(saved, in: workspace)
            onConfirmed?()
            if !isDemo { await refreshAfterConfirmedMutation(projectID: saved.id, in: workspace, confirmation: "Project saved.", onFailure: onRefreshFailure) }
            try requireCurrent(operation, session: session, in: workspace)
            return project(id: saved.id, in: workspace) ?? saved
        } catch {
            handleScopeFailure(error, operation: operation, in: workspace, projectID: draft.id)
            throw error
        }
    }

    func saveCard(_ draft: CardDraft, projectID: String, in workspace: Workspace, key: String, onConfirmed: (() -> Void)? = nil, onSavedCard: ((Card) -> Void)? = nil, onRefreshFailure: ((String) -> Void)? = nil) async throws -> Card {
        try requireAccess(workspace)
        let operation = sessionID
        let session = api.sessionGeneration
        do {
            let saved: Card
            if isDemo {
                guard var current = project(id: projectID, in: workspace) else { throw AppFailure.missingProject }
                guard current.archivedAt == nil else { throw AppFailure.readOnlyProject }
                guard current.columns.contains(where: { $0.id == draft.columnId }) else { throw AppFailure.missingColumn }
                let retryKey = projectKey(projectID, in: workspace) + "/create-card/" + key
                if draft.id == nil, let retry = demoCreatedCards[retryKey] {
                    guard retry.draft == draft else { throw AppFailure.changedRetry }
                    let saved = current.cards.first(where: { $0.id == retry.card.id }) ?? retry.card
                    onConfirmed?()
                    onSavedCard?(saved)
                    return saved
                }
                let previous = current.cards.first { $0.id == draft.id }
                if draft.id != nil {
                    guard let previous else { throw AppFailure.missingCard }
                    guard previous.archivedAt == nil else { throw AppFailure.readOnlyCard }
                    guard previous.version == draft.version else { throw AppFailure.conflict }
                }
                let timestamp = ServerTimestamp.string()
                saved = Card(id: draft.id ?? UUID().uuidString, externalKey: draft.externalKey,
                    title: draft.title, body: draft.body, nextActor: draft.nextActor, nextAction: draft.nextAction,
                    priority: draft.priority, blockedReason: draft.blockedReason, columnId: previous?.columnId ?? draft.columnId,
                    position: previous?.position ?? draft.position, version: (previous?.version ?? 0) + 1,
                    archivedAt: previous?.archivedAt, createdAt: previous?.createdAt ?? timestamp,
                    updatedAt: timestamp, comments: previous?.comments ?? [])
                current.cards.removeAll { $0.id == saved.id }
                current.cards.append(saved)
                current.revision += 1
                record("Saved \(saved.title).", cardID: saved.id, project: &current)
                loadedProjects[projectKey(projectID, in: workspace)] = current
                updateSummary(current, in: workspace)
                recordConfirmedMutation(projectID: projectID, in: workspace)
                if draft.id == nil { demoCreatedCards[retryKey] = (draft, saved) }
            } else {
                let result: CardMutationResult
                if draft.id == nil { result = try await api.createCardConfirmed(draft, projectID: projectID, in: workspace, idempotencyKey: key) }
                else { result = try await api.updateCardConfirmed(draft, projectID: projectID, in: workspace) }
                saved = result.card
                try requireCurrent(operation, session: session, in: workspace)
                cacheConfirmedCard(saved, projectRevision: result.projectRevision, projectID: projectID, in: workspace)
            }
            onConfirmed?()
            onSavedCard?(saved)
            if !isDemo { await refreshAfterConfirmedMutation(projectID: projectID, in: workspace, confirmation: "Card saved.", onFailure: onRefreshFailure) }
            try requireCurrent(operation, session: session, in: workspace)
            return saved
        } catch {
            handleScopeFailure(error, operation: operation, in: workspace, projectID: projectID)
            throw error
        }
    }

    func addComment(_ body: String, cardID: String, projectID: String, in workspace: Workspace, key: String, onConfirmed: (() -> Void)? = nil, onRefreshFailure: ((String) -> Void)? = nil) async throws {
        try requireAccess(workspace)
        let operation = sessionID
        let session = api.sessionGeneration
        do {
            if isDemo {
                guard var current = project(id: projectID, in: workspace) else { throw AppFailure.missingProject }
                guard current.archivedAt == nil else { throw AppFailure.readOnlyProject }
                guard let index = current.cards.firstIndex(where: { $0.id == cardID }) else { throw AppFailure.missingCard }
                let retryKey = projectKey(projectID, in: workspace) + "/comment/" + cardID + "/" + key
                if let savedBody = demoComments[retryKey] {
                    guard savedBody == body else { throw AppFailure.changedRetry }
                    onConfirmed?()
                    return
                }
                let timestamp = ServerTimestamp.string()
                current.cards[index].comments.append(Comment(id: UUID().uuidString, body: body, author: "Demo owner", createdAt: timestamp))
                current.cards[index].version += 1
                current.cards[index].updatedAt = timestamp
                current.revision += 1
                record("Commented on \(current.cards[index].title).", cardID: cardID, project: &current)
                loadedProjects[projectKey(projectID, in: workspace)] = current
                updateSummary(current, in: workspace)
                recordConfirmedMutation(projectID: projectID, in: workspace)
                demoComments[retryKey] = body
            } else {
                let result = try await api.addComment(body: body, cardID: cardID, projectID: projectID, in: workspace, idempotencyKey: key)
                try requireCurrent(operation, session: session, in: workspace)
                recordConfirmedMutation(projectID: projectID, in: workspace)
                let scope = projectKey(projectID, in: workspace)
                if var current = loadedProjects[scope], let index = current.cards.firstIndex(where: { $0.id == cardID }) {
                    if !current.cards[index].comments.contains(where: { $0.id == result.comment.id }) {
                        current.cards[index].comments.append(result.comment)
                    }
                    // Only this sole next version proves the cached Card fields are still current.
                    if result.card.version == current.cards[index].version + 1 {
                        current.cards[index].version = result.card.version
                    }
                    current.revision = max(current.revision, result.projectRevision)
                    loadedProjects[scope] = current
                    updateSummary(current, in: workspace)
                }
            }
            onConfirmed?()
            if !isDemo { await refreshAfterConfirmedMutation(projectID: projectID, in: workspace, confirmation: "Comment sent.", onFailure: onRefreshFailure) }
            try requireCurrent(operation, session: session, in: workspace)
        } catch {
            handleScopeFailure(error, operation: operation, in: workspace, projectID: projectID)
            throw error
        }
    }

    func moveCard(cardID: String, to columnID: String, projectID: String, in workspace: Workspace,
                  onRefreshFailure: ((String) -> Void)? = nil) async throws -> Card {
        try requireAccess(workspace)
        let loadedForThisMove = project(id: projectID, in: workspace) == nil
        if loadedForThisMove { try await loadProject(id: projectID, in: workspace) }
        guard let card = project(id: projectID, in: workspace)?.cards.first(where: { $0.id == cardID }) else { throw AppFailure.missingCard }
        return try await cardEditingSession(workspace: workspace, projectID: projectID, card: card)
            .move(to: columnID, refreshBeforeMove: !loadedForThisMove, onRefreshFailure: onRefreshFailure)
    }

    /// The shared session durably protects this exact version/destination before calling.
    func performCardMove(_ card: Card, to columnID: String, position: Double, projectID: String, in workspace: Workspace,
                         onConfirmed: ((Card) -> Void)? = nil, onRefreshFailure: ((String) -> Void)? = nil) async throws -> Card {
        try requireAccess(workspace)
        let operation = sessionID
        let session = api.sessionGeneration
        guard let project = project(id: projectID, in: workspace), project.archivedAt == nil else { throw AppFailure.readOnlyProject }
        guard let current = project.cards.first(where: { $0.id == card.id }), current.archivedAt == nil else { throw AppFailure.readOnlyCard }
        guard project.columns.contains(where: { $0.id == columnID }) else { throw AppFailure.missingColumn }
        guard current.version == card.version else { throw AppFailure.conflict }
        if isDemo {
            var updated = project
            guard let index = updated.cards.firstIndex(where: { $0.id == card.id }) else { throw AppFailure.missingCard }
            updated.cards[index].columnId = columnID; updated.cards[index].position = position
            updated.cards[index].version += 1; updated.cards[index].updatedAt = ServerTimestamp.string()
            updated.revision += 1
            record("Moved \(card.title).", cardID: card.id, project: &updated)
            cacheConfirmedProject(updated, in: workspace)
            let moved = updated.cards[index]; onConfirmed?(moved); return moved
        }
        do {
            let result = try await api.moveCard(card, to: columnID, position: position, projectID: projectID, in: workspace)
            try requireCurrent(operation, session: session, in: workspace)
            cacheConfirmedCard(result.card, projectRevision: result.projectRevision, projectID: projectID, in: workspace)
            onConfirmed?(result.card)
            await refreshAfterConfirmedMutation(projectID: projectID, in: workspace, confirmation: "Card moved.", onFailure: onRefreshFailure)
            try requireCurrent(operation, session: session, in: workspace)
            return result.card
        } catch {
            handleScopeFailure(error, operation: operation, in: workspace, projectID: projectID)
            throw error
        }
    }

    func archive(_ card: Card, projectID: String, in workspace: Workspace, archived: Bool, onRefreshFailure: ((String) -> Void)? = nil) async throws {
        try requireAccess(workspace)
        let operation = sessionID
        let session = api.sessionGeneration
        do {
            if isDemo {
                guard var current = project(id: projectID, in: workspace) else { throw AppFailure.missingProject }
                guard current.archivedAt == nil else { throw AppFailure.readOnlyProject }
                guard let index = current.cards.firstIndex(where: { $0.id == card.id }) else { throw AppFailure.missingCard }
                guard current.cards[index].version == card.version else { throw AppFailure.conflict }
                current.cards[index].archivedAt = archived ? ServerTimestamp.string() : nil
                current.cards[index].updatedAt = ServerTimestamp.string()
                current.cards[index].version += 1
                current.revision += 1
                record(archived ? "Archived \(card.title)." : "Restored \(card.title).", cardID: card.id, project: &current)
                cacheConfirmedProject(current, in: workspace)
            } else {
                let result = try await api.archiveCardConfirmed(card: card, archived: archived, projectID: projectID, in: workspace)
                try requireCurrent(operation, session: session, in: workspace)
                cacheConfirmedCard(result.card, projectRevision: result.projectRevision, projectID: projectID, in: workspace)
                await refreshAfterConfirmedMutation(projectID: projectID, in: workspace,
                    confirmation: archived ? "Card archived." : "Card restored.", onFailure: onRefreshFailure)
            }
            try requireCurrent(operation, session: session, in: workspace)
        } catch {
            handleScopeFailure(error, operation: operation, in: workspace, projectID: projectID)
            throw error
        }
    }

    func archiveProject(_ project: Project, in workspace: Workspace, archived: Bool, onRefreshFailure: ((String) -> Void)? = nil) async throws {
        try requireAccess(workspace)
        let operation = sessionID
        let session = api.sessionGeneration
        do {
            let saved: Project
            if isDemo {
                guard var current = self.project(id: project.id, in: workspace) else { throw AppFailure.missingProject }
                guard current.revision == project.revision else { throw AppFailure.conflict }
                current.archivedAt = archived ? ServerTimestamp.string() : nil
                current.updatedAt = ServerTimestamp.string()
                current.revision += 1
                saved = current
            } else {
                saved = try await api.archiveProject(project: project, archived: archived, in: workspace)
                try requireCurrent(operation, session: session, in: workspace)
            }
            cacheConfirmedProject(saved, in: workspace)
            if !isDemo { await refreshAfterConfirmedMutation(projectID: saved.id, in: workspace,
                confirmation: archived ? "Project archived." : "Project restored.", onFailure: onRefreshFailure) }
            try requireCurrent(operation, session: session, in: workspace)
        } catch {
            handleScopeFailure(error, operation: operation, in: workspace, projectID: project.id)
            throw error
        }
    }

    func handle(_ error: Error) {
        guard !(error is CancellationError) else { return }
        if let generation = (error as? APIError)?.sessionGeneration, generation != api.sessionGeneration { return }
        if (error as? APIError)?.isUnauthorized == true {
            sessionID = UUID()
            passkeys.cancel()
            signingIn = false
            signedIn = false
            clearPrivateState()
        }
        errorMessage = error.localizedDescription
    }

    func isConflict(_ error: Error) -> Bool {
        (error as? APIError)?.isConflict == true || (error as? AppFailure) == .conflict
    }

    /// Recheck when the app returns to the foreground, including after system sleep.
    func validateSession() {
        guard !isDemo, signedIn, !endingSession, !signOutPending else { return }
        guard let credential = api.credential,
              let expiry = ServerTimestamp.date(from: credential.expiresAt), expiry > .now else {
            sessionID = UUID()
            passkeys.cancel()
            signingIn = false
            signedIn = false
            clearPrivateState()
            errorMessage = "Your session expired. Sign in again to continue."
            return
        }
    }

    private func scheduleSessionExpiry() {
        sessionExpiryTask?.cancel()
        sessionExpiryTask = nil
        guard !isDemo, signedIn, let credential = api.credential,
              let expiry = ServerTimestamp.date(from: credential.expiresAt) else {
            validateSession()
            return
        }
        let operation = sessionID
        let delay = max(0, expiry.timeIntervalSinceNow)
        sessionExpiryTask = Task<Void, Never> { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) }
            catch { return }
            guard let self, self.sessionID == operation else { return }
            self.validateSession()
        }
    }

    private func requireWorkspaceCreationSession(_ operation: UUID, session: UUID) throws {
        validateSession()
        guard operation == sessionID, session == api.sessionGeneration,
              signedIn, !signOutPending, !endingSession else { throw CancellationError() }
    }

    private func replaceWorkspaceInventory(_ incoming: [Workspace]) {
        let retained = Set(incoming.map(workspaceKey))
        projectLists = projectLists.filter { retained.contains($0.key) }
        loadedProjects = loadedProjects.filter { key, _ in retained.contains { key.hasPrefix($0 + "/") } }
        workspaces = incoming
    }

    private func seedDemoWorkspace() {
        #if DEBUG
        guard !ProcessInfo.processInfo.arguments.contains("--demo-empty-workspaces") else { return }
        #endif
        let workspace = Workspace(id: "demo-workspace", slug: "studio", name: Self.demoWorkspaceName,
            url: URL(string: "https://studio.demo.invalid")!)
        workspaces = [workspace]
        let project = Self.demoProjectWithAuditFixture()
        loadedProjects[projectKey(project.id, in: workspace)] = project
        updateSummary(project, in: workspace)
    }

    private func canAccess(_ workspace: Workspace) -> Bool {
        let credentialIsCurrent = isDemo || api.credential.flatMap { ServerTimestamp.date(from: $0.expiresAt) }.map { $0 > .now } == true
        return signedIn && credentialIsCurrent && !signOutPending && !endingSession
            && workspaces.contains(where: { $0.id == workspace.id && $0.url == workspace.url })
    }

    private func requireAccess(_ workspace: Workspace) throws {
        validateSession()
        guard canAccess(workspace) else { throw CancellationError() }
    }

    private func requireCurrent(_ operation: UUID, session: UUID, in workspace: Workspace) throws {
        guard operation == sessionID, session == api.sessionGeneration, canAccess(workspace) else { throw CancellationError() }
    }

    private func workspaceKey(_ workspace: Workspace) -> String {
        // Length prefixes prevent resource IDs with separators from colliding.
        [ownerID, workspace.id, workspace.url.absoluteString].map { "\($0.utf8.count):\($0)" }.joined()
    }

    private func projectKey(_ projectID: String, in workspace: Workspace) -> String {
        workspaceKey(workspace) + "/" + "\(projectID.utf8.count):\(projectID)"
    }

    private func clearPrivateState() {
        for session in cardEditingSessions.values { session.invalidate() }
        cardEditingSessions.removeAll()
        for session in commentEditingSessions.values { session.invalidate() }
        commentEditingSessions.removeAll()
        sessionExpiryTask?.cancel()
        sessionExpiryTask = nil
        workspaceLoadID = nil
        workspaceCreationID = nil
        creatingWorkspace = false
        uncertainWorkspaceCreationBaselines = [:]
        loadingWorkspaces = false
        workspaceLoadFailed = false
        workspaceLoadError = nil
        loadingProjectLists = []
        projectListErrors = [:]
        fullSnapshotRevisions = [:]
        workspaces = []
        projectLists = [:]
        loadedProjects = [:]
        workspaceRefreshes = [:]
        projectRefreshes = [:]
        workspaceMutationGenerations = [:]
        projectMutationGenerations = [:]
        demoCreatedCards = [:]
        demoCreatedProjects = [:]
        demoComments = [:]
    }

    private func handleScopeFailure(_ error: Error, operation: UUID, in workspace: Workspace, projectID: String? = nil) {
        guard operation == sessionID, !(error is CancellationError) else { return }
        if let generation = (error as? APIError)?.sessionGeneration, generation != api.sessionGeneration { return }
        // A local verification restriction says nothing about server read access.
        if (error as? APIError)?.isLocalPolicyDenial == true { return }
        if (error as? APIError)?.isUnauthorized == true { handle(error); return }
        if let code = (error as? APIError)?.statusCode, code == 403 || code == 404 {
            if let projectID {
                loadedProjects.removeValue(forKey: projectKey(projectID, in: workspace))
                projectLists[workspaceKey(workspace)]?.removeAll { $0.id == projectID }
            } else {
                let scope = workspaceKey(workspace)
                projectLists.removeValue(forKey: scope)
                loadedProjects = loadedProjects.filter { !$0.key.hasPrefix(scope + "/") }
            }
        }
    }

    private func refreshAfterConfirmedMutation(projectID: String, in workspace: Workspace, confirmation: String, onFailure: ((String) -> Void)? = nil) async {
        let operation = sessionID
        do {
            try await loadProject(id: projectID, in: workspace)
            try await loadProjects(in: workspace)
        } catch {
            guard !(error is CancellationError) else { return }
            if let generation = (error as? APIError)?.sessionGeneration, generation != api.sessionGeneration { return }
            // loadProject/loadProjects already clear inaccessible data, including session failures.
            guard operation == sessionID else { return }
            onFailure?("\(confirmation) The latest state could not be refreshed. Retry refresh. \(error.localizedDescription)")
        }
    }

    private func cacheConfirmedProject(_ incoming: Project, in workspace: Workspace) {
        recordConfirmedMutation(projectID: incoming.id, in: workspace)
        let scope = projectKey(incoming.id, in: workspace)
        guard let current = loadedProjects[scope] else {
            loadedProjects[scope] = incoming
            fullSnapshotRevisions[scope] = incoming.revision
            updateSummary(incoming, in: workspace)
            return
        }
        // Partial Card/Comment results advance the revision watermark but do not
        // contain metadata. An older full response may still carry newly confirmed
        // metadata; merge it without lowering Card versions or losing Comments.
        var merged = incoming.revision >= (fullSnapshotRevisions[scope] ?? 0) ? incoming : current
        if incoming.revision >= (fullSnapshotRevisions[scope] ?? 0) {
            fullSnapshotRevisions[scope] = incoming.revision
        }
        var cards = Dictionary(uniqueKeysWithValues: merged.cards.map { ($0.id, $0) })
        for card in current.cards {
            if let other = cards[card.id] {
                cards[card.id] = mergedCard(other, with: card)
            } else if incoming.revision < current.revision {
                cards[card.id] = card
            }
        }
        merged.cards = Array(cards.values)
        merged.revision = max(current.revision, incoming.revision)
        merged.updatedAt = max(current.updatedAt, incoming.updatedAt)
        let activities = Dictionary((current.activity + incoming.activity).map { ($0.id, $0) }, uniquingKeysWith: { old, _ in old })
        merged.activity = activities.values.sorted { $0.createdAt < $1.createdAt }
        loadedProjects[scope] = merged
        updateSummary(merged, in: workspace)
    }

    private func mergedCard(_ first: Card, with second: Card) -> Card {
        var merged = first.version >= second.version ? first : second
        // Comments append independently; a partial response cannot revoke one.
        let comments = Dictionary((first.comments + second.comments).map { ($0.id, $0) }, uniquingKeysWith: { old, _ in old })
        merged.comments = comments.values.sorted { $0.createdAt < $1.createdAt }
        return merged
    }

    private func cacheConfirmedCard(_ card: Card, projectRevision: Int, projectID: String, in workspace: Workspace) {
        recordConfirmedMutation(projectID: projectID, in: workspace)
        let scope = projectKey(projectID, in: workspace)
        guard var current = loadedProjects[scope] else { return }
        let existing = current.cards.first { $0.id == card.id }
        current.cards.removeAll { $0.id == card.id }
        current.cards.append(existing.map { mergedCard(card, with: $0) } ?? card)
        current.revision = max(current.revision, projectRevision)
        loadedProjects[scope] = current
        updateSummary(current, in: workspace)
    }

    private func recordConfirmedMutation(projectID: String, in workspace: Workspace) {
        projectMutationGenerations[projectKey(projectID, in: workspace)] = UUID()
        workspaceMutationGenerations[workspaceKey(workspace)] = UUID()
    }

    private func projectSummary(_ project: Project) -> ProjectSummary {
        ProjectSummary(id: project.id, name: project.name, description: project.description,
            revision: project.revision, archivedAt: project.archivedAt, createdAt: project.createdAt,
            updatedAt: project.updatedAt, cardCount: project.cards.filter { $0.archivedAt == nil }.count)
    }

    private func updateSummary(_ project: Project, in workspace: Workspace) {
        let summary = projectSummary(project)
        let scope = workspaceKey(workspace)
        var summaries = projectLists[scope] ?? []
        if let cached = summaries.first(where: { $0.id == project.id }), cached.revision > summary.revision { return }
        summaries.removeAll { $0.id == project.id }
        summaries.append(summary)
        projectLists[scope] = summaries.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    private func record(_ summary: String, cardID: String, project: inout Project) {
        project.activity.append(Activity(id: UUID().uuidString, action: "card.updated",
            actor: ActivityActor(channel: "native", label: "Demo owner"), summary: summary,
            projectId: project.id, cardId: cardID, createdAt: ServerTimestamp.string()))
        project.updatedAt = ServerTimestamp.string()
    }

    private static var defaultColumns: [Column] {
        [Column(id: "next", name: "Next", position: 0), Column(id: "doing", name: "Doing", position: 1),
         Column(id: "done", name: "Done", position: 2)]
    }

    private static var demoWorkspaceName: String {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--audit-long-workspace") {
            return String(repeating: "Studio Workspace with a long multilingual name 日本語 العربية ", count: 4)
        }
        #endif
        return "Studio Workspace"
    }

    private static func demoProjectWithAuditFixture() -> Project {
        var project = demoProject()
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--audit-long-content") {
            project.description = (1...50).map { "Project context \($0): Preserve readable native scrolling for long, multilingual content. 日本語 العربية" }.joined(separator: "\n")
            if let index = project.cards.firstIndex(where: { $0.id == "demo-card-homepage" }) {
                project.cards[index].title = String(repeating: "Review a long multilingual launch heading 日本語 العربية ", count: 12)
                project.cards[index].body = (1...50).map { "Paragraph \($0): The detail view retains the entire saved source for reading and editing." }.joined(separator: "\n\n")
                project.cards[index].nextAction = String(repeating: "Choose the accessible heading order. ", count: 20)
                project.cards[index].blockedReason = String(repeating: "Waiting for the content review. ", count: 20)
                project.cards[index].comments = (1...50).map { Comment(id: "long-fixture-comment-\($0)", body: "Comment \($0): Readable history remains available through native scrolling.", author: "Demo reviewer", createdAt: ServerTimestamp.string()) }
            }
        }
        #endif
        return project
    }

    private static func demoProject() -> Project {
        let timestamp = ServerTimestamp.string()
        let samples: [(id: String, title: String, column: String, body: String, actor: CardNextActor?, priority: CardPriority?, action: String, blocker: String)] = [
            ("pricing", "Clarify the pricing comparison", "next", "Choose useful comparison criteria for the available plans.", .human, .high, "Choose the comparison criteria", ""),
            ("checklist", "Draft the launch checklist", "next", "Turn the agreed launch scope into a practical checklist.", .agent, .medium, "Turn the agreed scope into a checklist", ""),
            ("footer", "Review footer navigation", "next", "Review the links in the website footer.", nil, nil, "", ""),
            ("research", "Organize the research notes", "next", "Organize the notes so the reader questions are easy to find.", .agent, .low, "Group notes by reader question", ""),
            ("homepage", "Review homepage hierarchy", "doing", "Help a first-time visitor understand the offer before comparing plans.\n\nReview the headline, supporting sentence, and primary action together.", .human, .high, "Choose the preferred heading order", ""),
            ("keyboard", "Check keyboard navigation", "doing", "Check that each part of the launch experience can be reached with the keyboard.", .agent, .high, "Complete the navigation pass", ""),
            ("licenses", "Confirm illustration licenses", "doing", "Confirm the usage rights for the launch illustrations.", .human, .medium, "", "Waiting for the license receipt"),
            ("signup", "Simplify the signup introduction", "done", "Explain what happens after signup in one short introduction.\n\nKeep the next step clear before asking for information.", .agent, .medium, "Introduction updated", ""),
            ("buttons", "Replace unclear button labels", "done", "Use clear labels for each button in the launch experience.", .human, .high, "", "")
        ]
        let cards = samples.enumerated().map { index, sample in
            let comments: [Comment]
            switch sample.id {
            case "homepage":
                comments = [Comment(id: "demo-comment-homepage-1", body: "The revised order puts the offer before implementation detail.", author: "Studio assistant", createdAt: timestamp),
                    Comment(id: "demo-comment-homepage-2", body: "Keep the short explanation; compare the two heading options.", author: "You", createdAt: timestamp)]
            case "signup":
                comments = [Comment(id: "demo-comment-signup-1", body: "The introduction now explains the next step before the form.", author: "Studio assistant", createdAt: timestamp),
                    Comment(id: "demo-comment-signup-2", body: "Keep the shorter introduction for launch.", author: "You", createdAt: timestamp)]
            default: comments = []
            }
            return Card(id: "demo-card-\(sample.id)", title: sample.title, body: sample.body,
                nextActor: sample.actor, nextAction: sample.action, priority: sample.priority,
                blockedReason: sample.blocker, columnId: sample.column, position: Double(index),
                version: 1, createdAt: timestamp, updatedAt: timestamp, comments: comments)
        }
        return Project(id: "demo-project", name: "Atlas website", description: "Prepare a clear, accessible launch experience.",
            columns: defaultColumns, cards: cards, activity: [], revision: 1, createdAt: timestamp, updatedAt: timestamp)
    }
}

enum AppFailure: LocalizedError, Equatable {
    case missingProject, missingCard, missingColumn, conflict, readOnlyProject, readOnlyCard, changedRetry
    var errorDescription: String? {
        switch self {
        case .missingProject: "The Project is unavailable. Refresh and try again."
        case .missingCard: "The Card is unavailable. Refresh and try again."
        case .missingColumn: "Choose a current Column before saving."
        case .conflict: "This item changed while you were editing. Review the latest saved values before saving."
        case .readOnlyProject: "This Project is archived. Restore it before making changes."
        case .readOnlyCard: "This Card is archived. Restore it before moving it."
        case .changedRetry: "This retry contains different changes. Refresh before trying again."
        }
    }
}

private struct WorkspaceCreationIntent: Hashable {
    let name: String
    let slug: String

    init(name: String, slug: String) throws {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let slug = slug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !name.isEmpty, name.utf16.count <= 120,
              !name.unicodeScalars.contains(where: { [0, 10, 13].contains($0.value) }) else {
            throw APIError(message: "Workspace name must be 120 characters or fewer and stay on one line.")
        }
        guard slug.range(of: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", options: .regularExpression) != nil,
              !["api", "app", "auth", "admin", "www"].contains(slug) else {
            throw APIError(message: "Choose a Workspace address using lowercase letters, numbers, and hyphens.")
        }
        self.name = name
        self.slug = slug
    }
}
