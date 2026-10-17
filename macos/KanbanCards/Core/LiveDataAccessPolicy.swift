import Foundation

/// A local acceptance-session boundary; server authorization still applies to every request.
enum LiveDataAccessPolicy: Equatable, Sendable {
    case unrestricted
    case readOnly
    case testProject(workspaceURL: URL, projectID: String)
    case createVerificationProject(workspaceURL: URL)

    static let verificationProjectName = "macOS verification"

    init(arguments: [String]) {
        let related = arguments.filter(Self.isPolicyArgument)
        // Ordinary launches use the owner's normal server-authorized access.
        // Explicit verification arguments retain their read-only or test-Project scope.
        guard !related.isEmpty else { self = .unrestricted; return }

        let valueFlags: Set<String> = ["--writable-test-workspace", "--writable-test-project",
                                      "--create-verification-project-in"]
        var seen = Set<String>()
        var values: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            guard Self.isPolicyArgument(argument) else { index += 1; continue }
            guard seen.insert(argument).inserted else { self = .readOnly; return }
            if argument == "--live-read-only" {
                index += 1
                continue
            }
            guard valueFlags.contains(argument), index + 1 < arguments.count,
                  !arguments[index + 1].hasPrefix("-") else { self = .readOnly; return }
            values[argument] = arguments[index + 1]
            index += 2
        }
        guard seen.contains("--live-read-only") else { self = .readOnly; return }

        if let creationURL = values["--create-verification-project-in"] {
            guard values.count == 1, let url = Self.workspaceURL(creationURL) else {
                self = .readOnly; return
            }
            self = .createVerificationProject(workspaceURL: url)
        } else if let workspace = values["--writable-test-workspace"],
                  let projectID = values["--writable-test-project"] {
            guard values.count == 2, let url = Self.workspaceURL(workspace),
                  Self.validProjectID(projectID) else { self = .readOnly; return }
            self = .testProject(workspaceURL: url, projectID: projectID)
        } else {
            self = .readOnly
        }
    }

    var canCreateWorkspace: Bool { self == .unrestricted }

    var requiredProjectCreationName: String? {
        if case .createVerificationProject = self { return Self.verificationProjectName }
        return nil
    }

    func canEditProject(id: String, in workspaceURL: URL) -> Bool {
        switch self {
        case .unrestricted: return true
        case .testProject(let allowedURL, let allowedID):
            return workspaceURL == allowedURL && id == allowedID
        case .readOnly, .createVerificationProject: return false
        }
    }

    func canCreateProject(in workspaceURL: URL) -> Bool {
        switch self {
        case .unrestricted: return true
        case .createVerificationProject(let allowedURL): return workspaceURL == allowedURL
        case .readOnly, .testProject: return false
        }
    }

    func permitsRequest(origin: URL, path: [String], method: String, body: Data?,
                        rootURL: URL, authURL: URL) -> Bool {
        if self == .unrestricted || method == "GET" || method == "HEAD" { return true }
        if origin == authURL, method == "POST",
           path == ["native-auth", "challenge"] || path == ["native-auth", "verify"] { return true }
        if origin == rootURL, method == "DELETE", path == ["session"] { return true }

        switch self {
        case .testProject:
            return ["POST", "PATCH", "DELETE"].contains(method) && path.count >= 2
                && path[0] == "projects" && canEditProject(id: path[1], in: origin)
        case .createVerificationProject:
            guard method == "POST", path == ["projects"], canCreateProject(in: origin),
                  let body, let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
            else { return false }
            return object["name"] as? String == Self.verificationProjectName
        case .readOnly, .unrestricted: return false
        }
    }

    private static func isPolicyArgument(_ value: String) -> Bool {
        value.hasPrefix("--live-") || value.hasPrefix("--writable-test-")
            || value.hasPrefix("--create-verification-")
    }

    private static func workspaceURL(_ value: String) -> URL? {
        guard let url = URL(string: value), url.absoluteString == value,
              url.scheme == "https", let host = url.host, host == host.lowercased(),
              host.hasSuffix(".kanban.cards"), host != "auth.kanban.cards",
              host.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == ".") }),
              url.port == nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/"
        else { return nil }
        return url
    }

    private static func validProjectID(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 256 && value != "." && value != ".."
            && value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == ".") }
    }
}
