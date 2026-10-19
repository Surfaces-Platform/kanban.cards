import Foundation
import XCTest
@testable import KanbanCards

@MainActor
final class SharedServerHandoffTests: XCTestCase {
    func testSI024NativeClientReadsAndSavesSharedBackend() async throws {
        guard let path = ProcessInfo.processInfo.environment["KANBAN_SHARED_HANDOFF_CONFIG"] else {
            throw XCTSkip("Opt-in isolated backend config is required; execute the separate cross-client handoff run.")
        }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let config = try JSONDecoder().decode(SharedHandoffConfiguration.self, from: data)
        let store = SharedHandoffCredentials()
        store.value = NativeSessionCredential(token: config.token, expiresAt: config.expiresAt,
            rootUrl: config.rootUrl, owner: config.owner)
        let transport = URLSessionConfiguration.ephemeral
        transport.protocolClasses = [SharedHandoffForwarder.self]
        SharedHandoffForwarder.loopback = config.loopbackUrl
        let api = KanbanAPIClient(rootURL: config.rootUrl, authURL: config.authUrl,
            credentialStore: store, session: URLSession(configuration: transport))
        let restored = try await api.restoreSession()
        XCTAssertEqual(restored?.owner?.id, config.owner.id)
        let workspaces = try await api.workspaces()
        let workspace = try XCTUnwrap(workspaces.first { $0.url == config.workspaceUrl })
        let project = try await api.project(id: config.projectId, in: workspace)
        let card = try XCTUnwrap(project.cards.first { $0.id == config.cardId })
        XCTAssertEqual(card.title, config.expectedTitle)
        var draft = CardDraft(card: card)
        if !config.writeTitle.isEmpty {
            draft.title = config.writeTitle
            let saved = try await api.updateCard(draft, projectID: project.id, in: workspace)
            XCTAssertEqual(saved.title, config.writeTitle)
            XCTAssertGreaterThan(saved.version, card.version)
            XCTAssertEqual(saved.body, card.body)
            XCTAssertEqual(saved.columnId, card.columnId)
        }
        let latestProject = try await api.project(id: config.projectId, in: workspace)
        let latest = try XCTUnwrap(latestProject.cards.first { $0.id == config.cardId })
        XCTAssertEqual(latest.title, config.writeTitle.isEmpty ? config.expectedTitle : config.writeTitle)
        XCTAssertEqual(latest.body, card.body)
        XCTAssertEqual(latest.nextAction, card.nextAction)
        XCTAssertEqual(latest.priority, card.priority)
        XCTAssertEqual(latest.columnId, card.columnId)
    }
}

private struct SharedHandoffConfiguration: Decodable {
    let loopbackUrl: URL
    let rootUrl: URL
    let authUrl: URL
    let token: String
    let expiresAt: String
    let owner: NativeOwner
    let workspaceUrl: URL
    let projectId: String
    let cardId: String
    let expectedTitle: String
    let writeTitle: String
}

@MainActor
private final class SharedHandoffCredentials: SessionCredentialStore {
    var value: NativeSessionCredential?
    func load() throws -> NativeSessionCredential? { value }
    func save(_ credential: NativeSessionCredential) throws { value = credential }
    func remove() throws { value = nil }
}

// Only the test transport is forwarded. Production clients and auth policy remain unchanged.
private final class SharedHandoffForwarder: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var loopback: URL?
    private var forwardingTask: URLSessionDataTask?
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".kanban.test") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let original = request.url, let root = Self.loopback,
              root.scheme == "http", root.host == "127.0.0.1",
              let url = URL(string: original.path + (original.query.map { "?" + $0 } ?? ""), relativeTo: root) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL)); return
        }
        var forwarded = request
        forwarded.url = url
        let host = (original.host ?? "") + (original.port.map { ":\($0)" } ?? "")
        forwarded.setValue(host, forHTTPHeaderField: "Host")
        forwarded.setValue(host, forHTTPHeaderField: "X-Forwarded-Host")
        forwarded.setValue("https", forHTTPHeaderField: "X-Forwarded-Proto")
        if forwarded.httpBody == nil, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var body = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; body.append(buffer, count: count) }
            forwarded.httpBody = body
        }
        let transport = URLSessionConfiguration.ephemeral
        transport.protocolClasses = []
        transport.httpCookieStorage = nil
        transport.httpShouldSetCookies = false
        forwardingTask = URLSession(configuration: transport).dataTask(with: forwarded) { [self] data, response, error in
            if let error { client?.urlProtocol(self, didFailWithError: error); return }
            guard let response = response as? HTTPURLResponse,
                  let restored = HTTPURLResponse(url: original, statusCode: response.statusCode,
                    httpVersion: "HTTP/1.1", headerFields: response.allHeaderFields as? [String: String]) else {
                client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return
            }
            client?.urlProtocol(self, didReceive: restored, cacheStoragePolicy: .notAllowed)
            if let data { client?.urlProtocol(self, didLoad: data) }
            client?.urlProtocolDidFinishLoading(self)
        }
        forwardingTask?.resume()
    }
    override func stopLoading() { forwardingTask?.cancel() }
}
