import SwiftUI
import UIKit

struct ConfirmedDraftReceipt: Codable, Equatable {
    var confirmedAt: String
    var evidence: String? = nil
}

struct PendingCardDraft: Codable, Equatable {
    var draft: CardDraft
    var key: String
    var submitted: CardDraft?
    var confirmed: ConfirmedDraftReceipt?
    var baseline: Card? = nil
    var submissionBase: Card? = nil
    var unresolvedFields: [CardDraftField]? = nil
    var move: PendingCardMove? = nil
    var schemaVersion: Int? = nil
}

struct RetainedDraftIdentityError: LocalizedError {
    var errorDescription: String? { "The retained record belongs to a different resource. It has not been changed." }
}

extension PendingCardDraft {
    func validateIdentity(cardID: String?) throws {
        guard draft.id == cardID,
              submitted == nil || submitted?.id == cardID,
              baseline == nil || baseline?.id == cardID else { throw RetainedDraftIdentityError() }
    }
}


struct CardEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let workspace: Workspace
    let projectID: String
    let card: Card?
    @State private var pending: PendingCardDraft
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var latest: Card?
    @State private var discarding = false
    @State private var loadedDraft = false
    @State private var draftOwnerID = ""
    @State private var persistenceFailed = false
    @State private var receiptPersisted = false
    @State private var cleanupComplete = false
    @State private var legacyNeedsScope = false
    @State private var draftLoadFailed = false
    @State private var loadErrorMessage: String?
    @State private var unreadRecordText: String?

    init(workspace: Workspace, projectID: String, card: Card?) {
        self.workspace = workspace
        self.projectID = projectID
        self.card = card
        var draft = card.map(CardDraft.init(card:)) ?? CardDraft(columnId: "")
        if card == nil { draft.externalKey = "native-draft:\(UUID().uuidString)" }
        _pending = State(initialValue: PendingCardDraft(draft: draft, key: UUID().uuidString))
    }

    private var draftContextIsCurrent: Bool { model.signedIn && model.ownerID == draftOwnerID && model.workspaces.contains { $0.id == workspace.id && $0.url == workspace.url } }
    private var resourceKey: String { "card:\(projectID):\(card?.id ?? "new")" }
    private var columns: [Column] { (model.loadedProjects[projectID]?.columns ?? []).sorted { $0.position < $1.position } }
    private var projectReadOnly: Bool { model.loadedProjects[projectID]?.archivedAt != nil }

    var body: some View {
        if card == nil { NewCardEditor(workspace: workspace, projectID: projectID) }
        else { existingEditor }
    }

    private var existingEditor: some View {
        NavigationStack {
            Form {
                if projectReadOnly { Section { Text("Archived Project. Your local draft is retained; server changes are unavailable.") } }
                if draftLoadFailed {
                    Section("Retained draft could not be opened") {
                        Text(loadErrorMessage ?? "The original record is unchanged. Retry reading before editing or saving.")
                        Button("Retry reading retained draft") { loadDraft(retrying: true) }
                        if draftContextIsCurrent, let unreadRecordText {
                            Button("Copy retained record") { UIPasteboard.general.string = unreadRecordText }
                            ShareLink("Export retained record", item: unreadRecordText)
                        }
                    }
                }
                if legacyNeedsScope {
                    Section("Confirm retained draft Workspace") {
                        Text("This older draft did not record its Workspace. Confirm this is its original Workspace before editing or retrying any request.")
                        Text(workspace.url.absoluteString).textSelection(.enabled)
                        Button("This is the original Workspace") { recoverLegacy() }
                        Button("Copy retained draft") { UIPasteboard.general.string = String(decoding: (try? JSONEncoder().encode(pending)) ?? Data(), as: UTF8.self) }
                        ShareLink("Export retained draft", item: String(decoding: (try? JSONEncoder().encode(pending)) ?? Data(), as: UTF8.self))
                    }
                }
                if persistenceFailed {
                    Section("Local draft protection failed") {
                        Text("The newest draft remains only in this running app until protection succeeds.")
                        Button("Retry local protection") { persist() }
                        Button("Copy draft") { UIPasteboard.general.string = String(decoding: (try? JSONEncoder().encode(pending.draft)) ?? Data(), as: UTF8.self) }
                        ShareLink("Export draft", item: String(decoding: (try? JSONEncoder().encode(pending.draft)) ?? Data(), as: UTF8.self))
                    }
                }
                if pending.confirmed != nil {
                    Section { Text("Card saved. Remove the local draft to finish.") }
                } else if pending.submitted != nil {
                    Section {
                        Text("The previous save may have reached the server. Retry the same save to confirm its result.")
                    }
                }
                Section("Card") {
                    TextField("Title", text: $pending.draft.title)
                        .accessibilityIdentifier("card-title")
                    Picker("Column", selection: $pending.draft.columnId) {
                        ForEach(columns) { Text($0.name).tag($0.id) }
                    }
                    Picker("Next actor", selection: $pending.draft.nextActor) {
                        Text("Unassigned").tag(CardNextActor?.none)
                        ForEach(CardNextActor.allCases) { Text($0.label).tag(Optional($0)) }
                    }
                    Picker("Priority", selection: $pending.draft.priority) {
                        Text("Unset").tag(CardPriority?.none)
                        ForEach(CardPriority.allCases) { Text($0.rawValue).tag(Optional($0)) }
                    }
                    TextField("Next action", text: $pending.draft.nextAction, axis: .vertical)
                    TextField("Blocker", text: $pending.draft.blockedReason, axis: .vertical)
                }
                .disabled(saving || draftLoadFailed || legacyNeedsScope || pending.submitted != nil || pending.confirmed != nil || projectReadOnly)
                Section("Description") {
                    TextEditor(text: $pending.draft.body)
                        .accessibilityLabel("Description")
                        .accessibilityIdentifier("card-description")
                }.disabled(saving || draftLoadFailed || legacyNeedsScope || pending.submitted != nil || pending.confirmed != nil || projectReadOnly)
                if let latest {
                    Section("Latest saved Card") { Text(latest.title) }
                    CardFields(card: latest, columns: columns)
                    Section {
                        Button("Continue editing with latest version") {
                            guard !projectReadOnly else { return }
                            pending.draft.version = latest.version
                            pending.submitted = nil
                            self.latest = nil
                            persist()
                        }.disabled(projectReadOnly)
                    } footer: {
                        Text("Your draft remains in the editor above. Review and reconcile the saved values before saving again.")
                    }
                }
                if pending.confirmed == nil {
                    Section { Button("Discard draft", role: .destructive) { discarding = true }.disabled(saving || draftLoadFailed || legacyNeedsScope || pending.submitted != nil || projectReadOnly) }
                }
            }
            .navigationTitle(card == nil ? "New Card" : "Edit Card")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        persist()
                        if !persistenceFailed { dismiss() }
                    }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(pending.confirmed != nil ? "Retry cleanup" : pending.submitted == nil ? (card == nil ? "Create" : "Save") : "Retry Save") { Task { await save() } }
                        .disabled(saving || draftLoadFailed || legacyNeedsScope || projectReadOnly || (pending.confirmed == nil && (latest != nil || pending.draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || pending.draft.columnId.isEmpty)))
                }
            }
            .interactiveDismissDisabled(saving || persistenceFailed || (pending.confirmed != nil && !receiptPersisted))
            .task {
                guard !loadedDraft else { return }
                draftOwnerID = model.ownerID
                loadDraft()
            }
            .onChange(of: pending) { _, _ in if loadedDraft && !cleanupComplete { persist() } }
            .alert(pending.confirmed != nil ? "Unable to remove local draft" : "Unable to save Card", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: { Text(errorMessage ?? "") }
            .confirmationDialog("Discard this local draft? A previous request may already have saved changes on the server.", isPresented: $discarding, titleVisibility: .visible) {
                Button("Discard draft", role: .destructive) {
                    guard !draftLoadFailed, draftContextIsCurrent, !projectReadOnly else { return }
                    do { try model.drafts.removeScoped(ownerID: draftOwnerID, workspace: workspace, projectID: projectID, resourceKey: resourceKey, legacyResourceKey: resourceKey); dismiss() }
                    catch { errorMessage = error.localizedDescription }
                }
            }
        }
    }

    private func loadDraft(retrying: Bool = false) {
        guard !saving, draftContextIsCurrent else { return }
        loadedDraft = true
        if retrying {
            model.drafts.prepareToRetryReading(ownerID: draftOwnerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: resourceKey)
        }
        do {
            let saved = try model.drafts.loadScoped(ownerID: draftOwnerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey, legacyResourceKey: resourceKey, as: PendingCardDraft.self)
            let retained = saved == nil ? try model.drafts.unprovenLegacy(ownerID: draftOwnerID,
                legacyResourceKey: resourceKey, as: PendingCardDraft.self) : nil
            if let record = saved ?? retained { try record.validateIdentity(cardID: card?.id) }
            legacyNeedsScope = retained != nil
            draftLoadFailed = false; loadErrorMessage = nil; unreadRecordText = nil; persistenceFailed = false
            if let record = saved ?? retained { pending = record; receiptPersisted = record.confirmed != nil }
            if !legacyNeedsScope && pending.draft.columnId.isEmpty { pending.draft.columnId = columns.first?.id ?? "" }
        } catch {
            draftLoadFailed = true; persistenceFailed = false
            unreadRecordText = model.drafts.retainedRecordText(ownerID: draftOwnerID, workspace: workspace,
                projectID: projectID, resourceKey: resourceKey, legacyResourceKey: resourceKey)
            loadErrorMessage = "The original record is unchanged. Retry reading before editing, saving, or discarding. \(error.localizedDescription)"
        }
    }

    private func recoverLegacy() {
        guard !draftLoadFailed, legacyNeedsScope, draftContextIsCurrent else { return }
        do {
            try model.drafts.recoverLegacy(pending, ownerID: draftOwnerID, workspace: workspace,
                projectID: projectID, resourceKey: resourceKey, legacyResourceKey: resourceKey)
            legacyNeedsScope = false; persistenceFailed = false
            receiptPersisted = pending.confirmed != nil
        } catch { persistenceFailed = true; errorMessage = error.localizedDescription }
    }

    private func persist() {
        guard loadedDraft, !draftLoadFailed, !draftOwnerID.isEmpty, !legacyNeedsScope else { return }
        do {
            try model.drafts.saveScoped(pending, ownerID: draftOwnerID, workspace: workspace, projectID: projectID, resourceKey: resourceKey, legacyResourceKey: resourceKey)
            persistenceFailed = false
            receiptPersisted = pending.confirmed != nil
        } catch {
            persistenceFailed = true
            errorMessage = pending.confirmed != nil
                ? "Card saved. This iPhone could not record completion. Keep the editor open and retry cleanup. \(error.localizedDescription)"
                : "The draft could not be saved on this iPhone. Keep the editor open or discard the draft explicitly. \(error.localizedDescription)"
        }
    }

    private func save() async {
        guard loadedDraft, !draftLoadFailed, !legacyNeedsScope, draftContextIsCurrent, !projectReadOnly else { return }
        saving = true
        defer { saving = false }
        if pending.confirmed != nil { cleanupConfirmedDraft(); return }
        let alreadySubmitted = pending.submitted != nil
        if pending.submitted == nil {
            if let project = model.loadedProjects[projectID] {
                let oldColumn = project.cards.first { $0.id == pending.draft.id }?.columnId
                if pending.draft.id == nil || oldColumn != pending.draft.columnId {
                    pending.draft.position = (project.cards.filter { $0.columnId == pending.draft.columnId && $0.id != pending.draft.id }.map(\.position).max() ?? -1) + 1
                }
            }
            pending.submitted = pending.draft
        }
        persist()
        guard !persistenceFailed else { if !alreadySubmitted { pending.submitted = nil; persist() }; return }
        do {
            _ = try await model.saveCard(pending.submitted!, projectID: projectID, in: workspace, key: pending.key)
        } catch {
            if let failure = error as? AppFailure, case .readOnlyProject = failure {
                if !alreadySubmitted { pending.submitted = nil }
            } else if model.isConflict(error), let id = pending.draft.id {
                pending.submitted = nil
                do {
                    try await model.loadProject(id: projectID, in: workspace)
                    latest = model.loadedProjects[projectID]?.cards.first { $0.id == id }
                } catch { errorMessage = error.localizedDescription }
            } else if let apiError = error as? APIError, let status = apiError.statusCode, status < 500, !apiError.isAmbiguousMutation {
                pending.submitted = nil
            }
            persist()
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
            else { errorMessage = error.localizedDescription }
            return
        }
        pending.confirmed = ConfirmedDraftReceipt(confirmedAt: ServerTimestamp.string())
        persist()
        cleanupConfirmedDraft()
    }

    private func cleanupConfirmedDraft() {
        guard !draftLoadFailed, pending.confirmed != nil else { return }
        if !receiptPersisted { persist() }
        do {
            try model.drafts.removeScoped(ownerID: draftOwnerID, workspace: workspace, projectID: projectID, resourceKey: resourceKey, legacyResourceKey: resourceKey)
            cleanupComplete = true
            dismiss()
        } catch {
            errorMessage = "Card saved. The local draft could not be removed. Retry cleanup. \(error.localizedDescription)"
        }
    }
}

