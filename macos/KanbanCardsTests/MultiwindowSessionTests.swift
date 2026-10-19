import Foundation
import XCTest
@testable import KanbanCards

@MainActor
final class MultiwindowSessionTests: XCTestCase {
    private var model: AppModel!
    private var store: MultiwindowCredentialStore!
    private var defaults: UserDefaults!
    private var suite: String!
    private var draftDirectory: URL!
    private let workspace = Workspace(id: "workspace-a", slug: "test", name: "Test",
        url: URL(string: "https://test.kanban.cards")!)

    override func setUp() async throws {
        MultiwindowURLProtocol.state.reset()
        store = MultiwindowCredentialStore()
        store.value = NativeSessionCredential(token: "kcn_multiwindow_test_only",
            expiresAt: ServerTimestamp.string(from: .now.addingTimeInterval(3600)),
            rootUrl: URL(string: "https://kanban.cards")!,
            owner: NativeOwner(id: "owner-a", displayName: "Test", email: ""))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MultiwindowURLProtocol.self]
        let client = KanbanAPIClient(credentialStore: store, session: URLSession(configuration: configuration))
        suite = "cards.kanban.macos.MultiwindowSessionTests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        draftDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        model = AppModel(api: client, drafts: DraftStore(directory: draftDirectory), defaults: defaults, demo: false)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        if FileManager.default.fileExists(atPath: draftDirectory.path) {
            try FileManager.default.removeItem(at: draftDirectory)
        }
    }

    func testBoardAndRestoredCardScenesAwaitOneSessionRestore() async throws {
        let stub = MultiwindowURLProtocol.state
        stub.enqueue(path: "/api/session", json: Self.sessionJSON, held: "restore")
        stub.enqueue(path: "/api/workspaces", json: Self.workspacesJSON)
        let board = Task { await model.restore() }
        try await stub.waitForStart("restore")
        var joinedScenes = 0
        let firstCard = Task { joinedScenes += 1; await model.restore() }
        let secondCard = Task { joinedScenes += 1; await model.restore() }
        // Both scene tasks reach restore while the shared operation remains suspended.
        while joinedScenes < 2 { await Task.yield() }
        XCTAssertTrue(model.restoring)
        XCTAssertFalse(model.signedIn)
        XCTAssertEqual(stub.requestCount(path: "/api/session"), 1)

        try stub.release("restore")
        await board.value
        await firstCard.value
        await secondCard.value

        XCTAssertFalse(model.restoring)
        XCTAssertTrue(model.signedIn)
        XCTAssertEqual(model.workspaces, [workspace])
        XCTAssertEqual(stub.requestCount(path: "/api/session"), 1)
        XCTAssertEqual(stub.requestCount(path: "/api/workspaces"), 1)
        XCTAssertEqual(store.loads, 1)
        XCTAssertNil(model.errorMessage)
    }

    func testConfirmedReceiptPrecedesRefreshAndLateReadsCannotExposeSignedOutData() async throws {
        let stub = MultiwindowURLProtocol.state
        stub.enqueue(path: "/api/session", json: Self.sessionJSON)
        stub.enqueue(path: "/api/workspaces", json: Self.workspacesJSON)
        await model.restore()
        let original = makeProject()
        try stub.enqueue(ProjectEnvelope(project: original), path: "/api/projects/project-a")
        try await model.loadProject(id: original.id, in: workspace)
        let oldSession = model.sessionID
        var edited = original.cards[0]
        edited.title = "Confirmed private title"
        edited.version += 1
        var updated = original
        updated.cards = [edited]
        updated.revision += 1
        var draft = CardDraft(card: original.cards[0])
        draft.title = edited.title
        let resource = "workspace-a/project-a/card-a"
        try model.drafts.save(draft, ownerID: model.ownerID, resourceKey: resource)

        stub.enqueue(path: "/api/workspaces", json: Self.workspacesJSON, held: "workspaces")
        let workspaceRefresh = Task { await model.refreshWorkspaces() }
        try await stub.waitForStart("workspaces")
        try stub.enqueue(CardEnvelope(card: edited, projectRevision: updated.revision),
            path: "/api/projects/project-a/cards/card-a", method: "PATCH")
        try stub.enqueue(ProjectEnvelope(project: updated), path: "/api/projects/project-a", held: "project-refresh")
        var confirmed = false
        let save = Task {
            try await model.saveCard(draft, projectID: original.id, in: workspace, key: "retained-patch", onConfirmed: {
                confirmed = true
                // Record proof of confirmation using the original owner before any refresh suspension.
                try? self.model.drafts.save(true, ownerID: "owner-a", resourceKey: "confirmed/" + resource)
            })
        }
        try await stub.waitForStart("project-refresh")
        XCTAssertTrue(confirmed)
        XCTAssertEqual(model.project(id: original.id, in: workspace)?.cards.first?.title, edited.title)
        XCTAssertEqual(try model.drafts.load(ownerID: "owner-a", resourceKey: "confirmed/" + resource, as: Bool.self), true)

        stub.enqueue(path: "/api/session", method: "DELETE",
            json: #"{"signedOutHere":true,"globalSignOutComplete":true}"#)
        await model.signOut()
        XCTAssertNotEqual(model.sessionID, oldSession)
        XCTAssertFalse(model.signedIn)
        XCTAssertTrue(model.workspaces.isEmpty)
        XCTAssertNil(model.project(id: original.id, in: workspace))
        try stub.release("project-refresh")
        try stub.release("workspaces")
        do { _ = try await save.value; XCTFail("A replaced session must not return private Card data.") }
        catch { XCTAssertTrue(error is CancellationError) }
        await workspaceRefresh.value

        XCTAssertFalse(model.signedIn)
        XCTAssertTrue(model.workspaces.isEmpty)
        XCTAssertTrue(model.projects(in: workspace).isEmpty)
        XCTAssertNil(model.project(id: original.id, in: workspace))
        XCTAssertFalse(model.loadingWorkspaces)
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(try model.drafts.load(ownerID: "owner-a", resourceKey: resource, as: CardDraft.self), draft)
        XCTAssertEqual(try model.drafts.load(ownerID: "owner-a", resourceKey: "confirmed/" + resource, as: Bool.self), true)
        XCTAssertNil(try model.drafts.load(ownerID: "another-owner", resourceKey: resource, as: CardDraft.self))
    }

    func testKnownSessionExpiryClearsIdleWindowsWithoutAnotherRequest() async throws {
        let stub = MultiwindowURLProtocol.state
        store.value?.expiresAt = ServerTimestamp.string(from: .now.addingTimeInterval(1))
        stub.enqueue(path: "/api/session", json: Self.sessionJSON)
        stub.enqueue(path: "/api/workspaces", json: Self.workspacesJSON)
        await model.restore()
        XCTAssertTrue(model.signedIn)
        let project = makeProject()
        try stub.enqueue(ProjectEnvelope(project: project), path: "/api/projects/project-a")
        try await model.loadProject(id: project.id, in: workspace)
        XCTAssertNotNil(model.project(id: project.id, in: workspace))
        let session = model.sessionID
        let requestCount = stub.totalRequestCount

        // Do not call validateSession or initiate a refresh: the idle expiry task must publish this.
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while model.signedIn && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }

        XCTAssertFalse(model.signedIn)
        XCTAssertNotEqual(model.sessionID, session)
        XCTAssertTrue(model.workspaces.isEmpty)
        XCTAssertTrue(model.projects(in: workspace).isEmpty)
        XCTAssertNil(model.project(id: project.id, in: workspace))
        XCTAssertTrue(model.errorMessage?.contains("expired") == true)
        XCTAssertEqual(stub.totalRequestCount, requestCount)
    }

    func testOlderFullMutationCannotReplaceNewerConfirmedCardAndCommentWhenRefreshFails() async throws {
        let stub = MultiwindowURLProtocol.state
        stub.enqueue(path: "/api/session", json: Self.sessionJSON)
        stub.enqueue(path: "/api/workspaces", json: Self.workspacesJSON)
        await model.restore()
        let original = makeProject()
        try stub.enqueue(ProjectEnvelope(project: original), path: "/api/projects/project-a")
        try await model.loadProject(id: original.id, in: workspace)

        var metadata = original
        metadata.name = "Confirmed Project name"
        metadata.revision = 2
        var projectDraft = ProjectDraft(project: original)
        projectDraft.name = metadata.name
        try stub.enqueue(ProjectEnvelope(project: metadata), path: "/api/projects/project-a", method: "PATCH", held: "metadata")
        let metadataSave = Task { try await model.saveProject(projectDraft, in: workspace, key: "metadata") }
        try await stub.waitForStart("metadata")

        var savedCard = original.cards[0]
        savedCard.title = "Confirmed newer Card"
        savedCard.version = 2
        var cardDraft = CardDraft(card: original.cards[0])
        cardDraft.title = savedCard.title
        try stub.enqueue(CardEnvelope(card: savedCard, projectRevision: 3), path: "/api/projects/project-a/cards/card-a", method: "PATCH")
        var localFailures: [String] = []
        _ = try await model.saveCard(cardDraft, projectID: original.id, in: workspace, key: "card",
            onRefreshFailure: { localFailures.append($0) })
        stub.enqueue(path: "/api/projects/project-a/cards/card-a/comments", method: "POST",
            json: #"{"comment":{"id":"comment-confirmed","body":"Confirmed comment","author":"Test","createdAt":"2026-10-13T12:00:00.000Z"},"card":{"id":"card-a","version":3},"projectRevision":4}"#)
        try await model.addComment("Confirmed comment", cardID: "card-a", projectID: original.id, in: workspace, key: "comment",
            onRefreshFailure: { localFailures.append($0) })
        try stub.release("metadata")
        _ = try await metadataSave.value

        let displayed = try XCTUnwrap(model.project(id: original.id, in: workspace))
        XCTAssertEqual(displayed.revision, 4)
        XCTAssertEqual(displayed.name, metadata.name)
        XCTAssertEqual(displayed.cards.first?.title, savedCard.title)
        XCTAssertEqual(displayed.cards.first?.version, 3)
        XCTAssertEqual(displayed.cards.first?.comments.last?.body, "Confirmed comment")
        XCTAssertEqual(model.projects(in: workspace).first?.revision, 4)
        XCTAssertEqual(localFailures.count, 2)
        XCTAssertTrue(localFailures[0].contains("Card saved."))
        XCTAssertTrue(localFailures[1].contains("Comment sent."))
        XCTAssertNil(model.errorMessage, "Ordinary refresh failures belong to the originating operation.")
    }

    func testMoveReconcilesLostResponseAndPreservesExternalTextWithDestinationOnlyPatch() async throws {
        let stub = MultiwindowURLProtocol.state
        stub.enqueue(path: "/api/session", json: Self.sessionJSON)
        stub.enqueue(path: "/api/workspaces", json: Self.workspacesJSON)
        await model.restore()
        var latest = makeProject()
        latest.columns.append(Column(id: "done", name: "Done", position: 1))
        latest.cards[0].title = "External title must survive"
        latest.cards[0].version = 2
        latest.revision = 2
        try stub.enqueue(ProjectEnvelope(project: latest), path: "/api/projects/project-a")
        // A malformed 2xx response models a committed move whose result was lost.
        stub.enqueue(path: "/api/projects/project-a/cards/card-a", method: "PATCH", json: "{}")
        do {
            _ = try await model.moveCard(cardID: "card-a", to: "done", projectID: latest.id, in: workspace)
            XCTFail("The first response must be uncertain.")
        } catch { XCTAssertTrue((error as? APIError)?.isAmbiguousMutation == true) }
        XCTAssertEqual(stub.requestCount(path: "/api/projects/project-a"), 1,
                       "Opening an uncached Project for Move must reuse that fresh read before its versioned PATCH.")
        let moveRequest = try XCTUnwrap(stub.lastRequest(path: "/api/projects/project-a/cards/card-a", method: "PATCH"))
        let body = try jsonBody(moveRequest)
        XCTAssertEqual(Set(body.keys), ["columnId", "position"])
        XCTAssertEqual(moveRequest.value(forHTTPHeaderField: "X-Kanban-Version"), "2")

        latest.cards[0].columnId = "done"
        latest.cards[0].version = 3
        latest.revision = 3
        try stub.enqueue(ProjectEnvelope(project: latest), path: "/api/projects/project-a")
        let reconciled = try await model.moveCard(cardID: "card-a", to: "done", projectID: latest.id, in: workspace)
        XCTAssertEqual(reconciled, latest.cards[0])
        XCTAssertEqual(reconciled.title, "External title must survive")
        XCTAssertEqual(stub.requestCount(path: "/api/projects/project-a/cards/card-a"), 1, "Already-completed moves must not issue another PATCH.")
    }

    func testMoveRejectsLatestArchivedCardAndRemovedDestinationWithoutPatch() async throws {
        let stub = MultiwindowURLProtocol.state
        stub.enqueue(path: "/api/session", json: Self.sessionJSON)
        stub.enqueue(path: "/api/workspaces", json: Self.workspacesJSON)
        await model.restore()
        var latest = makeProject()
        latest.columns.append(Column(id: "done", name: "Done", position: 1))
        latest.cards[0].archivedAt = ServerTimestamp.string()
        try stub.enqueue(ProjectEnvelope(project: latest), path: "/api/projects/project-a")
        do {
            _ = try await model.moveCard(cardID: "card-a", to: "done", projectID: latest.id, in: workspace)
            XCTFail("An externally archived Card must not move.")
        } catch { XCTAssertEqual(error as? AppFailure, .readOnlyCard) }
        latest.cards[0].archivedAt = nil
        latest.columns.removeAll { $0.id == "done" }
        latest.revision += 1
        try stub.enqueue(ProjectEnvelope(project: latest), path: "/api/projects/project-a")
        do {
            _ = try await model.moveCard(cardID: "card-a", to: "done", projectID: latest.id, in: workspace)
            XCTFail("A removed destination must not move.")
        } catch { XCTAssertEqual(error as? AppFailure, .missingColumn) }
        XCTAssertEqual(stub.requestCount(path: "/api/projects/project-a/cards/card-a"), 0)
    }

    func testProjectInventoryPublishesLoadingFailureAndSuccessfulRetry() async throws {
        let stub = MultiwindowURLProtocol.state
        stub.enqueue(path: "/api/session", json: Self.sessionJSON)
        stub.enqueue(path: "/api/workspaces", json: Self.workspacesJSON)
        await model.restore()
        stub.enqueue(path: "/api/projects", json: "{}", held: "inventory")
        let loading = Task { try await model.loadProjects(in: workspace) }
        try await stub.waitForStart("inventory")
        XCTAssertTrue(model.projectListLoading(in: workspace))
        XCTAssertNil(model.projectListError(in: workspace))
        try stub.release("inventory")
        do { try await loading.value; XCTFail("Malformed inventory must fail.") } catch { }
        XCTAssertFalse(model.projectListLoading(in: workspace))
        XCTAssertNotNil(model.projectListError(in: workspace))
        stub.enqueue(path: "/api/projects", json: #"{"projects":[]}"#)
        try await model.loadProjects(in: workspace)
        XCTAssertFalse(model.projectListLoading(in: workspace))
        XCTAssertNil(model.projectListError(in: workspace))
        XCTAssertNil(model.errorMessage)
    }

    private func jsonBody(_ request: URLRequest) throws -> [String: Any] {
        let data: Data
        if let body = request.httpBody { data = body }
        else if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var collected = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                collected.append(contentsOf: buffer.prefix(count))
            }
            data = collected
        } else { throw APIError(message: "Missing test request body") }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func makeProject() -> Project {
        let timestamp = ServerTimestamp.string()
        let card = Card(id: "card-a", title: "Original private title", body: "Private source",
            nextActor: .human, nextAction: "Review", priority: .high, blockedReason: "",
            columnId: "next", position: 0, version: 1, createdAt: timestamp, updatedAt: timestamp, comments: [])
        return Project(id: "project-a", name: "Private Project", description: "Private context",
            columns: [Column(id: "next", name: "Next", position: 0)], cards: [card], activity: [], revision: 1,
            createdAt: timestamp, updatedAt: timestamp)
    }

    private struct ProjectEnvelope: Encodable { var project: Project }
    private struct CardEnvelope: Encodable { var card: Card; var projectRevision: Int }
    private static let sessionJSON = #"{"authenticated":true,"context":"root","authenticationMethod":"native","rootUrl":"https://kanban.cards"}"#
    private static let workspacesJSON = #"{"workspaces":[{"id":"workspace-a","slug":"test","name":"Test","url":"https://test.kanban.cards"}]}"#
}

