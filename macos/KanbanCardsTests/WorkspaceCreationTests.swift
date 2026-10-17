import Foundation
import XCTest
@testable import KanbanCards

@MainActor
final class WorkspaceCreationTests: XCTestCase {
    private var store: CreationCredentialStore!
    private var client: KanbanAPIClient!
    private var model: AppModel!
    private var defaults: UserDefaults!
    private var suite: String!
    private var directory: URL!
    private let original = Workspace(id: "workspace-a", slug: "studio", name: "Studio",
        url: URL(string: "https://studio.kanban.cards")!)
    private let created = Workspace(id: "workspace-new", slug: "new-team", name: "New team",
        url: URL(string: "https://new-team.kanban.cards")!)

    override func setUp() async throws {
        WorkspaceCreationProtocol.state.reset()
        suite = "cards.kanban.macos.WorkspaceCreationTests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        store = CreationCredentialStore()
        client = makeClient(policy: .unrestricted)
        model = AppModel(api: client, drafts: DraftStore(directory: directory), defaults: defaults, demo: false)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }

    func testDemoCreationIsEmptyAndPreservesExistingProjectAndDraft() async throws {
        let demo = AppModel(drafts: DraftStore(directory: directory), defaults: defaults, demo: true)
        let existing = try XCTUnwrap(demo.workspaces.first)
        let project = try XCTUnwrap(demo.project(id: "demo-project", in: existing))
        var draft = CardDraft(card: try XCTUnwrap(project.cards.first))
        draft.title = "Retained unsaved title"
        try demo.drafts.save(draft, ownerID: demo.ownerID, resourceKey: "existing-card")
        XCTAssertTrue(demo.canCreateWorkspace)

        let workspace = try await demo.createWorkspace(name: " New team ", slug: " NEW-TEAM ")
        XCTAssertEqual(workspace.name, "New team")
        XCTAssertEqual(workspace.slug, "new-team")
        XCTAssertEqual(workspace.url.absoluteString, "https://new-team.demo.invalid")
        XCTAssertTrue(demo.projects(in: workspace).isEmpty)
        try await demo.loadProjects(in: workspace)
        XCTAssertEqual(demo.project(id: project.id, in: existing), project)
        XCTAssertEqual(try demo.drafts.load(ownerID: demo.ownerID, resourceKey: "existing-card", as: CardDraft.self), draft)
        do { _ = try await demo.createWorkspace(name: "Another name", slug: "new-team"); XCTFail("Duplicate address must fail.") }
        catch let error as APIError { XCTAssertEqual(error.statusCode, 409) }
        XCTAssertEqual(demo.workspaces.count, 2)
        XCTAssertTrue(WorkspaceCreationProtocol.state.requests.isEmpty)
    }

