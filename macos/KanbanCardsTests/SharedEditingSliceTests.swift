import CryptoKit
import Foundation
import XCTest
@testable import KanbanCards

/// Shared interaction slice scenarios run in the disposable macOS VM.
@MainActor
final class SharedEditingSliceTests: XCTestCase {
    private var directory: URL!
    private var defaults: UserDefaults!
    private var suite: String!
    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("shared-slice-\(UUID().uuidString)")
        suite = "cards.kanban.shared-slice.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }
    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }
    private func fixture() throws -> (AppModel, Workspace, Project, Card) {
        let model = AppModel(drafts: DraftStore(directory: directory), defaults: defaults, demo: true)
        let workspace = try XCTUnwrap(model.workspaces.first)
        let project = try XCTUnwrap(model.project(id: "demo-project", in: workspace))
        let card = try XCTUnwrap(project.cards.first { $0.id == "demo-card-homepage" })
        return (model, workspace, project, card)
    }

    func testSI005OwnMoveThenSavePreservesDestinationAndDirtyTitle() async throws {
        let (model, workspace, project, card) = try fixture()
        let session = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        session.pending.draft.title = "A title retained during Move"
        let moved = try await model.moveCard(cardID: card.id, to: "done", projectID: project.id, in: workspace)
        XCTAssertEqual(session.pending.draft.title, "A title retained during Move")
        XCTAssertEqual(session.pending.draft.columnId, "done")
        XCTAssertEqual(session.pending.draft.position, moved.position)
        XCTAssertEqual(session.pending.draft.version, moved.version)
        XCTAssertTrue(session.conflicts.isEmpty)
        await session.save()
        XCTAssertEqual(session.currentCard?.columnId, "done")
        XCTAssertEqual(session.currentCard?.title, "A title retained during Move")
        XCTAssertEqual(session.currentCard?.version, moved.version + 1)
    }

    func testSI006LocallyDirtyPlacementRequiresDestinationOnlyMove() async throws {
        let (model, workspace, project, card) = try fixture()
        let session = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        session.pending.draft.title = "Keep text out of Move"
        session.pending.draft.columnId = "done"
        session.pending.draft.position = 99
        session.reconcile(with: card)
        XCTAssertEqual(session.conflicts, [.placement])
        XCTAssertFalse(session.canSave)
        await session.save()
        XCTAssertEqual(session.currentCard, card)
        session.resolve(.placement, useSaved: false)
        XCTAssertEqual(session.conflicts, [.placement], "Text conflict choices cannot enact a destination change.")
        await session.moveToProposedColumn()
        XCTAssertEqual(session.currentCard?.columnId, "done")
        XCTAssertEqual(session.currentCard?.title, card.title, "Move must contain no unsaved text.")
        XCTAssertEqual(session.pending.draft.title, "Keep text out of Move")
        XCTAssertTrue(session.conflicts.isEmpty)
        await session.save()
        XCTAssertEqual(session.currentCard?.columnId, "done")
        XCTAssertEqual(session.currentCard?.title, "Keep text out of Move")
    }

    func testSI008And009NonoverlapMergesAndSameFieldChoiceSurvivesRefresh() async throws {
        let (model, workspace, project, card) = try fixture()
        let session = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        session.pending.draft.title = "My local title"
        var remote = CardDraft(card: card)
        remote.title = "New saved title"
        remote.body = "Independent saved body"
        _ = try await model.saveCard(remote, projectID: project.id, in: workspace, key: "remote")
        XCTAssertEqual(session.pending.draft.title, "My local title")
        XCTAssertEqual(session.pending.draft.body, "Independent saved body")
        XCTAssertEqual(session.conflicts, [.title])
        XCTAssertFalse(session.canSave)
        await session.retryRefresh()
        XCTAssertEqual(session.conflicts, [.title], "Refreshing must not silently choose an unresolved local field.")
        session.resolve(.title, useSaved: false)
        XCTAssertTrue(session.canSave)
        await session.save()
        XCTAssertEqual(session.currentCard?.title, "My local title")
        XCTAssertEqual(session.currentCard?.body, "Independent saved body")
    }

    func testSI011UnknownPATCHReadbackMatchingDoesNotReplayOrClaimReceipt() async throws {
        let (model, workspace, project, card) = try fixture()
        let session = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        session.pending.draft.title = "Lost response title"
        let snapshot = session.pending.draft
        session.pending.submitted = snapshot
        let written = try await model.saveCard(snapshot, projectID: project.id, in: workspace, key: "lost-response")
        XCTAssertEqual(session.pending.submitted, snapshot)
        await session.save()
        XCTAssertEqual(session.currentCard?.version, written.version, "Readback must not replay PATCH.")
        XCTAssertNil(session.pending.confirmed, "A matching value is not a confirmed response receipt.")
        XCTAssertNil(session.pending.submitted)
        XCTAssertEqual(session.pending.draft, CardDraft(card: written))
        XCTAssertEqual(session.savedMessage, "Current saved values match the submitted changes.")
    }

    func testSI011UnknownPATCHReadbackDifferentRetainsDraftForNewExplicitSave() async throws {
        let (model, workspace, project, card) = try fixture()
        let session = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        session.pending.draft.title = "Unconfirmed title"
        session.pending.submitted = session.pending.draft
        let identity = session.pending.key
        XCTAssertFalse(session.canRevert, "An unresolved submitted identity cannot be discarded.")
        await session.save()
        XCTAssertEqual(session.currentCard, card, "Checking an unknown request only reads.")
        XCTAssertNil(session.pending.submitted)
        XCTAssertNotEqual(session.pending.key, identity)
        XCTAssertEqual(session.pending.draft.title, "Unconfirmed title")
        XCTAssertTrue(session.canSave)
        await session.save()
        XCTAssertEqual(session.currentCard?.version, card.version + 1)
    }

    func testSI007And018CommentAuthorityIsSharedAcrossPresentationsAndCardDraftSurvivesPost() async throws {
        let (model, workspace, project, card) = try fixture()
        let cardSession = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        cardSession.pending.draft.title = "An unfinished Card edit"
        let pane = model.commentEditingSession(workspace: workspace, projectID: project.id, cardID: card.id)
        let window = model.commentEditingSession(workspace: workspace, projectID: project.id, cardID: card.id)
        XCTAssertTrue(pane === window)
        pane.pending.body = "  One exact shared Comment\n"
        XCTAssertEqual(window.pending.body, pane.pending.body)
        let key = pane.pending.key
        pane.pending.submitted = pane.pending.body
        window.pending.body = "A presentation cannot replace the frozen request"
        XCTAssertFalse(window.canDiscard)
        await window.post()
        XCTAssertEqual(cardSession.currentCard?.comments.last?.body, "  One exact shared Comment\n")
        XCTAssertEqual(cardSession.currentCard?.comments.count, card.comments.count + 1)
        XCTAssertEqual(cardSession.pending.draft.title, "An unfinished Card edit")
        XCTAssertEqual(cardSession.pending.draft.version, card.version + 1)
        XCTAssertTrue(cardSession.conflicts.isEmpty)
        XCTAssertNil(pane.pending.submitted)
        XCTAssertNotEqual(pane.pending.key, key)
        XCTAssertEqual(window.pending.body, "")
        XCTAssertNotNil(pane.completionID)
    }

    func testSI015And016CommentSignoutHidesAllViewsAndKeepsOwnerRecovery() async throws {
        let (model, workspace, project, card) = try fixture()
        let session = model.commentEditingSession(workspace: workspace, projectID: project.id, cardID: card.id)
        session.pending.body = "Private Comment draft"
        session.pending.submitted = session.pending.body
        let exact = session.pending
        let key = session.resourceKey
        await model.signOut()
        XCTAssertEqual(session.pending.body, "")
        XCTAssertFalse(session.sessionIsCurrent)
        XCTAssertFalse(session.canPost)
        XCTAssertEqual(try model.drafts.load(ownerID: "demo-owner", resourceKey: key, as: PendingCommentDraft.self), exact)
        XCTAssertNil(try model.drafts.load(ownerID: "other-owner", resourceKey: key, as: PendingCommentDraft.self))
    }

    func testSI015ExactOriginScopesAndLosslessExplicitLegacyAssociation() throws {
        let (_, workspace, project, card) = try fixture()
        var other = workspace
        other.url = URL(string: "https://other.kanban.cards")!
        let first = MacDraftScope.key("shared-comment", workspace: workspace, projectID: project.id, resourceID: card.id)
        let second = MacDraftScope.key("shared-comment", workspace: other, projectID: project.id, resourceID: card.id)
        XCTAssertNotEqual(first, second)
        let store = DraftStore(directory: directory)
        let old = PendingCommentDraft(body: "Origin-less exact source", key: "frozen", submitted: "Origin-less exact source")
        try store.save(old, ownerID: "owner", resourceKey: "legacy")
        XCTAssertTrue(try store.legacyMayBeAssociated(ownerID: "owner", legacyKey: "legacy", destination: first))
        try store.associateLegacy(ownerID: "owner", legacyKey: "legacy", destination: first)
        XCTAssertFalse(try store.legacyMayBeAssociated(ownerID: "owner", legacyKey: "legacy", destination: second))
        XCTAssertThrowsError(try store.associateLegacy(ownerID: "owner", legacyKey: "legacy", destination: second))
        XCTAssertEqual(try store.load(ownerID: "owner", resourceKey: "legacy", as: PendingCommentDraft.self), old,
                       "Migration must preserve the origin-ambiguous source and its operation identity.")
        let creation = try store.creationResourceKey(ownerID: "owner", scope: first)
        XCTAssertEqual(try store.creationResourceKey(ownerID: "owner", scope: first), creation)
        XCTAssertNotEqual(try store.creationResourceKey(ownerID: "owner", scope: second), creation)
    }

    private func draftFile(ownerID: String, resourceKey: String) -> URL {
        func digest(_ text: String) -> String {
            SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        }
        return directory.appendingPathComponent(digest(ownerID), isDirectory: true)
            .appendingPathComponent(digest(resourceKey)).appendingPathExtension("json")
    }

    func testLegacyCommentAssociationSurvivesFailedScopedCopyAndRelaunch() throws {
        let (model, workspace, project, card) = try fixture()
        let legacyKey = "workspace:\(workspace.id):project:\(project.id):card:\(card.id):comment"
        let destination = MacDraftScope.key("shared-comment", workspace: workspace, projectID: project.id, resourceID: card.id)
        let old = PendingCommentDraft(body: "Unconfirmed exact Comment", key: "frozen-original-key", submitted: "Unconfirmed exact Comment")
        try model.drafts.save(old, ownerID: model.ownerID, resourceKey: legacyKey)
        let originalBytes = try Data(contentsOf: draftFile(ownerID: model.ownerID, resourceKey: legacyKey))
        try model.drafts.associateLegacy(ownerID: model.ownerID, legacyKey: legacyKey, destination: destination)
        // A directory at the final leaf rejects the atomic copy after binding succeeds.
        let blocked = draftFile(ownerID: model.ownerID, resourceKey: destination)
        try FileManager.default.createDirectory(at: blocked, withIntermediateDirectories: true)
        XCTAssertThrowsError(try model.drafts.save(old, ownerID: model.ownerID, resourceKey: destination))
        try FileManager.default.removeItem(at: blocked)
        let relaunched = AppModel(drafts: DraftStore(directory: directory), defaults: defaults, demo: true)
        let session = relaunched.commentEditingSession(workspace: workspace, projectID: project.id, cardID: card.id)
        XCTAssertEqual(session.legacyDraft, old)
        session.associateLegacyDraft()
        XCTAssertEqual(session.pending, old, "Recovery retains the original submitted payload and POST identity.")
        XCTAssertEqual(try Data(contentsOf: draftFile(ownerID: model.ownerID, resourceKey: legacyKey)), originalBytes)
        var anotherOrigin = workspace; anotherOrigin.url = URL(string: "https://other.kanban.cards")!
        XCTAssertFalse(try relaunched.drafts.legacyMayBeAssociated(ownerID: model.ownerID, legacyKey: legacyKey,
            destination: MacDraftScope.key("shared-comment", workspace: anotherOrigin, projectID: project.id, resourceID: card.id)))
    }

    func testLegacyRetirementPrecedesRemovalAndPreventsResurrectionAfterDiscard() throws {
        let store = DraftStore(directory: directory)
        let old = PendingCommentDraft(body: "Previously associated unsent text", key: "legacy-key")
        try store.save(old, ownerID: "owner", resourceKey: "legacy")
        try store.associateLegacy(ownerID: "owner", legacyKey: "legacy", destination: "scoped")
        try store.save(old, ownerID: "owner", resourceKey: "scoped")
        let blocked = draftFile(ownerID: "owner", resourceKey: "legacy-retired:scoped")
        try FileManager.default.createDirectory(at: blocked, withIntermediateDirectories: true)
        XCTAssertThrowsError(try store.remove(ownerID: "owner", resourceKey: "scoped"))
        let afterFailure = DraftStore(directory: directory)
        XCTAssertEqual(try afterFailure.load(ownerID: "owner", resourceKey: "scoped", as: PendingCommentDraft.self), old)
        try FileManager.default.removeItem(at: blocked)
        try store.remove(ownerID: "owner", resourceKey: "scoped")
        let relaunched = DraftStore(directory: directory)
        XCTAssertNil(try relaunched.load(ownerID: "owner", resourceKey: "scoped", as: PendingCommentDraft.self))
        XCTAssertEqual(try relaunched.load(ownerID: "owner", resourceKey: "legacy", as: PendingCommentDraft.self), old)
        XCTAssertFalse(try relaunched.legacyMayBeAssociated(ownerID: "owner", legacyKey: "legacy", destination: "scoped"))
        XCTAssertThrowsError(try relaunched.associateLegacy(ownerID: "owner", legacyKey: "legacy", destination: "scoped"))
    }

    private func installMoveRecord(model: AppModel, workspace: Workspace, project: Project, card: Card,
                                   confirmed: Card? = nil, position: Double = 3) throws -> SharedCardEditingSession {
        var draft = CardDraft(card: card); draft.title = "Text retained beside the Move"
        let pending = PendingCardDraft(draft: draft, key: "separate-text-identity")
        let intent = MacPendingCardMove(card: card, columnID: "done", position: position, confirmedCard: confirmed)
        let record = SharedCardDraftRecord(pending: pending, savedCard: card, alternatives: [], legacyImported: true,
            conflicts: [], pendingMove: intent)
        let scope = MacDraftScope.key("shared-card-editor", workspace: workspace, projectID: project.id, resourceID: card.id)
        try model.drafts.save(record, ownerID: model.ownerID, resourceKey: scope)
        return model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
    }

    func testSI011UnknownMoveRelaunchReadbackCannotTurnNewDestinationIntoAnotherWrite() async throws {
        let (model, workspace, project, card) = try fixture()
        let session = try installMoveRecord(model: model, workspace: workspace, project: project, card: card)
        XCTAssertEqual(session.pendingMove?.card.version, card.version)
        XCTAssertEqual(session.pendingMove?.columnID, "done")
        XCTAssertTrue(session.editingDisabled)
        XCTAssertFalse(session.canRevert)
        let readback = try await model.moveCard(cardID: card.id, to: "next", projectID: project.id, in: workspace)
        XCTAssertEqual(readback, card, "A different destination cannot replace the frozen original request during readback.")
        XCTAssertEqual(session.currentCard, card)
        XCTAssertNil(session.pendingMove)
        XCTAssertEqual(session.pending.draft.title, "Text retained beside the Move")
        XCTAssertTrue(session.savedMessage?.contains("not current") == true)
        await session.save()
        XCTAssertEqual(session.currentCard?.columnId, card.columnId, "Text Save after reconciliation must preserve current placement.")
    }

    func testSI005And011ObservedMoveReadbackPreservesDirtyTextWithoutRepeatingMove() async throws {
        let (model, workspace, project, card) = try fixture()
        let moved = try await model.performCardMove(card, to: "done", position: 3, projectID: project.id, in: workspace)
        let session = try installMoveRecord(model: model, workspace: workspace, project: project, card: card)
        let retained = try XCTUnwrap(model.drafts.load(ownerID: model.ownerID, resourceKey: session.resourceKey, as: SharedCardDraftRecord.self))
        XCTAssertEqual(retained.pendingMove?.columnID, "done")
        XCTAssertEqual(retained.pendingMove?.position, 3)
        XCTAssertEqual(retained.pendingMove?.card.version, card.version)
        await session.save()
        XCTAssertNil(session.pendingMove)
        XCTAssertNil(session.pending.confirmed, "Readback is not an attributed text or Move confirmation receipt.")
        XCTAssertEqual(session.currentCard?.version, moved.version)
        XCTAssertEqual(session.pending.draft.title, "Text retained beside the Move")
        XCTAssertEqual(session.pending.draft.columnId, "done")
        XCTAssertTrue(session.savedMessage?.contains("does not identify") == true)
        await session.save()
        XCTAssertEqual(session.currentCard?.version, moved.version + 1)
        XCTAssertEqual(session.currentCard?.columnId, "done")
    }

    func testSI012ConfirmedMoveReceiptOnlyCleansLocalState() async throws {
        let (model, workspace, project, card) = try fixture()
        let moved = try await model.performCardMove(card, to: "done", position: 3, projectID: project.id, in: workspace)
        let session = try installMoveRecord(model: model, workspace: workspace, project: project, card: card, confirmed: moved)
        XCTAssertEqual(session.confirmationLabel, "Retry Move Cleanup")
        await session.save()
        XCTAssertNil(session.pendingMove)
        XCTAssertEqual(session.currentCard?.version, moved.version)
        XCTAssertEqual(session.pending.draft.title, "Text retained beside the Move")
        XCTAssertEqual(session.pending.draft.columnId, "done")
    }

    func testSI011UnknownTextSubmissionMustBeReadBeforeSeparateMove() async throws {
        let (model, workspace, project, card) = try fixture()
        let session = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        session.pending.draft.title = "Unknown text submission"
        session.pending.submitted = session.pending.draft
        do { _ = try await model.moveCard(cardID: card.id, to: "done", projectID: project.id, in: workspace); XCTFail("Move requires a separate explicit action after text readback.") }
        catch { XCTAssertTrue(error.localizedDescription.contains("earlier Card save")) }
        XCTAssertEqual(session.currentCard, card)
        XCTAssertNil(session.pending.submitted)
        XCTAssertNil(session.pendingMove)
        XCTAssertEqual(session.pending.draft.title, "Unknown text submission")
    }

    func testSI004MoveIsNotSentWhenItsFrozenIntentCannotBeProtected() async throws {
        try Data("blocked storage".utf8).write(to: directory)
        let (model, workspace, project, card) = try fixture()
        let session = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        session.pending.draft.title = "Retain this text in owner recovery"
        do { _ = try await model.moveCard(cardID: card.id, to: "done", projectID: project.id, in: workspace); XCTFail("No Move may precede local protection.") }
        catch { XCTAssertTrue(error.localizedDescription.contains("No Move was sent")) }
        XCTAssertEqual(session.currentCard, card)
        XCTAssertNil(session.pendingMove)
        XCTAssertEqual(session.pending.draft.title, "Retain this text in owner recovery")
        XCTAssertTrue(model.drafts.hasUnpersistedRecovery(ownerID: model.ownerID))
    }

    func testSharedFixturesExerciseActualPortableReconciler() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("tests/fixtures/shared-editing.json")
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let baselineJSON = try XCTUnwrap(root["baseline"] as? [String: Any])
        let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
        func card(_ patch: [String: Any]) throws -> Card {
            try JSONDecoder().decode(Card.self, from: JSONSerialization.data(withJSONObject: baselineJSON.merging(patch) { _, new in new }))
        }
        let base = try card([:])
        for vector in cases {
            let label = try XCTUnwrap(vector["id"] as? String)
            let local = CardDraft(card: try card(try XCTUnwrap(vector["localChanges"] as? [String: Any])))
            let latest = try card(try XCTUnwrap(vector["latestChanges"] as? [String: Any]))
            let result = local.reconcile(base: base, latest: latest)
            let expectedConflicts = try XCTUnwrap(vector["conflicts"] as? [String])
            XCTAssertEqual(result.conflicts.map(\.rawValue).sorted(), expectedConflicts.sorted(), label)
            let actual = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(result.draft)) as? [String: Any])
            for (field, value) in try XCTUnwrap(vector["expectedDraft"] as? [String: Any]) {
                XCTAssertEqual(actual[field] as? NSObject, value as? NSObject, "\(label): \(field)")
            }
        }
    }
}