@MainActor
private final class MultiwindowCredentialStore: SessionCredentialStore {
    var value: NativeSessionCredential?
    var loads = 0
    func load() throws -> NativeSessionCredential? { loads += 1; return value }
    func save(_ credential: NativeSessionCredential) throws { value = credential }
    func remove() throws { value = nil }
}

private final class MultiwindowStub: @unchecked Sendable {
    struct Reply: Sendable { var status: Int; var data: Data; var held: String? }
    private let lock = NSLock()
    private var replies: [String: [Reply]] = [:]
    private var pending: [String: (MultiwindowURLProtocol, Reply)] = [:]
    private var requests: [URLRequest] = []

    func reset() { lock.withLock { replies = [:]; pending = [:]; requests = [] } }

    func enqueue<T: Encodable>(_ value: T, path: String, method: String = "GET", held: String? = nil) throws {
        let reply = Reply(status: 200, data: try JSONEncoder().encode(value), held: held)
        lock.withLock { replies[method + " " + path, default: []].append(reply) }
    }

    func enqueue(path: String, method: String = "GET", json: String, held: String? = nil) {
        lock.withLock {
            replies[method + " " + path, default: []].append(Reply(status: 200, data: Data(json.utf8), held: held))
        }
    }

    var totalRequestCount: Int { lock.withLock { requests.count } }

