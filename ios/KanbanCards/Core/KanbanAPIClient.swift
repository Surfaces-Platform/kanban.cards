import Foundation

struct APIError: LocalizedError, Sendable {
    let message: String
    var statusCode: Int? = nil
    var isAmbiguousMutation = false
    var sessionGeneration: UUID? = nil
    var isConflict: Bool { statusCode == 409 || statusCode == 412 }
    var isUnauthorized: Bool { statusCode == 401 }
    var errorDescription: String? { message }
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class KanbanAPIClient {
    private let rootURL: URL
    private let authURL: URL
    private let session: URLSession
    private let credentialStore: any SessionCredentialStore
    private var workspaceOrigins = Set<URL>()
    private var workspaceRequestID: UUID?
    private(set) var credential: NativeSessionCredential?
    private(set) var sessionGeneration = UUID()

    init(rootURL: URL = URL(string: "https://kanban.cards")!,
         authURL: URL = URL(string: "https://auth.kanban.cards")!,
         credentialStore: any SessionCredentialStore = KeychainSessionStore(),
         session: URLSession? = nil) {
        self.rootURL = rootURL
        self.authURL = authURL
        self.credentialStore = credentialStore
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpShouldSetCookies = false
            configuration.httpCookieStorage = nil
            configuration.urlCredentialStorage = nil
            configuration.urlCache = nil
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.timeoutIntervalForRequest = 30
            self.session = URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
        }
    }

    func restoreSession() async throws -> NativeSessionInfo? {
        guard let stored = try credentialStore.load() else {
            credential = nil
            workspaceOrigins.removeAll()
            sessionGeneration = UUID()
            return nil
        }
        guard stored.rootUrl == rootURL,
              let expiry = ServerTimestamp.date(from: stored.expiresAt), expiry > .now else {
            try invalidateCredential()
            return nil
        }
        credential = stored
        workspaceOrigins.removeAll()
        sessionGeneration = UUID()
        let generation = sessionGeneration
        do {
            var result: NativeSessionInfo = try await request(origin: rootURL, path: ["session"])
            guard generation == sessionGeneration else { throw CancellationError() }
            guard result.authenticated, result.authenticationMethod == "native", result.rootUrl == rootURL else {
                try invalidateCredential()
                return nil
            }
            result.owner = stored.owner
            return result
        } catch let error as APIError where error.isUnauthorized {
            return nil
        }
    }

    func beginSignIn() async throws -> NativeSignInChallenge {
        try await request(origin: authURL, path: ["native-auth", "challenge"], method: "POST",
                          body: Data("{}".utf8), authorized: false)
    }

    func completeSignIn(challenge: NativeSignInChallenge,
                        assertion: NativePasskeyAssertion) async throws -> NativeSessionInfo {
        struct Verification: Encodable {
            var challengeId: String
            var ceremonyToken: String
            var response: NativePasskeyAssertion
        }
        struct Result: Decodable {
            var authenticated: Bool
            var tokenType: String
            var token: String
            var expiresAt: String
            var rootUrl: URL
            var owner: NativeOwner
        }
        let generation = sessionGeneration
        let result: Result = try await request(origin: authURL, path: ["native-auth", "verify"], method: "POST",
            body: encode(Verification(challengeId: challenge.challengeId,
                ceremonyToken: challenge.ceremonyToken, response: assertion)), authorized: false)
        guard generation == sessionGeneration else { throw CancellationError() }
        guard result.authenticated, result.tokenType == "Bearer", result.rootUrl == rootURL,
              result.token.hasPrefix("kcn_"),
              let expiry = ServerTimestamp.date(from: result.expiresAt), expiry > .now else {
            throw APIError(message: "The sign-in response could not be verified. Try signing in again.")
        }
        let stored = NativeSessionCredential(token: result.token, expiresAt: result.expiresAt,
            rootUrl: result.rootUrl, owner: result.owner)
        try credentialStore.save(stored)
        credential = stored
        workspaceOrigins.removeAll()
        sessionGeneration = UUID()
        return NativeSessionInfo(authenticated: true, context: "root", authMode: "passkey",
            authenticationMethod: "native", label: result.owner.displayName, email: result.owner.email,
            expiresAt: result.expiresAt, rootUrl: result.rootUrl, workspace: nil, owner: result.owner)
    }