struct PendingProjectDraft: Codable, Equatable {
    var draft: ProjectDraft
    var key: String
    var submitted: ProjectDraft?
    var confirmed: ConfirmedDraftReceipt?
}

extension PendingProjectDraft {
    func validateIdentity(projectID: String?) throws {
        guard draft.id == projectID, submitted == nil || submitted?.id == projectID else {
            throw RetainedDraftIdentityError()
        }
    }
}

struct ProjectEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let workspace: Workspace
    var project: Project? = nil
    @State private var pending: PendingProjectDraft
    @State private var saving = false
    @State private var loadedDraft = false
    @State private var draftOwnerID = ""
    @State private var errorMessage: String?
    @State private var latest: Project?
    @State private var persistenceFailed = false
    @State private var discarding = false
    @State private var receiptPersisted = false
    @State private var cleanupComplete = false
    @State private var legacyNeedsScope = false
    @State private var draftLoadFailed = false
    @State private var loadErrorMessage: String?
    @State private var unreadRecordText: String?

    init(workspace: Workspace, project: Project? = nil) {
        self.workspace = workspace
        self.project = project
        _pending = State(initialValue: PendingProjectDraft(draft: Self.metadataDraft(project), key: UUID().uuidString))
    }

    private static func metadataDraft(_ project: Project?) -> ProjectDraft {
        guard let project else { return ProjectDraft() }
        var draft = ProjectDraft(project: project)
        draft.columns = nil
        draft.archivedAt = nil
        return draft
    }

    private var draftContextIsCurrent: Bool { model.signedIn && model.ownerID == draftOwnerID && model.workspaces.contains { $0.id == workspace.id && $0.url == workspace.url } }
    private var resourceKey: String { "project:\(workspace.id):\(project?.id ?? "new")" }
    private var projectReadOnly: Bool { project.map { (model.loadedProjects[$0.id] ?? $0).archivedAt != nil } ?? false }

    var body: some View {
        if project == nil { NewProjectEditor(workspace: workspace) }
        else { existingEditor }
    }

    private var existingEditor: some View {
        NavigationStack {
            Form {
                if projectReadOnly { Section { Text("Archived Project. Your local draft is retained; server changes are unavailable.") } }
                if draftLoadFailed {
                    Section("Retained draft could not be opened") {
                        Text(loadErrorMessage ?? "The original record is unchanged. Retry reading before editing or saving.")
                        Button("Retry reading retained draft") { loadDraft(retrying: true) }
                        if draftContextIsCurrent, let unreadRecordText {
                            Button("Copy retained record") { UIPasteboard.general.string = unreadRecordText }
                            ShareLink("Export retained record", item: unreadRecordText)
                        }
                    }
                }
                if legacyNeedsScope {
                    Section("Confirm retained draft Workspace") {
                        Text("This older draft did not record its Workspace. Confirm this is its original Workspace before editing or retrying any request.")
                        Text(workspace.url.absoluteString).textSelection(.enabled)
                        Button("This is the original Workspace") { recoverLegacy() }
                        Button("Copy retained draft") { UIPasteboard.general.string = String(decoding: (try? JSONEncoder().encode(pending)) ?? Data(), as: UTF8.self) }
                        ShareLink("Export retained draft", item: String(decoding: (try? JSONEncoder().encode(pending)) ?? Data(), as: UTF8.self))
                    }
                }
                if persistenceFailed {
                    Section("Local draft protection failed") {
                        Text("The newest draft remains only in this running app until protection succeeds.")
                        Button("Retry local protection") { persist() }
                        Button("Copy draft") { UIPasteboard.general.string = String(decoding: (try? JSONEncoder().encode(pending.draft)) ?? Data(), as: UTF8.self) }
                        ShareLink("Export draft", item: String(decoding: (try? JSONEncoder().encode(pending.draft)) ?? Data(), as: UTF8.self))
                    }
                }
                if pending.confirmed != nil { Section { Text("Project saved. Remove the local draft to finish.") } }
                else if pending.submitted != nil { Section { Text("The previous save may have reached the server. Retry the same save to confirm its result.") } }
                Section {
                    TextField("Name", text: $pending.draft.name).accessibilityIdentifier("project-name")
                    TextField("Description", text: $pending.draft.description, axis: .vertical)
                }.disabled(saving || draftLoadFailed || legacyNeedsScope || pending.submitted != nil || pending.confirmed != nil || projectReadOnly)
                if let latest {
                    Section("Latest saved Project") {
                        LabeledContent("Name", value: latest.name)
                        Text(latest.description)
                        Button("Continue editing with latest revision") {
                            guard !projectReadOnly else { return }
                            pending.draft.revision = latest.revision; pending.submitted = nil; self.latest = nil
                        }.disabled(projectReadOnly)
                    }
                }
                if pending.confirmed == nil {
                    Section { Button("Discard draft", role: .destructive) { discarding = true }.disabled(saving || draftLoadFailed || legacyNeedsScope || pending.submitted != nil || projectReadOnly) }
                }
            }
            .navigationTitle(project == nil ? "New Project" : "Edit Project")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { persist(); if !persistenceFailed { dismiss() } }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(pending.confirmed != nil ? "Retry cleanup" : pending.submitted == nil ? (project == nil ? "Create" : "Save") : "Retry Save") { Task { await save() } }
                        .disabled(saving || draftLoadFailed || legacyNeedsScope || projectReadOnly || (pending.confirmed == nil && (latest != nil || pending.draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)))
                }
            }
            .interactiveDismissDisabled(saving || persistenceFailed || (pending.confirmed != nil && !receiptPersisted))
            .task {
                guard !loadedDraft else { return }
                draftOwnerID = model.ownerID
                loadDraft()
            }
            .onChange(of: pending) { _, _ in if loadedDraft && !cleanupComplete { persist() } }
            .alert(pending.confirmed != nil ? "Unable to remove local draft" : "Unable to save Project", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: { Text(errorMessage ?? "") }
            .confirmationDialog("Discard this local draft? A previous request may already have saved changes on the server.", isPresented: $discarding, titleVisibility: .visible) {
                Button("Discard draft", role: .destructive) {
                    guard !draftLoadFailed, draftContextIsCurrent, !projectReadOnly else { return }
                    do { try model.drafts.removeScoped(ownerID: draftOwnerID, workspace: workspace, projectID: project?.id ?? "new", resourceKey: resourceKey, legacyResourceKey: resourceKey); dismiss() }
                    catch { errorMessage = error.localizedDescription }
                }
            }
        }
    }

    private func loadDraft(retrying: Bool = false) {
        guard !saving, draftContextIsCurrent else { return }
        loadedDraft = true
        if retrying {
            model.drafts.prepareToRetryReading(ownerID: draftOwnerID, workspace: workspace, projectID: project?.id ?? "new",
                resourceKey: resourceKey, legacyResourceKey: resourceKey)
        }
        do {
            let saved = try model.drafts.loadScoped(ownerID: draftOwnerID, workspace: workspace, projectID: project?.id ?? "new",
                resourceKey: resourceKey, legacyResourceKey: resourceKey, as: PendingProjectDraft.self)
            let retained = saved == nil ? try model.drafts.unprovenLegacy(ownerID: draftOwnerID,
                legacyResourceKey: resourceKey, as: PendingProjectDraft.self) : nil
            if let record = saved ?? retained { try record.validateIdentity(projectID: project?.id) }
            legacyNeedsScope = retained != nil
            draftLoadFailed = false; loadErrorMessage = nil; unreadRecordText = nil; persistenceFailed = false
            if let record = saved ?? retained { pending = record; receiptPersisted = record.confirmed != nil }
        } catch {
            draftLoadFailed = true; persistenceFailed = false
            unreadRecordText = model.drafts.retainedRecordText(ownerID: draftOwnerID, workspace: workspace,
                projectID: project?.id ?? "new", resourceKey: resourceKey, legacyResourceKey: resourceKey)
            loadErrorMessage = "The original record is unchanged. Retry reading before editing, saving, or discarding. \(error.localizedDescription)"
        }
    }

    private func recoverLegacy() {
        guard !draftLoadFailed, legacyNeedsScope, draftContextIsCurrent else { return }
        do {
            try model.drafts.recoverLegacy(pending, ownerID: draftOwnerID, workspace: workspace,
                projectID: project?.id ?? "new", resourceKey: resourceKey, legacyResourceKey: resourceKey)
            legacyNeedsScope = false; persistenceFailed = false
            receiptPersisted = pending.confirmed != nil
        } catch { persistenceFailed = true; errorMessage = error.localizedDescription }
    }

    private func persist() {
        guard loadedDraft, !draftLoadFailed, !draftOwnerID.isEmpty, !legacyNeedsScope else { return }
        do {
            try model.drafts.saveScoped(pending, ownerID: draftOwnerID, workspace: workspace, projectID: project?.id ?? "new", resourceKey: resourceKey, legacyResourceKey: resourceKey)
            persistenceFailed = false
            receiptPersisted = pending.confirmed != nil
        } catch {
            persistenceFailed = true
            errorMessage = pending.confirmed != nil
                ? "Project saved. This iPhone could not record completion. Keep the editor open and retry cleanup. \(error.localizedDescription)"
                : error.localizedDescription
        }
    }

    private func save() async {
        guard loadedDraft, !draftLoadFailed, !legacyNeedsScope, draftContextIsCurrent, !projectReadOnly else { return }
        saving = true
        defer { saving = false }
        if pending.confirmed != nil { cleanupConfirmedDraft(); return }
        let alreadySubmitted = pending.submitted != nil
        pending.submitted = pending.submitted ?? pending.draft
        persist()
        guard !persistenceFailed else { if !alreadySubmitted { pending.submitted = nil; persist() }; return }
        do {
            _ = try await model.saveProject(pending.submitted!, in: workspace, key: pending.key)
        } catch {
            if let failure = error as? AppFailure, case .readOnlyProject = failure {
                if !alreadySubmitted { pending.submitted = nil }
            } else if model.isConflict(error), let id = pending.draft.id {
                pending.submitted = nil
                do { try await model.loadProject(id: id, in: workspace); latest = model.loadedProjects[id] }
                catch { errorMessage = error.localizedDescription }
            } else if let apiError = error as? APIError, let status = apiError.statusCode, status < 500, !apiError.isAmbiguousMutation { pending.submitted = nil }
            persist()
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
            else { errorMessage = error.localizedDescription }
            return
        }
        pending.confirmed = ConfirmedDraftReceipt(confirmedAt: ServerTimestamp.string())
        persist()
        cleanupConfirmedDraft()
    }

    private func cleanupConfirmedDraft() {
        guard !draftLoadFailed, pending.confirmed != nil else { return }
        if !receiptPersisted { persist() }
        do {
            try model.drafts.removeScoped(ownerID: draftOwnerID, workspace: workspace, projectID: project?.id ?? "new", resourceKey: resourceKey, legacyResourceKey: resourceKey)
            cleanupComplete = true
            dismiss()
        } catch {
            errorMessage = "Project saved. The local draft could not be removed. Retry cleanup. \(error.localizedDescription)"
        }
    }
}

