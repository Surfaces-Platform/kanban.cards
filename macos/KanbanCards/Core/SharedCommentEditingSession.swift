import Foundation
import Observation

/// One owner-scoped composer and one POST identity for every view of a Card.
@MainActor @Observable
final class SharedCommentEditingSession {
    @ObservationIgnored private weak var model: AppModel?
    let workspace: Workspace
    let projectID: String
    let cardID: String
    let ownerID: String
    let openingSessionID: UUID
    @ObservationIgnored private var loaded = false
    @ObservationIgnored private var suppressPersistence = false
    private(set) var invalidated = false
    var pending = PendingCommentDraft() { didSet { if !suppressPersistence { persist() } } }
    private(set) var legacyDraft: PendingCommentDraft?
    private(set) var saving = false
    private(set) var draftLoadFailed = false
    private(set) var persistenceFailed = false
    private(set) var recoveredDraft = false
    private(set) var receiptPersisted = false
    private(set) var completionID: UUID?
    var errorMessage: String?
    private(set) var persistenceError: String?
    private(set) var refreshError: String?

    init(model: AppModel, workspace: Workspace, projectID: String, cardID: String) {
        self.model = model; self.workspace = workspace; self.projectID = projectID; self.cardID = cardID
        ownerID = model.ownerID; openingSessionID = model.sessionID
    }
    var resourceKey: String { MacDraftScope.key("shared-comment", workspace: workspace, projectID: projectID, resourceID: cardID) }
    var legacyResourceKey: String { "workspace:\(workspace.id):project:\(projectID):card:\(cardID):comment" }
    var sessionIsCurrent: Bool {
        guard let model else { return false }
        return !invalidated && model.signedIn && model.ownerID == ownerID && model.sessionID == openingSessionID
    }
    var isReadOnly: Bool {
        guard sessionIsCurrent, let model, model.canEditProject(id: projectID, in: workspace),
              let project = model.project(id: projectID, in: workspace), project.archivedAt == nil,
              let card = project.cards.first(where: { $0.id == cardID }) else { return true }
        return card.archivedAt != nil
    }
    var editingDisabled: Bool { !sessionIsCurrent || saving || draftLoadFailed || isReadOnly || pending.submitted != nil || pending.confirmed != nil || legacyDraft != nil }
    var canPost: Bool { sessionIsCurrent && !saving && !draftLoadFailed && legacyDraft == nil && (pending.confirmed != nil || (!isReadOnly && !pending.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)) }
    var canDiscard: Bool { sessionIsCurrent && !saving && pending.submitted == nil && pending.confirmed == nil && legacyDraft == nil }
    var interactionLocked: Bool { saving || persistenceFailed || (pending.confirmed != nil && !receiptPersisted) }
    var confirmationLabel: String {
        if saving { return pending.confirmed == nil ? "Posting…" : "Finishing…" }
        if pending.confirmed != nil { return "Retry Cleanup" }
        return pending.submitted == nil ? "Post" : "Retry Comment"
    }
    func load() {
        guard !loaded, sessionIsCurrent, let model else { return }
        suppressPersistence = true
        defer { suppressPersistence = false }
        loaded = true
        do {
            if let saved = try model.drafts.load(ownerID: ownerID, resourceKey: resourceKey, as: PendingCommentDraft.self) {
                pending = saved; recoveredDraft = true
                receiptPersisted = saved.confirmed != nil && !model.drafts.hasRecovery(ownerID: ownerID, resourceKey: resourceKey)
            } else if try model.drafts.legacyMayBeAssociated(ownerID: ownerID, legacyKey: legacyResourceKey, destination: resourceKey) {
                legacyDraft = try model.drafts.load(ownerID: ownerID, resourceKey: legacyResourceKey, as: PendingCommentDraft.self)
            }
        } catch { draftLoadFailed = true; errorMessage = "The retained Comment could not be opened. Its original copy is retained. \(error.localizedDescription)" }
    }
    func associateLegacyDraft() {
        guard sessionIsCurrent, let model, let legacyDraft, !saving else { return }
        do {
            try model.drafts.associateLegacy(ownerID: ownerID, legacyKey: legacyResourceKey, destination: resourceKey)
            pending = legacyDraft; self.legacyDraft = nil; recoveredDraft = true; persist()
        } catch { errorMessage = error.localizedDescription }
    }
    func persist() {
        guard loaded, sessionIsCurrent, !draftLoadFailed, legacyDraft == nil, let model else { return }
        do {
            try model.drafts.save(pending, ownerID: ownerID, resourceKey: resourceKey)
            persistenceFailed = false; persistenceError = nil; receiptPersisted = pending.confirmed != nil
        } catch {
            persistenceFailed = true
            persistenceError = pending.confirmed != nil
                ? "Comment posted. This Mac could not record completion. Retry cleanup. \(error.localizedDescription)"
                : "This Mac could not write the draft to disk. Your text is retained in this app for your account. Copy or export it before quitting. \(error.localizedDescription)"
        }
    }
    func discard() {
        guard canDiscard, let model else { return }
        do {
            try model.drafts.remove(ownerID: ownerID, resourceKey: resourceKey)
            suppressPersistence = true; pending = PendingCommentDraft(); suppressPersistence = false
            recoveredDraft = false; completionID = UUID()
        } catch { errorMessage = error.localizedDescription }
    }
    func post() async {
        guard canPost, let model else { return }
        saving = true
        defer { saving = false }
        if pending.confirmed != nil { finishConfirmed(); return }
        let retrying = pending.submitted != nil
        pending.submitted = pending.submitted ?? pending.body
        persist()
        guard !persistenceFailed else {
            if !retrying { pending.submitted = nil; persist() }
            return
        }
        do {
            try await model.addComment(pending.submitted!, cardID: cardID, projectID: projectID, in: workspace, key: pending.key,
                onConfirmed: { [weak self] in
                    guard let self, self.sessionIsCurrent else { return }
                    self.pending.confirmed = ConfirmedDraftReceipt(confirmedAt: ServerTimestamp.string()); self.persist()
                }, onRefreshFailure: { [weak self] message in
                    guard let self, self.sessionIsCurrent else { return }; self.refreshError = message
                })
        } catch {
            guard sessionIsCurrent else { return }
            if pending.confirmed != nil { refreshError = error.localizedDescription; finishConfirmed(); return }
            if let status = (error as? APIError)?.statusCode, status < 500, status != 408 {
                pending.submitted = nil; pending.key = UUID().uuidString
            }
            persist()
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
            else { errorMessage = error.localizedDescription }
            return
        }
        if sessionIsCurrent { finishConfirmed() }
    }
    private func finishConfirmed() {
        guard sessionIsCurrent, pending.confirmed != nil, let model else { return }
        if !receiptPersisted { persist() }
        guard receiptPersisted else { return }
        do {
            try model.drafts.remove(ownerID: ownerID, resourceKey: resourceKey)
            suppressPersistence = true; pending = PendingCommentDraft(); suppressPersistence = false
            recoveredDraft = false; receiptPersisted = false; persistenceFailed = false; persistenceError = nil
            completionID = UUID()
        } catch { errorMessage = "Comment posted. The local receipt could not be removed. Retry cleanup. \(error.localizedDescription)" }
    }
    func retryRefresh() async {
        guard sessionIsCurrent, !saving, let model else { return }
        saving = true; defer { saving = false }
        do { try await model.loadProject(id: projectID, in: workspace); if sessionIsCurrent { refreshError = nil } }
        catch { if sessionIsCurrent { refreshError = error.localizedDescription } }
    }
    func invalidate() {
        guard !invalidated else { return }
        if loaded, !draftLoadFailed, let model, !pending.body.isEmpty || pending.submitted != nil || pending.confirmed != nil {
            try? model.drafts.retainForRecovery(pending, ownerID: ownerID, resourceKey: resourceKey)
        }
        invalidated = true; suppressPersistence = true; pending = PendingCommentDraft(); legacyDraft = nil
        errorMessage = nil; persistenceError = nil; refreshError = nil; suppressPersistence = false
    }
}
