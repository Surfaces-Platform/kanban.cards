import CryptoKit
import Foundation
import XCTest
@testable import KanbanCards

/// Production model/session boundaries with synthetic identities and fully intercepted requests.
/// Run native tests only in the task's disposable VM.
@MainActor
final class ArchivedProjectTests: XCTestCase {
    private var model: AppModel!
    private var directory: URL!
    private var defaults: UserDefaults!
    private var suite: String!
    private let ownerID = "synthetic-archived-owner"
    private let rootURL = URL(string: "https://rehearsal.kanban.test")!
    private let workspace = Workspace(id: "workspace-a", slug: "fixture", name: "Synthetic Workspace",
        url: URL(string: "https://fixture.rehearsal.kanban.test")!)
    private let timestamp = "2026-10-01T12:00:00.000Z"
    private let resource = "card:project-a:card-a"

    override func setUp() async throws {
        ArchivedProjectTransport.state.reset()
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        suite = "cards.kanban.ArchivedProjects.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        model = try await authenticatedModel()
    }

    override func tearDown() async throws {
        model = nil
        defaults.removePersistentDomain(forName: suite)
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
    }

    func testProjectListIncludesArchivedAndRetainsBothKindsWithoutRevisionRegression() async throws {
        let archived = project(archived: true, revision: 8)
        var active = project(archived: false, revision: 3); active.id = "project-active"
        try enqueueProjects([summary(active), summary(archived)])
        try await model.loadProjects(in: workspace)
        XCTAssertEqual(model.projectLists[workspace.id]?.count, 2)
        XCTAssertNil(model.projectLists[workspace.id]?.first(where: { $0.id == active.id })?.archivedAt)
        XCTAssertNotNil(model.projectLists[workspace.id]?.first(where: { $0.id == archived.id })?.archivedAt)
        let request = try XCTUnwrap(ArchivedProjectTransport.state.requests.last)
        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems,
            [URLQueryItem(name: "includeArchived", value: "true")])
        var stale = summary(archived); stale.revision = 7; stale.archivedAt = nil
        try enqueueProjects([summary(active), stale])
        try await model.loadProjects(in: workspace)
        XCTAssertEqual(model.projectLists[workspace.id]?.first(where: { $0.id == archived.id })?.revision, 8)
        XCTAssertNotNil(model.projectLists[workspace.id]?.first(where: { $0.id == archived.id })?.archivedAt)
    }

    func testLoadedArchivedProjectWinsOverOlderUnarchivedSummary() async throws {
        try await load(project(archived: true, revision: 9))
        try enqueueProjects([summary(project(archived: false, revision: 8))])
        try await model.loadProjects(in: workspace)
        XCTAssertEqual(model.projectLists[workspace.id]?.first?.revision, 9)
        XCTAssertTrue(model.isProjectReadOnly(projectID: "project-a", in: workspace))
        XCTAssertNotNil(model.projectLists[workspace.id]?.first?.archivedAt)
    }

    func testEveryRawModelMutationIsBlockedByLoadedArchivedParentBeforeAnyRequest() async throws {
        try await load(project(archived: true))
        let before = ArchivedProjectTransport.state.requests.count
        await assertAllMutationsBlocked()
        XCTAssertEqual(ArchivedProjectTransport.state.requests.count, before)
    }

    func testEveryRawModelMutationIsBlockedByArchivedSummaryBeforeProjectIsLoaded() async throws {
        try enqueueProjects([summary(project(archived: true))])
        try await model.loadProjects(in: workspace)
        XCTAssertTrue(model.loadedProjects.isEmpty)
        let before = ArchivedProjectTransport.state.requests.count
        await assertAllMutationsBlocked()
        XCTAssertEqual(ArchivedProjectTransport.state.requests.count, before)
    }

    func testArchivedLegacyConfirmationIsLocalPreservesExactOriginalAndSurvivesFreshStore() async throws {
        let archived = project(archived: true)
        try await load(archived)
        let raw = Data(#"{"draft":{"id":"card-a","version":7,"title":"Retained local title","body":"  Retained source\n\n","nextActor":"human","nextAction":"Review","priority":"Medium","blockedReason":"","columnId":"next","position":0},"key":"synthetic-legacy-operation"}"#.utf8)
        let legacyURL = fileURL(resource)
        try FileManager.default.createDirectory(at: legacyURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try raw.write(to: legacyURL)
        let session = model.cardEditingSession(workspace: workspace, projectID: archived.id,
            card: card(), readOnly: true)
        session.load()
        XCTAssertTrue(session.legacyNeedsScope)
        XCTAssertTrue(session.projectReadOnly)
        let before = ArchivedProjectTransport.state.requests.count
        await session.save(); await session.revert(); await session.move(to: "done")
        XCTAssertEqual(ArchivedProjectTransport.state.requests.count, before)
        XCTAssertEqual(try Data(contentsOf: legacyURL), raw)
        session.recoverLegacy()
        XCTAssertFalse(session.legacyNeedsScope)
        XCTAssertTrue(session.readOnly)
        XCTAssertEqual(session.pending.draft.title, "Retained local title")
        XCTAssertEqual(session.pending.draft.body, "  Retained source\n\n")
        XCTAssertEqual(session.pending.key, "synthetic-legacy-operation")
        session.persist()
        await session.save(); await session.revert()
        XCTAssertEqual(ArchivedProjectTransport.state.requests.count, before)
        XCTAssertEqual(try Data(contentsOf: legacyURL), raw)
        let binding = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf:
            fileURL("legacy-scope:v2:" + resource))) as? [String: String])
        XCTAssertEqual(binding["workspaceID"], workspace.id)
        XCTAssertEqual(binding["origin"], workspace.url.absoluteString)
        XCTAssertEqual(binding["projectID"], archived.id)
        XCTAssertEqual(binding["resourceKey"], resource)
        let fresh = try await authenticatedModel()
        try enqueueProject(archived); try await fresh.loadProject(id: archived.id, in: workspace)
        let resumed = fresh.cardEditingSession(workspace: workspace, projectID: archived.id,
            card: card(), readOnly: true)
        resumed.load()
        XCTAssertFalse(resumed.legacyNeedsScope)
        XCTAssertEqual(resumed.pending.draft.title, session.pending.draft.title)
        XCTAssertEqual(resumed.pending.draft.body, session.pending.draft.body)
        XCTAssertEqual(resumed.pending.key, session.pending.key)
        XCTAssertEqual(try Data(contentsOf: legacyURL), raw)
        let freshStore = DraftStore(directory: directory)
        XCTAssertNil(try freshStore.loadScoped(ownerID: "another-owner", workspace: workspace,
            projectID: archived.id, resourceKey: resource, legacyResourceKey: resource, as: PendingCardDraft.self))
        var otherOrigin = workspace; otherOrigin.url = URL(string: "https://other.rehearsal.kanban.test")!
        XCTAssertNil(try freshStore.loadScoped(ownerID: ownerID, workspace: otherOrigin,
            projectID: archived.id, resourceKey: resource, legacyResourceKey: resource, as: PendingCardDraft.self))
    }

    func testArchivedBrowseNeverReconcilesPendingPatchMoveOrCleansConfirmedReceiptFromSaveOrRevert() async throws {
        try await load(project(archived: true))
        let base = card()
        var patch = PendingCardDraft(draft: CardDraft(card: base), key: "retained-patch", baseline: base)
        patch.draft.title = "Unconfirmed local title"; patch.submitted = patch.draft; patch.submissionBase = base
        var move = PendingCardDraft(draft: CardDraft(card: base), key: "retained-move", baseline: base)
        move.move = PendingCardMove(columnId: "done", position: 2, version: base.version)
        var confirmed = PendingCardDraft(draft: CardDraft(card: base), key: "retained-receipt", baseline: base)
        confirmed.confirmed = ConfirmedDraftReceipt(confirmedAt: timestamp)
        for retained in [patch, move, confirmed] {
            try model.drafts.saveScoped(retained, ownerID: ownerID, workspace: workspace,
                projectID: "project-a", resourceKey: resource, legacyResourceKey: resource)
            let session = CardEditingSession(model: model, workspace: workspace, projectID: "project-a",
                card: base, readOnly: true)
            session.load()
            let scoped = model.drafts.scopedKey(workspace: workspace, projectID: "project-a", resourceKey: resource)
            let beforeBytes = try Data(contentsOf: fileURL(scoped))
            let beforeRequests = ArchivedProjectTransport.state.requests.count
            await session.save(); await session.revert(); await session.move(to: "done")
            XCTAssertEqual(ArchivedProjectTransport.state.requests.count, beforeRequests)
            XCTAssertEqual(session.pending.submitted, retained.submitted)
            XCTAssertEqual(session.pending.move, retained.move)
            XCTAssertEqual(session.pending.confirmed, retained.confirmed)
            XCTAssertEqual(try Data(contentsOf: fileURL(scoped)), beforeBytes)
        }
    }

    func testBrowseAuthorityStaysReadOnlyAfterRemoteUnarchiveAndUsesSeparateCachedSession() async throws {
        try await load(project(archived: true, revision: 8))
        let browse = model.cardEditingSession(workspace: workspace, projectID: "project-a", card: card(), readOnly: true)
        let edit = model.cardEditingSession(workspace: workspace, projectID: "project-a", card: card())
        XCTAssertFalse(browse === edit)
        XCTAssertTrue(browse.browsingReadOnly)
        browse.load()
        try await load(project(archived: false, revision: 9))
        XCTAssertFalse(model.isProjectReadOnly(projectID: "project-a", in: workspace))
        XCTAssertTrue(browse.projectReadOnly)
        XCTAssertTrue(browse.readOnly)
        XCTAssertFalse(edit.projectReadOnly)
        let before = ArchivedProjectTransport.state.requests.count
        await browse.save(); await browse.revert(); await browse.move(to: "done")
        XCTAssertEqual(ArchivedProjectTransport.state.requests.count, before)
        XCTAssertTrue(model.cardEditingSession(workspace: workspace, projectID: "project-a", card: card(), readOnly: true) === browse)
    }

    func testStaleBrowseLoadRefreshAndCloseCannotOverwriteNewerEditableDraftAfterRestore() async throws {
        try await load(project(archived: true))
        var retained = PendingCardDraft(draft: CardDraft(card: card()), key: "shared-local-operation", baseline: card())
        retained.draft.title = "Earlier local draft"
        try model.drafts.saveScoped(retained, ownerID: ownerID, workspace: workspace,
            projectID: "project-a", resourceKey: resource, legacyResourceKey: resource)
        let scoped = model.drafts.scopedKey(workspace: workspace, projectID: "project-a", resourceKey: resource)
        let originalBytes = try Data(contentsOf: fileURL(scoped))
        let browse = model.cardEditingSession(workspace: workspace, projectID: "project-a", card: card(), readOnly: true)
        browse.load()
        XCTAssertEqual(try Data(contentsOf: fileURL(scoped)), originalBytes,
            "Browse load must not normalize or rewrite the retained record.")
        try await load(project(archived: false, revision: 9))
        let edit = model.cardEditingSession(workspace: workspace, projectID: "project-a", card: card())
        edit.load(); edit.pending.draft.title = "Newer editable draft"; edit.edited()
        let newerBytes = try Data(contentsOf: fileURL(scoped))
        XCTAssertNotEqual(newerBytes, originalBytes)
        try enqueueProject(project(archived: false, revision: 9))
        await browse.refresh()
        XCTAssertEqual(browse.pending.draft.title, "Earlier local draft")
        browse.persist() // The same persistence call used when the browse Form closes.
        XCTAssertEqual(try Data(contentsOf: fileURL(scoped)), newerBytes)
        let recovered = try DraftStore(directory: directory).loadScoped(ownerID: ownerID,
            workspace: workspace, projectID: "project-a", resourceKey: resource,
            legacyResourceKey: resource, as: PendingCardDraft.self)
        XCTAssertEqual(recovered?.draft.title, "Newer editable draft")
        XCTAssertEqual(recovered?.key, retained.key)
    }

    func testStaleLegacyBrowseConfirmationAdoptsNewerScopedDraftWithoutOverwritingIt() async throws {
        try await load(project(archived: true))
        var retained = PendingCardDraft(draft: CardDraft(card: card()), key: "legacy-shared-operation")
        retained.draft.title = "Older legacy draft"
        try model.drafts.save(retained, ownerID: ownerID, resourceKey: resource)
        let legacyBytes = try Data(contentsOf: fileURL(resource))
        let browse = model.cardEditingSession(workspace: workspace, projectID: "project-a", card: card(), readOnly: true)
        browse.load()
        XCTAssertTrue(browse.legacyNeedsScope)
        try await load(project(archived: false, revision: 9))
        let edit = model.cardEditingSession(workspace: workspace, projectID: "project-a", card: card())
        edit.load(); XCTAssertTrue(edit.legacyNeedsScope)
        edit.recoverLegacy()
        edit.pending.draft.title = "Newer scoped editor draft"
        edit.pending.draft.body = "  Newer exact source\n\n"
        edit.edited()
        let scoped = model.drafts.scopedKey(workspace: workspace, projectID: "project-a", resourceKey: resource)
        let newerBytes = try Data(contentsOf: fileURL(scoped))
        let before = ArchivedProjectTransport.state.requests.count
        browse.recoverLegacy()
        XCTAssertFalse(browse.legacyNeedsScope)
        XCTAssertTrue(browse.readOnly)
        XCTAssertEqual(browse.pending.draft.title, edit.pending.draft.title)
        XCTAssertEqual(browse.pending.draft.body, edit.pending.draft.body)
        XCTAssertEqual(browse.pending.key, edit.pending.key)
        browse.persist()
        XCTAssertEqual(try Data(contentsOf: fileURL(scoped)), newerBytes)
        XCTAssertEqual(try Data(contentsOf: fileURL(resource)), legacyBytes)
        XCTAssertEqual(ArchivedProjectTransport.state.requests.count, before)
    }

    func testReadOnlyRefreshCanReadLatestWhileRetainingFrozenOperation() async throws {
        try await load(project(archived: true))
        var retained = PendingCardDraft(draft: CardDraft(card: card()), key: "frozen-read-only", baseline: card())
        retained.draft.title = "Retained source"
        retained.submitted = retained.draft; retained.submissionBase = card()
        try model.drafts.saveScoped(retained, ownerID: ownerID, workspace: workspace,
            projectID: "project-a", resourceKey: resource, legacyResourceKey: resource)
        let session = model.cardEditingSession(workspace: workspace, projectID: "project-a", card: card(), readOnly: true)
        session.load()
        var newer = project(archived: true, revision: 9)
        newer.cards[0].version = 8
        newer.cards[0].comments = [Comment(id: "comment-a", body: "Read-only saved Comment", author: "Synthetic", createdAt: timestamp)]
        try enqueueProject(newer)
        let before = ArchivedProjectTransport.state.requests.count
        await session.refresh()
        let requests = Array(ArchivedProjectTransport.state.requests.dropFirst(before))
        XCTAssertEqual(requests.count, 1)
        XCTAssertTrue(requests.allSatisfy { $0.method == "GET" })
        XCTAssertEqual(session.latest.comments.count, 1)
        XCTAssertEqual(session.pending.submitted?.title, "Retained source")
        XCTAssertTrue(session.readOnly)
    }

    func testUnauthorizedProjectReadClearsActiveAndArchivedPrivateCaches() async throws {
        let archived = project(archived: true)
        var active = project(archived: false); active.id = "project-active"
        try enqueueProjects([summary(active), summary(archived)])
        try await model.loadProjects(in: workspace)
        try await load(archived)
        let session = model.cardEditingSession(workspace: workspace, projectID: archived.id, card: card(), readOnly: true)
        XCTAssertFalse(model.projectLists.isEmpty)
        XCTAssertFalse(model.loadedProjects.isEmpty)
        ArchivedProjectTransport.state.enqueue(status: 401, json: #"{"error":"Synthetic session expired"}"#)
        do { try await model.loadProjects(in: workspace); XCTFail("Expected synthetic authorization failure") }
        catch { model.handle(error) }
        XCTAssertFalse(model.signedIn)
        XCTAssertTrue(model.workspaces.isEmpty)
        XCTAssertTrue(model.projectLists.isEmpty)
        XCTAssertTrue(model.loadedProjects.isEmpty)
        XCTAssertFalse(session.authorized)
    }

    func testLatestArchivedRefreshSuccessIgnoresOlderCancellationAndServerFailure() async {
        let oldErrors: [Error] = [CancellationError(), APIError(message: "Older synthetic failure", statusCode: 500)]
        for oldError in oldErrors {
            let state = ArchivedProjectsRefreshState()
            let old = ArchivedProjectsRefreshGate()
            let latest = ArchivedProjectsRefreshGate()
            var reported: [Error] = []
            let oldTask = Task {
                await state.refresh(load: { try await old.load() }, handleError: { reported.append($0) })
            }
            await old.waitUntilStarted()
            let latestTask = Task {
                await state.refresh(load: { try await latest.load() }, handleError: { reported.append($0) })
            }
            await latest.waitUntilStarted()
            latest.finish()
            await latestTask.value
            XCTAssertFalse(state.loading)
            XCTAssertFalse(state.loadFailed)
            old.finish(error: oldError)
            await oldTask.value
            XCTAssertFalse(state.loading)
            XCTAssertFalse(state.loadFailed)
            XCTAssertTrue(reported.isEmpty)
        }
    }

    func testOlderArchivedRefreshCompletionCannotEndLatestPendingLoad() async {
        let oldErrors: [Error?] = [nil, CancellationError(), APIError(message: "Older synthetic failure", statusCode: 500)]
        for oldError in oldErrors {
            let state = ArchivedProjectsRefreshState()
            let old = ArchivedProjectsRefreshGate()
            let latest = ArchivedProjectsRefreshGate()
            var reported: [Error] = []
            let oldTask = Task {
                await state.refresh(load: { try await old.load() }, handleError: { reported.append($0) })
            }
            await old.waitUntilStarted()
            let latestTask = Task {
                await state.refresh(load: { try await latest.load() }, handleError: { reported.append($0) })
            }
            await latest.waitUntilStarted()
            old.finish(error: oldError)
            await oldTask.value
            XCTAssertTrue(state.loading, "Only the latest request can finish its loading state.")
            XCTAssertFalse(state.loadFailed)
            XCTAssertTrue(reported.isEmpty)
            latest.finish()
            await latestTask.value
            XCTAssertFalse(state.loading)
            XCTAssertFalse(state.loadFailed)
        }
    }

    func testCurrentArchivedRefreshFailureCanRetryWithoutKeepingFailedState() async {
        let state = ArchivedProjectsRefreshState()
        var reported: [Error] = []
        await state.refresh(load: { throw APIError(message: "Current synthetic failure", statusCode: 500) },
            handleError: { reported.append($0) })
        XCTAssertFalse(state.loading)
        XCTAssertTrue(state.loadFailed)
        XCTAssertEqual(reported.count, 1)
        let retry = ArchivedProjectsRefreshGate()
        let retryTask = Task {
            await state.refresh(load: { try await retry.load() }, handleError: { reported.append($0) })
        }
        await retry.waitUntilStarted()
        XCTAssertTrue(state.loading)
        XCTAssertFalse(state.loadFailed)
        retry.finish()
        await retryTask.value
        XCTAssertFalse(state.loading)
        XCTAssertFalse(state.loadFailed)
        XCTAssertEqual(reported.count, 1)
    }

    func testCurrentArchivedRefreshCancellationDoesNotPresentFailure() async {
        let state = ArchivedProjectsRefreshState()
        var reported: [Error] = []
        await state.refresh(load: { throw CancellationError() }, handleError: { reported.append($0) })
        XCTAssertFalse(state.loading)
        XCTAssertFalse(state.loadFailed)
        XCTAssertTrue(reported.isEmpty)
    }

    func testSupersededArchivedRefresh401StillClearsCurrentOwnerCaches() async throws {
        try await load(project(archived: true))
        let state = ArchivedProjectsRefreshState()
        let old = ArchivedProjectsRefreshGate()
        let generation = model.api.sessionGeneration
        var reported = 0
        let oldTask = Task {
            await state.refresh(load: { try await old.load() }, handleError: {
                reported += 1; self.model.handle($0)
            })
        }
        await old.waitUntilStarted()
        await state.refresh(load: {}, handleError: { self.model.handle($0) })
        XCTAssertTrue(model.signedIn)
        old.finish(error: APIError(message: "Synthetic current owner expired", statusCode: 401,
            sessionGeneration: generation))
        await oldTask.value
        XCTAssertEqual(reported, 1)
        XCTAssertFalse(model.signedIn)
        XCTAssertTrue(model.workspaces.isEmpty)
        XCTAssertTrue(model.projectLists.isEmpty)
        XCTAssertTrue(model.loadedProjects.isEmpty)
        XCTAssertFalse(state.loading)
        XCTAssertFalse(state.loadFailed, "A superseded request cannot replace successful list state.")
    }

    func testSupersededArchivedRefresh401FromDifferentGenerationCannotClearCurrentOwner() async throws {
        try await load(project(archived: true))
        let state = ArchivedProjectsRefreshState()
        let old = ArchivedProjectsRefreshGate()
        let oldGeneration = UUID()
        XCTAssertNotEqual(oldGeneration, model.api.sessionGeneration)
        var reported = 0
        let oldTask = Task {
            await state.refresh(load: { try await old.load() }, handleError: {
                reported += 1; self.model.handle($0)
            })
        }
        await old.waitUntilStarted()
        await state.refresh(load: {}, handleError: { self.model.handle($0) })
        old.finish(error: APIError(message: "Synthetic replaced owner expired", statusCode: 401,
            sessionGeneration: oldGeneration))
        await oldTask.value
        XCTAssertEqual(reported, 1, "The coordinator forwards authorization errors to the model's generation guard.")
        XCTAssertTrue(model.signedIn)
        XCTAssertFalse(model.workspaces.isEmpty)
        XCTAssertFalse(model.projectLists.isEmpty)
        XCTAssertFalse(model.loadedProjects.isEmpty)
        XCTAssertNil(model.errorMessage)
        XCTAssertFalse(state.loading)
        XCTAssertFalse(state.loadFailed)
    }

    private func assertAllMutationsBlocked() async {
        let saved = project(archived: true)
        await assertReadOnly { _ = try await self.model.saveProject(ProjectDraft(project: saved), in: self.workspace, key: "project-intent") }
        await assertReadOnly { _ = try await self.model.saveCard(CardDraft(card: self.card()), projectID: saved.id, in: self.workspace, key: "edit-intent") }
        await assertReadOnly { _ = try await self.model.saveCard(CardDraft(columnId: "next"), projectID: saved.id, in: self.workspace, key: "create-intent") }
        await assertReadOnly { try await self.model.addComment("Synthetic Comment", cardID: "card-a", projectID: saved.id, in: self.workspace, key: "comment-intent") }
        await assertReadOnly { _ = try await self.model.moveCard(self.card(), to: "done", projectID: saved.id, in: self.workspace) }
        await assertReadOnly { try await self.model.archive(self.card(), projectID: saved.id, in: self.workspace, archived: true) }
        await assertReadOnly { try await self.model.archive(self.card(), projectID: saved.id, in: self.workspace, archived: false) }
    }

    private func assertReadOnly(_ operation: @MainActor () async throws -> Void,
                                file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("An archived parent must reject the mutation", file: file, line: line) }
        catch { XCTAssertEqual(error as? AppFailure, .readOnlyProject, file: file, line: line) }
    }

    private func authenticatedModel() async throws -> AppModel {
        let credentials = ArchivedProjectCredentialStore()
        credentials.value = NativeSessionCredential(token: "kcn_synthetic_archived_only",
            expiresAt: ServerTimestamp.string(from: .now.addingTimeInterval(3600)), rootUrl: rootURL,
            owner: NativeOwner(id: ownerID, displayName: "Synthetic owner", email: ""))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ArchivedProjectTransport.self]
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil; configuration.urlCache = nil
        let api = KanbanAPIClient(rootURL: rootURL, authURL: URL(string: "https://auth.rehearsal.kanban.test")!,
            credentialStore: credentials, session: URLSession(configuration: configuration))
        let result = AppModel(api: api, drafts: DraftStore(directory: directory), defaults: defaults, demo: false)
        struct Session: Encodable { let authenticated = true; let context = "root"; let authenticationMethod = "native"; let rootUrl: URL }
        struct Workspaces: Encodable { let workspaces: [Workspace] }
        try ArchivedProjectTransport.state.enqueue(Session(rootUrl: rootURL))
        try ArchivedProjectTransport.state.enqueue(Workspaces(workspaces: [workspace]))
        await result.restore()
        XCTAssertTrue(result.signedIn)
        return result
    }
    private func card() -> Card {
        Card(id: "card-a", title: "Saved synthetic title", body: "Saved source", nextActor: .human,
            nextAction: "Review", priority: .medium, blockedReason: "", columnId: "next", position: 0,
            version: 7, createdAt: timestamp, updatedAt: timestamp, comments: [])
    }
    private func project(archived: Bool, revision: Int = 8) -> Project {
        Project(id: "project-a", name: "Synthetic Project", description: "Synthetic Project description",
            columns: [Column(id: "next", name: "Next", position: 0), Column(id: "done", name: "Done", position: 1)],
            cards: [card()], activity: [], revision: revision, archivedAt: archived ? timestamp : nil,
            createdAt: timestamp, updatedAt: timestamp)
    }
    private func summary(_ project: Project) -> ProjectSummary {
        ProjectSummary(id: project.id, name: project.name, description: project.description,
            revision: project.revision, archivedAt: project.archivedAt, createdAt: project.createdAt,
            updatedAt: project.updatedAt, cardCount: project.cards.count)
    }
    private func load(_ project: Project) async throws {
        try enqueueProject(project); try await model.loadProject(id: project.id, in: workspace)
    }
    private func enqueueProject(_ project: Project) throws {
        struct Reply: Encodable { let project: Project }
        try ArchivedProjectTransport.state.enqueue(Reply(project: project))
    }
    private func enqueueProjects(_ projects: [ProjectSummary]) throws {
        struct Reply: Encodable { let projects: [ProjectSummary] }
        try ArchivedProjectTransport.state.enqueue(Reply(projects: projects))
    }
    private func fileURL(_ resource: String) -> URL {
        func hash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
        return directory.appendingPathComponent(hash(ownerID)).appendingPathComponent(hash(resource) + ".json")
    }
}

