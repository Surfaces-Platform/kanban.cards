import Foundation
import Observation
import SwiftUI

struct CardDraftActions {
    var canSave: Bool
    var canRevert: Bool
    var save: () -> Void
    var revert: () -> Void
}
struct CardDraftActionsKey: FocusedValueKey { typealias Value = CardDraftActions }
extension FocusedValues {
    var cardDraftActions: CardDraftActions? {
        get { self[CardDraftActionsKey.self] }
        set { self[CardDraftActionsKey.self] = newValue }
    }
}

struct RetainedCardEditingDraft: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var pending: PendingCardDraft
}

struct SharedCardDraftRecord: Codable, Equatable {
    var pending: PendingCardDraft
    var savedCard: Card
    var alternatives: [RetainedCardEditingDraft]
    var legacyImported: Bool
}

/// One editor state machine is shared by every surface showing the same Card.
/// Pending submissions and confirmed receipts survive surface changes and relaunches.
@MainActor
@Observable
final class SharedCardEditingSession {
    @ObservationIgnored private weak var model: AppModel?
    let workspace: Workspace
    let projectID: String
    let cardID: String
    let ownerID: String
    let openingSessionID: UUID
    @ObservationIgnored private var suppressPersistence = false
    @ObservationIgnored private var loaded = false
    private(set) var invalidated = false
    private(set) var savedCard: Card?
    var pending: PendingCardDraft {
        didSet { if !suppressPersistence { persist() } }
    }
    private(set) var alternatives: [RetainedCardEditingDraft] = []
    private(set) var saving = false
    private(set) var reviewingConflict = false
    private(set) var draftLoadFailed = false
    private(set) var persistenceFailed = false
    private(set) var recoveredDraft = false
    private(set) var receiptPersisted = false
    private(set) var latest: Card?
    var errorMessage: String?
    private(set) var persistenceError: String?
    private(set) var refreshError: String?
    private(set) var savedMessage: String?

    init(model: AppModel, workspace: Workspace, projectID: String, card: Card) {
        self.model = model
        self.workspace = workspace
        self.projectID = projectID
        cardID = card.id
        ownerID = model.ownerID
        openingSessionID = model.sessionID
        savedCard = card
        pending = PendingCardDraft(draft: CardDraft(card: card), key: UUID().uuidString)
    }

    var legacyResourceKeys: [(key: String, label: String)] {
        let base = "workspace:\(workspace.id):project:\(projectID):card:\(cardID)"
        return [(base, "Earlier sheet draft"), (base + ":editor:inline", "Column draft"),
            (base + ":editor:window", "Window draft")]
    }
    var resourceKey: String {
        let scope = [workspace.id, workspace.url.absoluteString, projectID, cardID]
            .map { "\($0.utf8.count):\($0)" }.joined()
        return "shared-card-editor:\(scope)"
    }
    var sessionIsCurrent: Bool {
        guard let model else { return false }
        return !invalidated && model.signedIn && model.ownerID == ownerID
            && model.sessionID == openingSessionID
    }
    var currentCard: Card? {
        guard sessionIsCurrent, let model else { return nil }
        return model.project(id: projectID, in: workspace)?.cards.first { $0.id == cardID }
    }
    var columns: [Column] {
        guard sessionIsCurrent, let model else { return [] }
        return (model.project(id: projectID, in: workspace)?.columns ?? []).sorted { $0.position < $1.position }
    }
    var isReadOnly: Bool {
        guard sessionIsCurrent, let model, model.canEditProject(id: projectID, in: workspace),
              let project = model.project(id: projectID, in: workspace), project.archivedAt == nil,
              let card = project.cards.first(where: { $0.id == cardID }) else { return true }
        return card.archivedAt != nil
    }
    var isDirty: Bool {
        guard let savedCard else { return false }
        return CardDraftComparison.differingFields(pending.draft, from: savedCard) != ["None"]
    }
    var interactionLocked: Bool {
        saving || reviewingConflict || persistenceFailed || (pending.confirmed != nil && !receiptPersisted)
    }
    var editingDisabled: Bool {
        !sessionIsCurrent || saving || reviewingConflict || draftLoadFailed || isReadOnly
            || pending.submitted != nil || pending.confirmed != nil
    }
    var canSave: Bool {
        sessionIsCurrent && !saving && !reviewingConflict && !draftLoadFailed
            && (pending.confirmed != nil || (!isReadOnly && alternatives.isEmpty
                && pending.requiresConflictReview != true && (isDirty || pending.submitted != nil)
                && !pending.draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && columns.contains { $0.id == pending.draft.columnId }))
    }
    var canRevert: Bool {
        sessionIsCurrent && !saving && !reviewingConflict
            && (isDirty || pending.submitted != nil || pending.confirmed != nil || !alternatives.isEmpty || draftLoadFailed)
    }
    var confirmationLabel: String {
        if saving { return pending.confirmed == nil ? "Saving…" : "Finishing…" }
        if pending.confirmed != nil { return "Retry Cleanup" }
        return pending.submitted == nil ? "Save" : "Retry Save"
    }
    var recoveryText: String {
        "Title: \(pending.draft.title)\nColumn: \(pending.draft.columnId)\nNext actor: \(pending.draft.nextActor?.label ?? "Unassigned")\nPriority: \(pending.draft.priority?.rawValue ?? "Unset")\nNext action: \(pending.draft.nextAction)\nBlocker: \(pending.draft.blockedReason)\n\n\(pending.draft.body)"
    }

