import Foundation
import XCTest
@testable import KanbanCards

@MainActor
final class WorkspaceActivityTests: XCTestCase {
    private var model: AppModel!
    private var client: KanbanAPIClient!
    private var directory: URL!
    private var defaults: UserDefaults!
    private var suite: String!
    private let workspace = Workspace(id: "activity-workspace", slug: "test", name: "Test Workspace",
        url: URL(string: "https://test.kanban.cards")!)
    private let other = Workspace(id: "other-workspace", slug: "other", name: "Other Workspace",
        url: URL(string: "https://other.kanban.cards")!)

    override func setUp() async throws {
        WorkspaceActivityProtocol.state.reset()
        suite = "WorkspaceActivityTests-" + UUID().uuidString
        defaults = UserDefaults(suiteName: suite)!
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorkspaceActivityProtocol.self]
        client = KanbanAPIClient(credentialStore: ActivityCredentialStore(), session: URLSession(configuration: configuration), dataAccessPolicy: .readOnly)
        model = AppModel(api: client, drafts: DraftStore(directory: directory), defaults: defaults, demo: false)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }

    func testVerifiedReadOnlyTransportPreservesCursorAndRejectsUnknownOrigin() async throws {
        try await restore()
        let event = item("one", project: "archived-project")
        try enqueue([event], nextCursor: "older/+==")
        let first = try await client.workspaceActivity(in: workspace)
        XCTAssertEqual(first.activity, [event])
        try enqueue([], nextCursor: nil)
        _ = try await client.workspaceActivity(in: workspace, cursor: first.nextCursor)
        let request = try XCTUnwrap(WorkspaceActivityProtocol.state.requests.last)
        XCTAssertEqual(request.url?.host, workspace.url.host)
        XCTAssertEqual(request.url?.path, "/api/activity")
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(query.first(where: { $0.name == "limit" })?.value, "50")
        XCTAssertEqual(query.first(where: { $0.name == "cursor" })?.value, "older/+==")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer kcn_workspace_activity_test_only")
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        XCTAssertFalse(request.httpShouldHandleCookies)
        var spoof = workspace; spoof.url = URL(string: "https://unknown.kanban.cards")!
        let count = WorkspaceActivityProtocol.state.requests.count
        do { _ = try await client.workspaceActivity(in: spoof); XCTFail("Unknown origins must fail before HTTP.") }
        catch { XCTAssertTrue(error is APIError) }
        XCTAssertEqual(WorkspaceActivityProtocol.state.requests.count, count)
    }

    func testPaginationKeepsProjectScopedEventIDsAndStoredActorMetadata() async throws {
        try await restore()
        let first = item("same", project: "first")
        let second = item("same", project: "second", actor: "Claude Research")
        try enqueue([first], nextCursor: "older")
        try await model.loadWorkspaceActivity(in: workspace)
        try enqueue([first, second], nextCursor: nil)
        try await model.loadWorkspaceActivity(in: workspace, loadMore: true)
        let state = model.workspaceActivity(in: workspace)
        XCTAssertEqual(state.activity, [first, second])
        XCTAssertEqual(state.activity.map(\.actor.label), ["Codex Writer", "Claude Research"])
        XCTAssertEqual(state.activity.last?.projectArchivedAt, "2026-10-18T12:00:00Z")
        XCTAssertTrue(state.hasLoaded)
        XCTAssertFalse(state.isLoading)
        XCTAssertNil(state.nextCursor)
        XCTAssertTrue(model.projects(in: workspace).isEmpty, "Activity must work without loading Project inventory.")
    }

    func testFailedPageAndRefreshRetainRowsAndRetryState() async throws {
        try await restore()
        let first = item("one", project: "first")
        try enqueue([first], nextCursor: "older")
        try await model.loadWorkspaceActivity(in: workspace)
        WorkspaceActivityProtocol.state.enqueue(path: "/api/activity", status: 503, json: #"{"error":"Unavailable"}"#)
        do { try await model.loadWorkspaceActivity(in: workspace, loadMore: true); XCTFail("The page must fail.") }
        catch { }
        XCTAssertEqual(model.workspaceActivity(in: workspace).activity, [first])
        XCTAssertEqual(model.workspaceActivity(in: workspace).nextCursor, "older")
        XCTAssertTrue(model.workspaceActivity(in: workspace).failedLoadMore)
        XCTAssertNotNil(model.workspaceActivity(in: workspace).error)
        let older = item("two", project: "second")
        try enqueue([older], nextCursor: nil)
        try await model.loadWorkspaceActivity(in: workspace, loadMore: true)
        XCTAssertEqual(model.workspaceActivity(in: workspace).activity, [first, older])
        WorkspaceActivityProtocol.state.enqueue(path: "/api/activity", status: 500, json: #"{"error":"Refresh unavailable"}"#)
        do { try await model.loadWorkspaceActivity(in: workspace); XCTFail("Refresh must fail.") }
        catch { }
        XCTAssertEqual(model.workspaceActivity(in: workspace).activity, [first, older])
        XCTAssertFalse(model.workspaceActivity(in: workspace).failedLoadMore)
        XCTAssertFalse(model.workspaceActivity(in: workspace).isLoading)
    }

    func testFirstFailureIsNotEmptySuccessAndCanRetry() async throws {
        try await restore()
        WorkspaceActivityProtocol.state.enqueue(path: "/api/activity", status: 500, json: #"{"error":"Unavailable"}"#)
        do { try await model.loadWorkspaceActivity(in: workspace); XCTFail("First read must fail.") }
        catch { }
        XCTAssertFalse(model.workspaceActivity(in: workspace).hasLoaded)
        XCTAssertNotNil(model.workspaceActivity(in: workspace).error)
        try enqueue([], nextCursor: nil)
        try await model.loadWorkspaceActivity(in: workspace)
        XCTAssertTrue(model.workspaceActivity(in: workspace).hasLoaded)
        XCTAssertNil(model.workspaceActivity(in: workspace).error)
    }

    func testNewRefreshRejectsOldResponseAndWorkspaceCachesStaySeparate() async throws {
        try await restore()
        try enqueue([item("old", project: "first")], nextCursor: nil, held: "old")
        let old = Task { try await model.loadWorkspaceActivity(in: workspace) }
        try await WorkspaceActivityProtocol.state.waitForStart("old")
        let current = item("new", project: "second")
        try enqueue([current], nextCursor: nil)
        try await model.loadWorkspaceActivity(in: workspace)
        try WorkspaceActivityProtocol.state.release("old")
        do { try await old.value; XCTFail("An older refresh must be rejected.") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(model.workspaceActivity(in: workspace).activity, [current])
        try enqueue([], nextCursor: nil)
        try await model.loadWorkspaceActivity(in: other)
        XCTAssertTrue(model.workspaceActivity(in: other).activity.isEmpty)
        XCTAssertEqual(model.workspaceActivity(in: workspace).activity, [current])
    }

    func testRemovedWorkspaceAndReplacedSessionRejectDelayedPages() async throws {
        try await restore()
        try enqueue([item("old", project: "first")], nextCursor: nil, held: "removed")
        let removed = Task { try await model.loadWorkspaceActivity(in: workspace) }
        try await WorkspaceActivityProtocol.state.waitForStart("removed")
        try WorkspaceActivityProtocol.state.enqueue(Inventory(workspaces: [other]), path: "/api/workspaces")
        await model.refreshWorkspaces()
        try WorkspaceActivityProtocol.state.release("removed")
        do { try await removed.value; XCTFail("Removed Workspace must reject delayed results.") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(model.workspaceActivity(in: workspace).activity.isEmpty)
        try enqueue([item("old-session", project: "first")], nextCursor: nil, held: "old-session")
        let replaced = Task { try await model.loadWorkspaceActivity(in: other) }
        try await WorkspaceActivityProtocol.state.waitForStart("old-session")
        enqueueSession()
        _ = try await client.restoreSession()
        try WorkspaceActivityProtocol.state.release("old-session")
        do { try await replaced.value; XCTFail("Replaced session must reject delayed results.") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(model.workspaceActivity(in: other).activity.isEmpty)
    }

    func testSignOutClearsFeedAndRejectsLateResponse() async throws {
        try await restore()
        try enqueue([item("old", project: "first")], nextCursor: nil, held: "sign-out")
        let read = Task { try await model.loadWorkspaceActivity(in: workspace) }
        try await WorkspaceActivityProtocol.state.waitForStart("sign-out")
        WorkspaceActivityProtocol.state.enqueue(path: "/api/session", method: "DELETE", json: #"{"signedOutHere":true,"globalSignOutComplete":true}"#)
        await model.signOut()
        try WorkspaceActivityProtocol.state.release("sign-out")
        do { try await read.value; XCTFail("Signed-out read must be rejected.") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(model.workspaceActivity(in: workspace).activity.isEmpty)
        XCTAssertFalse(model.signedIn)
    }

    func testCanceledReadDoesNotApplyRowsOrShowFailure() async throws {
        try await restore()
        try enqueue([item("canceled", project: "first")], nextCursor: nil, held: "canceled")
        let read = Task { try await model.loadWorkspaceActivity(in: workspace) }
        try await WorkspaceActivityProtocol.state.waitForStart("canceled")
        read.cancel()
        try WorkspaceActivityProtocol.state.release("canceled")
        do { try await read.value; XCTFail("A canceled view must not accept delayed results.") }
        catch { XCTAssertTrue(error is CancellationError) }
        let state = model.workspaceActivity(in: workspace)
        XCTAssertTrue(state.activity.isEmpty)
        XCTAssertFalse(state.hasLoaded)
        XCTAssertFalse(state.isLoading)
        XCTAssertNil(state.error)
    }

    func testDemoUsesArchivedHistoryAndEmptyWorkspaceWithoutHTTP() async throws {
        let demo = AppModel(drafts: DraftStore(directory: directory), defaults: defaults, demo: true)
        let original = try XCTUnwrap(demo.workspaces.first)
        let project = try XCTUnwrap(demo.project(id: "demo-project", in: original))
        try await demo.archiveProject(project, in: original, archived: true)
        try await demo.loadWorkspaceActivity(in: original)
        let state = demo.workspaceActivity(in: original)
        XCTAssertFalse(state.activity.isEmpty)
        XCTAssertTrue(state.activity.allSatisfy { $0.projectArchivedAt != nil && $0.projectName == project.name })
        XCTAssertTrue(state.activity.contains { $0.actor.label == "Codex Writer (demo)" })
        let empty = try await demo.createWorkspace(name: "Empty", slug: "empty-activity")
        try await demo.loadWorkspaceActivity(in: empty)
        XCTAssertTrue(demo.workspaceActivity(in: empty).hasLoaded)
        XCTAssertTrue(demo.workspaceActivity(in: empty).activity.isEmpty)
        XCTAssertTrue(WorkspaceActivityProtocol.state.requests.isEmpty)
    }

    private func item(_ id: String, project: String, actor: String = "Codex Writer") -> Activity {
        Activity(id: id, action: "card.updated", actor: ActivityActor(channel: "api", label: actor, agentConnectionId: "connection-" + actor),
            summary: "Updated retained Card.", projectId: project, cardId: "card", createdAt: "2026-10-19T12:00:00Z",
            projectName: "Retained Project", projectArchivedAt: "2026-10-18T12:00:00Z", cardTitle: "Retained Card")
    }
    private func enqueue(_ activity: [Activity], nextCursor: String?, held: String? = nil) throws {
        try WorkspaceActivityProtocol.state.enqueue(WorkspaceActivityPage(activity: activity, nextCursor: nextCursor), path: "/api/activity", held: held)
    }
    private func enqueueSession() {
        WorkspaceActivityProtocol.state.enqueue(path: "/api/session", json: #"{"authenticated":true,"context":"root","authenticationMethod":"native","rootUrl":"https://kanban.cards"}"#)
    }
    private func restore() async throws {
        enqueueSession()
        try WorkspaceActivityProtocol.state.enqueue(Inventory(workspaces: [workspace, other]), path: "/api/workspaces")
        await model.restore()
        XCTAssertTrue(model.signedIn)
    }
    private struct Inventory: Encodable { let workspaces: [Workspace] }
}

@MainActor
private final class ActivityCredentialStore: SessionCredentialStore {
    var value: NativeSessionCredential? = NativeSessionCredential(token: "kcn_workspace_activity_test_only",
        expiresAt: ServerTimestamp.string(from: .now.addingTimeInterval(3600)), rootUrl: URL(string: "https://kanban.cards")!,
        owner: NativeOwner(id: "activity-owner", displayName: "Test", email: ""))
    func load() throws -> NativeSessionCredential? { value }
    func save(_ credential: NativeSessionCredential) throws { value = credential }
    func remove() throws { value = nil }
}

private final class WorkspaceActivityStub: @unchecked Sendable {
    struct Reply: Sendable { var status: Int; var data: Data; var held: String? }
    private let lock = NSLock()
    private var replies: [String: [Reply]] = [:]
    private var pending: [String: (WorkspaceActivityProtocol, Reply)] = [:]
    private var received: [URLRequest] = []
    var requests: [URLRequest] { lock.withLock { received } }
    func reset() { lock.withLock { replies = [:]; pending = [:]; received = [] } }
    func enqueue<T: Encodable>(_ value: T, path: String, method: String = "GET", held: String? = nil) throws {
        let reply = Reply(status: 200, data: try JSONEncoder().encode(value), held: held)
        lock.withLock { replies[method + " " + path, default: []].append(reply) }
    }
    func enqueue(path: String, method: String = "GET", status: Int = 200, json: String, held: String? = nil) {
        lock.withLock { replies[method + " " + path, default: []].append(Reply(status: status, data: Data(json.utf8), held: held)) }
    }
    func start(_ instance: WorkspaceActivityProtocol) {
        let reply: Reply = lock.withLock {
            received.append(instance.request)
            let key = (instance.request.httpMethod ?? "GET") + " " + (instance.request.url?.path ?? "")
            let reply = replies[key]?.isEmpty == false ? replies[key]!.removeFirst()
                : Reply(status: 500, data: Data(#"{"error":"Unexpected test request"}"#.utf8), held: nil)
            if let held = reply.held { pending[held] = (instance, reply) }
            return reply
        }
        if reply.held == nil { instance.finish(reply) }
    }
    func waitForStart(_ id: String) async throws {
        for _ in 0..<500 {
            if lock.withLock({ pending[id] != nil }) { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw APIError(message: "Expected held test request did not start: \(id)")
    }
    func release(_ id: String) throws {
        guard let held = lock.withLock({ pending.removeValue(forKey: id) }) else { throw APIError(message: "Held request unavailable: \(id)") }
        held.0.finish(held.1)
    }
}

private final class WorkspaceActivityProtocol: URLProtocol, @unchecked Sendable {
    static let state = WorkspaceActivityStub()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.state.start(self) }
    override func stopLoading() { }
    func finish(_ reply: WorkspaceActivityStub.Reply) {
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.data)
        client?.urlProtocolDidFinishLoading(self)
    }
}
