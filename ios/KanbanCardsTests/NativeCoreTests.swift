import Foundation
import XCTest
@testable import KanbanCards

@MainActor
final class NativeCoreTests: XCTestCase {
    private var store: MemoryCredentialStore!
    private var client: KanbanAPIClient!
    private let workspace = Workspace(id: "workspace-a", slug: "test", name: "Test",
        url: URL(string: "https://test.kanban.cards")!)

    override func setUp() async throws {
        URLProtocolStub.state.reset()
        store = MemoryCredentialStore()
        store.value = NativeSessionCredential(token: "kcn_test_only", expiresAt: ServerTimestamp.string(from: .now.addingTimeInterval(3600)),
            rootUrl: URL(string: "https://kanban.cards")!, owner: NativeOwner(id: "owner-a", displayName: "Test", email: ""))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolStub.self]
        client = KanbanAPIClient(credentialStore: store, session: URLSession(configuration: configuration))
    }

    private func authenticate() async throws {
        URLProtocolStub.state.enqueue(json: #"{"authenticated":true,"context":"root","authenticationMethod":"native","rootUrl":"https://kanban.cards"}"#)
        URLProtocolStub.state.enqueue(json: #"{"workspaces":[{"id":"workspace-a","slug":"test","name":"Test","url":"https://test.kanban.cards"}]}"#)
        let session = try await client.restoreSession()
        XCTAssertEqual(session?.owner?.id, "owner-a")
        _ = try await client.workspaces()
    }

    func testCardPatchUsesVersionAndEditableFieldsAndPreservesBody() async throws {
        try await authenticate()
        URLProtocolStub.state.enqueue(json: Self.cardResult)
        var draft = CardDraft(columnId: "custom-column")
        draft.id = "card-a"
        draft.version = 7
        draft.title = "Edited"
        draft.body = "  # Source\n\n- Keep whitespace  \n"
        draft.position = 999
        draft.archivedAt = "2026-10-10T20:00:00.000Z"
        _ = try await client.updateCard(draft, projectID: "project-a", in: workspace)

        let request = try XCTUnwrap(URLProtocolStub.state.requests.last)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.absoluteString, "https://test.kanban.cards/api/projects/project-a/cards/card-a")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Kanban-Version"), "7")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer kcn_test_only")
        XCTAssertNil(request.value(forHTTPHeaderField: "If-Match"))
        XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
        XCTAssertFalse(request.httpShouldHandleCookies)
        let body = try jsonBody(request)
        XCTAssertEqual(body["body"] as? String, draft.body)
        XCTAssertTrue(body["priority"] is NSNull)
        XCTAssertTrue(body["nextActor"] is NSNull)
        XCTAssertNil(body["archivedAt"])
        XCTAssertNil(body["columnId"], "Existing-Card text Save must not move the Card.")
        XCTAssertNil(body["position"])
        XCTAssertNil(body["externalKey"])
        XCTAssertNil(body["id"])
        XCTAssertNil(body["version"])
    }

    func testWorkspaceActivityUsesValidatedOriginAndPreservesActorAndArchivedContext() async throws {
        try await authenticate()
        URLProtocolStub.state.enqueue(json: #"{"activity":[{"id":"event-a","action":"card.updated","actor":{"channel":"api","label":"Claude Research (pilot)","agentConnectionId":"agent-a"},"summary":"Updated a Card.","projectId":"project-a","cardId":"card-a","createdAt":"2026-10-19T23:00:00.000Z","projectName":"Archived research","projectArchivedAt":"2026-10-19T22:00:00.000Z","cardTitle":"Research"}],"nextCursor":"older-cursor"}"#)
        let cursor = "opaque+/=cursor"
        let result = try await client.workspaceActivity(in: workspace, cursor: cursor)
        let request = try XCTUnwrap(URLProtocolStub.state.requests.last)
        XCTAssertEqual(request.url?.host, "test.kanban.cards")
        XCTAssertEqual(request.url?.path, "/api/activity")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer kcn_test_only")
        let query = try XCTUnwrap(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(query.first { $0.name == "limit" }?.value, "50")
        XCTAssertEqual(query.first { $0.name == "cursor" }?.value, cursor)
        let event = try XCTUnwrap(result.activity.first)
        XCTAssertEqual(event.actor.label, "Claude Research (pilot)")
        XCTAssertEqual(event.actor.agentConnectionId, "agent-a")
        XCTAssertEqual(event.projectName, "Archived research")
        XCTAssertNotNil(event.projectArchivedAt)
        XCTAssertEqual(event.cardTitle, "Research")
        XCTAssertEqual(result.nextCursor, "older-cursor")
    }

    func testWorkspaceActivityFirstPageHasNoCursorAndRejectsUnlistedOrigin() async throws {
        try await authenticate()
        URLProtocolStub.state.enqueue(json: #"{"activity":[],"nextCursor":null}"#)
        let page = try await client.workspaceActivity(in: workspace)
        XCTAssertTrue(page.activity.isEmpty)
        XCTAssertNil(page.nextCursor)
        let request = try XCTUnwrap(URLProtocolStub.state.requests.last)
        XCTAssertEqual(request.url?.query, "limit=50")
        let count = URLProtocolStub.state.requests.count
        let other = Workspace(id: "other", slug: "other", name: "Other", url: URL(string: "https://other.kanban.cards")!)
        do { _ = try await client.workspaceActivity(in: other); XCTFail("Unlisted Workspace must not receive a bearer.") }
        catch is APIError { }
        XCTAssertEqual(URLProtocolStub.state.requests.count, count)
    }

    func testSI005MovePatchContainsOnlyDestinationAndOptionalOrder() async throws {
        try await authenticate()
        URLProtocolStub.state.enqueue(json: Self.cardResult)
        var card = try JSONDecoder().decode(CardResultForMove.self, from: Data(Self.cardResult.utf8)).card
        card.version = 7
        _ = try await client.moveCard(card, to: "done", position: 3, projectID: "project-a", in: workspace)
        let request = try XCTUnwrap(URLProtocolStub.state.requests.last)
        let payload = try jsonBody(request)
        XCTAssertEqual(Set(payload.keys), ["columnId", "position"])
        XCTAssertEqual(payload["columnId"] as? String, "done")
        XCTAssertEqual(payload["position"] as? Double, 3)
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Kanban-Version"), "7")
        XCTAssertNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
    }

    private struct CardResultForMove: Decodable { var card: Card }

    func testProjectMetadataPatchCannotOverwriteHiddenColumnsOrArchiveState() async throws {
        try await authenticate()
        URLProtocolStub.state.enqueue(json: Self.projectResult)
        var draft = ProjectDraft(name: "Edited", description: "Updated description")
        draft.id = "project-a"
        draft.revision = 4
        draft.columns = [Column(id: "old-column", name: "Old name", position: 99)]
        draft.archivedAt = "2026-10-10T20:00:00.000Z"
        _ = try await client.updateProject(draft, in: workspace)
        let request = try XCTUnwrap(URLProtocolStub.state.requests.last)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Kanban-Version"), "4")
        let body = try jsonBody(request)
        XCTAssertEqual(body.count, 2)
        XCTAssertEqual(body["name"] as? String, "Edited")
        XCTAssertEqual(body["description"] as? String, "Updated description")
        XCTAssertNil(body["columns"])
        XCTAssertNil(body["archivedAt"])
    }

    func testCreationKeepsFrozenPositionAndExternalKey() async throws {
        try await authenticate()
        URLProtocolStub.state.enqueue(json: Self.cardResult)
        var draft = CardDraft(columnId: "custom-column")
        draft.title = "New Card"
        draft.position = 12
        draft.externalKey = "native-draft:test"
        _ = try await client.createCard(draft, projectID: "project-a", in: workspace, idempotencyKey: "frozen-create")
        let request = try XCTUnwrap(URLProtocolStub.state.requests.last)
        let body = try jsonBody(request)
        XCTAssertEqual(body["position"] as? Double, 12)
        XCTAssertEqual(body["externalKey"] as? String, "native-draft:test")
        XCTAssertNil(body["archivedAt"])
        XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "frozen-create")
    }

    func testCommentTimeoutDoesNotAutomaticallyRetryAndKeepsCallerKey() async throws {
        try await authenticate()
        URLProtocolStub.state.enqueue(error: URLError(.timedOut))
        let body = "The same comment"
        do {
            _ = try await client.addComment(body: body, cardID: "card-a", projectID: "project-a", in: workspace, idempotencyKey: "same-post")
            XCTFail("A timeout must not look like a confirmed save.")
        } catch let error as APIError { XCTAssertTrue(error.isAmbiguousMutation) }
        XCTAssertEqual(URLProtocolStub.state.requests.count, 3)
        URLProtocolStub.state.enqueue(json: #"{"comment":{"id":"comment-a","body":"The same comment","author":"Test","createdAt":"2026-10-11T20:00:00.000Z"},"card":{"id":"card-a","version":8},"projectRevision":9}"#)
        let result = try await client.addComment(body: body, cardID: "card-a", projectID: "project-a", in: workspace, idempotencyKey: "same-post")
        XCTAssertEqual(result.card.version, 8)
        let requests = URLProtocolStub.state.requests.suffix(2)
        XCTAssertEqual(requests.map { $0.value(forHTTPHeaderField: "Idempotency-Key") }, ["same-post", "same-post"])
        XCTAssertEqual(try jsonBody(requests.first!)["body"] as? String, body)
        XCTAssertEqual(try jsonBody(requests.last!)["body"] as? String, body)
    }

    func testConflictIsReportedWithoutChangingDraftVersion() async throws {
        try await authenticate()
        URLProtocolStub.state.enqueue(status: 409, json: #"{"error":"Card changed. Reload and try again."}"#)
        var draft = CardDraft(columnId: "custom-column")
        draft.id = "card-a"
        draft.version = 3
        draft.body = "Unsaved work"
        do {
            _ = try await client.updateCard(draft, projectID: "project-a", in: workspace)
            XCTFail("The caller must reconcile a stale draft.")
        } catch let error as APIError {
            XCTAssertTrue(error.isConflict)
            XCTAssertFalse(error.isAmbiguousMutation)
        }
        XCTAssertEqual(draft.version, 3)
        XCTAssertEqual(draft.body, "Unsaved work")
        XCTAssertEqual(URLProtocolStub.state.requests.count, 3)
    }

    func testRevokedSessionClearsCredentialBeforeAnyFurtherRequest() async throws {
        try await authenticate()
        URLProtocolStub.state.enqueue(status: 401, json: #"{"error":"Sign in again."}"#)
        do { _ = try await client.project(id: "project-a", in: workspace); XCTFail() }
        catch let error as APIError { XCTAssertTrue(error.isUnauthorized) }
        XCTAssertNil(store.value)
        XCTAssertNil(client.credential)
        let count = URLProtocolStub.state.requests.count
        do { _ = try await client.workspaces(); XCTFail() }
        catch let error as APIError { XCTAssertTrue(error.isUnauthorized) }
        XCTAssertEqual(URLProtocolStub.state.requests.count, count)
    }

    func testExpiredSessionIsRemovedWithoutARequest() async throws {
        store.value?.expiresAt = ServerTimestamp.string(from: .now.addingTimeInterval(-10))
        let result = try await client.restoreSession()
        XCTAssertNil(result)
        XCTAssertNil(store.value)
        XCTAssertTrue(URLProtocolStub.state.requests.isEmpty)
    }

    func testUnlistedAndForeignWorkspaceOriginsNeverReceiveCredential() async throws {
        try await authenticate()
        let foreign = Workspace(id: "other", slug: "other", name: "Other", url: URL(string: "https://attacker.example")!)
        let unlisted = Workspace(id: "other", slug: "other", name: "Other", url: URL(string: "https://other.kanban.cards")!)
        for candidate in [foreign, unlisted] {
            do { _ = try await client.projects(in: candidate); XCTFail() }
            catch is APIError { }
        }
        XCTAssertEqual(URLProtocolStub.state.requests.count, 2)
    }

    func testRestoreArchiveSendsNullWithCurrentVersion() async throws {
        try await authenticate()
        URLProtocolStub.state.enqueue(json: Self.cardResult)
        let decoded = try JSONDecoder().decode(CardEnvelope.self, from: Data(Self.cardResult.utf8)).card
        _ = try await client.archiveCard(card: decoded, archived: false, projectID: "project-a", in: workspace)
        let request = try XCTUnwrap(URLProtocolStub.state.requests.last)
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Kanban-Version"), "8")
        let body = try jsonBody(request)
        XCTAssertEqual(body.count, 1)
        XCTAssertTrue(body["archivedAt"] is NSNull)
    }

    func testChallengeUsesNativeRouteWithoutSessionHeaders() async throws {
        URLProtocolStub.state.enqueue(json: #"{"challengeId":"challenge-a","ceremonyToken":"secret-test","relyingPartyIdentifier":"auth.kanban.cards","challenge":"AQID","expiresAt":"2027-10-11T20:00:00.000Z"}"#)
        let result = try await client.beginSignIn()
        XCTAssertEqual(result.relyingPartyIdentifier, "auth.kanban.cards")
        let request = try XCTUnwrap(URLProtocolStub.state.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "https://auth.kanban.cards/api/native-auth/challenge")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
        XCTAssertFalse(request.httpShouldHandleCookies)
    }

    func testNativeVerificationPreservesSystemAssertionAndStoresOwnerSession() async throws {
        let expiry = ServerTimestamp.string(from: .now.addingTimeInterval(3600))
        URLProtocolStub.state.enqueue(json: """
        {"authenticated":true,"tokenType":"Bearer","token":"kcn_verified_test","expiresAt":"\(expiry)","rootUrl":"https://kanban.cards","owner":{"id":"owner-b","displayName":"Owner B","email":""}}
        """)
        let challenge = NativeSignInChallenge(challengeId: "challenge-a", ceremonyToken: "test-ceremony",
            relyingPartyIdentifier: "auth.kanban.cards", challenge: "AQID", expiresAt: expiry)
        let assertion = NativePasskeyAssertion(id: "AQID", rawId: "AQID", response: .init(
            authenticatorData: "BAUG", clientDataJSON: "BwgJ", signature: "CgsM", userHandle: "DQ4P"))
        let session = try await client.completeSignIn(challenge: challenge, assertion: assertion)
        XCTAssertEqual(session.owner?.id, "owner-b")
        XCTAssertEqual(store.value?.token, "kcn_verified_test")
        let request = try XCTUnwrap(URLProtocolStub.state.requests.last)
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        let body = try jsonBody(request)
        XCTAssertEqual(body["ceremonyToken"] as? String, "test-ceremony")
        let credential = try XCTUnwrap(body["response"] as? [String: Any])
        XCTAssertEqual(credential["rawId"] as? String, "AQID")
        XCTAssertEqual(credential["type"] as? String, "public-key")
        XCTAssertNotNil(credential["clientExtensionResults"] as? [String: Any])
        let response = try XCTUnwrap(credential["response"] as? [String: Any])
        XCTAssertEqual(response["clientDataJSON"] as? String, "BwgJ")
        XCTAssertEqual(response["signature"] as? String, "CgsM")
        XCTAssertEqual(response["userHandle"] as? String, "DQ4P")
    }

    func testSignOutTimeoutRetainsSessionForRevocationRetry() async throws {
        try await authenticate()
        URLProtocolStub.state.enqueue(error: URLError(.timedOut))
        do { try await client.signOut(); XCTFail() }
        catch let error as APIError { XCTAssertTrue(error.isAmbiguousMutation) }
        XCTAssertNotNil(client.credential)
        XCTAssertNotNil(store.value)
        URLProtocolStub.state.enqueue(json: #"{"signedOutHere":true,"globalSignOutComplete":true}"#)
        try await client.signOut()
        XCTAssertNil(client.credential)
        XCTAssertNil(store.value)
        XCTAssertEqual(URLProtocolStub.state.requests.last?.httpMethod, "DELETE")
    }

    func testDraftOwnerIsolationAndWhitespaceRetention() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let drafts = DraftStore(directory: directory)
        var draft = CardDraft(columnId: "custom-column")
        draft.id = "card-a"
        draft.version = 4
        draft.body = "  ## source\n\n\tcontent  \n"
        try drafts.save(draft, ownerID: "owner-a", resourceKey: "workspace-a/project-a/card-a")
        let saved = try drafts.load(ownerID: "owner-a", resourceKey: "workspace-a/project-a/card-a", as: CardDraft.self)
        XCTAssertEqual(saved, draft)
        XCTAssertNil(try drafts.load(ownerID: "owner-b", resourceKey: "workspace-a/project-a/card-a", as: CardDraft.self))
        try drafts.removeAll(ownerID: "owner-a")
        XCTAssertNil(try drafts.load(ownerID: "owner-a", resourceKey: "workspace-a/project-a/card-a", as: CardDraft.self))
    }

    func testPasskeyBytesUseUnpaddedBase64URL() {
        let bytes = Data([0, 255, 254, 253, 250])
        let encoded = bytes.base64URLEncodedString()
        XCTAssertFalse(encoded.contains("="))
        XCTAssertFalse(encoded.contains("+"))
        XCTAssertFalse(encoded.contains("/"))
        XCTAssertEqual(Data(base64URL: encoded), bytes)
        XCTAssertNil(Data(base64URL: "AQID!"))
        XCTAssertNil(Data(base64URL: "AQID="))
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

    private struct CardEnvelope: Decodable { var card: Card }
    private static let cardResult = #"{"card":{"id":"card-a","title":"Edited","body":"Source","nextActor":null,"nextAction":"","priority":null,"blockedReason":"","columnId":"custom-column","position":0,"version":8,"archivedAt":null,"createdAt":"2026-10-11T20:00:00.000Z","updatedAt":"2026-10-11T20:01:00.000Z","comments":[]},"projectRevision":9}"#
    private static let projectResult = #"{"project":{"id":"project-a","name":"Edited","description":"Updated description","columns":[{"id":"current-column","name":"Current name","position":0}],"cards":[],"activity":[],"revision":5,"archivedAt":null,"createdAt":"2026-10-11T20:00:00.000Z","updatedAt":"2026-10-11T20:01:00.000Z"}}"#
}

@MainActor
private final class MemoryCredentialStore: SessionCredentialStore {
    var value: NativeSessionCredential?
    func load() throws -> NativeSessionCredential? { value }
    func save(_ credential: NativeSessionCredential) throws { value = credential }
    func remove() throws { value = nil }
}

private final class StubState: @unchecked Sendable {
    struct Reply: Sendable { var status: Int; var data: Data; var error: URLError? }
    private let lock = NSLock()
    private var queue: [Reply] = []
    private var received: [URLRequest] = []
    var requests: [URLRequest] { lock.withLock { received } }
    func reset() { lock.withLock { queue = []; received = [] } }
    func enqueue(status: Int = 200, json: String) {
        lock.withLock { queue.append(Reply(status: status, data: Data(json.utf8), error: nil)) }
    }
    func enqueue(error: URLError) {
        lock.withLock { queue.append(Reply(status: 0, data: Data(), error: error)) }
    }
    func consume(_ request: URLRequest) -> Reply {
        lock.withLock {
            received.append(request)
            guard !queue.isEmpty else { return Reply(status: 500, data: Data(), error: nil) }
            return queue.removeFirst()
        }
    }
}

private final class URLProtocolStub: URLProtocol, @unchecked Sendable {
    static let state = StubState()
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
    override func stopLoading() { }
}
