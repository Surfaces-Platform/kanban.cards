import Foundation
import XCTest

@testable import KanbanCards

@MainActor
final class CreationPayloadTests: XCTestCase {
    func testCardPreviewIncludesEveryCopiedDetailEvenWithoutTitleOrDescription() {
        var draft = CardDraft(columnId: "doing")
        draft.nextActor = .agent
        draft.priority = .high
        draft.nextAction = "Review the saved plan"
        draft.blockedReason = "Waiting for approval"
        let pending = PendingCardDraft(draft: draft, key: "preview-test")
        XCTAssertEqual(pending.previewTitle, "Untitled card")
        XCTAssertEqual(
            pending.previewDetails(columnName: "Doing"),
            [
                CreationPreviewDetail(label: "Column", value: "Doing"),
                CreationPreviewDetail(label: "Next actor", value: "Agent"),
                CreationPreviewDetail(label: "Priority", value: "High"),
                CreationPreviewDetail(label: "Next action", value: "Review the saved plan"),
                CreationPreviewDetail(label: "Blocker", value: "Waiting for approval"),
            ])
        XCTAssertEqual(
            pending.freshCopy().previewDetails(columnName: "Doing"),
            pending.previewDetails(columnName: "Doing"))
    }

    func testCardExportPreservesAllEditableValuesAndExactMultilineText() {
        var draft = CardDraft(columnId: "doing")
        draft.title = "  Keep this title  "
        draft.body = "First paragraph.\n\n  Indented second paragraph.\n"
        draft.nextActor = .agent
        draft.priority = .high
        draft.nextAction = "  Review the draft\nThen send feedback.\n"
        draft.blockedReason = "Waiting for access.\n  Keep the details.  "
        let pending = PendingCardDraft(draft: draft, key: "export-test")

        XCTAssertEqual(
            pending.exportText,
            "Title:\n  Keep this title  \n\nDescription:\nFirst paragraph.\n\n  Indented second paragraph.\n\n\nColumn:\ndoing\n\nNext actor:\nAgent\n\nPriority:\nHigh\n\nNext action:\n  Review the draft\nThen send feedback.\n\n\nBlocker:\nWaiting for access.\n  Keep the details.  "
        )
    }

    func testProjectExportPreservesExactNameAndDescription() {
        let draft = ProjectDraft(
            name: "  Project name  ", description: "First paragraph.\n\n  More detail.\n")
        let pending = PendingProjectDraft(draft: draft, key: "export-test")

        XCTAssertEqual(
            pending.exportText,
            "Name:\n  Project name  \n\nDescription:\nFirst paragraph.\n\n  More detail.\n")
    }

    func testCardTextCopyPreservesFieldsButStartsANewRequestIdentity() throws {
        var draft = CardDraft(columnId: "doing")
        draft.id = "old-card"
        draft.version = 7
        draft.title = "  Keep the original title  "
        draft.body = "First paragraph.\n\nSecond paragraph.\n"
        draft.nextActor = .human
        draft.priority = .high
        draft.nextAction = "Ask for the review"
        draft.blockedReason = "Waiting for a reply"
        draft.position = 42
        draft.archivedAt = "2026-10-19T10:00:00Z"
        draft.externalKey = "source-creation-key"
        let source = PendingCardDraft(
            draft: draft, key: "source-request-key", submitted: draft,
            confirmed: ConfirmedDraftReceipt(confirmedAt: "2026-10-19T10:00:00Z"),
            unresolvedFields: [.title], schemaVersion: 2)

        let copy = source.freshCopy()

        XCTAssertEqual(copy.draft.title, draft.title)
        XCTAssertEqual(copy.draft.body, draft.body)
        XCTAssertEqual(copy.draft.nextActor, draft.nextActor)
        XCTAssertEqual(copy.draft.priority, draft.priority)
        XCTAssertEqual(copy.draft.nextAction, draft.nextAction)
        XCTAssertEqual(copy.draft.blockedReason, draft.blockedReason)
        XCTAssertEqual(copy.draft.columnId, draft.columnId)
        XCTAssertNil(copy.draft.id)
        XCTAssertNil(copy.draft.version)
        XCTAssertNil(copy.draft.archivedAt)
        XCTAssertEqual(copy.draft.position, 0)
        XCTAssertNotEqual(copy.draft.externalKey, draft.externalKey)
        XCTAssertTrue(try XCTUnwrap(copy.draft.externalKey).hasPrefix("native-draft:"))
        XCTAssertNotEqual(copy.key, source.key)
        XCTAssertNil(copy.submitted)
        XCTAssertNil(copy.confirmed)
        XCTAssertNil(copy.baseline)
        XCTAssertNil(copy.submissionBase)
        XCTAssertNil(copy.unresolvedFields)
        XCTAssertNil(copy.move)
        XCTAssertNil(copy.schemaVersion)
        XCTAssertNoThrow(try copy.validateCreationIdentity())
        XCTAssertEqual(source.draft, draft, "Recovering text must not alter the original payload.")
        XCTAssertEqual(source.submitted, draft)
    }

