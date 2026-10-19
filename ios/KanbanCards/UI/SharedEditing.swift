import Foundation
import Observation

struct PendingCardMove: Codable, Equatable {
    var columnId: String
    var position: Double?
    var version: Int
}

@MainActor
@Observable
final class CardEditingSession {
    private unowned let model: AppModel
    let ownerID: String
    let workspace: Workspace
    let projectID: String
    let cardID: String
    let browsingReadOnly: Bool
    private(set) var baseline: Card
    private(set) var latest: Card
    var pending: PendingCardDraft
    private(set) var conflicts = Set<CardDraftField>()
    private(set) var busy = false
    private(set) var persistenceFailed = false
    private(set) var loadFailed = false
    private var unreadRecordText: String?
    private(set) var unavailable = false
    private(set) var legacyNeedsScope = false
    var message: String?
    private var loaded = false
    private var changing = false

    init(model: AppModel, workspace: Workspace, projectID: String, card: Card, readOnly: Bool = false) {
        self.model = model; self.ownerID = model.ownerID; self.workspace = workspace
        browsingReadOnly = readOnly
        self.projectID = projectID; cardID = card.id; baseline = card; latest = card
        pending = PendingCardDraft(draft: CardDraft(card: card), key: UUID().uuidString,
            baseline: card)
    }

    private var resourceKey: String { "card:\(projectID):\(cardID)" }
    var authorized: Bool { model.signedIn && !model.signOutPending && model.ownerID == ownerID && model.workspaces.contains(where: { $0.id == workspace.id && $0.url == workspace.url }) }
    var projectReadOnly: Bool { browsingReadOnly || model.isProjectReadOnly(projectID: projectID, in: workspace) }
    var readOnly: Bool { projectReadOnly || loadFailed || legacyNeedsScope || unavailable || latest.archivedAt != nil || !authorized }
    var unresolvedOperation: Bool { pending.submitted != nil || pending.move != nil }
    var dirty: Bool { !pending.draft.matchesEditableFields(of: CardDraft(card: latest)) || conflicts.contains(.placement) }
    var recoveryText: String { "Title: \(pending.draft.title)\n\nDescription:\n\(pending.draft.body)\n\nNext actor: \(pending.draft.nextActor?.rawValue ?? "unassigned")\nNext action: \(pending.draft.nextAction)\nPriority: \(pending.draft.priority?.rawValue ?? "unset")\nBlocker: \(pending.draft.blockedReason)\nColumn: \(pending.draft.columnId)\n" }

    var retainedRecordText: String? { authorized ? unreadRecordText : nil }

    func load() {
        guard authorized, !loaded else { return }
        loaded = true
        do {
            let saved = try model.drafts.loadScoped(ownerID: ownerID, workspace: workspace,
                projectID: projectID, resourceKey: resourceKey, legacyResourceKey: resourceKey, as: PendingCardDraft.self)
            let legacy = saved == nil ? try model.drafts.unprovenLegacy(ownerID: ownerID,
                legacyResourceKey: resourceKey, as: PendingCardDraft.self) : nil
            if let record = saved ?? legacy { try record.validateIdentity(cardID: cardID) }
            loadFailed = false; unreadRecordText = nil; persistenceFailed = false
            legacyNeedsScope = legacy != nil; conflicts = []; message = nil
            pending = saved ?? legacy ?? PendingCardDraft(draft: CardDraft(card: latest), key: UUID().uuidString, baseline: latest)
            baseline = pending.baseline ?? latest
            if legacyNeedsScope {
                message = "This older draft did not record its Workspace. Confirm the original Workspace before recovery; no request has been sent."
                return
            }
            if let saved {
                if saved.baseline == nil, saved.draft.version != latest.version {
                    // No original baseline: never guess which differing fields were local.
                    conflicts = Set(CardDraftField.allCases.filter { !saved.draft.matches(CardDraft(card: latest), field: $0) })
                }
                conflicts.formUnion(saved.unresolvedFields ?? [])
            }
            receive(latest)
            persist()
        } catch {
            loadFailed = true; persistenceFailed = false
            unreadRecordText = model.drafts.retainedRecordText(ownerID: ownerID, workspace: workspace,
                projectID: projectID, resourceKey: resourceKey, legacyResourceKey: resourceKey)
            message = "The retained draft could not be opened. Its original record is unchanged. Retry reading before editing or saving. \(error.localizedDescription)"
        }
    }