    func signOut() async throws {
        // Obsolete board requests cannot repopulate state while revocation is pending.
        sessionGeneration = UUID()
        let generation = sessionGeneration
        if credential != nil {
            struct Result: Decodable { var signedOutHere: Bool; var globalSignOutComplete: Bool }
            do {
                let result: Result = try await request(origin: rootURL, path: ["session"], method: "DELETE")
                guard result.signedOutHere else { throw APIError(message: "Sign-out was not confirmed. Try again.") }
            } catch let error as APIError where error.isUnauthorized {
                // A session the server no longer accepts has already ended. Scope local
                // cleanup to that result even if a new sign-in completed during suspension.
                guard error.sessionGeneration == sessionGeneration else { throw CancellationError() }
                try invalidateCredential()
                return
            }
        }
        guard generation == sessionGeneration else { throw CancellationError() }
        try invalidateCredential()
    }

    func workspaces() async throws -> [Workspace] {
        struct Result: Decodable { var workspaces: [Workspace] }
        let generation = sessionGeneration
        let requestID = UUID()
        workspaceRequestID = requestID
        let result: Result = try await request(origin: rootURL, path: ["workspaces"])
        guard generation == sessionGeneration, workspaceRequestID == requestID else { throw CancellationError() }
        for workspace in result.workspaces { try validateWorkspaceOrigin(workspace.url) }
        workspaceOrigins = Set(result.workspaces.map(\.url))
        return result.workspaces
    }

    func createWorkspace(name: String, slug: String) async throws -> Workspace {
        struct Body: Encodable { var name: String; var slug: String }
        struct Result: Decodable { var workspace: Workspace }
        let result: Result = try await request(origin: rootURL, path: ["workspaces"], method: "POST",
            body: encode(Body(name: name, slug: slug)))
        let workspace = result.workspace
        do {
            try validateWorkspaceOrigin(workspace.url)
            guard !workspace.id.isEmpty, workspace.slug == slug,
                  workspace.name == name,
                  workspace.url.host == "\(slug).\(rootURL.host ?? "")" else {
                throw APIError(message: "The Workspace address could not be verified.")
            }
        } catch {
            // A successful server mutation with an unreadable or invalid receipt may
            // already exist. Reconcile against the owner's inventory before retrying.
            throw APIError(message: "The new Workspace could not be verified. Refresh your Workspaces before retrying.",
                isAmbiguousMutation: true, sessionGeneration: sessionGeneration)
        }
        // An inventory read begun before creation must not remove the new origin.
        workspaceRequestID = nil
        workspaceOrigins.insert(workspace.url)
        return workspace
    }

    func projects(in workspace: Workspace, includeArchived: Bool = false) async throws -> [ProjectSummary] {
        struct Result: Decodable { var projects: [ProjectSummary] }
        let result: Result = try await request(origin: workspaceOrigin(workspace), path: ["projects"],
            query: includeArchived ? [URLQueryItem(name: "includeArchived", value: "true")] : [])
        return result.projects
    }

    func project(id: String, in workspace: Workspace) async throws -> Project {
        let result: ProjectResult = try await request(origin: workspaceOrigin(workspace), path: ["projects", id])
        return result.project
    }

    func createProject(_ draft: ProjectDraft, in workspace: Workspace, idempotencyKey: String) async throws -> Project {
        let result: ProjectResult = try await request(origin: workspaceOrigin(workspace), path: ["projects"],
            method: "POST", body: encode(ProjectWriteBody(draft: draft, creation: true)), idempotencyKey: idempotencyKey)
        return result.project
    }

    func updateProject(_ draft: ProjectDraft, in workspace: Workspace) async throws -> Project {
        guard let id = draft.id, let revision = draft.revision else {
            throw APIError(message: "Reload the Project before saving changes.")
        }
        let result: ProjectResult = try await request(origin: workspaceOrigin(workspace), path: ["projects", id],
            method: "PATCH", body: encode(ProjectWriteBody(draft: draft, creation: false)), version: revision)
        return result.project
    }

