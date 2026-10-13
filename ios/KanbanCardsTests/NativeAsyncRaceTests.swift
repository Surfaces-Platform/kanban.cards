import Foundation
import XCTest
@testable import KanbanCards

@MainActor
final class NativeAsyncRaceTests: XCTestCase {
    private var client: KanbanAPIClient!
    private var model: AppModel!
    private var store: RaceCredentialStore!
    private var defaults: UserDefaults!
    private var suite: String!
    private var draftDirectory: URL!
    private let workspace = Workspace(id: "workspace-a", slug: "test", name: "Test", url: URL(string: "https://test.kanban.cards")!)

    override func setUp() async throws {
        RaceURLProtocol.state.reset()
        store = RaceCredentialStore()
        store.value = credential(token: "kcn_original", owner: "owner-a")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RaceURLProtocol.self]
        client = KanbanAPIClient(credentialStore: store, session: URLSession(configuration: configuration))
        suite = "cards.kanban.AsyncRaceTests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        draftDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        model = AppModel(api: client, drafts: DraftStore(directory: draftDirectory), defaults: defaults, demo: false)
        RaceURLProtocol.state.enqueue(json: Self.sessionJSON)
        RaceURLProtocol.state.enqueue(json: Self.workspacesJSON)
        await model.restore()
        XCTAssertTrue(model.signedIn)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        if FileManager.default.fileExists(atPath: draftDirectory.path) { try FileManager.default.removeItem(at: draftDirectory) }
    }

    func testSlowProjectReadCannotReplaceConfirmedMutationAndNewerRefresh() async throws {
        let original = project(revision: 2, cardVersion: 1, title: "Original")
        try RaceURLProtocol.state.enqueue(ProjectReply(project: original))
        try await model.loadProject(id: original.id, in: workspace)
        try RaceURLProtocol.state.enqueue(ProjectReply(project: original), held: "old-project")
        let slow = Task { try await model.loadProject(id: original.id, in: workspace) }
        await RaceURLProtocol.state.waitForStart("old-project")

        let updated = project(revision: 3, cardVersion: 2, title: "Confirmed edit")
        try RaceURLProtocol.state.enqueue(CardReply(card: updated.cards[0], projectRevision: updated.revision))
        try RaceURLProtocol.state.enqueue(ProjectReply(project: updated))
        try enqueueList(updated)
        var draft = CardDraft(card: original.cards[0])
        draft.title = "Confirmed edit"
        _ = try await model.saveCard(draft, projectID: original.id, in: workspace, key: "edit")
        RaceURLProtocol.state.release("old-project")
        do { try await slow.value; XCTFail("A pre-mutation read must be discarded.") }
        catch is CancellationError { }

        XCTAssertEqual(model.loadedProjects[original.id]?.revision, 3)
        XCTAssertEqual(model.loadedProjects[original.id]?.cards.first?.title, "Confirmed edit")
        XCTAssertEqual(model.projectLists[workspace.id]?.first?.revision, 3)
        XCTAssertNil(model.errorMessage)
    }

    func testLowerProjectRevisionCannotReplaceNewerRead() async throws {
        let older = project(revision: 2, cardVersion: 1, title: "Older")
        let newer = project(revision: 5, cardVersion: 4, title: "Newer")
        try RaceURLProtocol.state.enqueue(ProjectReply(project: older), held: "older-read")
        let slow = Task { try await model.loadProject(id: older.id, in: workspace) }
        await RaceURLProtocol.state.waitForStart("older-read")
        try RaceURLProtocol.state.enqueue(ProjectReply(project: newer))
        try await model.loadProject(id: newer.id, in: workspace)
        RaceURLProtocol.state.release("older-read")
        try await slow.value
        XCTAssertEqual(model.loadedProjects[newer.id]?.revision, 5)
        XCTAssertEqual(model.loadedProjects[newer.id]?.cards.first?.title, "Newer")
    }

    func testSlowProjectListCannotReplaceNewerList() async throws {
        let older = project(revision: 2, cardVersion: 1, title: "Older")
        let newer = project(revision: 5, cardVersion: 4, title: "Newer")
        try enqueueList(older, held: "old-list")
        let slow = Task { try await model.loadProjects(in: workspace) }
        await RaceURLProtocol.state.waitForStart("old-list")
        try enqueueList(newer)
        try await model.loadProjects(in: workspace)
        RaceURLProtocol.state.release("old-list")
        do { try await slow.value; XCTFail("A superseded list refresh must be discarded.") }
        catch is CancellationError { }
        XCTAssertEqual(model.projectLists[workspace.id]?.first?.revision, 5)
    }

    func testLateSuccessAfterSignOutCannotRepopulatePrivateCache() async throws {
        let saved = project(revision: 2, cardVersion: 1, title: "Private Card")
        try RaceURLProtocol.state.enqueue(ProjectReply(project: saved), held: "old-success")
        let slow = Task { try await model.loadProject(id: saved.id, in: workspace) }
        await RaceURLProtocol.state.waitForStart("old-success")
        RaceURLProtocol.state.enqueue(json: #"{"signedOutHere":true,"globalSignOutComplete":true}"#)
        await model.signOut()
        RaceURLProtocol.state.release("old-success")
        do { try await slow.value; XCTFail("A signed-out response must be discarded.") }
        catch { model.handle(error) }
        XCTAssertFalse(model.signedIn)
        XCTAssertTrue(model.loadedProjects.isEmpty)
        XCTAssertTrue(model.projectLists.isEmpty)
        XCTAssertNil(model.errorMessage)
    }

    func testOldUnauthorizedResponseCannotRemoveReplacementCredentialOrSignOutModel() async throws {
        RaceURLProtocol.state.enqueue(status: 401, json: #"{"error":"Old session revoked."}"#, held: "old-401")
        let slow = Task { try await model.loadProject(id: "project-a", in: workspace) }
        await RaceURLProtocol.state.waitForStart("old-401")
        try await replaceCredential()
        RaceURLProtocol.state.release("old-401")
        do { try await slow.value; XCTFail("An obsolete 401 must be discarded.") }
        catch { XCTAssertTrue(error is CancellationError); model.handle(error) }
        XCTAssertEqual(client.credential?.token, "kcn_replacement")
        XCTAssertEqual(store.value?.owner.id, "owner-b")
        XCTAssertEqual(store.removals, 0)
        XCTAssertTrue(model.signedIn)
        XCTAssertNil(model.errorMessage)
    }

    func testOldTransportFailureIsIgnoredAfterCredentialReplacement() async throws {
        RaceURLProtocol.state.enqueue(error: URLError(.timedOut), held: "old-timeout")
        let slow = Task { try await model.loadProject(id: "project-a", in: workspace) }
        await RaceURLProtocol.state.waitForStart("old-timeout")
        try await replaceCredential()
        RaceURLProtocol.state.release("old-timeout")
        do { try await slow.value; XCTFail("An obsolete transport failure must be discarded.") }
        catch { XCTAssertTrue(error is CancellationError); model.handle(error) }
        XCTAssertEqual(client.credential?.token, "kcn_replacement")
        XCTAssertNil(model.errorMessage)
    }

    func testLateWorkspaceRefreshCannotRestoreWorkspacesAfterSignOut() async {
        RaceURLProtocol.state.enqueue(json: Self.workspacesJSON, held: "old-workspaces")
        let slow = Task { await model.refreshWorkspaces() }
        await RaceURLProtocol.state.waitForStart("old-workspaces")
        RaceURLProtocol.state.enqueue(json: #"{"signedOutHere":true,"globalSignOutComplete":true}"#)
        await model.signOut()
        RaceURLProtocol.state.release("old-workspaces")
        await slow.value
        XCTAssertFalse(model.signedIn)
        XCTAssertTrue(model.workspaces.isEmpty)
        XCTAssertFalse(model.loadingWorkspaces)
        XCTAssertNil(model.errorMessage)
    }

    func testOlderWorkspaceReadCannotReplaceNewerTenantAllowlist() async throws {
        RaceURLProtocol.state.enqueue(json: Self.workspacesJSON, held: "older-workspaces")
        let older = Task { await model.refreshWorkspaces() }
        await RaceURLProtocol.state.waitForStart("older-workspaces")
        RaceURLProtocol.state.enqueue(json: #"{"workspaces":[{"id":"workspace-a","slug":"test","name":"Test","url":"https://test.kanban.cards"},{"id":"workspace-b","slug":"second","name":"Second","url":"https://second.kanban.cards"}]}"#)
        await model.refreshWorkspaces()
        XCTAssertEqual(model.workspaces.map(\.id), ["workspace-a", "workspace-b"])
        RaceURLProtocol.state.release("older-workspaces")
        await older.value
        let second = try XCTUnwrap(model.workspaces.first(where: { $0.id == "workspace-b" }))
        let board = project(revision: 2, cardVersion: 1, title: "Second Workspace Card")
        try RaceURLProtocol.state.enqueue(ProjectReply(project: board))
        let result = try await client.project(id: board.id, in: second)
        XCTAssertEqual(result.cards.first?.title, "Second Workspace Card")
        XCTAssertEqual(model.workspaces.map(\.id), ["workspace-a", "workspace-b"])
        XCTAssertTrue(model.signedIn)
        XCTAssertNil(model.errorMessage)
    }

    func testSupersededWorkspaceReadUnauthorizedStillEndsCurrentSession() async throws {
        let board = project(revision: 2, cardVersion: 1, title: "Private Card")
        try RaceURLProtocol.state.enqueue(ProjectReply(project: board))
        try await model.loadProject(id: board.id, in: workspace)
        XCTAssertFalse(model.loadedProjects.isEmpty)
        RaceURLProtocol.state.enqueue(status: 401, json: #"{"error":"Session revoked."}"#, held: "older-workspace-401")
        let older = Task { await model.refreshWorkspaces() }
        await RaceURLProtocol.state.waitForStart("older-workspace-401")
        RaceURLProtocol.state.enqueue(json: Self.workspacesJSON, held: "newer-workspace-read")
        let newer = Task { await model.refreshWorkspaces() }
        await RaceURLProtocol.state.waitForStart("newer-workspace-read")
        RaceURLProtocol.state.release("older-workspace-401")
        await older.value
        XCTAssertFalse(model.signedIn)
        XCTAssertNil(client.credential)
        XCTAssertNil(store.value)
        XCTAssertTrue(model.loadedProjects.isEmpty)
        XCTAssertTrue(model.workspaces.isEmpty)
        RaceURLProtocol.state.release("newer-workspace-read")
        await newer.value
        XCTAssertFalse(model.signedIn)
        XCTAssertFalse(model.loadingWorkspaces)
        XCTAssertTrue(model.workspaces.isEmpty)
        XCTAssertEqual(store.removals, 1)
    }

    private func replaceCredential() async throws {
        let expiry = ServerTimestamp.string(from: .now.addingTimeInterval(3600))
        RaceURLProtocol.state.enqueue(json: """
        {"authenticated":true,"tokenType":"Bearer","token":"kcn_replacement","expiresAt":"\(expiry)","rootUrl":"https://kanban.cards","owner":{"id":"owner-b","displayName":"Replacement","email":""}}
        """)
        let challenge = NativeSignInChallenge(challengeId: "new-challenge", ceremonyToken: "test-only", relyingPartyIdentifier: "auth.kanban.cards", challenge: "AQID", expiresAt: expiry)
        let assertion = NativePasskeyAssertion(id: "AQID", rawId: "AQID", response: .init(authenticatorData: "AQID", clientDataJSON: "AQID", signature: "AQID", userHandle: "AQID"))
        _ = try await client.completeSignIn(challenge: challenge, assertion: assertion)
    }

    private func credential(token: String, owner: String) -> NativeSessionCredential {
        NativeSessionCredential(token: token, expiresAt: ServerTimestamp.string(from: .now.addingTimeInterval(3600)),
            rootUrl: URL(string: "https://kanban.cards")!, owner: NativeOwner(id: owner, displayName: "Test", email: ""))
    }

    private func project(revision: Int, cardVersion: Int, title: String) -> Project {
        let card = Card(id: "card-a", title: title, body: "Source", nextActor: nil, nextAction: "", priority: nil,
            blockedReason: "", columnId: "next", position: 0, version: cardVersion, createdAt: Self.timestamp, updatedAt: Self.timestamp, comments: [])
        return Project(id: "project-a", name: "Project", description: "", columns: [Column(id: "next", name: "Next", position: 0)],
            cards: [card], activity: [], revision: revision, createdAt: Self.timestamp, updatedAt: Self.timestamp)
    }

    private func enqueueList(_ project: Project, held: String? = nil) throws {
        let summary = ProjectSummary(id: project.id, name: project.name, description: project.description, revision: project.revision,
            createdAt: project.createdAt, updatedAt: project.updatedAt, cardCount: project.cards.count)
        try RaceURLProtocol.state.enqueue(ProjectsReply(projects: [summary]), held: held)
    }

    private struct ProjectReply: Encodable { var project: Project }
    private struct ProjectsReply: Encodable { var projects: [ProjectSummary] }
    private struct CardReply: Encodable { var card: Card; var projectRevision: Int }
    private static let timestamp = "2026-10-11T20:00:00.000Z"
    private static let sessionJSON = #"{"authenticated":true,"context":"root","authenticationMethod":"native","rootUrl":"https://kanban.cards"}"#
    private static let workspacesJSON = #"{"workspaces":[{"id":"workspace-a","slug":"test","name":"Test","url":"https://test.kanban.cards"}]}"#
}

@MainActor
private final class RaceCredentialStore: SessionCredentialStore {
    var value: NativeSessionCredential?
    var removals = 0
    func load() throws -> NativeSessionCredential? { value }
    func save(_ credential: NativeSessionCredential) throws { value = credential }
    func remove() throws { removals += 1; value = nil }
}

private final class RaceStubState: @unchecked Sendable {
    struct Reply: Sendable { var status: Int; var data: Data; var error: URLError?; var held: String? }
    private let lock = NSLock()
    private var replies: [Reply] = []
    private var pending: [String: (RaceURLProtocol, Reply)] = [:]
    private var starts: [String: [CheckedContinuation<Void, Never>]] = [:]
    func reset() { lock.withLock { replies = []; pending = [:]; starts = [:] } }
    func enqueue<T: Encodable>(_ value: T, held: String? = nil) throws {
        let data = try JSONEncoder().encode(value)
        lock.withLock { replies.append(Reply(status: 200, data: data, error: nil, held: held)) }
    }
    func enqueue(status: Int = 200, json: String, held: String? = nil) {
        lock.withLock { replies.append(Reply(status: status, data: Data(json.utf8), error: nil, held: held)) }
    }
    func enqueue(error: URLError, held: String) {
        lock.withLock { replies.append(Reply(status: 0, data: Data(), error: error, held: held)) }
    }
    func start(_ protocolInstance: RaceURLProtocol) {
        let (reply, waiters): (Reply, [CheckedContinuation<Void, Never>]) = lock.withLock {
            let reply = replies.isEmpty ? Reply(status: 500, data: Data(), error: nil, held: nil) : replies.removeFirst()
            if let id = reply.held {
                pending[id] = (protocolInstance, reply)
                return (reply, starts.removeValue(forKey: id) ?? [])
            }
            return (reply, [])
        }
        waiters.forEach { $0.resume() }
        if reply.held == nil { protocolInstance.finish(reply) }
    }
    func waitForStart(_ id: String) async {
        await withCheckedContinuation { continuation in
            let started = lock.withLock {
                if pending[id] != nil { return true }
                starts[id, default: []].append(continuation)
                return false
            }
            if started { continuation.resume() }
        }
    }
    func release(_ id: String) {
        let held = lock.withLock { pending.removeValue(forKey: id) }
        precondition(held != nil, "The held test request must have started before release.")
        held?.0.finish(held!.1)
    }
}

private final class RaceURLProtocol: URLProtocol, @unchecked Sendable {
    static let state = RaceStubState()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.state.start(self) }
    override func stopLoading() { }
    func finish(_ reply: RaceStubState.Reply) {
        if let error = reply.error { client?.urlProtocol(self, didFailWithError: error); return }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.data)
        client?.urlProtocolDidFinishLoading(self)
    }
}
