import Foundation
import XCTest
@testable import KanbanCards

@MainActor
final class LiveDataAccessPolicyTests: XCTestCase {
    private let rootURL = URL(string: "https://kanban.cards")!
    private let authURL = URL(string: "https://auth.kanban.cards")!
    private let workspaceURL = URL(string: "https://test.kanban.cards")!
    private let otherWorkspaceURL = URL(string: "https://other.kanban.cards")!

    func testOrdinaryLaunchAllowsEditingAndVerificationRestrictionsNeedExplicitCompleteArguments() {
        let ordinary = LiveDataAccessPolicy(arguments: ["KanbanCards"])
        XCTAssertEqual(ordinary, .unrestricted)
        XCTAssertEqual(LiveDataAccessPolicy(arguments: []), .unrestricted)
        XCTAssertTrue(ordinary.canEditProject(id: "real-project", in: workspaceURL))
        XCTAssertTrue(ordinary.canCreateProject(in: workspaceURL))
        XCTAssertEqual(LiveDataAccessPolicy(arguments: ["KanbanCards", "--live-read-only"]), .readOnly)
        XCTAssertEqual(LiveDataAccessPolicy(arguments: ["--live-read-only", "--writable-test-workspace",
            workspaceURL.absoluteString, "--writable-test-project", "test-project"]),
            .testProject(workspaceURL: workspaceURL, projectID: "test-project"))
        XCTAssertEqual(LiveDataAccessPolicy(arguments: ["--live-read-only", "--create-verification-project-in",
            workspaceURL.absoluteString]), .createVerificationProject(workspaceURL: workspaceURL))
    }

    func testMissingDuplicateConflictingOrUnknownRestrictionArgumentsFailClosed() {
        let invalid: [[String]] = [
            ["--live-read-only", "--live-read-only"],
            ["--live-read-only", "--writable-test-workspace"],
            ["--live-read-only", "--writable-test-project", "test-project"],
            ["--live-read-only", "--writable-test-workspace", workspaceURL.absoluteString],
            ["--writable-test-workspace", workspaceURL.absoluteString, "--writable-test-project", "test-project"],
            ["--create-verification-project-in", workspaceURL.absoluteString],
            ["--live-read-only", "--writable-test-workspace", workspaceURL.absoluteString,
             "--writable-test-workspace", otherWorkspaceURL.absoluteString, "--writable-test-project", "test-project"],
            ["--live-read-only", "--writable-test-workspace", workspaceURL.absoluteString,
             "--writable-test-project", "test-project", "--writable-test-project", "other-project"],
            ["--live-read-only", "--create-verification-project-in", workspaceURL.absoluteString,
             "--create-verification-project-in", otherWorkspaceURL.absoluteString],
            ["--live-read-only", "--create-verification-project-in", workspaceURL.absoluteString,
             "--writable-test-workspace", workspaceURL.absoluteString, "--writable-test-project", "test-project"],
            ["--live-read-only=false"], ["--live-read-only", "--writable-test-projec", "test-project"]
        ]
        for arguments in invalid {
            XCTAssertEqual(LiveDataAccessPolicy(arguments: arguments), .readOnly, arguments.joined(separator: " "))
        }
    }

    func testInvalidOriginsAndProjectIdentifiersFailClosed() {
        let invalidOrigins = ["http://test.kanban.cards", "https://kanban.cards", "https://auth.kanban.cards",
            "https://test.kanban.cards.evil.invalid", "https://test.kanban.cards:8443",
            "https://test.kanban.cards/api", "https://user@test.kanban.cards",
            "https://test.kanban.cards?mode=write", "https://test.kanban.cards#project", "not a URL"]
        for origin in invalidOrigins {
            XCTAssertEqual(LiveDataAccessPolicy(arguments: ["--live-read-only", "--writable-test-workspace",
                origin, "--writable-test-project", "test-project"]), .readOnly, origin)
            XCTAssertEqual(LiveDataAccessPolicy(arguments: ["--live-read-only", "--create-verification-project-in",
                origin]), .readOnly, origin)
        }
        for id in ["", ".", "..", "project/other", "project%2Fother", "project?write", " project", String(repeating: "x", count: 257)] {
            XCTAssertEqual(LiveDataAccessPolicy(arguments: ["--live-read-only", "--writable-test-workspace",
                workspaceURL.absoluteString, "--writable-test-project", id]), .readOnly, id)
        }
    }

