import Foundation
import XCTest

@testable import KanbanCards

@MainActor
final class CreationDraftStoreTests: XCTestCase {
    private var directory: URL!
    private let workspace = Workspace(
        id: "workspace-a", slug: "studio", name: "Studio",
        url: URL(string: "https://studio.kanban.cards")!)
    private let ownerID = "owner-a"
    private let projectID = "project-a"
    private let resourceKey = "card:project-a:new"

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }

    override func tearDown() async throws {
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
    }

    func testIndependentDraftsSurviveRelaunchAndSortByLastSave() throws {
        let store = DraftStore(directory: directory)
        let first = UUID()
        let second = UUID()
        try save(
            Payload(title: "First", body: "  Keep whitespace\n"), id: first, to: store,
            savedAt: Date(timeIntervalSince1970: 100))
        try save(
            Payload(title: "Second", body: "Another idea"), id: second, to: store,
            savedAt: Date(timeIntervalSince1970: 200))

        let listing = list(DraftStore(directory: directory))
        XCTAssertEqual(listing.records.map(\.id), [second, first])
        XCTAssertTrue(listing.failures.isEmpty)
        XCTAssertEqual(
            try decode(listing.records[1]), Payload(title: "First", body: "  Keep whitespace\n"))
    }

    func testOwnerExactOriginProjectAndResourceRemainIsolated() throws {
        let store = DraftStore(directory: directory)
        try save(Payload(title: "Private", body: "Idea"), id: UUID(), to: store)
        let changedOrigin = Workspace(
            id: workspace.id, slug: workspace.slug, name: workspace.name,
            url: URL(string: "https://studio.kanban.cards/")!)
        XCTAssertTrue(
            store.listCreationDrafts(
                ownerID: "owner-b", workspace: workspace,
                projectID: projectID, resourceKey: resourceKey
            ).records.isEmpty)
        XCTAssertTrue(
            store.listCreationDrafts(
                ownerID: ownerID, workspace: changedOrigin,
                projectID: projectID, resourceKey: resourceKey
            ).records.isEmpty)
        XCTAssertTrue(
            store.listCreationDrafts(
                ownerID: ownerID, workspace: workspace,
                projectID: "project-b", resourceKey: resourceKey
            ).records.isEmpty)
        XCTAssertTrue(
            store.listCreationDrafts(
                ownerID: ownerID, workspace: workspace,
                projectID: projectID, resourceKey: "project:new"
            ).records.isEmpty)
    }

    func testMalformedOldSlotsDoNotBlockNewDraftOrChangeTheirBytes() throws {
        let store = DraftStore(directory: directory)
        let legacy = Data([0x00, 0xff, 0x7b, 0x0a])
        let scoped = Data("{broken scoped draft".utf8)
        try writeOld(legacy, resourceKey: resourceKey)
        let scopedKey = store.scopedKey(
            workspace: workspace, projectID: projectID, resourceKey: resourceKey)
        try writeOld(scoped, resourceKey: scopedKey)

        try save(Payload(title: "New work", body: "Ready"), id: UUID(), to: store)
        XCTAssertEqual(list(DraftStore(directory: directory)).records.count, 1)
        XCTAssertEqual(try store.rawRecordData(ownerID: ownerID, resourceKey: resourceKey), legacy)
        XCTAssertEqual(try store.rawRecordData(ownerID: ownerID, resourceKey: scopedKey), scoped)
    }

    func testMalformedCreationRecordIsReportedWithoutBlockingAnotherUUID() throws {
        let initial = DraftStore(directory: directory)
        let damagedID = UUID()
        try save(Payload(title: "Old", body: "Saved"), id: damagedID, to: initial)
        let badBytes = Data("{damaged record".utf8)
        try badBytes.write(to: creationURL(id: damagedID))

        let relaunched = DraftStore(directory: directory)
        let newID = UUID()
        try save(Payload(title: "New", body: "Independent"), id: newID, to: relaunched)
        let listing = list(relaunched)
        XCTAssertEqual(listing.records.map(\.id), [newID])
        XCTAssertEqual(listing.failures.count, 1)
        XCTAssertEqual(listing.failures.first?.id, damagedID.uuidString.lowercased() + ".json")
        XCTAssertEqual(listing.failures.first?.rawData, badBytes)
        XCTAssertEqual(try Data(contentsOf: creationURL(id: damagedID)), badBytes)
    }

    func testFailedWriteKeepsLatestDraftInMemoryAndCanRetry() throws {
        let store = DraftStore(directory: directory)
        let id = UUID()
        try save(Payload(title: "Before", body: "On disk"), id: id, to: store)
        store.failWrites = true
        let latest = Payload(title: "After", body: "Only in memory until retry")
        XCTAssertThrowsError(try save(latest, id: id, to: store))
        XCTAssertEqual(try decode(try XCTUnwrap(list(store).records.first)), latest)
        XCTAssertEqual(
            try decode(try XCTUnwrap(list(DraftStore(directory: directory)).records.first)).title,
            "Before")

        store.failWrites = false
        try save(latest, id: id, to: store)
        XCTAssertEqual(
            try decode(try XCTUnwrap(list(DraftStore(directory: directory)).records.first)), latest)
    }

    func testFailedFirstWriteDoesNotNeedAnyExistingFolderAndSurvivesDiscovery() throws {
        let store = DraftStore(directory: directory)
        let id = UUID()
        let payload = Payload(title: "Unsaved", body: "Keep this copy")
        store.failWrites = true
        XCTAssertThrowsError(try save(payload, id: id, to: store))
        XCTAssertEqual(try decode(try XCTUnwrap(list(store).records.first)), payload)
        XCTAssertTrue(list(DraftStore(directory: directory)).records.isEmpty)
        store.failWrites = false
        try save(payload, id: id, to: store)
        XCTAssertEqual(list(DraftStore(directory: directory)).records.map(\.id), [id])
    }

    func testImportedCompletionSuppressesOnlyExactSourceAndRetainsOriginal() throws {
        let store = DraftStore(directory: directory)
        let original = Data("{\"title\":\"Old source\",\"body\":\"Keep exact bytes\"}".utf8)
        try writeOld(original, resourceKey: resourceKey)
        let fingerprint = DraftStore.fingerprint(original)
        let id = UUID()
        try save(
            Payload(title: "Recovered", body: "Ready"), id: id, to: store,
            sourceFingerprint: fingerprint)
        try store.resolveCreationDraft(
            id: id, ownerID: ownerID, workspace: workspace,
            projectID: projectID, resourceKey: resourceKey)

        let relaunched = DraftStore(directory: directory)
        let record = try XCTUnwrap(list(relaunched).records.first)
        XCTAssertEqual(record.state, .resolved)
        XCTAssertTrue(record.payload.isEmpty)
        XCTAssertEqual(list(relaunched).resolvedSourceFingerprints, [fingerprint])
        XCTAssertNotEqual(DraftStore.fingerprint(original + Data(" ".utf8)), fingerprint)
        XCTAssertEqual(
            try relaunched.rawRecordData(ownerID: ownerID, resourceKey: resourceKey), original)
        XCTAssertThrowsError(
            try save(Payload(title: "Late callback", body: ""), id: id, to: relaunched))
    }

    func testDiscardRemovesOnlySelectedFreshDraftAndRetainsImportedSourceReceipt() throws {
        let store = DraftStore(directory: directory)
        let first = UUID()
        let second = UUID()
        let imported = UUID()
        try save(Payload(title: "Discard", body: ""), id: first, to: store)
        try save(Payload(title: "Keep", body: ""), id: second, to: store)
        try save(
            Payload(title: "Imported", body: ""), id: imported, to: store,
            sourceFingerprint: "old-exact-source")

        try store.discardCreationDraft(
            id: first, ownerID: ownerID, workspace: workspace,
            projectID: projectID, resourceKey: resourceKey)
        try store.discardCreationDraft(
            id: imported, ownerID: ownerID, workspace: workspace,
            projectID: projectID, resourceKey: resourceKey)
        // Repeated discard is safe, including after a relaunch.
        let relaunched = DraftStore(directory: directory)
        try relaunched.discardCreationDraft(
            id: first, ownerID: ownerID, workspace: workspace,
            projectID: projectID, resourceKey: resourceKey)
        let listing = list(relaunched)
        XCTAssertEqual(Set(listing.records.map(\.id)), [second, imported])
        XCTAssertEqual(listing.records.first { $0.id == second }?.state, .active)
        XCTAssertEqual(listing.records.first { $0.id == imported }?.state, .resolved)
        XCTAssertEqual(listing.resolvedSourceFingerprints, ["old-exact-source"])
    }

    func testFailedResolutionRetainsReceiptInMemoryAndCanPersistItOnRetry() throws {
        let store = DraftStore(directory: directory)
        let id = UUID()
        try save(
            Payload(title: "Completed", body: ""), id: id, to: store, sourceFingerprint: "source")
        store.failWrites = true
        XCTAssertThrowsError(
            try store.resolveCreationDraft(
                id: id, ownerID: ownerID,
                workspace: workspace, projectID: projectID, resourceKey: resourceKey))
        XCTAssertEqual(list(store).records.first?.state, .resolved)
        XCTAssertEqual(list(DraftStore(directory: directory)).records.first?.state, .active)
        store.failWrites = false
        try store.resolveCreationDraft(
            id: id, ownerID: ownerID, workspace: workspace,
            projectID: projectID, resourceKey: resourceKey)
        XCTAssertEqual(list(DraftStore(directory: directory)).records.first?.state, .resolved)
    }

    func testFailedDiscardKeepsFreshDraftAvailableForRetry() throws {
        let store = DraftStore(directory: directory)
        let id = UUID()
        try save(Payload(title: "Keep until discard succeeds", body: ""), id: id, to: store)
        store.failWrites = true
        XCTAssertThrowsError(
            try store.discardCreationDraft(
                id: id, ownerID: ownerID,
                workspace: workspace, projectID: projectID, resourceKey: resourceKey))
        XCTAssertEqual(list(store).records.map(\.id), [id])
        store.failWrites = false
        try store.discardCreationDraft(
            id: id, ownerID: ownerID, workspace: workspace,
            projectID: projectID, resourceKey: resourceKey)
        XCTAssertTrue(list(DraftStore(directory: directory)).records.isEmpty)
    }

    func testRemoveAllClearsCreationMemoryAndDiskForOnlyOneOwner() throws {
        let store = DraftStore(directory: directory)
        try save(Payload(title: "Owner A", body: ""), id: UUID(), to: store)
        try store.saveCreationDraft(
            Payload(title: "Owner B", body: ""), id: UUID(), ownerID: "owner-b",
            workspace: workspace, projectID: projectID, resourceKey: resourceKey)
        try store.removeAll(ownerID: ownerID)
        XCTAssertTrue(list(store).records.isEmpty)
        XCTAssertTrue(list(DraftStore(directory: directory)).records.isEmpty)
        XCTAssertEqual(
            store.listCreationDrafts(
                ownerID: "owner-b", workspace: workspace,
                projectID: projectID, resourceKey: resourceKey
            ).records.count, 1)
    }

    func testBoundLegacyBytesRemainAvailableWhenScopedPayloadIsCorrupt() throws {
        let store = DraftStore(directory: directory)
        let original = Data(
            "{\n  \"body\": \"  Keep exact bytes\\n\",\n  \"title\": \"Legacy idea\"\n}\n".utf8)
        try writeOld(original, resourceKey: resourceKey)
        let payload = try JSONDecoder().decode(Payload.self, from: original)
        try store.recoverLegacy(
            payload, ownerID: ownerID, workspace: workspace, projectID: projectID,
            resourceKey: resourceKey, legacyResourceKey: resourceKey)
        let scopedKey = store.scopedKey(
            workspace: workspace, projectID: projectID, resourceKey: resourceKey)
        let corrupted = Data("{corrupt scoped payload".utf8)
        try writeOld(corrupted, resourceKey: scopedKey)

        let relaunched = DraftStore(directory: directory)
        XCTAssertThrowsError(
            try relaunched.loadScoped(
                ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: resourceKey, as: Payload.self))
        XCTAssertEqual(
            try relaunched.boundLegacyRecordData(
                ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: resourceKey), original)
        XCTAssertEqual(try Data(contentsOf: oldURL(resourceKey: resourceKey)), original)
        XCTAssertEqual(try Data(contentsOf: oldURL(resourceKey: scopedKey)), corrupted)
    }

    func testBoundLegacyBytesRemainAvailableWhenScopedPayloadIsMissing() throws {
        let store = DraftStore(directory: directory)
        let original = Data("{\"title\":\"Legacy idea\",\"body\":\"Keep the original\\n\"}\n".utf8)
        try writeOld(original, resourceKey: resourceKey)
        try store.recoverLegacy(
            JSONDecoder().decode(Payload.self, from: original), ownerID: ownerID,
            workspace: workspace, projectID: projectID, resourceKey: resourceKey,
            legacyResourceKey: resourceKey)
        let scopedKey = store.scopedKey(
            workspace: workspace, projectID: projectID, resourceKey: resourceKey)
        try FileManager.default.removeItem(at: oldURL(resourceKey: scopedKey))

        let relaunched = DraftStore(directory: directory)
        XCTAssertEqual(
            try relaunched.boundLegacyRecordData(
                ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: resourceKey), original)
        XCTAssertEqual(try Data(contentsOf: oldURL(resourceKey: resourceKey)), original)
        XCTAssertFalse(FileManager.default.fileExists(atPath: oldURL(resourceKey: scopedKey).path))
    }

    func testBoundLegacyBytesRequireExistingBindingForExactOwnerAndScope() throws {
        let store = DraftStore(directory: directory)
        let payload = Payload(title: "Legacy idea", body: "Only its confirmed destination")
        try store.save(payload, ownerID: ownerID, resourceKey: resourceKey)
        XCTAssertNil(
            try store.boundLegacyRecordData(
                ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: resourceKey),
            "Discovering legacy bytes must not establish their scope.")
        try store.recoverLegacy(
            payload, ownerID: ownerID, workspace: workspace, projectID: projectID,
            resourceKey: resourceKey, legacyResourceKey: resourceKey)
        // Matching raw bytes in another owner's folder are still unbound.
        try store.save(payload, ownerID: "owner-b", resourceKey: resourceKey)
        let otherLegacyKey = "card:other:new"
        try store.save(payload, ownerID: ownerID, resourceKey: otherLegacyKey)
        let relaunched = DraftStore(directory: directory)
        let changedOrigin = Workspace(
            id: workspace.id, slug: workspace.slug, name: workspace.name,
            url: URL(string: "https://studio.kanban.cards/")!)
        let changedWorkspace = Workspace(
            id: "workspace-b", slug: workspace.slug, name: workspace.name, url: workspace.url)

        XCTAssertNotNil(
            try relaunched.boundLegacyRecordData(
                ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: resourceKey))
        XCTAssertNil(
            try relaunched.boundLegacyRecordData(
                ownerID: "owner-b", workspace: workspace, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: resourceKey))
        XCTAssertNil(
            try relaunched.boundLegacyRecordData(
                ownerID: ownerID, workspace: changedOrigin, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: resourceKey))
        XCTAssertNil(
            try relaunched.boundLegacyRecordData(
                ownerID: ownerID, workspace: changedWorkspace, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: resourceKey))
        XCTAssertNil(
            try relaunched.boundLegacyRecordData(
                ownerID: ownerID, workspace: workspace, projectID: "project-b",
                resourceKey: resourceKey, legacyResourceKey: resourceKey))
        XCTAssertNil(
            try relaunched.boundLegacyRecordData(
                ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: "card:other:new", legacyResourceKey: resourceKey))
        XCTAssertNil(
            try relaunched.boundLegacyRecordData(
                ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: otherLegacyKey))
    }

    private struct Payload: Codable, Equatable {
        var title: String
        var body: String
    }

    @discardableResult
    private func save(
        _ payload: Payload, id: UUID, to store: DraftStore,
        sourceFingerprint: String? = nil, savedAt: Date = Date()
    ) throws -> CreationDraftRecord {
        try store.saveCreationDraft(
            payload, id: id, ownerID: ownerID, workspace: workspace,
            projectID: projectID, resourceKey: resourceKey, sourceFingerprint: sourceFingerprint,
            savedAt: savedAt)
    }

    private func list(_ store: DraftStore) -> CreationDraftListing {
        store.listCreationDrafts(
            ownerID: ownerID, workspace: workspace,
            projectID: projectID, resourceKey: resourceKey)
    }

    private func decode(_ record: CreationDraftRecord) throws -> Payload {
        try JSONDecoder().decode(Payload.self, from: record.payload)
    }

    private func writeOld(_ data: Data, resourceKey: String) throws {
        let folder = directory.appendingPathComponent(DraftStore.fingerprint(Data(ownerID.utf8)))
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try data.write(to: oldURL(resourceKey: resourceKey))
    }

    private func oldURL(resourceKey: String) -> URL {
        directory.appendingPathComponent(DraftStore.fingerprint(Data(ownerID.utf8)))
            .appendingPathComponent(DraftStore.fingerprint(Data(resourceKey.utf8)))
            .appendingPathExtension("json")
    }

    private func creationURL(id: UUID) throws -> URL {
        let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil)
        return try XCTUnwrap(
            files?.allObjects.compactMap { $0 as? URL }
                .first { $0.lastPathComponent == id.uuidString.lowercased() + ".json" })
    }
}