    func retryLoading() {
        guard authorized, !busy, loadFailed else { return }
        model.drafts.prepareToRetryReading(ownerID: ownerID, workspace: workspace, projectID: projectID,
            resourceKey: resourceKey, legacyResourceKey: resourceKey)
        loaded = false
        load()
    }

    func recoverLegacy() {
        guard authorized, !loadFailed, legacyNeedsScope, pending.draft.id == cardID else { return }
        do {
            // Another editor may have confirmed this record since the browse
            // session opened. Never replace its newer scoped text or intent.
            model.drafts.prepareToRetryReading(ownerID: ownerID, workspace: workspace,
                projectID: projectID, resourceKey: resourceKey, legacyResourceKey: resourceKey)
            let scopedKey = model.drafts.scopedKey(workspace: workspace, projectID: projectID, resourceKey: resourceKey)
            if let existing = try model.drafts.load(ownerID: ownerID, resourceKey: scopedKey, as: PendingCardDraft.self) {
                try existing.validateIdentity(cardID: cardID)
                legacyNeedsScope = false; loaded = false; persistenceFailed = false
                load()
                message = "An existing draft for this Workspace was opened. The older record is unchanged."
                return
            }
            try model.drafts.recoverLegacy(pending, ownerID: ownerID, workspace: workspace,
                projectID: projectID, resourceKey: resourceKey, legacyResourceKey: resourceKey)
            legacyNeedsScope = false; loaded = false; persistenceFailed = false
            load()
        } catch { persistenceFailed = true; message = error.localizedDescription }
    }

    func edited() {
        guard loaded, !loadFailed, !changing, authorized else { return }
        guard !busy, !unresolvedOperation, pending.confirmed == nil else { return }
        conflicts = Set(conflicts.filter { !pending.draft.matches(CardDraft(card: latest), field: $0) })
        persist()
    }

    func persist() {
        // A separate immutable browse session must not replace a newer editable
        // session's record after another client restores the Project. Explicit
        // legacy confirmation writes its own binding and scoped copy directly.
        guard !browsingReadOnly, loaded, !loadFailed, !legacyNeedsScope else { return }
        pending.baseline = baseline
        pending.unresolvedFields = Array(conflicts)
        pending.schemaVersion = 2
        do {
            try model.drafts.saveScoped(pending, ownerID: ownerID, workspace: workspace,
                projectID: projectID, resourceKey: resourceKey, legacyResourceKey: resourceKey)
            persistenceFailed = false
        } catch {
            persistenceFailed = true
            message = pending.confirmed == nil
                ? "Local draft protection failed. The text remains in this app while it stays open. Retry or copy/export before leaving. \(error.localizedDescription)"
                : "The saved values were confirmed, but local completion could not be protected. Retry cleanup; do not submit again. \(error.localizedDescription)"
        }
    }

    func receive(_ card: Card) {
        guard authorized, card.id == cardID, card.version >= latest.version else { return }
        unavailable = false
        latest = card
        guard !loadFailed, !legacyNeedsScope else { return }
        changing = true
        let result = pending.draft.reconcile(base: baseline, latest: card)
        let stillUnresolved = conflicts.filter { !result.draft.matches(CardDraft(card: card), field: $0) }
        pending.draft = result.draft
        conflicts = result.conflicts.union(stillUnresolved)
        baseline = card
        pending.baseline = card
        changing = false
        if loaded { persist() }
    }

    func missing() {
        unavailable = true
        message = "This Card is unavailable. Your local text is retained; Save cannot recreate a missing or inaccessible resource."
        persist()
    }

    func resolve(_ field: CardDraftField, useSaved: Bool) {
        guard authorized, !loadFailed, !busy, !unresolvedOperation, !legacyNeedsScope else { return }
        if useSaved { pending.draft.adopt(CardDraft(card: latest), field: field) }
        if field == .placement && !useSaved { return } // separate Move is the only alternative.
        conflicts.remove(field)
        persist()
    }

