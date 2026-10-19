import CryptoKit
import Foundation

@MainActor
final class DraftStore {
    private let directory: URL
    private let fileManager: FileManager
    private var memory: [String: Data] = [:]
    private var failedWrites = Set<String>()
    var failWrites = false

    init(directory: URL? = nil, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        self.directory = directory ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("kanban.cards", isDirectory: true)
            .appendingPathComponent("Drafts", isDirectory: true)
        #if DEBUG
        failWrites = ProcessInfo.processInfo.arguments.contains("--demo-draft-write-failure")
        #endif
    }

    func scopedKey(workspace: Workspace, projectID: String, resourceKey: String) -> String {
        // Length-prefixed components preserve the exact origin and cannot collide through separators.
        ["v2", workspace.id, workspace.url.absoluteString, projectID, resourceKey]
            .map { "\($0.utf8.count):\($0)" }.joined()
    }

    func load<T: Decodable>(ownerID: String, resourceKey: String, as type: T.Type) throws -> T? {
        let key = memoryKey(ownerID, resourceKey)
        if let data = memory[key] { return try JSONDecoder().decode(type, from: data) }
        let url = fileURL(ownerID: ownerID, resourceKey: resourceKey)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url)
        let decoded = try JSONDecoder().decode(type, from: data)
        memory[key] = data
        return decoded
    }

    /// A retry must perform a new read, but failed-write memory may be the
    /// owner's only remaining copy and must never be evicted by a read retry.
    func prepareToRetryReading(ownerID: String, workspace: Workspace, projectID: String,
        resourceKey: String, legacyResourceKey: String) {
        let keys = [scopedKey(workspace: workspace, projectID: projectID, resourceKey: resourceKey),
            legacyResourceKey, bindingKey(legacyResourceKey)]
        for resource in keys {
            let key = memoryKey(ownerID, resource)
            if !failedWrites.contains(key) { memory.removeValue(forKey: key) }
        }
    }

    /// Read-only recovery for a record that cannot be decoded. Invalid UTF-8 or
    /// inaccessible bytes are never presented as a lossless text export.
    func retainedRecordText(ownerID: String, workspace: Workspace, projectID: String,
        resourceKey: String, legacyResourceKey: String) -> String? {
        let keys = [scopedKey(workspace: workspace, projectID: projectID, resourceKey: resourceKey),
            legacyResourceKey, bindingKey(legacyResourceKey)]
        for resource in keys {
            let data = memory[memoryKey(ownerID, resource)]
                ?? (try? Data(contentsOf: fileURL(ownerID: ownerID, resourceKey: resource)))
            if let data, let text = String(data: data, encoding: .utf8) { return text }
        }
        return nil
    }

    private struct LegacyScope: Codable, Equatable {
        var workspaceID: String
        var origin: String
        var projectID: String
        var resourceKey: String
    }

    private func legacyScope(workspace: Workspace, projectID: String, resourceKey: String) -> LegacyScope {
        LegacyScope(workspaceID: workspace.id, origin: workspace.url.absoluteString,
            projectID: projectID, resourceKey: resourceKey)
    }
    private func bindingKey(_ legacyResourceKey: String) -> String { "legacy-scope:v2:" + legacyResourceKey }

    func loadScoped<T: Codable>(ownerID: String, workspace: Workspace, projectID: String,
        resourceKey: String, legacyResourceKey: String, as type: T.Type) throws -> T? {
        let key = scopedKey(workspace: workspace, projectID: projectID, resourceKey: resourceKey)
        if let value = try load(ownerID: ownerID, resourceKey: key, as: type) { return value }
        // An old owner/resource-only record is eligible only after the owner has
        // explicitly confirmed its original Workspace. Never guess the origin.
        let binding = try load(ownerID: ownerID, resourceKey: bindingKey(legacyResourceKey), as: LegacyScope.self)
        guard binding == legacyScope(workspace: workspace, projectID: projectID, resourceKey: resourceKey) else { return nil }
        return try load(ownerID: ownerID, resourceKey: legacyResourceKey, as: type)
    }

    func unprovenLegacy<T: Decodable>(ownerID: String, legacyResourceKey: String, as type: T.Type) throws -> T? {
        guard try load(ownerID: ownerID, resourceKey: bindingKey(legacyResourceKey), as: LegacyScope.self) == nil else { return nil }
        return try load(ownerID: ownerID, resourceKey: legacyResourceKey, as: type)
    }

    func recoverLegacy<T: Encodable>(_ draft: T, ownerID: String, workspace: Workspace,
        projectID: String, resourceKey: String, legacyResourceKey: String) throws {
        let expected = legacyScope(workspace: workspace, projectID: projectID, resourceKey: resourceKey)
        if let existing = try load(ownerID: ownerID, resourceKey: bindingKey(legacyResourceKey), as: LegacyScope.self), existing != expected {
            throw DraftRecoveryScopeFailure()
        }
        // Persist the explicit scope choice first. If the scoped copy fails, the
        // untouched legacy bytes plus this binding still recover after relaunch.
        try save(legacyScope(workspace: workspace, projectID: projectID, resourceKey: resourceKey),
            ownerID: ownerID, resourceKey: bindingKey(legacyResourceKey))
        try saveScoped(draft, ownerID: ownerID, workspace: workspace, projectID: projectID,
            resourceKey: resourceKey, legacyResourceKey: legacyResourceKey)
    }

    func save<T: Encodable>(_ draft: T, ownerID: String, resourceKey: String) throws {
        let key = memoryKey(ownerID, resourceKey)
        let data = try JSONEncoder().encode(draft)
        memory[key] = data
        do {
            if failWrites { throw DraftPersistenceFailure() }
            let url = fileURL(ownerID: ownerID, resourceKey: resourceKey)
            try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            var protectedURL = url.deletingLastPathComponent()
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try protectedURL.setResourceValues(values)
            failedWrites.remove(key)
        } catch {
            failedWrites.insert(key)
            throw error
        }
    }

    func saveScoped<T: Encodable>(_ draft: T, ownerID: String, workspace: Workspace,
        projectID: String, resourceKey: String, legacyResourceKey: String) throws {
        let key = scopedKey(workspace: workspace, projectID: projectID, resourceKey: resourceKey)
        try save(draft, ownerID: ownerID, resourceKey: key)
        // Unclaimed legacy bytes remain available for explicit scope recovery.
    }

    func remove(ownerID: String, resourceKey: String) throws {
        let url = fileURL(ownerID: ownerID, resourceKey: resourceKey)
        if fileManager.fileExists(atPath: url.path) { try fileManager.removeItem(at: url) }
        memory.removeValue(forKey: memoryKey(ownerID, resourceKey))
        failedWrites.remove(memoryKey(ownerID, resourceKey))
    }

    func removeScoped(ownerID: String, workspace: Workspace, projectID: String,
        resourceKey: String, legacyResourceKey: String) throws {
        let binding = try load(ownerID: ownerID, resourceKey: bindingKey(legacyResourceKey), as: LegacyScope.self)
        let ownsLegacy = binding == legacyScope(workspace: workspace, projectID: projectID, resourceKey: resourceKey)
        // Keep the scoped completion receipt if bound legacy cleanup fails.
        if ownsLegacy { try remove(ownerID: ownerID, resourceKey: legacyResourceKey) }
        try remove(ownerID: ownerID,
            resourceKey: scopedKey(workspace: workspace, projectID: projectID, resourceKey: resourceKey))
        if ownsLegacy { try remove(ownerID: ownerID, resourceKey: bindingKey(legacyResourceKey)) }
    }

    func removeAll(ownerID: String) throws {
        let url = directory.appendingPathComponent(digest(ownerID), isDirectory: true)
        if fileManager.fileExists(atPath: url.path) { try fileManager.removeItem(at: url) }
        let prefix = digest(ownerID) + ":"
        memory = memory.filter { !$0.key.hasPrefix(prefix) }
        failedWrites = Set(failedWrites.filter { !$0.hasPrefix(prefix) })
    }

    private func memoryKey(_ ownerID: String, _ resourceKey: String) -> String { digest(ownerID) + ":" + digest(resourceKey) }
    private func fileURL(ownerID: String, resourceKey: String) -> URL {
        directory.appendingPathComponent(digest(ownerID), isDirectory: true)
            .appendingPathComponent(digest(resourceKey)).appendingPathExtension("json")
    }
    private func digest(_ string: String) -> String {
        SHA256.hash(data: Data(string.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

struct DraftPersistenceFailure: LocalizedError {
    var errorDescription: String? { "The local draft could not be written. Keep this app open, retry, or copy/export the text before leaving." }
}

struct DraftRecoveryScopeFailure: LocalizedError {
    var errorDescription: String? { "The retained draft is already bound to another Workspace. Its original recovery record has not been changed." }
}
