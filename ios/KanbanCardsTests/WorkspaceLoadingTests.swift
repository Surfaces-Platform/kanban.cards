import Foundation
import XCTest
@testable import KanbanCards

@MainActor
final class WorkspaceLoadingTests: XCTestCase {
    private var model: AppModel!
    private var store: WorkspaceCredentialStore!
    private var suite: String!
    private var defaults: UserDefaults!
    private var directory: URL!

    override func setUp() async throws {
        WorkspaceURLProtocol.state.reset()
        suite = "cards.kanban.WorkspaceLoadingTests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        store = WorkspaceCredentialStore()
        store.value = NativeSessionCredential(token: "kcn_persisted", expiresAt: Self.expiry,
            rootUrl: URL(string: "https://kanban.cards")!, owner: NativeOwner(id: "owner-a", displayName: "Test", email: ""))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorkspaceURLProtocol.self]
        let client = KanbanAPIClient(credentialStore: store, session: URLSession(configuration: configuration))
        model = AppModel(api: client, drafts: DraftStore(directory: directory), defaults: defaults, demo: false)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }

    func testValidatedRestoreSurvivesWorkspaceTimeoutAndRetriesWithSameBearer() async {
        WorkspaceURLProtocol.state.enqueue(json: Self.sessionJSON)
        WorkspaceURLProtocol.state.enqueue(error: URLError(.timedOut))
        await model.restore()

        XCTAssertTrue(model.signedIn)
        XCTAssertFalse(model.restoring)
        XCTAssertTrue(model.workspaceLoadFailed)
        XCTAssertFalse(model.loadingWorkspaces)
        XCTAssertEqual(store.value?.token, "kcn_persisted")
        XCTAssertEqual(store.removals, 0)
        XCTAssertTrue(model.workspaces.isEmpty)

        WorkspaceURLProtocol.state.enqueue(json: Self.workspacesJSON)
        await model.refreshWorkspaces()
        XCTAssertTrue(model.signedIn)
        XCTAssertFalse(model.workspaceLoadFailed)
        XCTAssertEqual(model.workspaces.map(\.id), ["workspace-a"])
        let requests = WorkspaceURLProtocol.state.requests
        XCTAssertEqual(requests.map { $0.url?.path }, ["/api/session", "/api/workspaces", "/api/workspaces"])
        XCTAssertEqual(requests.map(\.httpMethod), ["GET", "GET", "GET"])
        XCTAssertEqual(requests.map { $0.value(forHTTPHeaderField: "Authorization") }, Array(repeating: "Bearer kcn_persisted", count: 3))
        XCTAssertEqual(store.saves, 0)
    }

    func testCompletedPasskeyStaysAuthenticatedAfterWorkspaceServerFailure() async throws {
        store.value = nil
        WorkspaceURLProtocol.state.enqueue(json: """
        {"authenticated":true,"tokenType":"Bearer","token":"kcn_verified","expiresAt":"\(Self.expiry)","rootUrl":"https://kanban.cards","owner":{"id":"owner-a","displayName":"Test","email":""}}
        """)
        WorkspaceURLProtocol.state.enqueue(status: 503, json: #"{"error":"Temporarily unavailable."}"#)
        let challenge = NativeSignInChallenge(challengeId: "challenge-a", ceremonyToken: "test-only", relyingPartyIdentifier: "auth.kanban.cards", challenge: "AQID", expiresAt: Self.expiry)
        let assertion = NativePasskeyAssertion(id: "AQID", rawId: "AQID", response: .init(authenticatorData: "AQID", clientDataJSON: "AQID", signature: "AQID", userHandle: "AQID"))
        try await model.completeSignIn(challenge: challenge, assertion: assertion)

        XCTAssertTrue(model.signedIn)
        XCTAssertTrue(model.workspaceLoadFailed)
        XCTAssertEqual(store.value?.token, "kcn_verified")
        XCTAssertEqual(store.saves, 1)
        // The sign-in action cannot mint another session while Workspace recovery is pending.
        await model.signIn()
        XCTAssertEqual(WorkspaceURLProtocol.state.requests.count, 2)

        WorkspaceURLProtocol.state.enqueue(json: Self.workspacesJSON)
        await model.refreshWorkspaces()
        XCTAssertTrue(model.signedIn)
        XCTAssertFalse(model.workspaceLoadFailed)
        XCTAssertEqual(model.workspaces.count, 1)
        let requests = WorkspaceURLProtocol.state.requests
        XCTAssertEqual(requests.map { $0.url?.path }, ["/api/native-auth/verify", "/api/workspaces", "/api/workspaces"])
        XCTAssertEqual(requests.dropFirst().map { $0.value(forHTTPHeaderField: "Authorization") }, ["Bearer kcn_verified", "Bearer kcn_verified"])
        XCTAssertEqual(store.saves, 1)
        XCTAssertEqual(store.removals, 0)
    }

    func testUnauthorizedWorkspaceRetryEndsRetainedSession() async {
        WorkspaceURLProtocol.state.enqueue(json: Self.sessionJSON)
        WorkspaceURLProtocol.state.enqueue(status: 503, json: #"{"error":"Temporarily unavailable."}"#)
        await model.restore()
        XCTAssertTrue(model.signedIn)
        WorkspaceURLProtocol.state.enqueue(status: 401, json: #"{"error":"Session revoked."}"#)
        await model.refreshWorkspaces()

        XCTAssertFalse(model.signedIn)
        XCTAssertNil(model.api.credential)
        XCTAssertNil(store.value)
        XCTAssertEqual(store.removals, 1)
        XCTAssertTrue(model.workspaces.isEmpty)
        XCTAssertTrue(model.loadedProjects.isEmpty)
        let count = WorkspaceURLProtocol.state.requests.count
        await model.refreshWorkspaces()
        XCTAssertEqual(WorkspaceURLProtocol.state.requests.count, count)
    }

    private static var expiry: String { ServerTimestamp.string(from: .now.addingTimeInterval(3600)) }
    private static let sessionJSON = #"{"authenticated":true,"context":"root","authenticationMethod":"native","rootUrl":"https://kanban.cards"}"#
    private static let workspacesJSON = #"{"workspaces":[{"id":"workspace-a","slug":"test","name":"Test","url":"https://test.kanban.cards"}]}"#
}

@MainActor
private final class WorkspaceCredentialStore: SessionCredentialStore {
    var value: NativeSessionCredential?
    var saves = 0
    var removals = 0
    func load() throws -> NativeSessionCredential? { value }
    func save(_ credential: NativeSessionCredential) throws { saves += 1; value = credential }
    func remove() throws { removals += 1; value = nil }
}

private final class WorkspaceStubState: @unchecked Sendable {
    struct Reply: Sendable { var status: Int; var data: Data; var error: URLError? }
    private let lock = NSLock()
    private var replies: [Reply] = []
    private var received: [URLRequest] = []
    var requests: [URLRequest] { lock.withLock { received } }
    func reset() { lock.withLock { replies = []; received = [] } }
    func enqueue(status: Int = 200, json: String) {
        lock.withLock { replies.append(Reply(status: status, data: Data(json.utf8), error: nil)) }
    }
    func enqueue(error: URLError) { lock.withLock { replies.append(Reply(status: 0, data: Data(), error: error)) } }
    func consume(_ request: URLRequest) -> Reply {
        lock.withLock {
            received.append(request)
            guard !replies.isEmpty else { return Reply(status: 500, data: Data(), error: nil) }
            return replies.removeFirst()
        }
    }
}

private final class WorkspaceURLProtocol: URLProtocol, @unchecked Sendable {
    static let state = WorkspaceStubState()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let reply = Self.state.consume(request)
        if let error = reply.error { client?.urlProtocol(self, didFailWithError: error); return }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