    private func currentCard() async throws -> Card {
        let generation = model.api.sessionGeneration
        try await model.loadProject(id: projectID, in: workspace)
        guard authorized, generation == model.api.sessionGeneration else { throw CancellationError() }
        guard let project = model.loadedProjects[projectID], let card = project.cards.first(where: { $0.id == cardID }) else {
            missing(); throw AppFailure.missingProject
        }
        return card
    }

    func refresh() async {
        guard authorized, !loadFailed, !busy else { return }
        busy = true; defer { busy = false }
        do { receive(try await currentCard()) }
        catch { handle(error) }
    }

    func save() async {
        guard authorized, !projectReadOnly, !loadFailed, !busy, !legacyNeedsScope else { return }
        busy = true; defer { busy = false }
        if pending.confirmed != nil { cleanup(); return }
        if unresolvedOperation { await reconcileUnknown(); return }
        guard !readOnly else { return }
        do {
            receive(try await currentCard())
            guard !readOnly, conflicts.isEmpty else { message = "Resolve the named fields before saving."; return }
            guard dirty else { message = "The displayed fields already match saved data."; return }
            guard !pending.draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { message = "Enter a title."; return }
            pending.submitted = pending.draft
            pending.submissionBase = latest
            persist()
            guard !persistenceFailed else { pending.submitted = nil; pending.submissionBase = nil; persist(); return }
            let generation = model.api.sessionGeneration
            let result = try await model.saveCard(pending.submitted!, projectID: projectID, in: workspace, key: pending.key,
                onConfirmed: { [weak self] saved in
                    guard let self, self.authorized, generation == self.model.api.sessionGeneration else { return }
                    self.baseline = saved; self.latest = saved; self.pending.draft = CardDraft(card: saved)
                    self.conflicts = []; self.pending.submitted = nil; self.pending.submissionBase = nil
                    self.pending.confirmed = ConfirmedDraftReceipt(confirmedAt: ServerTimestamp.string())
                    self.persist()
                })
            guard authorized, generation == model.api.sessionGeneration else { return }
            if let newer = model.loadedProjects[projectID]?.cards.first(where: { $0.id == cardID }), newer.version > result.version { receive(newer) }
            message = "Card saved."; persist(); cleanup()
        } catch {
            if (error as? APIError)?.isUnauthorized == true { model.handle(error); return }
            guard authorized else { return }
            if model.isConflict(error) {
                pending.submitted = nil; pending.submissionBase = nil
                do { receive(try await currentCard()) } catch { handle(error) }
                message = conflicts.isEmpty ? "The saved version changed. Review the rebased draft, then Save." : "Choose how to resolve the named fields before Save."
            } else if let apiError = error as? APIError, let status = apiError.statusCode, status < 500, !apiError.isAmbiguousMutation {
                pending.submitted = nil; pending.submissionBase = nil
                handle(error)
            } else { handle(error); message = "Save outcome unconfirmed. Reconcile saved values before retrying. Your submitted snapshot is retained." }
            persist()
        }
    }

    func move(to columnID: String) async {
        guard authorized, !busy, !readOnly, !unresolvedOperation else { return }
        busy = true; defer { busy = false }
        do {
            receive(try await currentCard())
            guard !readOnly, let project = model.loadedProjects[projectID], project.columns.contains(where: { $0.id == columnID }) else { return }
            pending.move = PendingCardMove(columnId: columnID, position: nil, version: latest.version)
            persist(); guard !persistenceFailed else { pending.move = nil; persist(); return }
            let generation = model.api.sessionGeneration
            let moved = try await model.moveCard(latest, to: columnID, projectID: projectID, in: workspace)
            guard authorized, generation == model.api.sessionGeneration else { return }
            pending.move = nil
            if conflicts.contains(.placement), pending.draft.columnId == columnID {
                pending.draft.adopt(CardDraft(card: moved), field: .placement)
                conflicts.remove(.placement)
            }
            receive(moved); message = "Card moved. Local text has not been saved."
            persist()
        } catch {
            if (error as? APIError)?.isUnauthorized == true { model.handle(error); return }
            guard authorized else { return }
            if let apiError = error as? APIError, let status = apiError.statusCode, status < 500, !apiError.isAmbiguousMutation { pending.move = nil }
            handle(error); persist()
        }
    }