    func load() {
        guard !loaded, sessionIsCurrent, let model else { return }
        suppressPersistence = true
        defer { suppressPersistence = false }
        do {
            if let record = try model.drafts.load(ownerID: ownerID, resourceKey: resourceKey, as: SharedCardDraftRecord.self) {
                pending = record.pending
                savedCard = record.savedCard
                alternatives = record.alternatives
                recoveredDraft = isDirty || pending.submitted != nil || pending.confirmed != nil || !alternatives.isEmpty
            } else {
                var retained: [RetainedCardEditingDraft] = []
                for item in legacyResourceKeys {
                    if let draft = try model.drafts.load(ownerID: ownerID, resourceKey: item.key, as: PendingCardDraft.self),
                       !retained.contains(where: { $0.pending == draft }) {
                        retained.append(RetainedCardEditingDraft(id: item.key, label: item.label, pending: draft))
                    }
                }
                if let first = retained.first {
                    pending = first.pending
                    alternatives = Array(retained.dropFirst())
                    recoveredDraft = true
                }
            }
            loaded = true
            draftLoadFailed = false
            receiptPersisted = pending.confirmed != nil && !model.drafts.hasRecovery(ownerID: ownerID, resourceKey: resourceKey)
            synchronizeIfClean()
        } catch {
            loaded = true
            draftLoadFailed = true
            errorMessage = "The retained draft could not be opened. Retry loading it, or use Revert to explicitly discard it. \(error.localizedDescription)"
        }
    }

    func retryLoading() {
        guard sessionIsCurrent, !saving else { return }
        loaded = false
        errorMessage = nil
        load()
    }

    func synchronizeIfClean() {
        guard loaded, sessionIsCurrent, !isDirty, pending.submitted == nil,
              pending.confirmed == nil, alternatives.isEmpty, !draftLoadFailed,
              let current = currentCard, current != savedCard else { return }
        suppressPersistence = true
        savedCard = current
        pending = PendingCardDraft(draft: CardDraft(card: current), key: UUID().uuidString)
        suppressPersistence = false
    }

    func persist() {
        guard loaded, sessionIsCurrent, !draftLoadFailed, let model, let savedCard else { return }
        do {
            let record = SharedCardDraftRecord(pending: pending, savedCard: savedCard,
                alternatives: alternatives, legacyImported: true)
            try model.drafts.save(record, ownerID: ownerID, resourceKey: resourceKey)
            persistenceFailed = false
            persistenceError = nil
            receiptPersisted = pending.confirmed != nil
        } catch {
            persistenceFailed = true
            persistenceError = pending.confirmed != nil
                ? "Card saved. This Mac could not record completion. Retry cleanup. \(error.localizedDescription)"
                : "This Mac could not write the draft to disk. Your text is retained in this app for your account. Copy or export it before quitting. \(error.localizedDescription)"
        }
    }

