import CryptoKit
import Foundation

@MainActor
final class DraftStore {
    private let directory: URL
    private let fileManager: FileManager
    private struct RecoveryKey: Hashable { var ownerID: String; var resourceKey: String }
    // A failed disk write must survive removal of visible private state. Access is
    // partitioned by the authenticated owner; this buffer is never cleared on expiry.
    private var recovery: [RecoveryKey: Data] = [:]

    var hasUnpersistedRecovery: Bool { !recovery.isEmpty }

    func hasUnpersistedRecovery(ownerID: String) -> Bool {
        recovery.keys.contains { $0.ownerID == ownerID }
    }

    func hasRecovery(ownerID: String, resourceKey: String) -> Bool {
        recovery[RecoveryKey(ownerID: ownerID, resourceKey: resourceKey)] != nil
    }

    func retainForRecovery<T: Encodable>(_ draft: T, ownerID: String, resourceKey: String) throws {
        recovery[RecoveryKey(ownerID: ownerID, resourceKey: resourceKey)] = try JSONEncoder().encode(draft)
    }

    func retryRecoveryWrites() throws {
        for (key, data) in recovery {
            try write(data, ownerID: key.ownerID, resourceKey: key.resourceKey)
            recovery.removeValue(forKey: key)
        }
    }

    init(directory: URL? = nil, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        self.directory = directory ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("cards.kanban.macOS", isDirectory: true)
            .appendingPathComponent("Drafts", isDirectory: true)
    }

    func load<T: Decodable>(ownerID: String, resourceKey: String, as type: T.Type) throws -> T? {
        if let data = recovery[RecoveryKey(ownerID: ownerID, resourceKey: resourceKey)] {
            return try JSONDecoder().decode(type, from: data)
        }
        let url = fileURL(ownerID: ownerID, resourceKey: resourceKey)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(type, from: Data(contentsOf: url))
    }

    func save<T: Encodable>(_ draft: T, ownerID: String, resourceKey: String) throws {
        let key = RecoveryKey(ownerID: ownerID, resourceKey: resourceKey)
        let data = try JSONEncoder().encode(draft)
        recovery[key] = data
        try write(data, ownerID: ownerID, resourceKey: resourceKey)
        recovery.removeValue(forKey: key)
    }

    private func write(_ data: Data, ownerID: String, resourceKey: String) throws {
        let url = fileURL(ownerID: ownerID, resourceKey: resourceKey)
        let ownerDirectory = url.deletingLastPathComponent()
        try fileManager.createDirectory(at: ownerDirectory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: ownerDirectory.path)
        try data.write(to: url, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        var excludedDirectory = ownerDirectory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excludedDirectory.setResourceValues(values)
    }

    func remove(ownerID: String, resourceKey: String) throws {
        let url = fileURL(ownerID: ownerID, resourceKey: resourceKey)
        if fileManager.fileExists(atPath: url.path) { try fileManager.removeItem(at: url) }
        recovery.removeValue(forKey: RecoveryKey(ownerID: ownerID, resourceKey: resourceKey))
    }

    func removeAll(ownerID: String) throws {
        let url = directory.appendingPathComponent(digest(ownerID), isDirectory: true)
        if fileManager.fileExists(atPath: url.path) { try fileManager.removeItem(at: url) }
        recovery = recovery.filter { $0.key.ownerID != ownerID }
    }

    private func fileURL(ownerID: String, resourceKey: String) -> URL {
        directory.appendingPathComponent(digest(ownerID), isDirectory: true)
            .appendingPathComponent(digest(resourceKey)).appendingPathExtension("json")
    }

    private func digest(_ string: String) -> String {
        SHA256.hash(data: Data(string.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
