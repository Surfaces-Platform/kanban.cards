import CryptoKit
import Foundation

enum CreationDraftState: String, Codable {
    case active
    case resolved
}

struct CreationDraftRecord: Codable, Equatable, Identifiable {
    var id: UUID
    var savedAt: Date
    var payload: Data
    var sourceFingerprint: String?
    var state: CreationDraftState
}

struct CreationDraftReadFailure: Identifiable {
    /// Stable across repeated discovery of the same file.
    var id: String
    var rawData: Data?
    var message: String
}

struct CreationDraftListing {
    var records: [CreationDraftRecord] = []
    var failures: [CreationDraftReadFailure] = []

    var resolvedSourceFingerprints: Set<String> {
        Set(records.filter { $0.state == .resolved }.compactMap(\.sourceFingerprint))
    }
}

/// Each creation attempt has its own file. Discovery never rewrites a previous
/// record, and a damaged record cannot prevent another UUID from being saved.
@MainActor
final class CreationDraftStore {
    private let directory: URL
    private let fileManager: FileManager
    private var memory: [String: [UUID: CreationDraftRecord]] = [:]

    init(directory: URL, fileManager: FileManager) {
        self.directory = directory
        self.fileManager = fileManager
    }

    func list(ownerID: String, scope: String) -> CreationDraftListing {
        let location = scopeDirectory(ownerID: ownerID, scope: scope)
        let key = location.path
        var listing = CreationDraftListing()
        var records: [UUID: CreationDraftRecord] = [:]
        if fileManager.fileExists(atPath: location.path) {
            do {
                let urls = try fileManager.contentsOfDirectory(
                    at: location,
                    includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
                for url in urls.filter({ $0.pathExtension == "json" }).sorted(by: {
                    $0.lastPathComponent < $1.lastPathComponent
                }) {
                    var bytes: Data?
                    do {
                        let data = try Data(contentsOf: url)
                        bytes = data
                        let record = try JSONDecoder().decode(CreationDraftRecord.self, from: data)
                        guard
                            UUID(uuidString: url.deletingPathExtension().lastPathComponent)
                                == record.id
                        else {
                            throw CreationDraftStorageFailure.invalidIdentity
                        }
                        records[record.id] = record
                    } catch {
                        // A failed write's in-memory copy is the current draft.
                        // Do not turn an older damaged disk copy into a second row.
                        let id = UUID(uuidString: url.deletingPathExtension().lastPathComponent)
                        if id.flatMap({ memory[key]?[$0] }) == nil {
                            listing.failures.append(
                                CreationDraftReadFailure(
                                    id: url.lastPathComponent,
                                    rawData: bytes, message: "This saved draft could not be read."))
                        }
                    }
                }
            } catch {
                listing.failures.append(
                    CreationDraftReadFailure(
                        id: "draft-folder", rawData: nil,
                        message: "Saved drafts could not be opened."))
            }
        }
        records.merge(memory[key] ?? [:]) { _, current in current }
        listing.records = records.values.sorted {
            $0.savedAt == $1.savedAt ? $0.id.uuidString < $1.id.uuidString : $0.savedAt > $1.savedAt
        }
        return listing
    }

    func save(
        _ payload: Data, id: UUID, ownerID: String, scope: String,
        sourceFingerprint: String?, savedAt: Date, failWrites: Bool
    ) throws -> CreationDraftRecord {
        if try existingRecord(id: id, ownerID: ownerID, scope: scope)?.state == .resolved {
            throw CreationDraftStorageFailure.alreadyResolved
        }
        let record = CreationDraftRecord(
            id: id, savedAt: savedAt, payload: payload,
            sourceFingerprint: sourceFingerprint, state: .active)
        try persist(record, ownerID: ownerID, scope: scope, failWrites: failWrites)
        return record
    }

    func resolve(id: UUID, ownerID: String, scope: String, failWrites: Bool) throws {
        guard var record = try existingRecord(id: id, ownerID: ownerID, scope: scope) else {
            return
        }
        record.state = .resolved
        record.payload = Data()
        try persist(record, ownerID: ownerID, scope: scope, failWrites: failWrites)
    }

    func discard(id: UUID, ownerID: String, scope: String, failWrites: Bool) throws {
        guard let record = try existingRecord(id: id, ownerID: ownerID, scope: scope) else {
            return
        }
        if record.sourceFingerprint != nil {
            try resolve(id: id, ownerID: ownerID, scope: scope, failWrites: failWrites)
        } else {
            if failWrites { throw DraftPersistenceFailure() }
            let url = fileURL(id: id, ownerID: ownerID, scope: scope)
            if fileManager.fileExists(atPath: url.path) { try fileManager.removeItem(at: url) }
            memory[scopeDirectory(ownerID: ownerID, scope: scope).path]?.removeValue(forKey: id)
        }
    }

    func removeMemory(ownerID: String) {
        let prefix = ownerDirectory(ownerID: ownerID).path + "/"
        memory = memory.filter { !$0.key.hasPrefix(prefix) }
    }

    private func existingRecord(id: UUID, ownerID: String, scope: String) throws
        -> CreationDraftRecord?
    {
        if let record = memory[scopeDirectory(ownerID: ownerID, scope: scope).path]?[id] {
            return record
        }
        let url = fileURL(id: id, ownerID: ownerID, scope: scope)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let record = try JSONDecoder().decode(CreationDraftRecord.self, from: Data(contentsOf: url))
        guard record.id == id else { throw CreationDraftStorageFailure.invalidIdentity }
        return record
    }

    private func persist(
        _ record: CreationDraftRecord, ownerID: String, scope: String, failWrites: Bool
    ) throws {
        let data = try JSONEncoder().encode(record)
        let parent = scopeDirectory(ownerID: ownerID, scope: scope)
        // Keep the latest copy available for Retry even when the filesystem fails.
        memory[parent.path, default: [:]][record.id] = record
        if failWrites { throw DraftPersistenceFailure() }
        try fileManager.createDirectory(at: parent, withIntermediateDirectories: true)
        try data.write(
            to: fileURL(id: record.id, ownerID: ownerID, scope: scope),
            options: [.atomic, .completeFileProtection])
        var protectedURL = parent
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try protectedURL.setResourceValues(values)
    }

    private func ownerDirectory(ownerID: String) -> URL {
        directory.appendingPathComponent(Self.fingerprint(Data(ownerID.utf8)), isDirectory: true)
    }

    private func scopeDirectory(ownerID: String, scope: String) -> URL {
        ownerDirectory(ownerID: ownerID).appendingPathComponent("creation-v1", isDirectory: true)
            .appendingPathComponent(Self.fingerprint(Data(scope.utf8)), isDirectory: true)
    }

    private func fileURL(id: UUID, ownerID: String, scope: String) -> URL {
        scopeDirectory(ownerID: ownerID, scope: scope).appendingPathComponent(
            id.uuidString.lowercased()
        )
        .appendingPathExtension("json")
    }

    static func fingerprint(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

private enum CreationDraftStorageFailure: LocalizedError {
    case invalidIdentity
    case alreadyResolved

    var errorDescription: String? {
        switch self {
        case .invalidIdentity: return "This saved draft could not be read."
        case .alreadyResolved:
            return
                "This draft has already been completed or discarded. Start a new draft to continue."
        }
    }
}