/// Explicit continuations establish request ordering without sleeps or network timing.
@MainActor
private final class ArchivedProjectsRefreshGate {
    private var continuation: CheckedContinuation<Void, Error>?
    private var started = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func load() async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            started = true
            let ready = waiters
            waiters = []
            for waiter in ready { waiter.resume() }
        }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func finish(error: Error? = nil) {
        guard let continuation else { preconditionFailure("Synthetic refresh must start before completion") }
        self.continuation = nil
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume() }
    }
}

@MainActor
private final class ArchivedProjectCredentialStore: SessionCredentialStore {
    var value: NativeSessionCredential?
    func load() throws -> NativeSessionCredential? { value }
    func save(_ credential: NativeSessionCredential) throws { value = credential }
    func remove() throws { value = nil }
}

private final class ArchivedProjectTransportState: @unchecked Sendable {
    struct Request { let method: String; let url: URL }
    struct Reply { let status: Int; let data: Data }
    private let lock = NSLock()
    private var replies: [Reply] = []
    private var captured: [Request] = []
    var requests: [Request] { lock.withLock { captured } }
    func reset() { lock.withLock { replies = []; captured = [] } }
    func enqueue(status: Int = 200, json: String) { lock.withLock { replies.append(Reply(status: status, data: Data(json.utf8))) } }
    func enqueue<T: Encodable>(_ value: T) throws {
        enqueue(json: String(decoding: try JSONEncoder().encode(value), as: UTF8.self))
    }
    func consume(_ request: URLRequest) -> Reply {
        lock.withLock {
            guard let url = request.url else { return Reply(status: 500, data: Data()) }
            captured.append(Request(method: request.httpMethod ?? "GET", url: url))
            guard url.scheme == "https", url.host == "rehearsal.kanban.test"
                    || url.host?.hasSuffix(".rehearsal.kanban.test") == true else {
                return Reply(status: 500, data: Data())
            }
            return replies.isEmpty ? Reply(status: 500, data: Data()) : replies.removeFirst()
        }
    }
}

private final class ArchivedProjectTransport: URLProtocol, @unchecked Sendable {
    static let state = ArchivedProjectTransportState()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let reply = Self.state.consume(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