    func useAlternative(id: String) {
        guard sessionIsCurrent, !saving, !reviewingConflict,
              let index = alternatives.firstIndex(where: { $0.id == id }) else { return }
        let selected = alternatives[index]
        alternatives[index] = RetainedCardEditingDraft(id: UUID().uuidString, label: "Other retained draft", pending: pending)
        suppressPersistence = true
        pending = selected.pending
        latest = nil
        savedMessage = nil
        suppressPersistence = false
        persist()
    }

    func keepCurrentDraftRemovingAlternatives() {
        guard sessionIsCurrent, !saving, let model, let savedCard else { return }
        let record = SharedCardDraftRecord(pending: pending, savedCard: savedCard,
            alternatives: [], legacyImported: true)
        do {
            try model.drafts.save(record, ownerID: ownerID, resourceKey: resourceKey)
            alternatives = []
            persistenceFailed = false
            persistenceError = nil
            removeLegacyCopies()
        } catch {
            persistenceFailed = true
            persistenceError = "The retained drafts could not be updated. Your other drafts are still available. \(error.localizedDescription)"
        }
    }

    func keepDraftForNextSave() {
        guard sessionIsCurrent, !isReadOnly, !saving, let latest else { return }
        suppressPersistence = true
        pending.draft.version = latest.version
        pending.draft.archivedAt = latest.archivedAt
        pending.draft.externalKey = latest.externalKey
        if pending.draft.columnId == latest.columnId { pending.draft.position = latest.position }
        pending.submitted = nil
        pending.key = UUID().uuidString
        pending.requiresConflictReview = false
        savedCard = latest
        self.latest = nil
        suppressPersistence = false
        persist()
    }

    func reviewConflict() async {
        guard sessionIsCurrent, !reviewingConflict, let model else { return }
        reviewingConflict = true
        defer { reviewingConflict = false }
        do {
            try await model.loadProject(id: projectID, in: workspace)
            guard sessionIsCurrent else { return }
            latest = currentCard
            if latest == nil { errorMessage = "This Card is no longer available. Your local draft is retained." }
        } catch {
            guard sessionIsCurrent else { return }
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
            else { errorMessage = error.localizedDescription }
        }
    }

    func retryRefresh() async {
        guard sessionIsCurrent, !saving, let model else { return }
        saving = true
        defer { saving = false }
        do {
            try await model.loadProject(id: projectID, in: workspace)
            guard sessionIsCurrent else { return }
            refreshError = nil
            if pending.confirmed != nil { finishConfirmedDraft() }
            else { synchronizeIfClean() }
        } catch { if sessionIsCurrent { refreshError = error.localizedDescription } }
    }

    func save() async {
        guard canSave, let model else { return }
        saving = true
        savedMessage = nil
        errorMessage = nil
        defer { saving = false }
        if pending.confirmed != nil { finishConfirmedDraft(); return }
        let retryingUncertainRequest = pending.submitted != nil
        if pending.submitted == nil {
            if let project = model.project(id: projectID, in: workspace),
               currentCard?.columnId != pending.draft.columnId {
                pending.draft.position = (project.cards.filter {
                    $0.columnId == pending.draft.columnId && $0.id != cardID
                }.map(\.position).max() ?? -1) + 1
            }
            pending.submitted = pending.draft
        }
        persist()
        guard !persistenceFailed else {
            if !retryingUncertainRequest { pending.submitted = nil; persist() }
            return
        }
        do {
            _ = try await model.saveCard(pending.submitted!, projectID: projectID, in: workspace, key: pending.key,
                onConfirmed: { [weak self] in
                    guard let self, self.sessionIsCurrent else { return }
                    self.pending.confirmed = ConfirmedDraftReceipt(confirmedAt: ServerTimestamp.string())
                    self.persist()
                },
                onSavedCard: { [weak self] saved in
                    guard let self, self.sessionIsCurrent else { return }
                    self.pending.confirmed?.createdCard = saved
                    self.persist()
                },
                onRefreshFailure: { [weak self] message in
                    guard let self, self.sessionIsCurrent else { return }
                    self.refreshError = message
                })
        } catch {
            guard sessionIsCurrent else { return }
            if pending.confirmed != nil {
                refreshError = error.localizedDescription
                finishConfirmedDraft()
                return
            }
            if model.isConflict(error) {
                suppressPersistence = true
                pending.submitted = nil
                pending.requiresConflictReview = true
                pending.key = UUID().uuidString
                suppressPersistence = false
                persist()
                await reviewConflict()
                return
            } else if let apiError = error as? APIError, let status = apiError.statusCode, status < 500, status != 408 {
                suppressPersistence = true
                pending.submitted = nil
                pending.key = UUID().uuidString
                suppressPersistence = false
            }
            persist()
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
            else { errorMessage = error.localizedDescription }
            return
        }
        guard sessionIsCurrent else { return }
        finishConfirmedDraft()
    }

