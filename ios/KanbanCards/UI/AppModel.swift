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
    private var projectMutationGenerations: [String: UUID] = [:]
    private var workspaceMutationGenerations: [String: UUID] = [:]
    private var workspaceRefreshes: [String: UUID] = [:]
    private var workspaceLoadID: UUID?
    private(set) var loadingWorkspaces = false
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
            workspaces = [Workspace(id: "demo-workspace", slug: "demo", name: "Demo Workspace", url: URL(string: "https://demo.invalid")!)]
            let timestamp = ServerTimestamp.string()
            let card = Card(id: "demo-card", title: "Review the iPhone app", body: "Check the native Card workflow.", nextActor: .human, nextAction: "Review the changes", priority: .high, blockedReason: "", columnId: "next", position: 0, version: 1, createdAt: timestamp, updatedAt: timestamp, comments: [])
            let project = Project(id: "demo-project", name: "iPhone app", description: "Isolated sample data for simulator verification.", columns: [Column(id: "next", name: "Next", position: 0), Column(id: "doing", name: "Doing", position: 1), Column(id: "done", name: "Done", position: 2)], cards: [card], activity: [], revision: 1, createdAt: timestamp, updatedAt: timestamp)
            loadedProjects[project.id] = project
            updateSummary(project, workspaceID: "demo-workspace")
        }
    }

    var ownerID: String { isDemo ? "demo-owner" : api.credential?.owner.id ?? "signed-out" }

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
        let incoming = try await api.projects(in: workspace)
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
        let project: Project
        if isDemo {
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

    func saveCard(_ proposed: CardDraft, projectID: String, in workspace: Workspace, key: String) async throws -> Card {
        let draft = proposed
        let card: Card
        if isDemo {
            guard var project = loadedProjects[projectID] else { throw AppFailure.missingProject }
            if let id = draft.id, let current = project.cards.first(where: { $0.id == id }), current.version != draft.version { throw AppFailure.conflict }
            let timestamp = ServerTimestamp.string()
            let previous = project.cards.first { $0.id == draft.id }
            card = Card(id: draft.id ?? UUID().uuidString, externalKey: draft.externalKey, title: draft.title, body: draft.body, nextActor: draft.nextActor, nextAction: draft.nextAction, priority: draft.priority, blockedReason: draft.blockedReason, columnId: draft.columnId, position: draft.position, version: (previous?.version ?? 0) + 1, archivedAt: draft.archivedAt, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, comments: previous?.comments ?? [])
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
            // Failure to refresh does not undo the confirmed save or require resubmission.
            await refreshAfterConfirmedMutation(projectID: projectID, in: workspace, confirmation: "Card saved.")
        }
        return card
    }

    func addComment(_ body: String, cardID: String, projectID: String, in workspace: Workspace, key: String) async throws {
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
            await refreshAfterConfirmedMutation(projectID: projectID, in: workspace, confirmation: "Comment sent.")
        }
    }

    func archive(_ card: Card, projectID: String, in workspace: Workspace, archived: Bool) async throws {
        if isDemo {
            var draft = CardDraft(card: card)
            draft.archivedAt = archived ? ServerTimestamp.string() : nil
            _ = try await saveCard(draft, projectID: projectID, in: workspace, key: UUID().uuidString)
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
            signedIn = false
            workspaces = []
            projectLists = [:]
            loadedProjects = [:]
        }
        errorMessage = error.localizedDescription
    }

    func isConflict(_ error: Error) -> Bool { (error as? APIError)?.isConflict == true || (error as? AppFailure) == .conflict }

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
    case missingProject, conflict
    var errorDescription: String? {
        switch self {
        case .missingProject: "The Project is unavailable. Refresh and try again."
        case .conflict: "This Card changed while you were editing. Review the latest saved values before saving."
        }
    }
}
