import AuthenticationServices
import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    private static let signOutIntentKey = "nativeSignOutPending"
    let api: KanbanAPIClient
    let drafts: DraftStore
    private let defaults: UserDefaults
    private let passkeys = PasskeySignInCoordinator()
    private var cardEditingSessions: [String: CardEditingSession] = [:]
    private var commentEditingSessions: [String: CommentEditingSession] = [:]
    private var projectMutationGenerations: [String: UUID] = [:]
    private var workspaceMutationGenerations: [String: UUID] = [:]
    private var workspaceRefreshes: [String: UUID] = [:]
    private var workspaceLoadID: UUID?
    private var workspaceCreationID: UUID?
    private var uncertainWorkspaceCreationBaselines: [WorkspaceCreationIntent: Set<String>] = [:]
    #if DEBUG
    private var demoCreationAttempts: Set<String> = []
    #endif
    private(set) var loadingWorkspaces = false
    private(set) var creatingWorkspace = false
    private(set) var workspaceLoadFailed = false
    private(set) var signedIn = false
    private(set) var restoring = true
    private(set) var signingIn = false
    private(set) var endingSession = false
    private(set) var signOutPending = false
    private(set) var workspaces: [Workspace] = []
    private(set) var projectLists: [String: [ProjectSummary]] = [:]
    private(set) var loadedProjects: [String: Project] = [:]
    var errorMessage: String?
    let isDemo: Bool

    init(api: KanbanAPIClient = KanbanAPIClient(), drafts: DraftStore = DraftStore(), defaults: UserDefaults = .standard, demo: Bool? = nil) {
        self.api = api
        self.drafts = drafts
        self.defaults = defaults
        #if DEBUG
        isDemo = demo ?? ProcessInfo.processInfo.arguments.contains("--demo")
        #else
        isDemo = false
        #endif
        if !isDemo { signOutPending = defaults.bool(forKey: Self.signOutIntentKey) }
        if isDemo {
            if ProcessInfo.processInfo.arguments.contains("--reset-demo-drafts") {
                try? drafts.removeAll(ownerID: "demo-owner")
            }
            signedIn = true
            restoring = false
            guard !ProcessInfo.processInfo.arguments.contains("--demo-empty-workspaces") else { return }
            workspaces = [Workspace(id: "demo-workspace", slug: "demo", name: "Demo Workspace", url: URL(string: "https://demo.invalid")!)]
            let timestamp = ServerTimestamp.string()
            let card = Card(id: "demo-card", title: "Review the iPhone app", body: "Check the native Card workflow.", nextActor: .human, nextAction: "Review the changes", priority: .high, blockedReason: "", columnId: "next", position: 0, version: 1, createdAt: timestamp, updatedAt: timestamp, comments: [])
            let project = Project(id: "demo-project", name: "iPhone app", description: "Isolated sample data for simulator verification.", columns: [Column(id: "next", name: "Next", position: 0), Column(id: "doing", name: "Doing", position: 1), Column(id: "done", name: "Done", position: 2)], cards: [card], activity: [], revision: 1, createdAt: timestamp, updatedAt: timestamp)
            loadedProjects[project.id] = project
            updateSummary(project, workspaceID: "demo-workspace")
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--demo-archived-projects") {
                var archivedCard = card
                archivedCard.id = "demo-archived-card"
                archivedCard.title = "Archived sample Card"
                archivedCard.archivedAt = timestamp
                archivedCard.comments = [Comment(id: "demo-archived-comment", body: "Archived sample Comment", author: "Demo owner", createdAt: timestamp)]
                var readOnlyCard = card
                readOnlyCard.id = "demo-readonly-card"
                readOnlyCard.title = "Read-only sample Card"
                readOnlyCard.comments = [Comment(id: "demo-readonly-comment", body: "Read-only sample Comment", author: "Demo owner", createdAt: timestamp)]
                var archivedProject = project
                archivedProject.id = "demo-archived-project"
                archivedProject.name = "Archived sample"
                archivedProject.archivedAt = timestamp
                archivedProject.cards = [archivedCard, readOnlyCard]
                archivedProject.activity = [Activity(id: "demo-archived-activity", action: "project.archived", actor: ActivityActor(channel: "native", label: "Demo owner"), summary: "Archived sample activity.", projectId: archivedProject.id, createdAt: timestamp)]
                loadedProjects[archivedProject.id] = archivedProject
                updateSummary(archivedProject, workspaceID: "demo-workspace")
            }
            if ProcessInfo.processInfo.arguments.contains("--demo-unreadable-creation-drafts"),
               let workspace = workspaces.first {
                let records = [(project.id, "card:\(project.id):new"), ("new", "project:\(workspace.id):new")]
                for (projectID, resource) in records {
                    let key = drafts.scopedKey(workspace: workspace, projectID: projectID, resourceKey: resource)
                    // Valid JSON of the wrong type exercises the real decode failure.
                    try? drafts.save("Synthetic unread creation record; retain operation-key-\(resource)",
                        ownerID: "demo-owner", resourceKey: key)
                }
            }
            if ProcessInfo.processInfo.arguments.contains("--demo-legacy-creation-drafts") {
                var cardDraft = CardDraft(columnId: "next")
                cardDraft.title = "Older Card idea"
                cardDraft.body = "Keep this original Card draft while I start something new."
                let cardPending = PendingCardDraft(draft: cardDraft, key: "demo-legacy-card-request")
                let projectPending = PendingProjectDraft(
                    draft: ProjectDraft(name: "Older Project idea",
                        description: "Keep this original Project draft while I start something new."),
                    key: "demo-legacy-project-request")
                // Owner-only keys represent pre-scope drafts; recovering text must
                // not imply that the user or app knows their original Workspace.
                try? drafts.save(cardPending, ownerID: "demo-owner", resourceKey: "card:\(project.id):new")
                try? drafts.save(projectPending, ownerID: "demo-owner", resourceKey: "project:demo-workspace:new")
            }
            if ProcessInfo.processInfo.arguments.contains("--demo-creation-recovery-metadata") {
                var cardDraft = CardDraft(columnId: "doing")
                cardDraft.title = "Card with saved details"
                cardDraft.body = "Review every saved detail before copying."
                cardDraft.nextActor = .agent
                cardDraft.priority = .high
                cardDraft.nextAction = "Review the saved plan"
                cardDraft.blockedReason = "Waiting for approval"
                try? drafts.save(PendingCardDraft(draft: cardDraft, key: "demo-details-request"),
                    ownerID: "demo-owner", resourceKey: "card:\(project.id):new")
            }
            if ProcessInfo.processInfo.arguments.contains("--demo-archived-creation-draft"),
               let workspace = workspaces.first {
                var cardDraft = CardDraft(columnId: "next")
                cardDraft.title = "Card saved before archiving"
                cardDraft.body = "Keep this draft available after the Project is archived."
                try? drafts.saveCreationDraft(PendingCardDraft(draft: cardDraft, key: "demo-archived-request"),
                    id: UUID(), ownerID: "demo-owner", workspace: workspace,
                    projectID: "demo-archived-project", resourceKey: "card:demo-archived-project:new")
            }
            #endif
        }
    }

    var ownerID: String { isDemo ? "demo-owner" : api.credential?.owner.id ?? "signed-out" }

    func cardEditingSession(workspace: Workspace, projectID: String, card: Card, readOnly: Bool = false) -> CardEditingSession {
        let key = ownerID + ":" + (readOnly ? "browse:" : "edit:")
            + drafts.scopedKey(workspace: workspace, projectID: projectID, resourceKey: "card:" + card.id)
        if let session = cardEditingSessions[key] { session.receive(card); return session }
        let session = CardEditingSession(model: self, workspace: workspace, projectID: projectID, card: card, readOnly: readOnly)
        cardEditingSessions[key] = session
        return session
    }

    func commentEditingSession(workspace: Workspace, projectID: String, cardID: String) -> CommentEditingSession {
        let key = ownerID + ":" + drafts.scopedKey(workspace: workspace, projectID: projectID, resourceKey: "comment:" + cardID)
        if let session = commentEditingSessions[key] { return session }
        let session = CommentEditingSession(model: self, workspace: workspace, projectID: projectID, cardID: cardID)
        commentEditingSessions[key] = session
        return session
    }

    var canCreateWorkspace: Bool {
        let credentialIsCurrent = isDemo || api.credential.flatMap { ServerTimestamp.date(from: $0.expiresAt) }.map { $0 > .now } == true
        return signedIn && credentialIsCurrent && !restoring && !signingIn
            && !signOutPending && !endingSession && !creatingWorkspace
    }

    func createWorkspace(name: String, slug: String) async throws -> Workspace {
        guard canCreateWorkspace else { throw CancellationError() }
        let intent = try WorkspaceCreationIntent(name: name, slug: slug)
        let baseline = uncertainWorkspaceCreationBaselines[intent] ?? Set(workspaces.map(\.id))
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
                    if error.isUnauthorized { handle(error); throw CancellationError() }
                    try requireWorkspaceCreationSession(creation, session: session)
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
                    try requireWorkspaceCreationSession(creation, session: session)
                    guard let reconciled = incoming.first(where: { $0.slug == intent.slug && $0.name == intent.name && !baseline.contains($0.id) }) else { throw error }
                    workspaces = incoming
                    saved = reconciled
                }
            }
            try requireWorkspaceCreationSession(creation, session: session)
            // Invalidate older AppModel reads as well as the transport's origin list.
            workspaceLoadID = nil
            loadingWorkspaces = false
            workspaceLoadFailed = false
            if let index = workspaces.firstIndex(where: { $0.id == saved.id }) { workspaces[index] = saved }
            else { workspaces.append(saved) }
            uncertainWorkspaceCreationBaselines.removeValue(forKey: intent)
            return saved
        } catch {
            if workspaceCreationID == creation, (error as? APIError)?.isUnauthorized == true { handle(error) }
            throw error
        }
    }

    func restore() async {
        guard restoring else { return }
        defer { restoring = false }
        if signOutPending {
            // Load the retained credential for revocation without exposing private data.
            do { _ = try await api.restoreSession() }
            catch {
                // A Keychain read may fail before the credential is available. Keep the
                // durable intent and secret so a later attempt can revoke it on the server.
                guard api.credential != nil else {
                    errorMessage = "Sign-out is still pending. The saved session could not be opened securely. Retry sign-out. \(error.localizedDescription)"
                    return
                }
            }
            await signOut()
            return
        }
        do {
            if let session = try await api.restoreSession(), session.authenticated {
                guard !signOutPending else { return }
                signedIn = true
                await refreshWorkspaces()
            }
        } catch { handle(error) }
    }

    func signIn() async {
        guard !signingIn, !signedIn, !signOutPending, !endingSession else { return }
        signingIn = true
        defer { signingIn = false }
        do {
            let challenge = try await api.beginSignIn()
            let assertion = try await passkeys.assertion(for: challenge)
            try await completeSignIn(challenge: challenge, assertion: assertion)
        } catch is CancellationError {
            return
        } catch let error as ASAuthorizationError where error.code == .canceled {
            return
        } catch { handle(error) }
    }

    func completeSignIn(challenge: NativeSignInChallenge, assertion: NativePasskeyAssertion) async throws {
        _ = try await api.completeSignIn(challenge: challenge, assertion: assertion)
        guard !signOutPending, !endingSession else { throw CancellationError() }
        signedIn = true
        await refreshWorkspaces()
    }

    func refreshWorkspaces() async {
        guard !isDemo, signedIn, !signOutPending else { return }
        let session = api.sessionGeneration
        let requestID = UUID()
        workspaceLoadID = requestID
        loadingWorkspaces = true
        workspaceLoadFailed = false
        defer { if workspaceLoadID == requestID { loadingWorkspaces = false } }
        do {
            let incoming = try await api.workspaces()
            guard session == api.sessionGeneration, workspaceLoadID == requestID,
                  signedIn, !signOutPending else { return }
            workspaces = incoming
        } catch {
            guard !(error is CancellationError) else { return }
            if let generation = (error as? APIError)?.sessionGeneration, generation != api.sessionGeneration { return }
            // A same-session 401 ends authentication even if another Workspace read
            // superseded this one. Replacement-session failures remain excluded above.
            if (error as? APIError)?.isUnauthorized == true { handle(error); return }
            guard workspaceLoadID == requestID else { return }
            workspaceLoadFailed = true
            handle(error)
        }
    }

    func signOut() async {
        guard !endingSession else { return }
        endingSession = true
        signOutPending = true
        if !isDemo { defaults.set(true, forKey: Self.signOutIntentKey) }
        signedIn = false
        workspaceLoadID = nil
        workspaceCreationID = nil
        creatingWorkspace = false
        uncertainWorkspaceCreationBaselines = [:]
        loadingWorkspaces = false
        workspaceLoadFailed = false
        workspaces = []
        projectLists = [:]
        loadedProjects = [:]
        defer { endingSession = false }
        do {
            if !isDemo {
                if api.credential == nil {
                    // A retry after a locked Keychain must recover the credential before
                    // deciding there is no server session left to revoke.
                    do { _ = try await api.restoreSession() }
                    catch { if api.credential == nil { throw error } }
                }
                try await api.signOut()
            }
            signOutPending = false
            if !isDemo { defaults.removeObject(forKey: Self.signOutIntentKey) }
        } catch { errorMessage = "The server has not confirmed sign-out. Retry to end this session. \(error.localizedDescription)" }
    }

    func loadProjects(in workspace: Workspace) async throws {
        guard !isDemo else { return }
        let session = api.sessionGeneration
        let mutation = workspaceMutationGenerations[workspace.id]
        let refresh = UUID()
        workspaceRefreshes[workspace.id] = refresh
        let incoming = try await api.projects(in: workspace, includeArchived: true)
        guard session == api.sessionGeneration, !signOutPending,
              mutation == workspaceMutationGenerations[workspace.id],
              refresh == workspaceRefreshes[workspace.id] else { throw CancellationError() }
        let previous = Dictionary(uniqueKeysWithValues: (projectLists[workspace.id] ?? []).map { ($0.id, $0) })
        projectLists[workspace.id] = incoming.map { summary in
            if let cached = previous[summary.id], cached.revision > summary.revision { return cached }
            if let project = loadedProjects[summary.id], project.revision > summary.revision {
                return projectSummary(project)
            }
            return summary
        }
    }

    func loadProject(id: String, in workspace: Workspace) async throws {
        guard !isDemo else { return }
        let session = api.sessionGeneration
        let mutation = projectMutationGenerations[id]
        let project = try await api.project(id: id, in: workspace)
        guard session == api.sessionGeneration, !signOutPending,
              mutation == projectMutationGenerations[id] else { throw CancellationError() }
        guard (loadedProjects[id]?.revision ?? 0) <= project.revision else { return }
        loadedProjects[id] = project
        updateSummary(project, workspaceID: workspace.id)
    }

    func saveProject(_ draft: ProjectDraft, in workspace: Workspace, key: String) async throws -> Project {
        if let id = draft.id { try requireWritableProject(id, in: workspace) }
        let project: Project
        if isDemo {
            #if DEBUG
            if draft.id == nil { try await prepareDemoCreation(key: key) }
            #endif
            let timestamp = ServerTimestamp.string()
            if let id = draft.id, var existing = loadedProjects[id] {
                existing.name = draft.name
                existing.description = draft.description
                existing.revision += 1
                existing.updatedAt = timestamp
                project = existing
            } else {
                project = Project(id: UUID().uuidString, name: draft.name, description: draft.description, columns: [Column(id: "next", name: "Next", position: 0), Column(id: "doing", name: "Doing", position: 1), Column(id: "done", name: "Done", position: 2)], cards: [], activity: [], revision: 1, createdAt: timestamp, updatedAt: timestamp)
            }
        } else if draft.id == nil {
            project = try await api.createProject(draft, in: workspace, idempotencyKey: key)
        } else {
            project = try await api.updateProject(draft, in: workspace)
        }
        recordConfirmedMutation(projectID: project.id, workspaceID: workspace.id)
        // A POST retry can return an older saved snapshot. Keep any newer local read
        // and fetch current state before presenting the Project as refreshed.
        if (loadedProjects[project.id]?.revision ?? 0) <= project.revision {
            loadedProjects[project.id] = project
            updateSummary(project, workspaceID: workspace.id)
        }
        if !isDemo {
            await refreshAfterConfirmedMutation(projectID: project.id, in: workspace, confirmation: "Project saved.")
        }
        return loadedProjects[project.id] ?? project
    }

    func saveCard(_ proposed: CardDraft, projectID: String, in workspace: Workspace, key: String,
                  onConfirmed: ((Card) -> Void)? = nil) async throws -> Card {
        #if DEBUG
        if isDemo, proposed.id == nil,
           ProcessInfo.processInfo.arguments.contains("--demo-archive-project-on-save"),
           var project = loadedProjects[projectID] {
            project.archivedAt = ServerTimestamp.string()
            loadedProjects[projectID] = project
            updateSummary(project, workspaceID: workspace.id)
            throw APIError(message: "This Project was archived.", statusCode: 409)
        }
        #endif
        try requireWritableProject(projectID, in: workspace)
        let draft = proposed
        let card: Card
        if isDemo {
            #if DEBUG
            if draft.id == nil { try await prepareDemoCreation(key: key) }
            #endif
            guard var project = loadedProjects[projectID] else { throw AppFailure.missingProject }
            if let id = draft.id, let current = project.cards.first(where: { $0.id == id }), current.version != draft.version { throw AppFailure.conflict }
            let timestamp = ServerTimestamp.string()
            let previous = project.cards.first { $0.id == draft.id }
            card = Card(id: draft.id ?? UUID().uuidString, externalKey: previous?.externalKey ?? draft.externalKey, title: draft.title, body: draft.body, nextActor: draft.nextActor, nextAction: draft.nextAction, priority: draft.priority, blockedReason: draft.blockedReason, columnId: previous?.columnId ?? draft.columnId, position: previous?.position ?? draft.position, version: (previous?.version ?? 0) + 1, archivedAt: previous?.archivedAt, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, comments: previous?.comments ?? [])
            project.cards.removeAll { $0.id == card.id }
            project.cards.append(card)
            project.revision += 1
            record("Saved \(card.title).", cardID: card.id, project: &project)
            loadedProjects[projectID] = project
            updateSummary(project, workspaceID: workspace.id)
        } else {
            if draft.id == nil { card = try await api.createCard(draft, projectID: projectID, in: workspace, idempotencyKey: key) }
            else { card = try await api.updateCard(draft, projectID: projectID, in: workspace) }
            cacheConfirmedCard(card, projectID: projectID, workspaceID: workspace.id)
            onConfirmed?(card)
            // Failure to refresh does not undo the confirmed save or require resubmission.
            await refreshAfterConfirmedMutation(projectID: projectID, in: workspace, confirmation: "Card saved.")
        }
        if isDemo { onConfirmed?(card) }
        return card
    }

    #if DEBUG
    private func prepareDemoCreation(key: String) async throws {
        if ProcessInfo.processInfo.arguments.contains("--demo-creation-save-delay") {
            try await Task.sleep(for: .seconds(30))
        }
        if ProcessInfo.processInfo.arguments.contains("--demo-creation-save-error") {
            throw APIError(message: "Demo creation request was rejected.", statusCode: 422)
        }
        if ProcessInfo.processInfo.arguments.contains("--demo-creation-save-uncertain"),
           demoCreationAttempts.insert(key).inserted {
            throw APIError(message: "The connection was interrupted.", isAmbiguousMutation: true)
        }
    }
    #endif

    func addComment(_ body: String, cardID: String, projectID: String, in workspace: Workspace, key: String,
                    onConfirmed: (() -> Void)? = nil) async throws {
        try requireWritableProject(projectID, in: workspace)
        if isDemo {
            guard var project = loadedProjects[projectID], let index = project.cards.firstIndex(where: { $0.id == cardID }) else { throw AppFailure.missingProject }
            project.cards[index].comments.append(Comment(id: UUID().uuidString, body: body, author: "Demo owner", createdAt: ServerTimestamp.string()))
            project.cards[index].version += 1
            project.revision += 1
            record("Commented on \(project.cards[index].title).", cardID: cardID, project: &project)
            loadedProjects[projectID] = project
        } else {
            let result = try await api.addComment(body: body, cardID: cardID, projectID: projectID, in: workspace, idempotencyKey: key)
            recordConfirmedMutation(projectID: projectID, workspaceID: workspace.id)
            if var project = loadedProjects[projectID], let index = project.cards.firstIndex(where: { $0.id == cardID }) {
                if !project.cards[index].comments.contains(where: { $0.id == result.comment.id }) {
                    project.cards[index].comments.append(result.comment)
                }
                // A compact comment response cannot establish the latest Card field values.
                // Advance its version only if this comment is the sole change since our read.
                if result.card.version == project.cards[index].version + 1 {
                    project.cards[index].version = result.card.version
                }
                loadedProjects[projectID] = project
            }
            onConfirmed?()
            await refreshAfterConfirmedMutation(projectID: projectID, in: workspace, confirmation: "Comment sent.")
        }
        if isDemo { onConfirmed?() }
    }

    func moveCard(_ card: Card, to columnID: String, projectID: String, in workspace: Workspace) async throws -> Card {
        try requireWritableProject(projectID, in: workspace)
        if isDemo {
            guard var project = loadedProjects[projectID], let index = project.cards.firstIndex(where: { $0.id == card.id }),
                  project.cards[index].version == card.version, project.columns.contains(where: { $0.id == columnID }) else { throw AppFailure.conflict }
            project.cards[index].columnId = columnID
            project.cards[index].position = (project.cards.filter { $0.columnId == columnID && $0.id != card.id }.map(\.position).max() ?? -1) + 1
            project.cards[index].version += 1
            project.revision += 1
            record("Moved \(card.title).", cardID: card.id, project: &project)
            loadedProjects[projectID] = project
            updateSummary(project, workspaceID: workspace.id)
            return project.cards[index]
        }
        let moved = try await api.moveCard(card, to: columnID, projectID: projectID, in: workspace)
        cacheConfirmedCard(moved, projectID: projectID, workspaceID: workspace.id)
        await refreshAfterConfirmedMutation(projectID: projectID, in: workspace, confirmation: "Card moved.")
        return moved
    }

    func archive(_ card: Card, projectID: String, in workspace: Workspace, archived: Bool) async throws {
        try requireWritableProject(projectID, in: workspace)
        if isDemo {
            guard var project = loadedProjects[projectID], let index = project.cards.firstIndex(where: { $0.id == card.id }), project.cards[index].version == card.version else { throw AppFailure.conflict }
            project.cards[index].archivedAt = archived ? ServerTimestamp.string() : nil
            project.cards[index].version += 1
            project.revision += 1
            record(archived ? "Archived \(card.title)." : "Restored \(card.title).", cardID: card.id, project: &project)
            loadedProjects[projectID] = project
            updateSummary(project, workspaceID: workspace.id)
        } else {
            let saved = try await api.archiveCard(card: card, archived: archived, projectID: projectID, in: workspace)
            cacheConfirmedCard(saved, projectID: projectID, workspaceID: workspace.id)
            await refreshAfterConfirmedMutation(projectID: projectID, in: workspace,
                confirmation: archived ? "Card archived." : "Card restored.")
        }
    }

    func handle(_ error: Error) {
        guard !(error is CancellationError) else { return }
        if let generation = (error as? APIError)?.sessionGeneration, generation != api.sessionGeneration { return }
        if let error = error as? APIError, error.isUnauthorized {
            workspaceCreationID = nil
            creatingWorkspace = false
            uncertainWorkspaceCreationBaselines = [:]
            signedIn = false
            workspaces = []
            projectLists = [:]
            loadedProjects = [:]
        }
        errorMessage = error.localizedDescription
    }

    func isProjectReadOnly(projectID: String, in workspace: Workspace) -> Bool {
        loadedProjects[projectID]?.archivedAt != nil
            || projectLists[workspace.id]?.contains(where: { $0.id == projectID && $0.archivedAt != nil }) == true
    }

    private func requireWritableProject(_ projectID: String, in workspace: Workspace) throws {
        guard !isProjectReadOnly(projectID: projectID, in: workspace) else { throw AppFailure.readOnlyProject }
    }

    func isConflict(_ error: Error) -> Bool { (error as? APIError)?.isConflict == true || (error as? AppFailure) == .conflict }

    private func requireWorkspaceCreationSession(_ creation: UUID, session: UUID) throws {
        guard workspaceCreationID == creation, session == api.sessionGeneration,
              signedIn, !signOutPending, !endingSession else { throw CancellationError() }
    }

    private func refreshAfterConfirmedMutation(projectID: String, in workspace: Workspace, confirmation: String) async {
        do {
            try await loadProject(id: projectID, in: workspace)
            if let project = loadedProjects[projectID] { updateSummary(project, workspaceID: workspace.id) }
            try await loadProjects(in: workspace)
        } catch {
            guard !(error is CancellationError) else { return }
            if let generation = (error as? APIError)?.sessionGeneration, generation != api.sessionGeneration { return }
            if (error as? APIError)?.isUnauthorized == true { handle(error) }
            errorMessage = "\(confirmation) The latest state could not be refreshed. Refresh to continue. \(error.localizedDescription)"
        }
    }

    private func cacheConfirmedCard(_ card: Card, projectID: String, workspaceID: String) {
        recordConfirmedMutation(projectID: projectID, workspaceID: workspaceID)
        guard var project = loadedProjects[projectID] else { return }
        if let current = project.cards.first(where: { $0.id == card.id }), current.version > card.version { return }
        project.cards.removeAll { $0.id == card.id }
        project.cards.append(card)
        loadedProjects[projectID] = project
        updateSummary(project, workspaceID: workspaceID)
    }

    private func recordConfirmedMutation(projectID: String, workspaceID: String) {
        projectMutationGenerations[projectID] = UUID()
        workspaceMutationGenerations[workspaceID] = UUID()
    }

    private func projectSummary(_ project: Project) -> ProjectSummary {
        ProjectSummary(id: project.id, name: project.name, description: project.description,
            revision: project.revision, archivedAt: project.archivedAt, createdAt: project.createdAt,
            updatedAt: project.updatedAt, cardCount: project.cards.filter { $0.archivedAt == nil }.count)
    }

    private func updateSummary(_ project: Project, workspaceID: String) {
        let summary = projectSummary(project)
        var summaries = projectLists[workspaceID] ?? []
        if let cached = summaries.first(where: { $0.id == project.id }), cached.revision > summary.revision { return }
        summaries.removeAll { $0.id == project.id }
        summaries.append(summary)
        projectLists[workspaceID] = summaries
    }

    private func record(_ summary: String, cardID: String, project: inout Project) {
        project.activity.append(Activity(id: UUID().uuidString, action: "card.updated", actor: ActivityActor(channel: "native", label: "Demo owner"), summary: summary, projectId: project.id, cardId: cardID, createdAt: ServerTimestamp.string()))
        project.updatedAt = ServerTimestamp.string()
    }
}

enum AppFailure: LocalizedError, Equatable {
    case missingProject, conflict, readOnlyProject
    var errorDescription: String? {
        switch self {
        case .missingProject: "The Project is unavailable. Refresh and try again."
        case .readOnlyProject: "This Project is archived and read-only. Your local drafts are retained."
        case .conflict: "This Card changed while you were editing. Review the latest saved values before saving."
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