struct CommentsView: View {
    @Environment(AppModel.self) private var model
    let workspace: Workspace
    let projectID: String
    let cardID: String
    let readOnly: Bool
    @State private var composing = false
    private var commentsReadOnly: Bool {
        readOnly || model.loadedProjects[projectID]?.archivedAt != nil
            || model.loadedProjects[projectID]?.cards.first(where: { $0.id == cardID })?.archivedAt != nil
    }

    init(workspace: Workspace, projectID: String, cardID: String, readOnly: Bool = false) {
        self.workspace = workspace
        self.projectID = projectID
        self.cardID = cardID
        self.readOnly = readOnly
    }

    var body: some View {
        List {
            let comments = model.loadedProjects[projectID]?.cards.first { $0.id == cardID }?.comments ?? []
            ForEach(comments) { comment in
                Section {
                    Text(verbatim: comment.body).textSelection(.enabled)
                    LabeledContent("By", value: comment.author)
                    if let date = ServerTimestamp.date(from: comment.createdAt) { Text(date, format: .dateTime) }
                }
            }
            if comments.isEmpty { ContentUnavailableView("No Comments", systemImage: "text.bubble") }
        }
        .navigationTitle("Comments")
        .toolbar {
            if !commentsReadOnly {
                ToolbarItem(placement: .primaryAction) { Button("Add Comment", systemImage: "square.and.pencil") { composing = true } }
            }
        }
        .sheet(isPresented: $composing) { CommentEditor(workspace: workspace, projectID: projectID, cardID: cardID) }
    }
}

struct PendingCommentDraft: Codable, Equatable {
    var body = ""
    var key = UUID().uuidString
    var submitted: String?
    var confirmed: ConfirmedDraftReceipt?
}

struct CommentEditor: View {
    @Environment(AppModel.self) private var model
    let workspace: Workspace
    let projectID: String
    let cardID: String
    @State private var editingSession: CommentEditingSession?
    var body: some View {
        Group {
            if let editingSession { CoordinatedCommentForm(session: editingSession) }
            else { ProgressView("Opening Comment") }
        }
        .task {
            let session = model.commentEditingSession(workspace: workspace, projectID: projectID, cardID: cardID)
            editingSession = session
            session.load()
        }
    }
}
