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

struct MacPendingCardMove: Codable, Equatable {
    var card: Card
    var columnID: String
    var position: Double
    var confirmedCard: Card? = nil
}

struct SharedCardDraftRecord: Codable, Equatable {
    var pending: PendingCardDraft
    var savedCard: Card
    var alternatives: [RetainedCardEditingDraft]
    var legacyImported: Bool
    var conflicts: Set<CardDraftField>? = nil
    var pendingMove: MacPendingCardMove? = nil
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
    private(set) var pendingMove: MacPendingCardMove?
    private(set) var moveReceiptPersisted = false
    private(set) var conflicts: Set<CardDraftField> = []
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
        return CardDraftField.allCases.contains { !pending.draft.matches(CardDraft(card: savedCard), field: $0) }
    }
    var interactionLocked: Bool {
        saving || reviewingConflict || persistenceFailed || (pending.confirmed != nil && !receiptPersisted)
    }
    var editingDisabled: Bool {
        !sessionIsCurrent || saving || reviewingConflict || draftLoadFailed || isReadOnly
            || pending.submitted != nil || pending.confirmed != nil || pendingMove != nil
    }
    var canSave: Bool {
        sessionIsCurrent && !saving && !reviewingConflict && !draftLoadFailed
            && (pendingMove != nil || pending.confirmed != nil || pending.submitted != nil || (!isReadOnly && alternatives.isEmpty
                && conflicts.isEmpty && pending.requiresConflictReview != true && (isDirty || pending.submitted != nil)
                && !pending.draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && columns.contains { $0.id == pending.draft.columnId }))
    }
    var canRevert: Bool {
        sessionIsCurrent && !saving && !reviewingConflict && pending.submitted == nil && pendingMove == nil
            && (isDirty || pending.submitted != nil || pending.confirmed != nil || !alternatives.isEmpty || draftLoadFailed)
    }
    var confirmationLabel: String {
        if saving { return "Saving…" }
        if let pendingMove { return pendingMove.confirmedCard == nil ? "Check Saved Destination" : "Retry Move Cleanup" }
        if pending.confirmed != nil { return "Retry Cleanup" }
        return pending.submitted == nil ? "Save" : "Check Saved Card"
    }
    var recoveryText: String {
        let move = pendingMove.map { "Retained Move: Column \($0.columnID), position \($0.position), source version \($0.card.version), \($0.confirmedCard == nil ? "outcome unconfirmed" : "confirmed; cleanup pending")\n\n" } ?? ""
        return move + "Title: \(pending.draft.title)\nColumn: \(pending.draft.columnId)\nNext actor: \(pending.draft.nextActor?.label ?? "Unassigned")\nPriority: \(pending.draft.priority?.rawValue ?? "Unset")\nNext action: \(pending.draft.nextAction)\nBlocker: \(pending.draft.blockedReason)\n\n\(pending.draft.body)"
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
                conflicts = record.conflicts ?? []
                pendingMove = record.pendingMove
                recoveredDraft = isDirty || pending.submitted != nil || pending.confirmed != nil || pendingMove != nil || !alternatives.isEmpty
            } else {
                var retained: [RetainedCardEditingDraft] = []
                for item in legacyResourceKeys {
                    if try model.drafts.legacyMayBeAssociated(ownerID: ownerID, legacyKey: item.key, destination: resourceKey),
                       let draft = try model.drafts.load(ownerID: ownerID, resourceKey: item.key, as: PendingCardDraft.self),
                       !retained.contains(where: { $0.pending == draft }) {
                        retained.append(RetainedCardEditingDraft(id: item.key, label: item.label, pending: draft))
                    }
                }
                // Old keys lack the Workspace origin. Show candidates, but never
                // silently associate private bytes with the currently open server.
                alternatives = retained
                recoveredDraft = !retained.isEmpty
            }
            loaded = true
            draftLoadFailed = false
            receiptPersisted = pending.confirmed != nil && !model.drafts.hasRecovery(ownerID: ownerID, resourceKey: resourceKey)
            moveReceiptPersisted = pendingMove?.confirmedCard != nil && !model.drafts.hasRecovery(ownerID: ownerID, resourceKey: resourceKey)
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
        guard loaded, sessionIsCurrent, pending.submitted == nil, pending.confirmed == nil,
              !draftLoadFailed, let base = savedCard, let current = currentCard,
              current != base else { return }
        reconcile(with: current)
    }

    /// Refresh, Comment and Move all enter the same three-way reconciliation.
    /// The original baseline advances only after every field has been compared.
    func reconcile(with current: Card) {
        guard sessionIsCurrent, let base = savedCard, pending.submitted == nil,
              pending.confirmed == nil else { return }
        let result = pending.draft.reconcile(base: base, latest: current)
        let currentDraft = CardDraft(card: current)
        let unresolved = conflicts.filter { !result.draft.matches(currentDraft, field: $0) }
        suppressPersistence = true
        pending.draft = result.draft
        conflicts = result.conflicts.union(unresolved)
        pending.requiresConflictReview = !conflicts.isEmpty
        savedCard = current
        latest = conflicts.isEmpty ? nil : current
        suppressPersistence = false
        persist()
    }

    func resolve(_ field: CardDraftField, useSaved: Bool) {
        guard sessionIsCurrent, !saving, let savedCard, conflicts.contains(field) else { return }
        // A legacy destination is a proposal for Move. Text Save cannot enact it.
        guard useSaved || field != .placement else { return }
        suppressPersistence = true
        if useSaved { pending.draft.adopt(CardDraft(card: savedCard), field: field) }
        conflicts.remove(field)
        pending.requiresConflictReview = !conflicts.isEmpty
        pending.key = UUID().uuidString
        latest = conflicts.isEmpty ? nil : savedCard
        suppressPersistence = false
        persist()
    }

    func moveToProposedColumn() async {
        guard conflicts.contains(.placement) else { return }
        do { _ = try await move(to: pending.draft.columnId) }
        catch { if sessionIsCurrent { errorMessage = error.localizedDescription } }
    }

    /// Text Save and Move have separate durable snapshots. Neither can consume
    /// the other's unknown request or turn a readback into a mutation receipt.
    func move(to columnID: String, refreshBeforeMove: Bool = true, onRefreshFailure: ((String) -> Void)? = nil) async throws -> Card {
        guard sessionIsCurrent, !saving, let model else { throw CancellationError() }
        saving = true
        defer { saving = false }
        if pending.confirmed != nil {
            finishConfirmedDraft()
            throw APIError(message: "Finish the earlier Card save before starting a separate Move.")
        }
        if pending.submitted != nil {
            await reconcileUnknownUpdate()
            throw APIError(message: "The earlier Card save was read back. Review it before starting a separate Move.")
        }
        if let move = pendingMove {
            if let confirmed = move.confirmedCard { finishConfirmedMove(); return confirmed }
            return try await reconcileUnknownMove()
        }
        // The wrapper may have just read an initially unopened Project. Reuse
        // that fresh read; all other Move entry points perform their own refresh.
        if refreshBeforeMove { try await model.loadProject(id: projectID, in: workspace) }
        guard sessionIsCurrent else { throw CancellationError() }
        guard let project = model.project(id: projectID, in: workspace) else { throw AppFailure.missingProject }
        guard project.archivedAt == nil else { throw AppFailure.readOnlyProject }
        guard let card = currentCard else { throw AppFailure.missingCard }
        guard card.archivedAt == nil else { throw AppFailure.readOnlyCard }
        guard project.columns.contains(where: { $0.id == columnID }) else { throw AppFailure.missingColumn }
        guard !isReadOnly else { throw AppFailure.readOnlyCard }
        if card.columnId == columnID { savedMessage = "The Card is already in the selected Column."; return card }
        let position = (project.cards.filter { $0.columnId == columnID && $0.id != cardID }.map(\.position).max() ?? -1) + 1
        pendingMove = MacPendingCardMove(card: card, columnID: columnID, position: position)
        persist()
        guard !persistenceFailed else {
            pendingMove = nil; persist()
            throw APIError(message: "This Mac could not protect the Move request. No Move was sent.")
        }
        do {
            let moved = try await model.performCardMove(card, to: columnID, position: position, projectID: projectID, in: workspace,
                onConfirmed: { [weak self] moved in
                    guard let self, self.sessionIsCurrent else { return }
                    self.pendingMove?.confirmedCard = moved
                    if self.conflicts.contains(.placement), self.pending.draft.columnId == columnID {
                        self.suppressPersistence = true
                        self.pending.draft.adopt(CardDraft(card: moved), field: .placement)
                        self.conflicts.remove(.placement)
                        self.suppressPersistence = false
                    }
                    self.reconcile(with: moved)
                    self.persist()
                }, onRefreshFailure: { [weak self] message in
                    guard let self, self.sessionIsCurrent else { return }
                    self.refreshError = message; onRefreshFailure?(message)
                })
            guard sessionIsCurrent else { throw CancellationError() }
            finishConfirmedMove()
            return moved
        } catch {
            guard sessionIsCurrent else { throw error }
            if pendingMove?.confirmedCard != nil { finishConfirmedMove() }
            else if let apiError = error as? APIError, let status = apiError.statusCode,
                    status < 500, !apiError.isAmbiguousMutation { pendingMove = nil; persist() }
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
            throw error
        }
    }

    private func reconcileUnknownMove() async throws -> Card {
        guard sessionIsCurrent, let model, let move = pendingMove else { throw CancellationError() }
        try await model.loadProject(id: projectID, in: workspace)
        guard sessionIsCurrent, let current = currentCard else {
            throw APIError(message: "This Card is unavailable. The original Move destination and version remain retained.")
        }
        // Persist the readback transition before allowing another operation.
        let record = SharedCardDraftRecord(pending: pending, savedCard: savedCard ?? current,
            alternatives: alternatives, legacyImported: true, conflicts: conflicts, pendingMove: nil)
        do { try model.drafts.save(record, ownerID: ownerID, resourceKey: resourceKey) }
        catch { persistenceFailed = true; throw error }
        pendingMove = nil; moveReceiptPersisted = false
        reconcile(with: current)
        savedMessage = current.columnId == move.columnID && current.position == move.position
            ? "The requested destination is currently saved. Readback does not identify which request moved it."
            : "The original destination is not current. Review the saved Column, then choose a separate Move if still intended."
        return current
    }

    private func finishConfirmedMove() {
        guard sessionIsCurrent, let model, let moved = pendingMove?.confirmedCard else { return }
        if !moveReceiptPersisted { persist() }
        guard moveReceiptPersisted else { return }
        let record = SharedCardDraftRecord(pending: pending, savedCard: savedCard ?? moved,
            alternatives: alternatives, legacyImported: true, conflicts: conflicts, pendingMove: nil)
        do {
            try model.drafts.save(record, ownerID: ownerID, resourceKey: resourceKey)
            pendingMove = nil; moveReceiptPersisted = false; persistenceFailed = false; persistenceError = nil
            savedMessage = "Card moved. Local text has not been saved."
        } catch {
            persistenceFailed = true
            persistenceError = "Card moved. Local cleanup failed. Retry cleanup without moving again. \(error.localizedDescription)"
        }
    }

    func persist() {
        guard loaded, sessionIsCurrent, !draftLoadFailed, let model, let savedCard else { return }
        do {
            let record = SharedCardDraftRecord(pending: pending, savedCard: savedCard,
                alternatives: alternatives, legacyImported: true, conflicts: conflicts, pendingMove: pendingMove)
            try model.drafts.save(record, ownerID: ownerID, resourceKey: resourceKey)
            persistenceFailed = false
            persistenceError = nil
            receiptPersisted = pending.confirmed != nil
            moveReceiptPersisted = pendingMove?.confirmedCard != nil
        } catch {
            persistenceFailed = true
            persistenceError = pendingMove?.confirmedCard != nil
                ? "Card moved. The completion receipt could not be protected. Retry cleanup without moving again. \(error.localizedDescription)"
                : pending.confirmed != nil
                ? "Card saved. This Mac could not record completion. Retry cleanup. \(error.localizedDescription)"
                : "This Mac could not write the draft to disk. Your text is retained in this app for your account. Copy or export it before quitting. \(error.localizedDescription)"
        }
    }

    func useAlternative(id: String) {
        guard sessionIsCurrent, !saving, !reviewingConflict, pending.submitted == nil, pending.confirmed == nil, pendingMove == nil,
              let index = alternatives.firstIndex(where: { $0.id == id }) else { return }
        let selected = alternatives[index]
        do {
            try model?.drafts.associateLegacy(ownerID: ownerID, legacyKey: selected.id, destination: resourceKey)
        } catch { errorMessage = "The recovered draft could not be associated. Its original copy is retained. \(error.localizedDescription)"; return }
        alternatives[index] = RetainedCardEditingDraft(id: UUID().uuidString, label: "Other retained draft", pending: pending)
        suppressPersistence = true
        pending = selected.pending
        latest = nil
        savedMessage = nil
        suppressPersistence = false
        if let current = currentCard, pending.submitted == nil, pending.confirmed == nil {
            savedCard = current
            conflicts = Set(CardDraftField.allCases.filter { !pending.draft.matches(CardDraft(card: current), field: $0) })
            pending.draft.version = current.version
            pending.draft.archivedAt = current.archivedAt
            pending.draft.externalKey = current.externalKey
            pending.requiresConflictReview = !conflicts.isEmpty
            latest = conflicts.isEmpty ? nil : current
        }
        persist()
    }

    func keepCurrentDraftRemovingAlternatives() {
        guard sessionIsCurrent, !saving, let model, let savedCard,
              alternatives.allSatisfy({ $0.pending.submitted == nil && $0.pending.confirmed == nil }) else {
            errorMessage = "Resolve the unconfirmed retained request before removing its draft."
            return
        }
        let record = SharedCardDraftRecord(pending: pending, savedCard: savedCard,
            alternatives: [], legacyImported: true, conflicts: conflicts, pendingMove: pendingMove)
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
        // Compatibility for existing callers: choose each text field explicitly.
        // Placement deliberately remains unresolved until a separate Move.
        for field in Array(conflicts) where field != .placement { resolve(field, useSaved: false) }
    }

    func reviewConflict() async {
        guard sessionIsCurrent, !reviewingConflict, let model else { return }
        reviewingConflict = true
        defer { reviewingConflict = false }
        do {
            try await model.loadProject(id: projectID, in: workspace)
            guard sessionIsCurrent else { return }
            if let current = currentCard { reconcile(with: current) }
            latest = conflicts.isEmpty ? nil : currentCard
            if currentCard == nil { errorMessage = "This Card is no longer available. Your local draft is retained." }
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
        if pendingMove != nil {
            do {
                if pendingMove?.confirmedCard != nil { finishConfirmedMove() }
                else { _ = try await reconcileUnknownMove() }
            } catch { if sessionIsCurrent { errorMessage = error.localizedDescription } }
            return
        }
        if pending.confirmed != nil { finishConfirmedDraft(); return }
        if pending.submitted != nil {
            await reconcileUnknownUpdate()
            return
        }
        let retryingUncertainRequest = false
        if let savedCard {
            // Placement is sent exclusively by the destination-only Move path.
            pending.draft.adopt(CardDraft(card: savedCard), field: .placement)
        }
        pending.submitted = pending.draft
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

    private func reconcileUnknownUpdate() async {
        guard sessionIsCurrent, let model, let submitted = pending.submitted else { return }
        do {
            try await model.loadProject(id: projectID, in: workspace)
            guard sessionIsCurrent, let current = currentCard else {
                errorMessage = "This Card is unavailable. The submitted snapshot and draft are retained."
                return
            }
            suppressPersistence = true
            pending.submitted = nil
            pending.key = UUID().uuidString
            suppressPersistence = false
            if submitted.matchesEditableFields(of: CardDraft(card: current)) {
                // Matching current values cannot attribute a lost PATCH response.
                suppressPersistence = true
                pending.draft = CardDraft(card: current)
                savedCard = current
                conflicts = []
                pending.requiresConflictReview = false
                latest = nil
                suppressPersistence = false
                savedMessage = "Current saved values match the submitted changes."
                persist()
            } else {
                reconcile(with: current)
                errorMessage = "The current saved Card differs from the submitted changes. Review your retained draft, then choose Save for a new request."
            }
        } catch {
            guard sessionIsCurrent else { return }
            errorMessage = "The previous save is still unconfirmed. Its exact snapshot is retained. \(error.localizedDescription)"
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
        }
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
            alternatives: alternatives, legacyImported: true, conflicts: [])
        do {
            // Replacing the receipt atomically with the saved baseline completes
            // recovery without ever replaying an already confirmed mutation.
            try model.drafts.save(record, ownerID: ownerID, resourceKey: resourceKey)
            suppressPersistence = true
            pending = clean
            savedCard = saved
            conflicts = []
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
                alternatives: [], legacyImported: true, conflicts: [])
            try model.drafts.save(record, ownerID: ownerID, resourceKey: resourceKey)
            suppressPersistence = true
            pending = clean
            savedCard = current
            conflicts = []
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
        // Migration never deletes an origin-ambiguous source. Association receipts
        // prevent it from being offered to a different origin on a later launch.
    }

    func invalidate() {
        guard !invalidated else { return }
        if loaded, !draftLoadFailed, let model, let savedCard,
           isDirty || pending.submitted != nil || pending.confirmed != nil || pendingMove != nil || !alternatives.isEmpty {
            let record = SharedCardDraftRecord(pending: pending, savedCard: savedCard,
                alternatives: alternatives, legacyImported: true, conflicts: conflicts, pendingMove: pendingMove)
            try? model.drafts.retainForRecovery(record, ownerID: ownerID, resourceKey: resourceKey)
        }
        invalidated = true
        suppressPersistence = true
        pending = PendingCardDraft(draft: CardDraft(columnId: ""), key: UUID().uuidString)
        savedCard = nil
        pendingMove = nil
        moveReceiptPersisted = false
        alternatives = []
        latest = nil
        errorMessage = nil
        persistenceError = nil
        refreshError = nil
        savedMessage = nil
        suppressPersistence = false
    }
}
