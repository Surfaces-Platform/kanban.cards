import Foundation
import XCTest
@testable import KanbanCards

@MainActor
final class AppModelTests: XCTestCase {
    private var credentialStore: AppModelCredentialStore!
    private var defaults: UserDefaults!
    private var defaultsSuite: String!
    private var draftDirectory: URL!
    private let workspace = Workspace(id: "workspace-a", slug: "test", name: "Test",
        url: URL(string: "https://test.kanban.cards")!)

    override func setUp() async throws {
        AppModelURLProtocol.state.reset()
        defaultsSuite = "cards.kanban.AppModelTests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: defaultsSuite))
        defaults.removePersistentDomain(forName: defaultsSuite)
        draftDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        credentialStore = AppModelCredentialStore()
        credentialStore.value = NativeSessionCredential(token: "kcn_app_model_test_only",
            expiresAt: ServerTimestamp.string(from: .now.addingTimeInterval(3600)),
            rootUrl: URL(string: "https://kanban.cards")!,
            owner: NativeOwner(id: "owner-a", displayName: "Test owner", email: ""))
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: defaultsSuite)
        if FileManager.default.fileExists(atPath: draftDirectory.path) {
            try FileManager.default.removeItem(at: draftDirectory)
        }
    }

    func testPendingSignOutSurvivesRelaunchWithoutLoadingPrivateData() async throws {
        let firstModel = await signedInModel()
        let project = makeProject()
        try enqueueProjects(project)
        try enqueueProject(project)
        try await firstModel.loadProjects(in: workspace)
        try await firstModel.loadProject(id: project.id, in: workspace)
        XCTAssertFalse(firstModel.projectLists.isEmpty)
        XCTAssertFalse(firstModel.loadedProjects.isEmpty)

        AppModelURLProtocol.state.enqueue(error: URLError(.timedOut))
        await firstModel.signOut()
        XCTAssertTrue(defaults.bool(forKey: "nativeSignOutPending"))
        XCTAssertTrue(firstModel.signOutPending)
        assertPrivateDataHidden(firstModel)
        XCTAssertNotNil(credentialStore.value)

        let relaunchedDefaults = try XCTUnwrap(UserDefaults(suiteName: defaultsSuite))
        let relaunchedModel = makeModel(defaults: relaunchedDefaults)
        XCTAssertTrue(relaunchedModel.signOutPending)
        let requestCount = AppModelURLProtocol.state.requests.count
        AppModelURLProtocol.state.enqueue(json: Self.sessionJSON)
        AppModelURLProtocol.state.enqueue(error: URLError(.timedOut))
        await relaunchedModel.restore()

        XCTAssertFalse(relaunchedModel.restoring)
        XCTAssertTrue(relaunchedModel.signOutPending)
        XCTAssertTrue(relaunchedDefaults.bool(forKey: "nativeSignOutPending"))
        XCTAssertNotNil(credentialStore.value)
        assertPrivateDataHidden(relaunchedModel)
        let relaunchRequests = Array(AppModelURLProtocol.state.requests.dropFirst(requestCount))
        XCTAssertEqual(relaunchRequests.map(\.httpMethod), ["GET", "DELETE"])
        XCTAssertEqual(relaunchRequests.map { $0.url?.path }, ["/api/session", "/api/session"])

        AppModelURLProtocol.state.enqueue(json: #"{"signedOutHere":true,"globalSignOutComplete":true}"#)
        await relaunchedModel.signOut()
        XCTAssertFalse(relaunchedModel.signOutPending)
        XCTAssertNil(relaunchedDefaults.object(forKey: "nativeSignOutPending"))
        XCTAssertNil(credentialStore.value)
        assertPrivateDataHidden(relaunchedModel)
        XCTAssertEqual(AppModelURLProtocol.state.requests.last?.httpMethod, "DELETE")
    }

    func testUnconfirmedRevocationKeepsPersistentSignOutIntent() async {
        defaults.set(true, forKey: "nativeSignOutPending")
        let model = makeModel()
        AppModelURLProtocol.state.enqueue(json: Self.sessionJSON)
        AppModelURLProtocol.state.enqueue(json: #"{"signedOutHere":false,"globalSignOutComplete":false}"#)
        await model.restore()

        XCTAssertTrue(model.signOutPending)
        XCTAssertTrue(defaults.bool(forKey: "nativeSignOutPending"))
        XCTAssertNotNil(credentialStore.value)
        XCTAssertNotNil(model.errorMessage)
        assertPrivateDataHidden(model)
        XCTAssertEqual(AppModelURLProtocol.state.requests.map { $0.url?.path }, ["/api/session", "/api/session"])
    }

    func testServerRejectedRetainedSessionClearsSignOutIntentWithoutLoadingPrivateData() async {
        defaults.set(true, forKey: "nativeSignOutPending")
        let model = makeModel()
        AppModelURLProtocol.state.enqueue(status: 401, json: #"{"error":"Session revoked."}"#)
        await model.restore()

        XCTAssertFalse(model.signOutPending)
        XCTAssertNil(defaults.object(forKey: "nativeSignOutPending"))
        XCTAssertNil(credentialStore.value)
        assertPrivateDataHidden(model)
        XCTAssertEqual(AppModelURLProtocol.state.requests.count, 1)
        XCTAssertEqual(AppModelURLProtocol.state.requests.first?.url?.path, "/api/session")
    }

    func testCredentialLoadFailureRetainsPendingRevocationAndStoredCredential() async {
        defaults.set(true, forKey: "nativeSignOutPending")
        credentialStore.loadError = APIError(message: "The retained credential could not be read.")
        let model = makeModel()
        await model.restore()

        XCTAssertTrue(model.signOutPending)
        XCTAssertTrue(defaults.bool(forKey: "nativeSignOutPending"))
        XCTAssertNotNil(credentialStore.value)
        XCTAssertNotNil(model.errorMessage)
        assertPrivateDataHidden(model)
        XCTAssertTrue(AppModelURLProtocol.state.requests.isEmpty)
    }

    func testCardCreateRetryKeepsFrozenPositionAfterProjectRefresh() async throws {
        let model = await signedInModel()
        let initialProject = makeProject(position: 2)
        try enqueueProject(initialProject)
        try await model.loadProject(id: initialProject.id, in: workspace)
        var draft = CardDraft(columnId: "next")
        draft.title = "Retained creation"
        draft.body = "  Keep the full draft.\n"
        draft.position = 3
        draft.externalKey = "native-draft:test-position"
        let frozen = draft

        AppModelURLProtocol.state.enqueue(error: URLError(.timedOut))
        do {
            _ = try await model.saveCard(frozen, projectID: initialProject.id, in: workspace, key: "same-create")
            XCTFail("A timed-out creation must remain unconfirmed.")
        } catch let error as APIError { XCTAssertTrue(error.isAmbiguousMutation) }

        let refreshedProject = makeProject(position: 500)
        try enqueueProject(refreshedProject)
        try await model.loadProject(id: refreshedProject.id, in: workspace)
        var savedProject = refreshedProject
        let createdCard = Card(id: "created-card", externalKey: frozen.externalKey, title: frozen.title,
            body: frozen.body, nextActor: nil, nextAction: "", priority: nil, blockedReason: "",
            columnId: frozen.columnId, position: frozen.position, version: 1,
            createdAt: Self.timestamp, updatedAt: Self.timestamp, comments: [])
        savedProject.cards.append(createdCard)
        try AppModelURLProtocol.state.enqueue(data: JSONEncoder().encode(CardEnvelope(card: createdCard, projectRevision: 3)))
        try enqueueProject(savedProject)
        try enqueueProjects(savedProject)
        let result = try await model.saveCard(frozen, projectID: refreshedProject.id, in: workspace, key: "same-create")

        XCTAssertEqual(result.id, createdCard.id)
        XCTAssertEqual(frozen, draft)
        let creates = AppModelURLProtocol.state.requests.filter { $0.httpMethod == "POST" }
        XCTAssertEqual(creates.count, 2)
        XCTAssertEqual(creates.map { $0.value(forHTTPHeaderField: "Idempotency-Key") }, ["same-create", "same-create"])
        let firstBody = try requestBody(creates[0])
        let retryBody = try requestBody(creates[1])
        XCTAssertEqual(firstBody["position"] as? Double, 3)
        XCTAssertEqual(retryBody["position"] as? Double, 3)
        XCTAssertEqual(NSDictionary(dictionary: firstBody), NSDictionary(dictionary: retryBody))
    }

    private func makeModel(defaults selectedDefaults: UserDefaults? = nil) -> AppModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AppModelURLProtocol.self]
        let client = KanbanAPIClient(credentialStore: credentialStore, session: URLSession(configuration: configuration))
        return AppModel(api: client, drafts: DraftStore(directory: draftDirectory), defaults: selectedDefaults ?? defaults, demo: false)
    }

    private func signedInModel() async -> AppModel {
        AppModelURLProtocol.state.enqueue(json: Self.sessionJSON)
        AppModelURLProtocol.state.enqueue(json: #"{"workspaces":[{"id":"workspace-a","slug":"test","name":"Test","url":"https://test.kanban.cards"}]}"#)
        let model = makeModel()
        await model.restore()
        XCTAssertTrue(model.signedIn)
        return model
    }

    private func assertPrivateDataHidden(_ model: AppModel, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(model.signedIn, file: file, line: line)
        XCTAssertTrue(model.workspaces.isEmpty, file: file, line: line)
        XCTAssertTrue(model.projectLists.isEmpty, file: file, line: line)
        XCTAssertTrue(model.loadedProjects.isEmpty, file: file, line: line)
    }

    private func makeProject(position: Double = 2) -> Project {
        let card = Card(id: "existing-card", title: "Existing private Card", body: "Private description",
            nextActor: nil, nextAction: "", priority: nil, blockedReason: "", columnId: "next",
            position: position, version: 1, createdAt: Self.timestamp, updatedAt: Self.timestamp, comments: [])
        return Project(id: "project-a", name: "Private Project", description: "Private context",
            columns: [Column(id: "next", name: "Next", position: 0)], cards: [card], activity: [], revision: 2,
            createdAt: Self.timestamp, updatedAt: Self.timestamp)
    }

    private func enqueueProject(_ project: Project) throws {
        try AppModelURLProtocol.state.enqueue(data: JSONEncoder().encode(ProjectEnvelope(project: project)))
    }

    private func enqueueProjects(_ project: Project) throws {
        let summary = ProjectSummary(id: project.id, name: project.name, description: project.description,
            revision: project.revision, createdAt: project.createdAt, updatedAt: project.updatedAt,
            cardCount: project.cards.count)
        try AppModelURLProtocol.state.enqueue(data: JSONEncoder().encode(ProjectsEnvelope(projects: [summary])))
    }

    private func requestBody(_ request: URLRequest) throws -> [String: Any] {
        let data: Data
        if let body = request.httpBody { data = body }
        else if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var body = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(contentsOf: buffer.prefix(count))
            }
            data = body
        } else { throw APIError(message: "Missing test request body") }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private struct ProjectEnvelope: Encodable { var project: Project }
    private struct ProjectsEnvelope: Encodable { var projects: [ProjectSummary] }
    private struct CardEnvelope: Encodable { var card: Card; var projectRevision: Int }
    private static let timestamp = "2026-10-11T20:00:00.000Z"
    private static let sessionJSON = #"{"authenticated":true,"context":"root","authenticationMethod":"native","rootUrl":"https://kanban.cards"}"#
}