    func createCard(_ draft: CardDraft, projectID: String, in workspace: Workspace,
                    idempotencyKey: String) async throws -> Card {
        let result: CardResult = try await request(origin: workspaceOrigin(workspace), path: ["projects", projectID, "cards"],
            method: "POST", body: encode(CardWriteBody(draft: draft, creation: true)), idempotencyKey: idempotencyKey)
        return result.card
    }

    func updateCard(_ draft: CardDraft, projectID: String, in workspace: Workspace) async throws -> Card {
        guard let id = draft.id, let version = draft.version else {
            throw APIError(message: "Reload the Card before saving changes.")
        }
        let result: CardResult = try await request(origin: workspaceOrigin(workspace),
            path: ["projects", projectID, "cards", id], method: "PATCH",
            body: encode(CardWriteBody(draft: draft, creation: false)), version: version)
        return result.card
    }

    func moveCard(_ card: Card, to columnID: String, position: Double? = nil, projectID: String, in workspace: Workspace) async throws -> Card {
        struct MoveBody: Encodable { var columnId: String; var position: Double? }
        let result: CardResult = try await request(origin: workspaceOrigin(workspace),
            path: ["projects", projectID, "cards", card.id], method: "PATCH",
            body: encode(MoveBody(columnId: columnID, position: position)), version: card.version)
        return result.card
    }

    func archiveCard(card: Card, archived: Bool, projectID: String, in workspace: Workspace) async throws -> Card {
        let result: CardResult = try await request(origin: workspaceOrigin(workspace),
            path: ["projects", projectID, "cards", card.id], method: "PATCH",
            body: encode(ArchiveBody(archivedAt: archived ? ServerTimestamp.string() : nil)), version: card.version)
        return result.card
    }

    func archiveProject(project: Project, archived: Bool, in workspace: Workspace) async throws -> Project {
        let result: ProjectResult = try await request(origin: workspaceOrigin(workspace),
            path: ["projects", project.id], method: "PATCH",
            body: encode(ArchiveBody(archivedAt: archived ? ServerTimestamp.string() : nil)), version: project.revision)
        return result.project
    }

    func addComment(body: String, cardID: String, projectID: String, in workspace: Workspace,
                    idempotencyKey: String) async throws -> CommentResult {
        struct Body: Encodable { var body: String }
        return try await request(origin: workspaceOrigin(workspace), path: ["projects", projectID, "cards", cardID, "comments"],
            method: "POST", body: encode(Body(body: body)), idempotencyKey: idempotencyKey)
    }

    func activity(projectID: String, in workspace: Workspace) async throws -> [Activity] {
        struct Result: Decodable { var activity: [Activity]; var projectRevision: Int }
        let result: Result = try await request(origin: workspaceOrigin(workspace), path: ["projects", projectID, "activity"],
            query: [URLQueryItem(name: "limit", value: "100")])
        return result.activity
    }