    func testCreateFromEmptyInventorySendsNativeRootRequestAndAllowsCreatedWorkspace() async throws {
        try await restore(workspaces: [])
        try enqueueCreated()
        let result = try await model.createWorkspace(name: created.name, slug: created.slug)
        XCTAssertEqual(result, created)
        XCTAssertEqual(model.workspaces, [created])
        XCTAssertFalse(model.creatingWorkspace)
        XCTAssertTrue(model.canCreateWorkspace)
        let request = try XCTUnwrap(WorkspaceCreationProtocol.state.requests.last)
        XCTAssertEqual(request.url?.absoluteString, "https://kanban.cards/api/workspaces")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer kcn_workspace_creation_test_only")
        XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        XCTAssertFalse(request.httpShouldHandleCookies)
        let body = try jsonBody(request)
        XCTAssertEqual(body as NSDictionary, ["name": "New team", "slug": "new-team"] as NSDictionary)
        WorkspaceCreationProtocol.state.enqueue(path: "/api/projects", json: #"{"projects":[]}"#)
        try await model.loadProjects(in: created)
        XCTAssertEqual(WorkspaceCreationProtocol.state.requests.last?.url?.host, "new-team.kanban.cards")
        XCTAssertTrue(model.projects(in: created).isEmpty)
    }

    func testOlderInventoryReadCannotRemoveConfirmedWorkspaceOrItsTransportAccess() async throws {
        try await restore(workspaces: [original])
        try WorkspaceCreationProtocol.state.enqueue(Inventory(workspaces: [original]), path: "/api/workspaces", held: "old-inventory")
        let refresh = Task { await model.refreshWorkspaces() }
        try await WorkspaceCreationProtocol.state.waitForStart("old-inventory")
        try enqueueCreated()
        _ = try await model.createWorkspace(name: created.name, slug: created.slug)
        try WorkspaceCreationProtocol.state.release("old-inventory")
        await refresh.value
        XCTAssertEqual(model.workspaces, [original, created])
        XCTAssertFalse(model.loadingWorkspaces)
        XCTAssertFalse(model.workspaceLoadFailed)
        WorkspaceCreationProtocol.state.enqueue(path: "/api/projects", json: #"{"projects":[]}"#)
        try await model.loadProjects(in: created)
        XCTAssertEqual(WorkspaceCreationProtocol.state.requests.last?.url?.host, created.url.host)
    }

    func testOnlyOneCreationCanRunAndLateSuccessCannotRepopulateSignedOutOwner() async throws {
        try await restore(workspaces: [original])
        try enqueueCreated(held: "create")
        let creation = Task { try await model.createWorkspace(name: created.name, slug: created.slug) }
        try await WorkspaceCreationProtocol.state.waitForStart("create")
        XCTAssertTrue(model.creatingWorkspace)
        XCTAssertFalse(model.canCreateWorkspace)
        do { _ = try await model.createWorkspace(name: "Other", slug: "other"); XCTFail("Concurrent creation must not start.") }
        catch { XCTAssertTrue(error is CancellationError) }
        WorkspaceCreationProtocol.state.enqueue(path: "/api/session", method: "DELETE",
            json: #"{"signedOutHere":true,"globalSignOutComplete":true}"#)
        await model.signOut()
        try WorkspaceCreationProtocol.state.release("create")
        do { _ = try await creation.value; XCTFail("Signed-out creation must not return private data.") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(model.workspaces.isEmpty)
        XCTAssertFalse(model.signedIn)
        XCTAssertFalse(model.creatingWorkspace)
        XCTAssertFalse(model.canCreateWorkspace)
        XCTAssertNil(store.value)
        XCTAssertEqual(WorkspaceCreationProtocol.state.requests.filter { $0.httpMethod == "POST" }.count, 1)
    }

    func testLostCreateResponseReconcilesExactOwnedWorkspaceWithoutSecondMutation() async throws {
        try await restore(workspaces: [original])
        WorkspaceCreationProtocol.state.enqueue(path: "/api/workspaces", method: "POST", json: "{}")
        try WorkspaceCreationProtocol.state.enqueue(Inventory(workspaces: [original, created]), path: "/api/workspaces")
        let result = try await model.createWorkspace(name: created.name, slug: created.slug)
        XCTAssertEqual(result, created)
        XCTAssertEqual(model.workspaces, [original, created])
        XCTAssertEqual(WorkspaceCreationProtocol.state.requests.filter { $0.httpMethod == "POST" }.count, 1)
        XCTAssertNil(model.errorMessage)
    }

    func testLostCreateResponseCannotAdoptAnAlreadyKnownIdenticalWorkspace() async throws {
        try await restore(workspaces: [original, created])
        WorkspaceCreationProtocol.state.enqueue(path: "/api/workspaces", method: "POST", json: "{}")
        try WorkspaceCreationProtocol.state.enqueue(Inventory(workspaces: [original, created]), path: "/api/workspaces")
        do { _ = try await model.createWorkspace(name: created.name, slug: created.slug); XCTFail("A known Workspace cannot confirm a new creation.") }
        catch let error as APIError { XCTAssertTrue(error.isAmbiguousMutation) }
        XCTAssertEqual(model.workspaces, [original, created])
        XCTAssertFalse(model.creatingWorkspace)

        WorkspaceCreationProtocol.state.enqueue(path: "/api/workspaces", method: "POST", status: 409,
            json: #"{"error":"Workspace address is already in use."}"#)
        try WorkspaceCreationProtocol.state.enqueue(Inventory(workspaces: [original, created]), path: "/api/workspaces")
        do { _ = try await model.createWorkspace(name: created.name, slug: created.slug); XCTFail("A retry must retain the original known-Workspace baseline.") }
        catch let error as APIError { XCTAssertEqual(error.statusCode, 409) }
        XCTAssertEqual(model.workspaces, [original, created])
        XCTAssertTrue(model.signedIn)
        XCTAssertTrue(model.canCreateWorkspace)
    }

    func testRetryAfterUncertainCreateReconcilesConflictOnlyForTheSameIntent() async throws {
        try await restore(workspaces: [original])
        WorkspaceCreationProtocol.state.enqueue(path: "/api/workspaces", method: "POST", json: "{}")
        WorkspaceCreationProtocol.state.enqueue(path: "/api/workspaces", status: 503, json: #"{"error":"Offline"}"#)
        do { _ = try await model.createWorkspace(name: created.name, slug: created.slug); XCTFail("Unconfirmed read must retain uncertainty.") }
        catch let error as APIError { XCTAssertTrue(error.isAmbiguousMutation) }
        XCTAssertEqual(model.workspaces, [original])
        // A later inventory refresh may discover the creation before its retry.
        // Recovery must still use the baseline from before the original POST.
        try WorkspaceCreationProtocol.state.enqueue(Inventory(workspaces: [original, created]), path: "/api/workspaces")
        await model.refreshWorkspaces()
        XCTAssertEqual(model.workspaces, [original, created])
        WorkspaceCreationProtocol.state.enqueue(path: "/api/workspaces", method: "POST", status: 409,
            json: #"{"error":"Workspace address is already in use."}"#)
        try WorkspaceCreationProtocol.state.enqueue(Inventory(workspaces: [original, created]), path: "/api/workspaces")
        let result = try await model.createWorkspace(name: created.name, slug: created.slug)
        XCTAssertEqual(result, created)
        XCTAssertEqual(model.workspaces, [original, created])
    }

    func testOrdinaryConflictAndQuotaFailurePreserveInventoryWithoutClaimingExistingWorkspace() async throws {
        try await restore(workspaces: [original])
        for status in [409, 403] {
            let count = WorkspaceCreationProtocol.state.requests.count
            WorkspaceCreationProtocol.state.enqueue(path: "/api/workspaces", method: "POST", status: status,
                json: #"{"error":"Creation denied"}"#)
            do { _ = try await model.createWorkspace(name: created.name, slug: created.slug); XCTFail("Creation must fail.") }
            catch let error as APIError { XCTAssertEqual(error.statusCode, status); XCTAssertFalse(error.isAmbiguousMutation) }
            XCTAssertEqual(WorkspaceCreationProtocol.state.requests.count, count + 1, "An ordinary conflict must not adopt an existing Workspace.")
            XCTAssertEqual(model.workspaces, [original])
            XCTAssertTrue(model.signedIn)
            XCTAssertTrue(model.canCreateWorkspace)
        }
    }

    func testInvalidReceiptOriginNeverReceivesBearerAndDoesNotEnterInventory() async throws {
        try await restore(workspaces: [original])
        let invalid = Workspace(id: created.id, slug: created.slug, name: created.name,
            url: URL(string: "https://new-team.kanban.cards.evil.invalid")!)
        try WorkspaceCreationProtocol.state.enqueue(Receipt(workspace: invalid), path: "/api/workspaces", method: "POST")
        try WorkspaceCreationProtocol.state.enqueue(Inventory(workspaces: [original]), path: "/api/workspaces")
        do { _ = try await model.createWorkspace(name: created.name, slug: created.slug); XCTFail("Invalid origin must fail.") }
        catch let error as APIError { XCTAssertTrue(error.isAmbiguousMutation) }
        XCTAssertEqual(model.workspaces, [original])
        XCTAssertTrue(WorkspaceCreationProtocol.state.requests.allSatisfy { $0.url?.host == "kanban.cards" })
        XCTAssertTrue(model.signedIn)
    }

    func testUnauthorizedCreationEndsSessionAndClearsPrivateInventory() async throws {
        try await restore(workspaces: [original])
        WorkspaceCreationProtocol.state.enqueue(path: "/api/workspaces", method: "POST", status: 401,
            json: #"{"error":"Session expired"}"#)
        do { _ = try await model.createWorkspace(name: created.name, slug: created.slug); XCTFail("Expired session must fail.") }
        catch { XCTAssertTrue(error is CancellationError, "An ended owner session cancels its in-flight creation.") }
        XCTAssertFalse(model.signedIn)
        XCTAssertFalse(model.creatingWorkspace)
        XCTAssertFalse(model.canCreateWorkspace)
        XCTAssertTrue(model.workspaces.isEmpty)
        XCTAssertNil(store.value)
    }

    func testInvalidNamesAndAddressesFailBeforeTransportIncludingCRLFAndUTF16Limit() async throws {
        try await restore(workspaces: [original])
        let count = WorkspaceCreationProtocol.state.requests.count
        let names = ["", "Line\r\nbreak", "Line\nbreak", "Line\rbreak", "Embedded\0null",
            String(repeating: "x", count: 121), String(repeating: "🙂", count: 61)]
        for name in names {
            do { _ = try await model.createWorkspace(name: name, slug: created.slug); XCTFail("Invalid name must fail.") }
            catch { XCTAssertTrue(error is APIError) }
        }
        for slug in ["", "auth", "api", "app", "admin", "www", "-team", "team-", "team.name", "team_name", "café", String(repeating: "x", count: 64)] {
            do { _ = try await model.createWorkspace(name: created.name, slug: slug); XCTFail("Invalid address must fail.") }
            catch { XCTAssertTrue(error is APIError) }
        }
        XCTAssertEqual(WorkspaceCreationProtocol.state.requests.count, count)
        XCTAssertEqual(model.workspaces, [original])
        XCTAssertFalse(model.creatingWorkspace)
        XCTAssertTrue(model.canCreateWorkspace)
    }

    func testVerificationPoliciesRejectWorkspaceCreationBeforeTransport() async throws {
        let policies: [LiveDataAccessPolicy] = [.readOnly,
            .testProject(workspaceURL: original.url, projectID: "test-project"),
            .createVerificationProject(workspaceURL: original.url)]
        XCTAssertTrue(LiveDataAccessPolicy.unrestricted.canCreateWorkspace)
        for policy in policies {
            XCTAssertFalse(policy.canCreateWorkspace)
            client = makeClient(policy: policy)
            model = AppModel(api: client, drafts: DraftStore(directory: directory), defaults: defaults, demo: false)
            try await restore(workspaces: [original])
            XCTAssertFalse(model.canCreateWorkspace)
            let count = WorkspaceCreationProtocol.state.requests.count
            do { _ = try await model.createWorkspace(name: created.name, slug: created.slug); XCTFail("Restricted model must reject creation.") }
            catch let error as APIError { XCTAssertTrue(error.isLocalPolicyDenial) }
            do { _ = try await client.createWorkspace(name: created.name, slug: created.slug); XCTFail("Restricted transport must reject creation.") }
            catch let error as APIError { XCTAssertTrue(error.isLocalPolicyDenial) }
            XCTAssertEqual(WorkspaceCreationProtocol.state.requests.count, count)
            XCTAssertEqual(model.workspaces, [original])
        }
    }

    private func restore(workspaces: [Workspace]) async throws {
        WorkspaceCreationProtocol.state.enqueue(path: "/api/session", json: #"{"authenticated":true,"context":"root","authenticationMethod":"native","rootUrl":"https://kanban.cards"}"#)
        try WorkspaceCreationProtocol.state.enqueue(Inventory(workspaces: workspaces), path: "/api/workspaces")
        await model.restore()
        XCTAssertTrue(model.signedIn)
    }

    private func enqueueCreated(held: String? = nil) throws {
        try WorkspaceCreationProtocol.state.enqueue(Receipt(workspace: created), path: "/api/workspaces", method: "POST", held: held)
    }

    private func makeClient(policy: LiveDataAccessPolicy) -> KanbanAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WorkspaceCreationProtocol.self]
        return KanbanAPIClient(credentialStore: store, session: URLSession(configuration: configuration), dataAccessPolicy: policy)
    }

    private func jsonBody(_ request: URLRequest) throws -> [String: Any] {
        if let data = request.httpBody { return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]) }
        let stream = try XCTUnwrap(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var data = Data()
        var bytes = [UInt8](repeating: 0, count: 512)
        while stream.hasBytesAvailable {
            let count = stream.read(&bytes, maxLength: bytes.count)
            guard count > 0 else { break }
            data.append(contentsOf: bytes.prefix(count))
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private struct Receipt: Encodable { let workspace: Workspace }
    private struct Inventory: Encodable { let workspaces: [Workspace] }
}

@MainActor
private final class CreationCredentialStore: SessionCredentialStore {
    var value: NativeSessionCredential? = NativeSessionCredential(token: "kcn_workspace_creation_test_only",
        expiresAt: ServerTimestamp.string(from: .now.addingTimeInterval(3600)), rootUrl: URL(string: "https://kanban.cards")!,
        owner: NativeOwner(id: "creation-owner", displayName: "Test", email: ""))
    func load() throws -> NativeSessionCredential? { value }
    func save(_ credential: NativeSessionCredential) throws { value = credential }
    func remove() throws { value = nil }
}

private final class WorkspaceCreationStub: @unchecked Sendable {
    struct Reply: Sendable { var status: Int; var data: Data; var held: String? }
    private let lock = NSLock()
    private var replies: [String: [Reply]] = [:]
    private var pending: [String: (WorkspaceCreationProtocol, Reply)] = [:]
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
    func start(_ instance: WorkspaceCreationProtocol) {
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

private final class WorkspaceCreationProtocol: URLProtocol, @unchecked Sendable {
    static let state = WorkspaceCreationStub()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.state.start(self) }
    override func stopLoading() { }
    func finish(_ reply: WorkspaceCreationStub.Reply) {
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.data)
        client?.urlProtocolDidFinishLoading(self)
    }
}