    private func reconcileUnknown() async {
        do {
            let saved = try await currentCard()
            if let submitted = pending.submitted {
                if submitted.matchesEditableFields(of: CardDraft(card: saved)) {
                    pending.submitted = nil; pending.submissionBase = nil
                    baseline = saved; latest = saved; pending.draft = CardDraft(card: saved); conflicts = []
                    pending.confirmed = ConfirmedDraftReceipt(confirmedAt: ServerTimestamp.string(), evidence: "observed-saved-state")
                    message = "The requested values are now saved. Readback does not identify which request saved them."
                    persist(); cleanup()
                    return
                }
                if let original = pending.submissionBase { baseline = original }
                pending.submitted = nil; pending.submissionBase = nil
                receive(saved)
                message = "Current saved values were read. Review the draft and choose Save again; the unknown PATCH was not replayed."
            } else if let move = pending.move {
                pending.move = nil
                receive(saved)
                message = saved.columnId == move.columnId
                    ? "The requested destination is now saved. Readback does not identify the original request."
                    : "The requested destination is not current. Review saved placement and use a separate Move if still intended."
            }
            persist()
        } catch { handle(error) }
    }

    func revert() async {
        guard authorized, !projectReadOnly, !loadFailed, !busy, !legacyNeedsScope else { return }
        busy = true; defer { busy = false }
        if unresolvedOperation { await reconcileUnknown(); return }
        do {
            let saved = try await currentCard()
            baseline = saved; latest = saved; pending.draft = CardDraft(card: saved)
            conflicts = []; pending.confirmed = ConfirmedDraftReceipt(confirmedAt: ServerTimestamp.string(), evidence: "local-revert")
            message = "Local edits reverted to current saved values. No server write was sent."; persist(); cleanup()
        } catch { handle(error) }
    }

    private func cleanup() {
        guard !loadFailed, pending.confirmed != nil else { return }
        do {
            try model.drafts.removeScoped(ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: resourceKey)
            pending.confirmed = nil; persistenceFailed = false
        } catch { persistenceFailed = true; message = "Saved state is confirmed; local cleanup failed. Retry cleanup without resubmitting. \(error.localizedDescription)" }
    }

    private func handle(_ error: Error) {
        guard !(error is CancellationError) else { return }
        if (error as? APIError)?.isUnauthorized == true { model.handle(error); return }
        guard authorized else { return }
        if [403, 404].contains((error as? APIError)?.statusCode ?? 0) { missing() }
        else { message = error.localizedDescription }
    }
}

@MainActor
@Observable
final class CommentEditingSession {
    private unowned let model: AppModel
    let ownerID: String
    let workspace: Workspace
    let projectID: String
    let cardID: String
    var pending = PendingCommentDraft()
    private(set) var busy = false
    private(set) var persistenceFailed = false
    private(set) var loadFailed = false
    private var unreadRecordText: String?
    private(set) var legacyNeedsScope = false
    var message: String?
    private var loaded = false
    private var resourceKey: String { "comment:\(projectID):\(cardID)" }
    var authorized: Bool { model.signedIn && !model.signOutPending && model.ownerID == ownerID && model.workspaces.contains(where: { $0.id == workspace.id && $0.url == workspace.url }) }
    var frozen: Bool { loadFailed || legacyNeedsScope || pending.submitted != nil || pending.confirmed != nil }