    private func request<Result: Decodable>(origin: URL, path: [String], method: String = "GET",
        query: [URLQueryItem] = [], body: Data? = nil, version: Int? = nil,
        idempotencyKey: String? = nil, authorized: Bool = true) async throws -> Result {
        try validateOrigin(origin)
        var endpoint = origin.appendingPathComponent("api")
        for component in path {
            guard !component.isEmpty, component != ".", component != "..", !component.contains("/") else {
                throw APIError(message: "The requested resource address is invalid.")
            }
            endpoint.appendPathComponent(component)
        }
        var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.httpBody = body
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if authorized {
            guard let credential, credential.rootUrl == rootURL else {
                throw APIError(message: "Sign in to continue.", statusCode: 401, sessionGeneration: sessionGeneration)
            }
            request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        }
        if let version { request.setValue(String(version), forHTTPHeaderField: "X-Kanban-Version") }
        if let idempotencyKey {
            guard !idempotencyKey.isEmpty else { throw APIError(message: "A retry identifier is required before saving.") }
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }
        let requestGeneration = sessionGeneration
        let mutation = method != "GET"
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch {
            guard requestGeneration == sessionGeneration else { throw CancellationError() }
            throw APIError(message: mutation
                ? "The save was not confirmed. Your draft is retained. Refresh before retrying the same save."
                : "Could not connect. Check your connection and try again.", isAmbiguousMutation: mutation, sessionGeneration: sessionGeneration)
        }
        // Neither a late success nor a late failure belongs to a replaced session.
        // Check before 401 handling so the old bearer can never revoke the new Keychain item.
        guard requestGeneration == sessionGeneration else { throw CancellationError() }
        guard let http = response as? HTTPURLResponse else {
            throw APIError(message: "The server response could not be verified.", isAmbiguousMutation: mutation, sessionGeneration: sessionGeneration)
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401, authorized {
                do { try invalidateCredential() }
                catch { throw APIError(message: "Your session expired. The local session could not be removed. Try signing out again.", statusCode: 401, sessionGeneration: sessionGeneration) }
            }
            let serverMessage = (try? JSONDecoder().decode(ServerFailure.self, from: data))?.error
            throw APIError(message: serverMessage ?? "The request could not be completed. Try again.",
                statusCode: http.statusCode, isAmbiguousMutation: mutation && (http.statusCode == 408 || http.statusCode >= 500), sessionGeneration: sessionGeneration)
        }
        do { return try JSONDecoder().decode(Result.self, from: data) }
        catch {
            throw APIError(message: mutation
                ? "The save response could not be read. Refresh before retrying."
                : "The server returned data this app could not read.", isAmbiguousMutation: mutation, sessionGeneration: sessionGeneration)
        }
    }

    private func workspaceOrigin(_ workspace: Workspace) throws -> URL {
        try validateWorkspaceOrigin(workspace.url)
        guard workspaceOrigins.contains(workspace.url) else {
            throw APIError(message: "Refresh your Workspaces before opening this Project.")
        }
        return workspace.url
    }

    private func validateOrigin(_ url: URL) throws {
        let loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].contains(url.host ?? "")
        guard url.scheme == "https" || (url.scheme == "http" && loopback), url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else {
            throw APIError(message: "A secure server address is required.")
        }
    }

    private func validateWorkspaceOrigin(_ url: URL) throws {
        try validateOrigin(url)
        try validateOrigin(rootURL)
        guard let host = url.host, let rootHost = rootURL.host,
              host.hasSuffix("." + rootHost), url.scheme == rootURL.scheme, url.port == rootURL.port else {
            throw APIError(message: "The Workspace address could not be verified.")
        }
    }

    private func invalidateCredential() throws {
        sessionGeneration = UUID()
        credential = nil
        workspaceOrigins.removeAll()
        try credentialStore.remove()
    }

    private func encode<T: Encodable>(_ body: T) throws -> Data { try JSONEncoder().encode(body) }
}

private struct ProjectResult: Decodable { var project: Project }
private struct CardResult: Decodable { var card: Card; var projectRevision: Int }
private struct ServerFailure: Decodable { var error: String }

private struct ArchiveBody: Encodable {
    var archivedAt: String?
    enum CodingKeys: CodingKey { case archivedAt }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(archivedAt, forKey: .archivedAt)
    }
}

private struct CardWriteBody: Encodable {
    var draft: CardDraft
    var creation: Bool
    enum CodingKeys: CodingKey {
        case title, body, nextActor, nextAction, priority, blockedReason, columnId, position, archivedAt, externalKey
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(draft.title, forKey: .title)
        try container.encode(draft.body, forKey: .body)
        try container.encode(draft.nextActor, forKey: .nextActor)
        try container.encode(draft.nextAction, forKey: .nextAction)
        try container.encode(draft.priority, forKey: .priority)
        try container.encode(draft.blockedReason, forKey: .blockedReason)
        if creation {
            try container.encode(draft.columnId, forKey: .columnId)
            try container.encode(draft.position, forKey: .position)
            try container.encodeIfPresent(draft.externalKey, forKey: .externalKey)
        }
    }
}

private struct ProjectWriteBody: Encodable {
    var draft: ProjectDraft
    var creation: Bool
    enum CodingKeys: CodingKey { case name, description, columns, archivedAt }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(draft.name, forKey: .name)
        try container.encode(draft.description, forKey: .description)
        if creation { try container.encodeIfPresent(draft.columns, forKey: .columns) }
    }
}