    func lastRequest(path: String, method: String) -> URLRequest? {
        lock.withLock { requests.last { $0.url?.path == path && $0.httpMethod == method } }
    }

    func requestCount(path: String) -> Int {
        lock.withLock { requests.filter { $0.url?.path == path }.count }
    }

    func start(_ instance: MultiwindowURLProtocol) {
        let reply: Reply = lock.withLock {
            requests.append(instance.request)
            let key = (instance.request.httpMethod ?? "GET") + " " + (instance.request.url?.path ?? "")
            let reply = replies[key]?.isEmpty == false
                ? replies[key]!.removeFirst()
                : Reply(status: 500, data: Data(#"{"error":"Unexpected test request."}"#.utf8), held: nil)
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
        throw APIError(message: "The expected test request did not start: \(id)")
    }

    func release(_ id: String) throws {
        guard let held = lock.withLock({ pending.removeValue(forKey: id) }) else {
            throw APIError(message: "The expected held test request was unavailable: \(id)")
        }
        held.0.finish(held.1)
    }
}

private final class MultiwindowURLProtocol: URLProtocol, @unchecked Sendable {
    static let state = MultiwindowStub()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.state.start(self) }
    override func stopLoading() { }
    func finish(_ reply: MultiwindowStub.Reply) {
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.data)
        client?.urlProtocolDidFinishLoading(self)
    }
}