    private func finishConfirmedDraft() {
        guard sessionIsCurrent, pending.confirmed != nil, let model else { return }
        if !receiptPersisted { persist() }
        guard receiptPersisted else { return }
        let receiptCard = pending.confirmed?.createdCard
        let refreshedCard = currentCard.flatMap { card in
            card.version >= (receiptCard?.version ?? ((pending.draft.version ?? 0) + 1)) ? card : nil
        }
        guard let saved = refreshedCard ?? receiptCard else {
            refreshError = "Card saved. Refresh to load its saved values before continuing."
            return
        }
        let clean = PendingCardDraft(draft: CardDraft(card: saved), key: UUID().uuidString)
        let record = SharedCardDraftRecord(pending: clean, savedCard: saved,
            alternatives: alternatives, legacyImported: true)
        do {
            // Replacing the receipt atomically with the saved baseline completes
            // recovery without ever replaying an already confirmed mutation.
            try model.drafts.save(record, ownerID: ownerID, resourceKey: resourceKey)
            suppressPersistence = true
            pending = clean
            savedCard = saved
            latest = nil
            recoveredDraft = false
            receiptPersisted = false
            persistenceFailed = false
            persistenceError = nil
            savedMessage = "Saved"
            suppressPersistence = false
            removeLegacyCopies()
        } catch {
            persistenceFailed = true
            persistenceError = "Card saved. The local receipt could not be updated. Retry cleanup. \(error.localizedDescription)"
        }
    }

    func revert() async {
        guard canRevert, let model else { return }
        saving = true
        defer { saving = false }
        do {
            try await model.loadProject(id: projectID, in: workspace)
            guard sessionIsCurrent, let current = currentCard else { return }
            let clean = PendingCardDraft(draft: CardDraft(card: current), key: UUID().uuidString)
            let record = SharedCardDraftRecord(pending: clean, savedCard: current,
                alternatives: [], legacyImported: true)
            try model.drafts.save(record, ownerID: ownerID, resourceKey: resourceKey)
            suppressPersistence = true
            pending = clean
            savedCard = current
            alternatives = []
            latest = nil
            recoveredDraft = false
            receiptPersisted = false
            draftLoadFailed = false
            persistenceFailed = false
            persistenceError = nil
            refreshError = nil
            errorMessage = nil
            savedMessage = nil
            suppressPersistence = false
            removeLegacyCopies()
        } catch {
            guard sessionIsCurrent else { return }
            errorMessage = "Changes could not be reverted. Your draft is retained. \(error.localizedDescription)"
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
        }
    }

    private func removeLegacyCopies() {
        guard sessionIsCurrent, let model else { return }
        for item in legacyResourceKeys {
            do { try model.drafts.remove(ownerID: ownerID, resourceKey: item.key) }
            catch { errorMessage = "The shared draft is saved. An older local draft copy could not be removed. \(error.localizedDescription)" }
        }
    }

    func invalidate() {
        guard !invalidated else { return }
        if loaded, !draftLoadFailed, let model, let savedCard,
           isDirty || pending.submitted != nil || pending.confirmed != nil || !alternatives.isEmpty {
            let record = SharedCardDraftRecord(pending: pending, savedCard: savedCard,
                alternatives: alternatives, legacyImported: true)
            try? model.drafts.retainForRecovery(record, ownerID: ownerID, resourceKey: resourceKey)
        }
        invalidated = true
        suppressPersistence = true
        pending = PendingCardDraft(draft: CardDraft(columnId: ""), key: UUID().uuidString)
        savedCard = nil
        alternatives = []
        latest = nil
        errorMessage = nil
        persistenceError = nil
        refreshError = nil
        savedMessage = nil
        suppressPersistence = false
    }
}
