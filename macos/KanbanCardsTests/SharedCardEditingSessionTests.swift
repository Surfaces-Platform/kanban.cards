import Foundation
import XCTest
@testable import KanbanCards

@MainActor
final class SharedCardEditingSessionTests: XCTestCase {
    private var directory: URL!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("shared-card-editing-\(UUID().uuidString)", isDirectory: true)
        suite = "cards.kanban.shared-editing.tests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
    }

    func testPaneAndWindowObtainOneLiveDraftWhileOtherCardsKeepTheirOwnDrafts() throws {
        let model = makeModel()
        let (workspace, project, card) = try fixture(model)
        let otherCard = try XCTUnwrap(project.cards.first { $0.id != card.id })
        let pane = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        let window = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        let other = model.cardEditingSession(workspace: workspace, projectID: project.id, card: otherCard)
        XCTAssertTrue(pane === window)
        XCTAssertFalse(pane === other)
        pane.pending.draft.title = "One live Card draft"
        window.pending.draft.body = "  # Exact shared source\n\n- Keep whitespace  \n"
        XCTAssertEqual(window.pending.draft.title, "One live Card draft")
        XCTAssertEqual(pane.pending.draft.body, window.pending.draft.body)
        XCTAssertEqual(other.pending.draft, CardDraft(card: otherCard))
        XCTAssertEqual(model.project(id: project.id, in: workspace)?.cards.first { $0.id == card.id }, card,
                       "Typing must not write the Card before explicit Save.")
        XCTAssertTrue(pane.canSave)
        let persisted = try XCTUnwrap(model.drafts.load(ownerID: model.ownerID,
            resourceKey: pane.resourceKey, as: SharedCardDraftRecord.self))
        XCTAssertEqual(persisted.pending.draft, pane.pending.draft)
    }

    func testExplicitSaveUpdatesEverySurfaceAndResetsTheSameSessionForAnotherEdit() async throws {
        let model = makeModel()
        let (workspace, project, card) = try fixture(model)
        let pane = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        let window = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        let otherCard = try XCTUnwrap(project.cards.first { $0.id != card.id })
        let other = model.cardEditingSession(workspace: workspace, projectID: project.id, card: otherCard)
        other.pending.draft.title = "Another Card's unfinished work"
        let retainedOther = other.pending
        pane.pending.draft.title = "Shared saved title"
        pane.pending.draft.body = "Shared saved description"
        let originalKey = pane.pending.key

        await window.save()

        let saved = try XCTUnwrap(model.project(id: project.id, in: workspace)?.cards.first { $0.id == card.id })
        XCTAssertEqual(saved.title, "Shared saved title")
        XCTAssertEqual(saved.body, "Shared saved description")
        XCTAssertEqual(saved.version, card.version + 1)
        XCTAssertTrue(pane === model.cardEditingSession(workspace: workspace, projectID: project.id, card: saved))
        XCTAssertEqual(pane.pending.draft, CardDraft(card: saved))
        XCTAssertEqual(window.pending, pane.pending)
        XCTAssertFalse(pane.isDirty)
        XCTAssertFalse(window.canSave)
        XCTAssertNil(pane.pending.submitted)
        XCTAssertNil(pane.pending.confirmed)
        XCTAssertNotEqual(pane.pending.key, originalKey)
        XCTAssertEqual(other.pending, retainedOther)
        pane.pending.draft.title = "The next unfinished edit"
        XCTAssertTrue(window.canSave, "Save must leave the same shared session ready for the next edit.")
        await window.save()
        XCTAssertEqual(pane.currentCard?.version, card.version + 2)
    }

    func testRelaunchRecoversOneExactDraftFromEitherPresentation() throws {
        let firstModel = makeModel()
        let (workspace, project, card) = try fixture(firstModel)
        let window = firstModel.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        window.pending.draft.title = "Retained shared title"
        window.pending.draft.body = "  # Local draft\n\n- Exact source  \n"
        let retained = window.pending

        let relaunchedModel = makeModel()
        let (nextWorkspace, nextProject, nextCard) = try fixture(relaunchedModel)
        let pane = relaunchedModel.cardEditingSession(workspace: nextWorkspace, projectID: nextProject.id, card: nextCard)
        let reopened = relaunchedModel.cardEditingSession(workspace: nextWorkspace, projectID: nextProject.id, card: nextCard)
        XCTAssertTrue(pane === reopened)
        XCTAssertEqual(pane.pending, retained)
        XCTAssertTrue(pane.recoveredDraft)
        XCTAssertEqual(pane.currentCard, nextCard)
        XCTAssertEqual(pane.currentCard?.title, card.title)
        XCTAssertEqual(pane.pending.draft.version, card.version)
        XCTAssertTrue(pane.canSave)
    }

    func testRevertLoadsLatestSavedCardAcrossSurfacesAndPreservesOtherCardDraft() async throws {
        let model = makeModel()
        let (workspace, project, card) = try fixture(model)
        let pane = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        let window = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        let otherCard = try XCTUnwrap(project.cards.first { $0.id != card.id })
        let other = model.cardEditingSession(workspace: workspace, projectID: project.id, card: otherCard)
        other.pending.draft.title = "Keep the other Card draft"
        let retainedOther = other.pending
        pane.pending.draft.title = "Discard this unfinished title"
        var external = CardDraft(card: card)
        external.title = "A newer confirmed title"
        external.body = "A newer confirmed description"
        let saved = try await model.saveCard(external, projectID: project.id, in: workspace, key: "external-save")
        XCTAssertEqual(window.pending.draft.title, "Discard this unfinished title",
                       "External saved changes must not overwrite dirty text before Revert.")

        await window.revert()

        XCTAssertEqual(pane.pending.draft, CardDraft(card: saved))
        XCTAssertEqual(window.pending, pane.pending)
        XCTAssertFalse(pane.isDirty)
        XCTAssertFalse(pane.canRevert)
        XCTAssertEqual(other.pending, retainedOther)
        let persisted = try XCTUnwrap(model.drafts.load(ownerID: model.ownerID,
            resourceKey: pane.resourceKey, as: SharedCardDraftRecord.self))
        XCTAssertEqual(persisted.pending.draft, CardDraft(card: saved))
    }

    func testCommentConflictRetainsSharedTextUntilAnExplicitResolution() async throws {
        let model = makeModel()
        let (workspace, project, card) = try fixture(model)
        let session = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        session.pending.draft.title = "My exact unsaved title"
        session.pending.draft.body = "  # Keep my text\n"
        try await model.addComment("A separately confirmed Comment", cardID: card.id,
            projectID: project.id, in: workspace, key: "new-comment")
        let commentVersion = try XCTUnwrap(session.currentCard?.version)

        await session.save()

        XCTAssertEqual(session.currentCard?.title, card.title)
        XCTAssertEqual(session.currentCard?.version, commentVersion)
        XCTAssertEqual(session.currentCard?.comments.last?.body, "A separately confirmed Comment")
        XCTAssertEqual(session.pending.draft.title, "My exact unsaved title")
        XCTAssertEqual(session.pending.draft.body, "  # Keep my text\n")
        XCTAssertEqual(session.pending.requiresConflictReview, true)
        XCTAssertNil(session.pending.submitted)
        XCTAssertFalse(session.canSave)
        XCTAssertEqual(session.latest?.version, commentVersion)
        session.keepDraftForNextSave()
        XCTAssertTrue(session.canSave)
        await session.save()
        XCTAssertEqual(session.currentCard?.title, "My exact unsaved title")
        XCTAssertEqual(session.currentCard?.comments.last?.body, "A separately confirmed Comment")
        XCTAssertEqual(session.currentCard?.version, commentVersion + 1)
    }

    func testSignOutClearsOpenSharedDraftsAndRetainsOwnerPartitionedRecovery() async throws {
        let model = makeModel()
        let (workspace, project, card) = try fixture(model)
        let session = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        session.pending.draft.title = "Private shared draft"
        let retained = session.pending
        let resourceKey = session.resourceKey

        await model.signOut()

        XCTAssertFalse(session.sessionIsCurrent)
        XCTAssertFalse(session.canSave)
        XCTAssertNil(session.currentCard)
        XCTAssertEqual(session.pending.draft.title, "", "Private text must disappear from existing surfaces on sign-out.")
        await session.save()
        let recovered = try XCTUnwrap(model.drafts.load(ownerID: "demo-owner",
            resourceKey: resourceKey, as: SharedCardDraftRecord.self))
        XCTAssertEqual(recovered.pending, retained)
        XCTAssertNil(try model.drafts.load(ownerID: "another-owner", resourceKey: resourceKey,
            as: SharedCardDraftRecord.self))
    }

    func testArchivingMakesAlreadyOpenSharedDraftReadOnlyWithoutLosingIt() async throws {
        let model = makeModel()
        let (workspace, project, card) = try fixture(model)
        let session = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        session.pending.draft.title = "Retain this draft while archived"
        let retained = session.pending.draft
        try await model.archive(card, projectID: project.id, in: workspace, archived: true)
        XCTAssertTrue(session.isReadOnly)
        XCTAssertTrue(session.editingDisabled)
        XCTAssertFalse(session.canSave)
        await session.save()
        XCTAssertEqual(session.currentCard?.title, card.title)
        XCTAssertEqual(session.pending.draft, retained)
    }

    func testDifferentLegacyPaneAndWindowDraftsRemainAvailableUntilExplicitChoice() throws {
        let model = makeModel()
        let (workspace, project, card) = try fixture(model)
        let base = "workspace:\(workspace.id):project:\(project.id):card:\(card.id)"
        var paneDraft = CardDraft(card: card)
        paneDraft.title = "Earlier Column draft"
        var windowDraft = CardDraft(card: card)
        windowDraft.title = "Earlier window draft"
        let panePending = PendingCardDraft(draft: paneDraft, key: "pane-retry-key")
        let windowPending = PendingCardDraft(draft: windowDraft, key: "window-retry-key")
        try model.drafts.save(panePending, ownerID: model.ownerID, resourceKey: base + ":editor:inline")
        try model.drafts.save(windowPending, ownerID: model.ownerID, resourceKey: base + ":editor:window")
        let session = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        XCTAssertEqual(session.pending, panePending)
        XCTAssertEqual(session.alternatives.map(\.pending), [windowPending])
        XCTAssertFalse(session.canSave, "Migration must require a choice before overwriting a different retained draft.")
        let alternative = try XCTUnwrap(session.alternatives.first)
        session.useAlternative(id: alternative.id)
        XCTAssertEqual(session.pending, windowPending)
        XCTAssertEqual(session.alternatives.map(\.pending), [panePending])
        let recovered = try XCTUnwrap(model.drafts.load(ownerID: model.ownerID,
            resourceKey: session.resourceKey, as: SharedCardDraftRecord.self))
        XCTAssertEqual(recovered.pending, windowPending)
        XCTAssertEqual(recovered.alternatives.map(\.pending), [panePending])
        session.keepCurrentDraftRemovingAlternatives()
        XCTAssertTrue(session.alternatives.isEmpty)
        XCTAssertTrue(session.canSave)
        XCTAssertNil(try model.drafts.load(ownerID: model.ownerID, resourceKey: base + ":editor:inline", as: PendingCardDraft.self))
        XCTAssertNil(try model.drafts.load(ownerID: model.ownerID, resourceKey: base + ":editor:window", as: PendingCardDraft.self))
    }

    func testRecoveredConfirmedReceiptFinishesLocallyWithoutReplayingTheMutation() async throws {
        let model = makeModel()
        let (workspace, project, card) = try fixture(model)
        var draft = CardDraft(card: card)
        draft.title = "Already confirmed title"
        let saved = try await model.saveCard(draft, projectID: project.id, in: workspace, key: "confirmed-once")
        let pending = PendingCardDraft(draft: draft, key: "confirmed-once", submitted: draft,
            confirmed: ConfirmedDraftReceipt(confirmedAt: saved.updatedAt, createdCard: saved))
        let session = SharedCardEditingSession(model: model, workspace: workspace, projectID: project.id, card: card)
        try model.drafts.save(SharedCardDraftRecord(pending: pending, savedCard: card,
            alternatives: [], legacyImported: true), ownerID: model.ownerID, resourceKey: session.resourceKey)
        session.load()
        XCTAssertTrue(session.canSave)
        await session.save()
        XCTAssertEqual(session.currentCard?.version, saved.version,
                       "Retrying cleanup must not submit an already confirmed mutation again.")
        XCTAssertEqual(session.pending.draft, CardDraft(card: saved))
        XCTAssertNil(session.pending.confirmed)
        XCTAssertNil(session.pending.submitted)
        XCTAssertFalse(session.canSave)
    }

    func testFailedLocalWritePreventsServerSaveAndKeepsExactRecoveryText() async throws {
        try Data("disk unavailable".utf8).write(to: directory)
        let model = makeModel()
        let (workspace, project, card) = try fixture(model)
        let session = model.cardEditingSession(workspace: workspace, projectID: project.id, card: card)
        session.pending.draft.title = "Retain this exact title"
        session.pending.draft.body = "  # Exact unfinished source\n\n- Keep whitespace  \n"
        let retainedDraft = session.pending.draft
        XCTAssertTrue(session.persistenceFailed)
        await session.save()
        XCTAssertEqual(session.currentCard, card)
        XCTAssertEqual(session.pending.draft, retainedDraft)
        XCTAssertTrue(model.drafts.hasUnpersistedRecovery)
        try FileManager.default.removeItem(at: directory)
        try model.drafts.retryRecoveryWrites()
        let restored = try XCTUnwrap(DraftStore(directory: directory).load(ownerID: model.ownerID,
            resourceKey: session.resourceKey, as: SharedCardDraftRecord.self))
        XCTAssertEqual(restored.pending.draft, retainedDraft)
    }

    private func makeModel() -> AppModel {
        AppModel(drafts: DraftStore(directory: directory), defaults: defaults, demo: true)
    }

    private func fixture(_ model: AppModel) throws -> (Workspace, Project, Card) {
        let workspace = try XCTUnwrap(model.workspaces.first)
        let project = try XCTUnwrap(model.project(id: "demo-project", in: workspace))
        let card = try XCTUnwrap(project.cards.first { $0.id == "demo-card-homepage" })
        return (workspace, project, card)
    }
}