    func testRestrictedModesRetainReadsNativeSignInAndOwnSessionSignOut() {
        let policies: [LiveDataAccessPolicy] = [.readOnly,
            .testProject(workspaceURL: workspaceURL, projectID: "test-project"),
            .createVerificationProject(workspaceURL: workspaceURL)]
        for policy in policies {
            XCTAssertTrue(permits(policy, origin: workspaceURL, path: ["projects", "real-project"], method: "GET"))
            XCTAssertTrue(permits(policy, origin: rootURL, path: ["workspaces"], method: "GET"))
            XCTAssertTrue(permits(policy, origin: workspaceURL, path: ["projects"], method: "HEAD"))
            XCTAssertTrue(permits(policy, origin: authURL, path: ["native-auth", "challenge"], method: "POST"))
            XCTAssertTrue(permits(policy, origin: authURL, path: ["native-auth", "verify"], method: "POST"))
            XCTAssertTrue(permits(policy, origin: rootURL, path: ["session"], method: "DELETE"))
            XCTAssertFalse(permits(policy, origin: workspaceURL, path: ["native-auth", "verify"], method: "POST"))
            XCTAssertFalse(permits(policy, origin: rootURL, path: ["native-auth", "challenge"], method: "POST"))
            XCTAssertFalse(permits(policy, origin: workspaceURL, path: ["session"], method: "DELETE"))
            XCTAssertFalse(permits(policy, origin: authURL, path: ["passkeys", "register"], method: "POST"))
        }
    }

