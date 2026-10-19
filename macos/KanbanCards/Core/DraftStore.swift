import CryptoKit
import Foundation

@MainActor
final class DraftStore {
    private struct WrittenEnvelope<T: Encodable>: Encodable { var schemaVersion = 1; var value: T }
    private struct ReadEnvelope<T: Decodable>: Decodable { var schemaVersion: Int; var value: T }
    private struct LegacyAssociation: Codable { var destination: String }
    private struct LegacyRetirement: Codable { var retired = true }
    private struct CreationSlot: Codable { var id: String }
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
        recovery[RecoveryKey(ownerID: ownerID, resourceKey: resourceKey)] = try JSONEncoder().encode(WrittenEnvelope(value: draft))
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
            return try decode(type, from: data)
        }
        let url = fileURL(ownerID: ownerID, resourceKey: resourceKey)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        return try decode(type, from: Data(contentsOf: url))
    }

    func save<T: Encodable>(_ draft: T, ownerID: String, resourceKey: String) throws {
        let key = RecoveryKey(ownerID: ownerID, resourceKey: resourceKey)
        let data = try JSONEncoder().encode(WrittenEnvelope(value: draft))
        recovery[key] = data
        try write(data, ownerID: ownerID, resourceKey: resourceKey)
        recovery.removeValue(forKey: key)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        if object?["schemaVersion"] != nil {
            let envelope = try JSONDecoder().decode(ReadEnvelope<T>.self, from: data)
            guard envelope.schemaVersion == 1 else { throw CocoaError(.fileReadCorruptFile) }
            return envelope.value
        }
        return try JSONDecoder().decode(type, from: data)
    }

    func legacyMayBeAssociated(ownerID: String, legacyKey: String, destination: String) throws -> Bool {
        if let retirement = try load(ownerID: ownerID, resourceKey: "legacy-retired:" + destination,
            as: LegacyRetirement.self), retirement.retired { return false }
        guard let association = try load(ownerID: ownerID, resourceKey: "legacy-association:" + legacyKey,
            as: LegacyAssociation.self) else { return true }
        // An interrupted scoped write may be retried only at the proven origin.
        // A retirement receipt below prevents resurrection after discard/cleanup.
        return association.destination == destination
    }

    func associateLegacy(ownerID: String, legacyKey: String, destination: String) throws {
        guard try legacyMayBeAssociated(ownerID: ownerID, legacyKey: legacyKey, destination: destination) else {
            throw CocoaError(.fileReadNoPermission)
        }
        if let prior = try load(ownerID: ownerID, resourceKey: "legacy-association:" + legacyKey, as: LegacyAssociation.self),
           prior.destination != destination { throw CocoaError(.fileReadNoPermission) }
        try save(LegacyAssociation(destination: destination), ownerID: ownerID,
            resourceKey: "legacy-association:" + legacyKey)
    }

    func creationResourceKey(ownerID: String, scope: String) throws -> String {
        let index = "creation-slot:" + scope
        if let slot = try load(ownerID: ownerID, resourceKey: index, as: CreationSlot.self) {
            return scope + ":creation:" + slot.id
        }
        let slot = CreationSlot(id: UUID().uuidString)
        try save(slot, ownerID: ownerID, resourceKey: index)
        return scope + ":creation:" + slot.id
    }

    func releaseCreationResource(ownerID: String, scope: String, resourceKey: String) throws {
        let index = "creation-slot:" + scope
        guard let slot = try load(ownerID: ownerID, resourceKey: index, as: CreationSlot.self),
              scope + ":creation:" + slot.id == resourceKey else { return }
        try remove(ownerID: ownerID, resourceKey: index)
    }

    private func write(_ data: Data, ownerID: String, resourceKey: String) throws {
        #if DEBUG
        // Opt-in fault injection for synthetic UI tests; Release and live owners
        // always use the ordinary filesystem write below.
        let arguments = ProcessInfo.processInfo.arguments
        if ownerID == "demo-owner", arguments.contains("--demo"),
           arguments.contains("--demo-comment-draft-write-failure"), (resourceKey.hasSuffix(":comment") || resourceKey.hasPrefix("shared-comment:")),
           let marker = ProcessInfo.processInfo.environment["KANBAN_CARDS_DEMO_COMMENT_WRITE_FAILURE_FILE"],
           fileManager.fileExists(atPath: marker) {
            throw CocoaError(.fileWriteNoPermission)
        }
        #endif
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
        // Retire legacy fallback before deleting its scoped authority. If this
        // receipt cannot be protected, retain the original draft/completion.
        if !resourceKey.hasPrefix("legacy-association:"), !resourceKey.hasPrefix("legacy-retired:") {
            try save(LegacyRetirement(), ownerID: ownerID, resourceKey: "legacy-retired:" + resourceKey)
        }
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

/// Length prefixes preserve the exact server origin and prevent delimiter aliases.
enum MacDraftScope {
    static func key(_ kind: String, workspace: Workspace, projectID: String, resourceID: String) -> String {
        kind + ":" + [workspace.id, workspace.url.absoluteString, projectID, resourceID]
            .map { "\($0.utf8.count):\($0)" }.joined()
    }
}
