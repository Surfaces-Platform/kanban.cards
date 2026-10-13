import Foundation
import XCTest
@testable import KanbanCards

@MainActor
final class AppModelMutationTests: XCTestCase {
    private var model: AppModel!
    private var defaults: UserDefaults!
    private var suite: String!
    private var draftDirectory: URL!
    private let workspace = Workspace(id: "workspace-a", slug: "test", name: "Test", url: URL(string: "https://test.kanban.cards")!)

    override func setUp() async throws {
        MutationURLProtocol.state.reset()
        suite = "cards.kanban.MutationTests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        draftDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = MutationCredentialStore()
        store.value = NativeSessionCredential(token: "kcn_mutation_test_only", expiresAt: ServerTimestamp.string(from: .now.addingTimeInterval(3600)), rootUrl: URL(string: "https://kanban.cards")!, owner: NativeOwner(id: "owner-a", displayName: "Test", email: ""))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MutationURLProtocol.self]
        model = AppModel(api: KanbanAPIClient(credentialStore: store, session: URLSession(configuration: configuration)),
            drafts: DraftStore(directory: draftDirectory), defaults: defaults, demo: false)
        MutationURLProtocol.state.enqueue(json: #"{"authenticated":true,"context":"root","authenticationMethod":"native","rootUrl":"https://kanban.cards"}"#)
        MutationURLProtocol.state.enqueue(json: #"{"workspaces":[{"id":"workspace-a","slug":"test","name":"Test","url":"https://test.kanban.cards"}]}"#)
        await model.restore()
        XCTAssertTrue(model.signedIn)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        if FileManager.default.fileExists(atPath: draftDirectory.path) { try FileManager.default.removeItem(at: draftDirectory) }
    }

    func testConfirmedCardPatchReturnsSuccessWhenRefreshFails() async throws {
        let project = makeProject()
        try await load(project)
        var saved = project.cards[0]
        saved.version = 2
        saved.title = "Confirmed title"
        let count = MutationURLProtocol.state.requests.count
        try MutationURLProtocol.state.enqueue(CardReply(card: saved, projectRevision: 3))
        MutationURLProtocol.state.enqueue(error: URLError(.notConnectedToInternet))
        var draft = CardDraft(card: project.cards[0])
        draft.title = saved.title

        let result = try await model.saveCard(draft, projectID: project.id, in: workspace, key: "patch")

        XCTAssertEqual(result.version, 2)
        XCTAssertEqual(model.loadedProjects[project.id]?.cards[0].title, "Confirmed title")
        XCTAssertEqual(model.loadedProjects[project.id]?.cards[0].version, 2)
        XCTAssertTrue(model.errorMessage?.hasPrefix("Card saved.") == true)
        XCTAssertEqual(Array(MutationURLProtocol.state.requests.dropFirst(count)).map(\.httpMethod), ["PATCH", "GET"])
    }

    func testConfirmedCommentDoesNotRetryOrAdvanceVersionAcrossUnseenChanges() async throws {
        let project = makeProject()
        try await load(project)
        let comment = Comment(id: "comment-a", body: "Confirmed comment", author: "Test", createdAt: Self.timestamp)
        let count = MutationURLProtocol.state.requests.count
        try MutationURLProtocol.state.enqueue(CommentReply(comment: comment, card: .init(id: "card-a", version: 5), projectRevision: 6))
        MutationURLProtocol.state.enqueue(error: URLError(.timedOut))

        try await model.addComment(comment.body, cardID: "card-a", projectID: project.id, in: workspace, key: "comment")

        let cached = try XCTUnwrap(model.loadedProjects[project.id]?.cards.first)
        XCTAssertEqual(cached.comments.map(\.id), [comment.id])
        XCTAssertEqual(cached.version, 1, "A compact response cannot authorize overwriting unseen Card fields.")
        XCTAssertEqual(model.loadedProjects[project.id]?.revision, project.revision)
        XCTAssertTrue(model.errorMessage?.hasPrefix("Comment sent.") == true)
        XCTAssertEqual(Array(MutationURLProtocol.state.requests.dropFirst(count)).map(\.httpMethod), ["POST", "GET"])
    }

    func testProjectCreationReplaysReadCurrentStateBeforeReturning() async throws {
        var original = makeProject()
        original.revision = 1
        var current = original
        current.revision = 7
        current.name = "Latest saved name"
        let count = MutationURLProtocol.state.requests.count
        try MutationURLProtocol.state.enqueue(ProjectReply(project: original))
        try MutationURLProtocol.state.enqueue(ProjectReply(project: current))
        try enqueueList(current)

        let result = try await model.saveProject(ProjectDraft(name: original.name), in: workspace, key: "same-project-create")

        XCTAssertEqual(result.revision, 7)
        XCTAssertEqual(result.name, "Latest saved name")
        XCTAssertEqual(model.projectLists[workspace.id]?.first?.revision, 7)
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(Array(MutationURLProtocol.state.requests.dropFirst(count)).map(\.httpMethod), ["POST", "GET", "GET"])
    }

    func testProjectReplayCannotReplaceNewerCachedReadWhenRefreshFails() async throws {
        var current = makeProject()
        current.revision = 8
        current.name = "Newer current Project"
        try await load(current)
        var snapshot = current
        snapshot.revision = 1
        snapshot.name = "Original created name"
        try MutationURLProtocol.state.enqueue(ProjectReply(project: snapshot))
        MutationURLProtocol.state.enqueue(error: URLError(.notConnectedToInternet))

        let result = try await model.saveProject(ProjectDraft(name: snapshot.name), in: workspace, key: "same-project-create")

        XCTAssertEqual(result.revision, 8)
        XCTAssertEqual(model.loadedProjects[current.id]?.name, current.name)
        XCTAssertTrue(model.errorMessage?.hasPrefix("Project saved.") == true)
    }

    func testConfirmedArchiveUpdatesCachedCardWhenRefreshFails() async throws {
        let project = makeProject()
        try await load(project)
        var archived = project.cards[0]
        archived.archivedAt = Self.timestamp
        archived.version = 2
        try MutationURLProtocol.state.enqueue(CardReply(card: archived, projectRevision: 3))
        MutationURLProtocol.state.enqueue(error: URLError(.timedOut))

        try await model.archive(project.cards[0], projectID: project.id, in: workspace, archived: true)

        XCTAssertEqual(model.loadedProjects[project.id]?.cards.first?.archivedAt, Self.timestamp)
        XCTAssertEqual(model.projectLists[workspace.id]?.first?.cardCount, 0)
        XCTAssertTrue(model.errorMessage?.hasPrefix("Card archived.") == true)
    }

    private func load(_ project: Project) async throws {
        try MutationURLProtocol.state.enqueue(ProjectReply(project: project))
        try await model.loadProject(id: project.id, in: workspace)
    }

    private func enqueueList(_ project: Project) throws {
        let summary = ProjectSummary(id: project.id, name: project.name, description: project.description,
            revision: project.revision, archivedAt: project.archivedAt, createdAt: project.createdAt,
            updatedAt: project.updatedAt, cardCount: project.cards.filter { $0.archivedAt == nil }.count)
        try MutationURLProtocol.state.enqueue(ProjectListReply(projects: [summary]))
    }

    private func makeProject() -> Project {
        let card = Card(id: "card-a", title: "Original title", body: "Source", nextActor: nil,
            nextAction: "", priority: nil, blockedReason: "", columnId: "next", position: 0,
            version: 1, createdAt: Self.timestamp, updatedAt: Self.timestamp, comments: [])
        return Project(id: "project-a", name: "Original Project", description: "Description",
            columns: [Column(id: "next", name: "Next", position: 0)], cards: [card], activity: [],
            revision: 2, createdAt: Self.timestamp, updatedAt: Self.timestamp)
    }

    private struct CardReply: Encodable { var card: Card; var projectRevision: Int }
    private struct ProjectReply: Encodable { var project: Project }
    private struct ProjectListReply: Encodable { var projects: [ProjectSummary] }
    private struct CommentReply: Encodable {
        struct Reference: Encodable { var id: String; var version: Int }
        var comment: Comment
        var card: Reference
        var projectRevision: Int
    }
    private static let timestamp = "2026-10-11T20:00:00.000Z"
}

@MainActor
private final class MutationCredentialStore: SessionCredentialStore {
    var value: NativeSessionCredential?
    func load() throws -> NativeSessionCredential? { value }
    func save(_ credential: NativeSessionCredential) throws { value = credential }
    func remove() throws { value = nil }
}

private final class MutationStubState: @unchecked Sendable {
    struct Reply: Sendable { var data: Data; var error: URLError? }
    private let lock = NSLock()
    private var replies: [Reply] = []
    private var received: [URLRequest] = []
    var requests: [URLRequest] { lock.withLock { received } }
    func reset() { lock.withLock { replies = []; received = [] } }
    func enqueue<T: Encodable>(_ value: T) throws {
        let data = try JSONEncoder().encode(value)
        lock.withLock { replies.append(Reply(data: data, error: nil)) }
    }
    func enqueue(json: String) { lock.withLock { replies.append(Reply(data: Data(json.utf8), error: nil)) } }
    func enqueue(error: URLError) { lock.withLock { replies.append(Reply(data: Data(), error: error)) } }
    func consume(_ request: URLRequest) -> Reply {
        lock.withLock {
            received.append(request)
            guard !replies.isEmpty else { return Reply(data: Data(), error: URLError(.resourceUnavailable)) }
            return replies.removeFirst()
        }
    }
}

private final class MutationURLProtocol: URLProtocol, @unchecked Sendable {
    static let state = MutationStubState()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let reply = Self.state.consume(request)
        if let error = reply.error { client?.urlProtocol(self, didFailWithError: error); return }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