    init(model: AppModel, workspace: Workspace, projectID: String, cardID: String) {
        self.model = model; ownerID = model.ownerID; self.workspace = workspace
        self.projectID = projectID; self.cardID = cardID
    }
    var retainedRecordText: String? { authorized ? unreadRecordText : nil }
    func load() {
        guard authorized, !loaded else { return }; loaded = true
        do {
            let saved = try model.drafts.loadScoped(ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: resourceKey, as: PendingCommentDraft.self)
            let legacy = saved == nil ? try model.drafts.unprovenLegacy(ownerID: ownerID,
                legacyResourceKey: resourceKey, as: PendingCommentDraft.self) : nil
            loadFailed = false; unreadRecordText = nil; persistenceFailed = false
            legacyNeedsScope = legacy != nil; message = nil
            pending = saved ?? legacy ?? PendingCommentDraft()
            if legacyNeedsScope {
                message = "This older Comment did not record its Workspace. Confirm the original Workspace before recovery; no request has been sent."
                return
            }
            persist()
        } catch {
            loadFailed = true; persistenceFailed = false
            unreadRecordText = model.drafts.retainedRecordText(ownerID: ownerID, workspace: workspace,
                projectID: projectID, resourceKey: resourceKey, legacyResourceKey: resourceKey)
            message = "The retained Comment could not be opened. Its original record is unchanged. Retry reading before editing, posting, or discarding. \(error.localizedDescription)"
        }
    }
    func retryLoading() {
        guard authorized, !busy, loadFailed else { return }
        model.drafts.prepareToRetryReading(ownerID: ownerID, workspace: workspace, projectID: projectID,
            resourceKey: resourceKey, legacyResourceKey: resourceKey)
        loaded = false
        load()
    }
    func recoverLegacy() {
        guard authorized, !loadFailed, legacyNeedsScope else { return }
        do {
            try model.drafts.recoverLegacy(pending, ownerID: ownerID, workspace: workspace,
                projectID: projectID, resourceKey: resourceKey, legacyResourceKey: resourceKey)
            legacyNeedsScope = false; persistenceFailed = false
            message = "Retained Comment recovered in the confirmed Workspace. Posting still requires an explicit action."
        } catch { persistenceFailed = true; message = error.localizedDescription }
    }
    func persist() {
        guard loaded, !loadFailed, !legacyNeedsScope else { return }
        do {
            try model.drafts.saveScoped(pending, ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: resourceKey)
            persistenceFailed = false
        } catch { persistenceFailed = true; message = "Local Comment protection failed. Keep this app open, Retry, or copy/export the text. \(error.localizedDescription)" }
    }
    func discard() {
        guard authorized, !busy, !frozen else { message = "Reconcile the submitted Comment before discarding its operation identity."; return }
        do {
            try model.drafts.removeScoped(ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: resourceKey)
            pending = PendingCommentDraft(); persistenceFailed = false
        } catch { persistenceFailed = true; message = error.localizedDescription }
    }
    func post() async {
        guard authorized, !loadFailed, !busy, !legacyNeedsScope else { return }
        busy = true; defer { busy = false }
        if pending.confirmed != nil { cleanup(); return }
        guard let project = model.loadedProjects[projectID], project.archivedAt == nil,
              let card = project.cards.first(where: { $0.id == cardID }), card.archivedAt == nil else { message = "This Card is unavailable for Comments. Local text is retained."; return }
        guard !pending.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let alreadySubmitted = pending.submitted != nil
        pending.submitted = pending.submitted ?? pending.body
        persist(); guard !persistenceFailed else { if !alreadySubmitted { pending.submitted = nil; persist() }; return }
        let generation = model.api.sessionGeneration
        do {
            try await model.addComment(pending.submitted!, cardID: cardID, projectID: projectID, in: workspace, key: pending.key,
                onConfirmed: { [weak self] in
                    guard let self, self.authorized, generation == self.model.api.sessionGeneration else { return }
                    self.pending.confirmed = ConfirmedDraftReceipt(confirmedAt: ServerTimestamp.string())
                    self.persist()
                })
            guard authorized, generation == model.api.sessionGeneration else { return }
            message = "Comment posted."; persist(); cleanup()
        } catch {
            if (error as? APIError)?.isUnauthorized == true { model.handle(error); return }
            guard authorized else { return }
            if let apiError = error as? APIError, let status = apiError.statusCode, status < 500, !apiError.isAmbiguousMutation { pending.submitted = nil }
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
            message = error.localizedDescription; persist()
        }
    }
    private func cleanup() {
        guard !loadFailed else { return }
        do {
            try model.drafts.removeScoped(ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: resourceKey)
            pending = PendingCommentDraft(); persistenceFailed = false
        } catch { persistenceFailed = true; message = "Comment is confirmed. Retry local cleanup without posting again. \(error.localizedDescription)" }
    }
}