    func testReadOnlyRejectsEveryBoardMutationAndCreation() {
        for method in ["POST", "PATCH", "DELETE", "PUT"] {
            XCTAssertFalse(permits(.readOnly, origin: workspaceURL, path: ["projects", "real-project"], method: method))
            XCTAssertFalse(permits(.readOnly, origin: workspaceURL,
                path: ["projects", "real-project", "cards", "card-a", "comments"], method: method))
        }
        XCTAssertFalse(permits(.readOnly, origin: workspaceURL, path: ["projects"], method: "POST",
            body: Data(#"{"name":"macOS verification"}"#.utf8)))
        XCTAssertFalse(LiveDataAccessPolicy.readOnly.canEditProject(id: "real-project", in: workspaceURL))
        XCTAssertFalse(LiveDataAccessPolicy.readOnly.canCreateProject(in: workspaceURL))
    }

    func testTestProjectAllowsOnlyExactProjectAndWorkspaceAndNeverProjectCreation() {
        let policy = LiveDataAccessPolicy.testProject(workspaceURL: workspaceURL, projectID: "test-project")
        for method in ["POST", "PATCH", "DELETE"] {
            XCTAssertTrue(permits(policy, origin: workspaceURL,
                path: ["projects", "test-project", "cards", "card-a"], method: method))
            XCTAssertFalse(permits(policy, origin: workspaceURL,
                path: ["projects", "real-project", "cards", "card-a"], method: method))
            XCTAssertFalse(permits(policy, origin: otherWorkspaceURL,
                path: ["projects", "test-project", "cards", "card-a"], method: method))
        }
        XCTAssertFalse(permits(policy, origin: workspaceURL, path: ["projects"], method: "POST",
            body: Data(#"{"name":"macOS verification"}"#.utf8)))
        XCTAssertFalse(policy.canCreateProject(in: workspaceURL))
        XCTAssertFalse(policy.canEditProject(id: "test-project-extra", in: workspaceURL))
    }

    func testCreationModeRequiresExactWorkspaceAndProjectNameAndCannotEditAnyExistingProject() {
        let policy = LiveDataAccessPolicy.createVerificationProject(workspaceURL: workspaceURL)
        let exact = Data(#"{"name":"macOS verification","description":"Synthetic verification data"}"#.utf8)
        XCTAssertTrue(permits(policy, origin: workspaceURL, path: ["projects"], method: "POST", body: exact))
        XCTAssertFalse(permits(policy, origin: otherWorkspaceURL, path: ["projects"], method: "POST", body: exact))
        XCTAssertFalse(permits(policy, origin: workspaceURL, path: ["projects", "existing"], method: "PATCH", body: exact))
        XCTAssertFalse(permits(policy, origin: workspaceURL, path: ["projects", "existing", "cards"], method: "POST", body: exact))
        for body in [nil, Data(), Data("[]".utf8), Data(#"{"name":"macOS verification "}"#.utf8),
                     Data(#"{"name":"MacOS verification"}"#.utf8), Data(#"{"name":"Real board"}"#.utf8)] {
            XCTAssertFalse(permits(policy, origin: workspaceURL, path: ["projects"], method: "POST", body: body))
        }
        XCTAssertEqual(policy.requiredProjectCreationName, "macOS verification")
        XCTAssertTrue(policy.canCreateProject(in: workspaceURL))
        XCTAssertFalse(policy.canCreateProject(in: otherWorkspaceURL))
        XCTAssertFalse(policy.canEditProject(id: "test-project", in: workspaceURL))
    }

    func testReadOnlyClientBlocksMutationsBeforeURLSessionWhileReadsAndSignOutReachTransport() async throws {
        LivePolicyURLProtocol.state.reset()
        let store = LivePolicyCredentialStore(rootURL: rootURL)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LivePolicyURLProtocol.self]
        let client = KanbanAPIClient(credentialStore: store, session: URLSession(configuration: configuration),
            dataAccessPolicy: .readOnly)
        _ = try await client.restoreSession()
        let workspaces = try await client.workspaces()
        let workspace = try XCTUnwrap(workspaces.first)
        XCTAssertEqual(LivePolicyURLProtocol.state.requests.count, 2)

        var draft = ProjectDraft(name: "Real Project", description: "Retained")
        do {
            _ = try await client.createProject(draft, in: workspace, idempotencyKey: "creation")
            XCTFail("Read-only creation must be rejected.")
        } catch let error as APIError { XCTAssertTrue(error.isLocalPolicyDenial); XCTAssertNil(error.statusCode) }
        draft.id = "real-project"
        draft.revision = 1
        do {
            _ = try await client.updateProject(draft, in: workspace)
            XCTFail("Read-only editing must be rejected.")
        } catch let error as APIError { XCTAssertTrue(error.isLocalPolicyDenial); XCTAssertNil(error.statusCode) }
        do {
            _ = try await client.addComment(body: "Do not send", cardID: "card-a",
                projectID: "real-project", in: workspace, idempotencyKey: "comment")
            XCTFail("Read-only Comments must be rejected.")
        } catch let error as APIError { XCTAssertTrue(error.isLocalPolicyDenial); XCTAssertNil(error.statusCode) }

        XCTAssertEqual(LivePolicyURLProtocol.state.requests.count, 2, "No rejected mutation may reach URLSession.")
        try await client.signOut()
        XCTAssertEqual(LivePolicyURLProtocol.state.requests.last?.httpMethod, "DELETE")
        XCTAssertEqual(LivePolicyURLProtocol.state.requests.last?.url?.path, "/api/session")
        XCTAssertNil(store.value)
    }

    func testOrdinaryLaunchSendsMutationsToServerAuthorization() async throws {
        LivePolicyURLProtocol.state.reset()
        let client = makeClient(policy: LiveDataAccessPolicy(arguments: ["KanbanCards"]))
        _ = try await client.restoreSession()
        let workspaces = try await client.workspaces()
        let workspace = try XCTUnwrap(workspaces.first)
        let readRequestCount = LivePolicyURLProtocol.state.requests.count

        var draft = ProjectDraft(name: "Real Project", description: "Retained")
        do {
            _ = try await client.createProject(draft, in: workspace, idempotencyKey: "creation")
            XCTFail("The stub server denies this request.")
        } catch let error as APIError {
            XCTAssertEqual(error.statusCode, 403)
            XCTAssertFalse(error.isLocalPolicyDenial)
        }
        draft.id = "real-project"
        draft.revision = 1
        do {
            _ = try await client.updateProject(draft, in: workspace)
            XCTFail("The stub server denies this request.")
        } catch let error as APIError {
            XCTAssertEqual(error.statusCode, 403)
            XCTAssertFalse(error.isLocalPolicyDenial)
        }
        do {
            _ = try await client.addComment(body: "Synthetic Comment", cardID: "card-a",
                projectID: "real-project", in: workspace, idempotencyKey: "comment")
            XCTFail("The stub server denies this request.")
        } catch let error as APIError {
            XCTAssertEqual(error.statusCode, 403)
            XCTAssertFalse(error.isLocalPolicyDenial)
        }

        let mutations = Array(LivePolicyURLProtocol.state.requests.dropFirst(readRequestCount))
        XCTAssertEqual(mutations.map(\.httpMethod), ["POST", "PATCH", "POST"])
        XCTAssertEqual(mutations.map { $0.url?.path }, ["/api/projects", "/api/projects/real-project",
            "/api/projects/real-project/cards/card-a/comments"])
    }

    func testOrdinaryLiveAppModelRelaunchKeepsEditingWhileDemoAndInjectedClientsRetainTheirPolicy() throws {
        let suite = "cards.kanban.macos.PolicyLaunchTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: directory)
        }
        let firstLaunch = AppModel(drafts: DraftStore(directory: directory), defaults: defaults, demo: false)
        let ordinaryRelaunch = AppModel(drafts: DraftStore(directory: directory), defaults: defaults, demo: false)
        XCTAssertEqual(firstLaunch.dataAccessPolicy, .unrestricted)
        XCTAssertEqual(ordinaryRelaunch.dataAccessPolicy, .unrestricted)

        let demo = AppModel(drafts: DraftStore(directory: directory), defaults: defaults, demo: true)
        XCTAssertEqual(demo.dataAccessPolicy, .unrestricted)
        let injectedClient = KanbanAPIClient(credentialStore: LivePolicyCredentialStore(rootURL: rootURL))
        let injected = AppModel(api: injectedClient, drafts: DraftStore(directory: directory), defaults: defaults, demo: false)
        XCTAssertEqual(injected.dataAccessPolicy, .unrestricted)
    }

    func testLocalPolicyDenialRetainsReadableProjectInventoryAndWorkspace() async throws {
        LivePolicyURLProtocol.state.reset()
        let suite = "cards.kanban.macos.PolicyCacheTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: directory)
        }
        let model = AppModel(api: makeClient(policy: .readOnly), drafts: DraftStore(directory: directory),
            defaults: defaults, demo: false)
        await model.restore()
        let workspace = try XCTUnwrap(model.workspaces.first)
        try await model.loadProjects(in: workspace)
        try await model.loadProject(id: "real-project", in: workspace)
        let original = try XCTUnwrap(model.project(id: "real-project", in: workspace))
        let inventory = model.projects(in: workspace)
        let requestCount = LivePolicyURLProtocol.state.requests.count

        var edited = ProjectDraft(project: original)
        edited.name = "Do not send this change"
        do {
            _ = try await model.saveProject(edited, in: workspace, key: "denied-existing")
            XCTFail("A local policy must reject this edit.")
        } catch let error as APIError {
            XCTAssertTrue(error.isLocalPolicyDenial)
            XCTAssertNil(error.statusCode)
        }
        XCTAssertEqual(model.project(id: original.id, in: workspace), original)
        XCTAssertEqual(model.projects(in: workspace), inventory)

        do {
            _ = try await model.saveProject(ProjectDraft(name: "macOS verification", description: "Do not create"),
                in: workspace, key: "denied-creation")
            XCTFail("Read-only mode must reject creation too.")
        } catch let error as APIError { XCTAssertTrue(error.isLocalPolicyDenial) }
        XCTAssertEqual(model.project(id: original.id, in: workspace), original)
        XCTAssertEqual(model.projects(in: workspace), inventory)
        XCTAssertEqual(model.workspaces, [workspace])
        XCTAssertTrue(model.signedIn)
        XCTAssertEqual(LivePolicyURLProtocol.state.requests.count, requestCount)
    }

    func testServerForbiddenStillEvictsInaccessibleProject() async throws {
        LivePolicyURLProtocol.state.reset()
        let suite = "cards.kanban.macos.PolicyServerDenialTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: directory)
        }
        let model = AppModel(api: makeClient(policy: .unrestricted), drafts: DraftStore(directory: directory),
            defaults: defaults, demo: false)
        await model.restore()
        let workspace = try XCTUnwrap(model.workspaces.first)
        try await model.loadProject(id: "real-project", in: workspace)
        let original = try XCTUnwrap(model.project(id: "real-project", in: workspace))
        let requestCount = LivePolicyURLProtocol.state.requests.count
        do {
            _ = try await model.saveProject(ProjectDraft(project: original), in: workspace, key: "server-denied")
            XCTFail("The stub server denies this request.")
        } catch let error as APIError {
            XCTAssertEqual(error.statusCode, 403)
            XCTAssertFalse(error.isLocalPolicyDenial)
        }
        XCTAssertNil(model.project(id: original.id, in: workspace))
        XCTAssertTrue(model.projects(in: workspace).isEmpty)
        XCTAssertEqual(LivePolicyURLProtocol.state.requests.count, requestCount + 1)
    }

    private func makeClient(policy: LiveDataAccessPolicy) -> KanbanAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LivePolicyURLProtocol.self]
        return KanbanAPIClient(credentialStore: LivePolicyCredentialStore(rootURL: rootURL),
            session: URLSession(configuration: configuration), dataAccessPolicy: policy)
    }

    private func permits(_ policy: LiveDataAccessPolicy, origin: URL, path: [String],
                         method: String, body: Data? = nil) -> Bool {
        policy.permitsRequest(origin: origin, path: path, method: method, body: body,
            rootURL: rootURL, authURL: authURL)
    }
}

@MainActor
private final class LivePolicyCredentialStore: SessionCredentialStore {
    var value: NativeSessionCredential?
    init(rootURL: URL) {
        value = NativeSessionCredential(token: "kcn_local_policy_test_only",
            expiresAt: ServerTimestamp.string(from: .now.addingTimeInterval(3600)), rootUrl: rootURL,
            owner: NativeOwner(id: "policy-owner", displayName: "Test", email: ""))
    }
    func load() throws -> NativeSessionCredential? { value }
    func save(_ credential: NativeSessionCredential) throws { value = credential }
    func remove() throws { value = nil }
}

private final class LivePolicyRequestState: @unchecked Sendable {
    private let lock = NSLock()
    private var received: [URLRequest] = []
    var requests: [URLRequest] { lock.withLock { received } }
    func reset() { lock.withLock { received = [] } }
    func record(_ request: URLRequest) { lock.withLock { received.append(request) } }
}

private final class LivePolicyURLProtocol: URLProtocol, @unchecked Sendable {
    static let state = LivePolicyRequestState()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.state.record(request)
        let json: String
        let status: Int
        switch (request.httpMethod, request.url?.path) {
        case ("GET", "/api/session"):
            status = 200
            json = #"{"authenticated":true,"context":"root","authenticationMethod":"native","rootUrl":"https://kanban.cards"}"#
        case ("GET", "/api/workspaces"):
            status = 200
            json = #"{"workspaces":[{"id":"policy-workspace","slug":"test","name":"Test","url":"https://test.kanban.cards"}]}"#
        case ("GET", "/api/projects"):
            status = 200
            json = #"{"projects":[{"id":"real-project","name":"Real Project","description":"Saved data","revision":1,"createdAt":"2026-10-13T12:00:00.000Z","updatedAt":"2026-10-13T12:00:00.000Z","cardCount":0}]}"#
        case ("GET", "/api/projects/real-project"):
            status = 200
            json = #"{"project":{"id":"real-project","name":"Real Project","description":"Saved data","columns":[],"cards":[],"activity":[],"revision":1,"createdAt":"2026-10-13T12:00:00.000Z","updatedAt":"2026-10-13T12:00:00.000Z"}}"#
        case ("DELETE", "/api/session"):
            status = 200
            json = #"{"signedOutHere":true,"globalSignOutComplete":true}"#
        default:
            status = 403
            json = #"{"error":"Server denied Project access"}"#
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
