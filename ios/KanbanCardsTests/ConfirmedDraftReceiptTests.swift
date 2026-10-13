import Foundation
import XCTest
@testable import KanbanCards

@MainActor
final class ConfirmedDraftReceiptTests: XCTestCase {
    func testPreReceiptDraftsRemainReadableWithoutAssumingCompletion() throws {
        let oldCard = #"{"draft":{"title":"Unconfirmed Card","body":"  Keep source\n","nextAction":"","blockedReason":"","columnId":"next","position":0},"key":"old-card-key","submitted":null}"#
        let oldProject = #"{"draft":{"name":"Unconfirmed Project","description":"Keep description"},"key":"old-project-key","submitted":null}"#
        let oldComment = #"{"body":"Unconfirmed Comment","key":"old-comment-key","submitted":"Unconfirmed Comment"}"#
        let card = try JSONDecoder().decode(PendingCardDraft.self, from: Data(oldCard.utf8))
        let project = try JSONDecoder().decode(PendingProjectDraft.self, from: Data(oldProject.utf8))
        let comment = try JSONDecoder().decode(PendingCommentDraft.self, from: Data(oldComment.utf8))
        XCTAssertNil(card.confirmed)
        XCTAssertNil(project.confirmed)
        XCTAssertNil(comment.confirmed)
        XCTAssertEqual(card.draft.body, "  Keep source\n")
        XCTAssertEqual(project.key, "old-project-key")
        XCTAssertEqual(comment.submitted, "Unconfirmed Comment")
    }

    func testConfirmedReceiptsSurviveFailedCleanupAndRelaunch() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DraftStore(directory: directory, fileManager: CleanupFailingFileManager())
        let receipt = ConfirmedDraftReceipt(confirmedAt: "2026-10-11T20:00:00.000Z")
        var cardDraft = CardDraft(columnId: "next")
        cardDraft.title = "Already saved"
        let card = PendingCardDraft(draft: cardDraft, key: "saved-card-key", submitted: cardDraft, confirmed: receipt)
        let projectDraft = ProjectDraft(name: "Already saved")
        let project = PendingProjectDraft(draft: projectDraft, key: "saved-project-key", submitted: projectDraft, confirmed: receipt)
        let comment = PendingCommentDraft(body: "Already sent", key: "sent-comment-key", submitted: "Already sent", confirmed: receipt)
        try store.save(card, ownerID: "owner-a", resourceKey: "card")
        try store.save(project, ownerID: "owner-a", resourceKey: "project")
        try store.save(comment, ownerID: "owner-a", resourceKey: "comment")
        for key in ["card", "project", "comment"] {
            XCTAssertThrowsError(try store.remove(ownerID: "owner-a", resourceKey: key))
        }

        let relaunchedStore = DraftStore(directory: directory)
        XCTAssertEqual(try relaunchedStore.load(ownerID: "owner-a", resourceKey: "card", as: PendingCardDraft.self), card)
        XCTAssertEqual(try relaunchedStore.load(ownerID: "owner-a", resourceKey: "project", as: PendingProjectDraft.self), project)
        XCTAssertEqual(try relaunchedStore.load(ownerID: "owner-a", resourceKey: "comment", as: PendingCommentDraft.self), comment)
        XCTAssertNil(try relaunchedStore.load(ownerID: "owner-b", resourceKey: "card", as: PendingCardDraft.self))
        for key in ["card", "project", "comment"] { try relaunchedStore.remove(ownerID: "owner-a", resourceKey: key) }
        XCTAssertNil(try relaunchedStore.load(ownerID: "owner-a", resourceKey: "card", as: PendingCardDraft.self))
    }
}

private final class CleanupFailingFileManager: FileManager, @unchecked Sendable {
    override func removeItem(at URL: URL) throws {
        throw CocoaError(.fileWriteNoPermission)
    }
}
