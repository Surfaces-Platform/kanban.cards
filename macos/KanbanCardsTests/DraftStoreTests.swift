import Foundation
import XCTest
@testable import KanbanCards

@MainActor
final class DraftStoreTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("macos-drafts-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() async throws {
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
    }

    func testFullCardDraftSurvivesClosingAndReopeningStore() throws {
        var draft = CardDraft(columnId: "doing")
        draft.id = "card-a"
        draft.version = 7
        draft.title = "Unsaved Card title"
        draft.body = "  # Markdown source\n\n- Preserve whitespace  \n"
        draft.nextActor = .human
        draft.nextAction = "Check the layout"
        draft.priority = .high
        draft.blockedReason = "Waiting for review"
        draft.position = 9
        let key = "workspace-a/project-a/card-a"
        try DraftStore(directory: directory).save(draft, ownerID: "owner-a", resourceKey: key)

        let recovered = try DraftStore(directory: directory)
            .load(ownerID: "owner-a", resourceKey: key, as: CardDraft.self)
        XCTAssertEqual(recovered, draft)
    }

    func testOwnersCannotReadOrDeleteEachOthersDrafts() throws {
        let store = DraftStore(directory: directory)
        var first = CardDraft(columnId: "next")
        first.title = "Owner A private draft"
        var second = CardDraft(columnId: "next")
        second.title = "Owner B private draft"
        try store.save(first, ownerID: "owner-a", resourceKey: "same-card")
        XCTAssertNil(try store.load(ownerID: "owner-b", resourceKey: "same-card", as: CardDraft.self))
        try store.save(second, ownerID: "owner-b", resourceKey: "same-card")
        try store.removeAll(ownerID: "owner-a")

        XCTAssertNil(try store.load(ownerID: "owner-a", resourceKey: "same-card", as: CardDraft.self))
        XCTAssertEqual(try store.load(ownerID: "owner-b", resourceKey: "same-card", as: CardDraft.self), second)
    }

    func testDraftStorageUsesPrivatePermissionsAndOpaqueNames() throws {
        let store = DraftStore(directory: directory)
        try store.save(CardDraft(columnId: "next"), ownerID: "private-owner", resourceKey: "private-card")
        let ownerDirectory = try XCTUnwrap(FileManager.default
            .contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        let file = try XCTUnwrap(FileManager.default
            .contentsOfDirectory(at: ownerDirectory, includingPropertiesForKeys: nil).first)

        XCTAssertFalse(ownerDirectory.lastPathComponent.contains("private-owner"))
        XCTAssertFalse(file.lastPathComponent.contains("private-card"))
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: ownerDirectory.path)[.posixPermissions] as? Int, 0o700)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int, 0o600)
    }

    func testFailedWritesRetainExactTextAcrossSessionClearingAndRemainOwnerPartitioned() async throws {
        // A regular file in place of the directory deterministically fails the write.
        try Data("not a directory".utf8).write(to: directory)
        let store = DraftStore(directory: directory)
        let model = AppModel(drafts: store, demo: true)
        var draft = CardDraft(columnId: "next")
        draft.title = "Private unsaved draft"
        draft.body = "  # Exact source\n\n- Keep whitespace  \n"
        XCTAssertThrowsError(try store.save(draft, ownerID: "demo-owner", resourceKey: "card-a"))
        XCTAssertTrue(store.hasUnpersistedRecovery)
        XCTAssertTrue(store.hasRecovery(ownerID: "demo-owner", resourceKey: "card-a"))
        await model.signOut()
        XCTAssertFalse(model.signedIn)
        XCTAssertEqual(try store.load(ownerID: "demo-owner", resourceKey: "card-a", as: CardDraft.self), draft)
        XCTAssertNil(try store.load(ownerID: "another-owner", resourceKey: "card-a", as: CardDraft.self))
        XCTAssertFalse(store.hasUnpersistedRecovery(ownerID: "another-owner"))

        // When storage is available again, retry makes recovery durable for relaunch.
        try FileManager.default.removeItem(at: directory)
        try store.retryRecoveryWrites()
        XCTAssertFalse(store.hasUnpersistedRecovery)
        XCTAssertEqual(try DraftStore(directory: directory).load(ownerID: "demo-owner", resourceKey: "card-a", as: CardDraft.self), draft)
    }

    func testLatestFailedWriteOverridesOlderDurableDraftUntilItIsExplicitlyDiscarded() throws {
        let store = DraftStore(directory: directory)
        var draft = CardDraft(columnId: "next")
        draft.title = "Older durable title"
        try store.save(draft, ownerID: "owner-a", resourceKey: "card-a")
        draft.title = "Newest unsaved title"
        try store.retainForRecovery(draft, ownerID: "owner-a", resourceKey: "card-a")
        XCTAssertEqual(try store.load(ownerID: "owner-a", resourceKey: "card-a", as: CardDraft.self)?.title, draft.title)
        try store.remove(ownerID: "owner-a", resourceKey: "card-a")
        XCTAssertFalse(store.hasUnpersistedRecovery)
        XCTAssertNil(try store.load(ownerID: "owner-a", resourceKey: "card-a", as: CardDraft.self))
    }

    func testLegacyReceiptAndConfirmedCreationRemainRecoverableAfterFailedWrite() throws {
        let legacy = try JSONDecoder().decode(ConfirmedDraftReceipt.self, from: Data(#"{"confirmedAt":"2026-10-13T12:00:00.000Z"}"#.utf8))
        XCTAssertNil(legacy.createdCard)
        let timestamp = ServerTimestamp.string()
        let card = Card(id: "created-card", title: "Already saved", body: "Exact source", nextAction: "", blockedReason: "",
            columnId: "next", position: 0, version: 1, createdAt: timestamp, updatedAt: timestamp, comments: [])
        let draft = CardDraft(card: card)
        let pending = PendingCardDraft(draft: draft, key: "stable-key", submitted: draft,
            confirmed: ConfirmedDraftReceipt(confirmedAt: timestamp, createdCard: card))
        try Data("disk unavailable".utf8).write(to: directory)
        let store = DraftStore(directory: directory)
        XCTAssertThrowsError(try store.save(pending, ownerID: "owner-a", resourceKey: "new-card"))
        XCTAssertEqual(try store.load(ownerID: "owner-a", resourceKey: "new-card", as: PendingCardDraft.self), pending)
        XCTAssertEqual(try store.load(ownerID: "owner-a", resourceKey: "new-card", as: PendingCardDraft.self)?.confirmed?.createdCard, card)
        XCTAssertNil(try store.load(ownerID: "owner-b", resourceKey: "new-card", as: PendingCardDraft.self))
    }

    func testUnreadableDraftRemainsOnDiskForRecovery() throws {
        let store = DraftStore(directory: directory)
        try store.save(CardDraft(columnId: "next"), ownerID: "owner-a", resourceKey: "card-a")
        let ownerDirectory = try XCTUnwrap(FileManager.default
            .contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        let file = try XCTUnwrap(FileManager.default
            .contentsOfDirectory(at: ownerDirectory, includingPropertiesForKeys: nil).first)
        let corrupted = Data("unfinished JSON".utf8)
        try corrupted.write(to: file)

        XCTAssertThrowsError(try store.load(ownerID: "owner-a", resourceKey: "card-a", as: CardDraft.self))
        XCTAssertEqual(try Data(contentsOf: file), corrupted)
    }
}