@MainActor
private final class AppModelCredentialStore: SessionCredentialStore {
    var value: NativeSessionCredential?
    var loadError: APIError?
    func load() throws -> NativeSessionCredential? {
        if let loadError { throw loadError }
        return value
    }
    func save(_ credential: NativeSessionCredential) throws { value = credential }
    func remove() throws { value = nil }
}

private final class AppModelStubState: @unchecked Sendable {
    struct Reply: Sendable { var status: Int; var data: Data; var error: URLError? }
    private let lock = NSLock()
    private var replies: [Reply] = []
    private var received: [URLRequest] = []
    var requests: [URLRequest] { lock.withLock { received } }
    func reset() { lock.withLock { replies = []; received = [] } }
    func enqueue(status: Int = 200, json: String) { enqueue(status: status, data: Data(json.utf8)) }
    func enqueue(status: Int = 200, data: Data) {
        lock.withLock { replies.append(Reply(status: status, data: data, error: nil)) }
    }
    func enqueue(error: URLError) {
        lock.withLock { replies.append(Reply(status: 0, data: Data(), error: error)) }
    }
    func consume(_ request: URLRequest) -> Reply {
        lock.withLock {
            received.append(request)
            guard !replies.isEmpty else {
                return Reply(status: 0, data: Data(), error: URLError(.resourceUnavailable))
            }
            return replies.removeFirst()
        }
    }
}

private final class AppModelURLProtocol: URLProtocol, @unchecked Sendable {
    static let state = AppModelStubState()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let reply = Self.state.consume(request)
        if let error = reply.error { client?.urlProtocol(self, didFailWithError: error); return }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