    func testProjectTextCopyPreservesExactTextAndDropsExistingProjectState() throws {
        var draft = ProjectDraft(
            name: "  Research project  ", description: "Keep this draft.\nWith its line break.\n")
        draft.id = "old-project"
        draft.revision = 9
        draft.columns = [Column(id: "old-column", name: "Original", position: 0)]
        draft.archivedAt = "2026-10-19T10:00:00Z"
        let source = PendingProjectDraft(
            draft: draft, key: "old-project-request", submitted: draft,
            confirmed: ConfirmedDraftReceipt(confirmedAt: "2026-10-19T10:00:00Z"))

        let copy = source.freshCopy()

        XCTAssertEqual(copy.draft.name, draft.name)
        XCTAssertEqual(copy.draft.description, draft.description)
        XCTAssertNil(copy.draft.id)
        XCTAssertNil(copy.draft.revision)
        XCTAssertNil(copy.draft.columns)
        XCTAssertNil(copy.draft.archivedAt)
        XCTAssertNotEqual(copy.key, source.key)
        XCTAssertNil(copy.submitted)
        XCTAssertNil(copy.confirmed)
        XCTAssertNoThrow(try copy.validateCreationIdentity())
        XCTAssertEqual(source.draft, draft)
        XCTAssertEqual(source.submitted, draft)
    }

    func testCardUnconfirmedRequestSurvivesEncodingAndKeepsItsFrozenSubmission() throws {
        var draft = CardDraft(columnId: "next")
        draft.title = "Original request"
        draft.body = "First submitted body"
        draft.externalKey = "original-creation-key"
        var pending = PendingCardDraft(draft: draft, key: "original-idempotency-key")
        pending.prepareRequest()
        // A response-loss retry must retain the first request, even if a later
        // caller accidentally changes the editable representation.
        pending.draft.title = "Unsubmitted title"
        pending.draft.body = "Unsubmitted body"
        pending.draft.columnId = "doing"
        pending.prepareRequest()

        var recovered = try JSONDecoder().decode(
            PendingCardDraft.self, from: JSONEncoder().encode(pending))
        recovered.prepareRequest()

        XCTAssertTrue(recovered.requestWasSent)
        XCTAssertFalse(recovered.saveWasConfirmed)
        XCTAssertEqual(recovered.key, "original-idempotency-key")
        XCTAssertEqual(recovered.submitted, draft)
        XCTAssertEqual(recovered.submitted?.externalKey, "original-creation-key")
        recovered.confirmRequest()
        XCTAssertTrue(recovered.saveWasConfirmed)
        XCTAssertEqual(recovered.submitted, draft)
    }

    func testProjectUnconfirmedRequestSurvivesEncodingAndKeepsItsFrozenSubmission() throws {
        let draft = ProjectDraft(
            name: "Original request", description: "Original submitted description")
        var pending = PendingProjectDraft(draft: draft, key: "original-project-key")
        pending.prepareRequest()
        pending.draft.name = "Unsubmitted project name"
        pending.draft.description = "Unsubmitted description"
        pending.prepareRequest()

        var recovered = try JSONDecoder().decode(
            PendingProjectDraft.self, from: JSONEncoder().encode(pending))
        recovered.prepareRequest()

        XCTAssertTrue(recovered.requestWasSent)
        XCTAssertFalse(recovered.saveWasConfirmed)
        XCTAssertEqual(recovered.key, "original-project-key")
        XCTAssertEqual(recovered.submitted, draft)
        recovered.confirmRequest()
        XCTAssertTrue(recovered.saveWasConfirmed)
        XCTAssertEqual(recovered.submitted, draft)
    }

    func testErasingTextAndKeepingDefaultColumnMatchesEmptyDraftAgain() {
        var initialCard = CardDraft(columnId: "next")
        initialCard.externalKey = "one-local-identity"
        let baselineCard = PendingCardDraft(draft: initialCard, key: "one-request-identity")
        var card = baselineCard.freshCopy()
        card.draft.title = "Temporary title"
        card.draft.body = "Temporary body"
        XCTAssertTrue(card.differsFromEmpty(baselineCard))
        card.draft.title = ""
        card.draft.body = ""
        XCTAssertFalse(
            card.differsFromEmpty(baselineCard), "Regenerated identity is not user content.")
        card.draft.columnId = "doing"
        XCTAssertTrue(
            card.differsFromEmpty(baselineCard), "An explicit column choice is still work to keep.")

        let baselineProject = PendingProjectDraft(draft: ProjectDraft(), key: "project-request")
        var project = baselineProject.freshCopy()
        project.draft.name = "Temporary name"
        project.draft.description = "Temporary description"
        XCTAssertTrue(project.differsFromEmpty(baselineProject))
        project.draft.name = ""
        project.draft.description = ""
        XCTAssertFalse(project.differsFromEmpty(baselineProject))
    }
}
