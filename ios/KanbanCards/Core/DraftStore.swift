import CryptoKit
import Foundation

@MainActor
final class DraftStore {
    private let directory: URL
    private let fileManager: FileManager

    init(directory: URL? = nil, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        self.directory = directory ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("kanban.cards", isDirectory: true)
            .appendingPathComponent("Drafts", isDirectory: true)
    }

    func load<T: Decodable>(ownerID: String, resourceKey: String, as type: T.Type) throws -> T? {
        let url = fileURL(ownerID: ownerID, resourceKey: resourceKey)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(type, from: Data(contentsOf: url))
    }

    func save<T: Encodable>(_ draft: T, ownerID: String, resourceKey: String) throws {
        let url = fileURL(ownerID: ownerID, resourceKey: resourceKey)
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(draft).write(to: url, options: [.atomic, .completeFileProtection])
        var protectedURL = url.deletingLastPathComponent()
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try protectedURL.setResourceValues(values)
    }

    func remove(ownerID: String, resourceKey: String) throws {
        let url = fileURL(ownerID: ownerID, resourceKey: resourceKey)
        if fileManager.fileExists(atPath: url.path) { try fileManager.removeItem(at: url) }
    }

    func removeAll(ownerID: String) throws {
        let url = directory.appendingPathComponent(digest(ownerID), isDirectory: true)
        if fileManager.fileExists(atPath: url.path) { try fileManager.removeItem(at: url) }
    }

    private func fileURL(ownerID: String, resourceKey: String) -> URL {
        directory.appendingPathComponent(digest(ownerID), isDirectory: true)
            .appendingPathComponent(digest(resourceKey)).appendingPathExtension("json")
    }

    private func digest(_ string: String) -> String {
        SHA256.hash(data: Data(string.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
