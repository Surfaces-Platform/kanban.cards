import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct ConfirmedDraftReceipt: Codable, Equatable {
    var confirmedAt: String
    var createdCard: Card? = nil
}

struct PendingCardDraft: Codable, Equatable {
    var draft: CardDraft
    var key: String
    var submitted: CardDraft?
    var confirmed: ConfirmedDraftReceipt?
    var requiresConflictReview: Bool?
}

struct CardEditor: View {
    enum Presentation: String, Equatable { case sheet, inline, window }
    @Environment(AppModel.self) private var model
    let workspace: Workspace
    let projectID: String
    let card: Card?
    var columnID: String? = nil
    var onCreated: ((Card) -> Void)? = nil
    var onRefreshFailure: ((String) -> Void)? = nil
    var presentation: Presentation = .sheet
    var onClose: (() -> Void)? = nil
    var onInteractionLockChanged: ((Bool) -> Void)? = nil
    var cardEditingDisabled = false
    var additionalContent: AnyView? = nil
    var additionalContentFocusRequest: UUID? = nil
    var headerLeadingContent: AnyView? = nil
    var headerTrailingContent: AnyView? = nil
    @State private var editingSession: SharedCardEditingSession?

    var body: some View {
        Group {
            if let card {
                if let editingSession, editingSession.sessionIsCurrent {
                    SharedCardEditorView(session: editingSession, presentation: presentation,
                        onInteractionLockChanged: onInteractionLockChanged,
                        cardEditingDisabled: cardEditingDisabled, additionalContent: additionalContent,
                        additionalContentFocusRequest: additionalContentFocusRequest,
                        headerLeadingContent: headerLeadingContent, headerTrailingContent: headerTrailingContent)
                } else {
                    ProgressView("Opening Card")
                }
            } else {
                NewCardEditor(workspace: workspace, projectID: projectID, card: nil,
                    columnID: columnID, onCreated: onCreated, onRefreshFailure: onRefreshFailure,
                    onClose: onClose, onInteractionLockChanged: onInteractionLockChanged)
            }
        }
        .task(id: [model.sessionID.uuidString, workspace.id, workspace.url.absoluteString, projectID, card?.id ?? "new"]) {
            guard let card, model.signedIn else { return }
            editingSession = model.cardEditingSession(workspace: workspace, projectID: projectID, card: card)
        }
    }
}

private struct NewCardEditor: View {
    enum Presentation: String, Equatable { case sheet, inline, window }
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let workspace: Workspace
    let projectID: String
    let card: Card?
    let onCreated: ((Card) -> Void)?
    let onRefreshFailure: ((String) -> Void)?
    let presentation: Presentation
    let onClose: (() -> Void)?
    let onInteractionLockChanged: ((Bool) -> Void)?
    @State private var pending: PendingCardDraft
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var latest: Card?
    @State private var replacingDraft = false
    @State private var createdCard: Card?
    @State private var creationRevealed = false
    @State private var reviewingConflict = false
    @State private var discarding = false
    @State private var loadedDraft = false
    @State private var draftOwnerID = ""
    @State private var draftSessionID: UUID?
    @State private var draftLoadFailed = false
    @State private var persistenceFailed = false
    @State private var receiptPersisted = false
    @State private var cleanupComplete = false
    @State private var recoveredDraft = false
    @State private var persistenceError: String?
    @State private var refreshError: String?

    init(workspace: Workspace, projectID: String, card: Card?, columnID: String? = nil, onCreated: ((Card) -> Void)? = nil, onRefreshFailure: ((String) -> Void)? = nil,
         presentation: Presentation = .sheet, onClose: (() -> Void)? = nil,
         onInteractionLockChanged: ((Bool) -> Void)? = nil) {
        self.workspace = workspace
        self.projectID = projectID
        self.card = card
        self.onCreated = onCreated
        self.onRefreshFailure = onRefreshFailure
        self.presentation = presentation
        self.onClose = onClose
        self.onInteractionLockChanged = onInteractionLockChanged
        var draft = card.map(CardDraft.init(card:)) ?? CardDraft(columnId: columnID ?? "")
        if card == nil { draft.externalKey = "native-macos-draft:\(UUID().uuidString)" }
        _pending = State(initialValue: PendingCardDraft(draft: draft, key: UUID().uuidString))
    }

    private var resourceKey: String {
        let base = "workspace:\(workspace.id):project:\(projectID):card:\(card?.id ?? "new")"
        // Independent edit surfaces retain independent drafts. Card versions still
        // require conflict review if another surface saves the same Card first.
        return card != nil && presentation != .sheet ? "\(base):editor:\(presentation.rawValue)" : base
    }
    private var columns: [Column] { (model.project(id: projectID, in: workspace)?.columns ?? []).sorted { $0.position < $1.position } }
    private var hasProminentDraftStatus: Bool { recoveredDraft || persistenceError != nil }

    private var sessionIsCurrent: Bool {
        loadedDraft && model.signedIn && model.ownerID == draftOwnerID && model.sessionID == draftSessionID
    }

    private var isReadOnly: Bool {
        guard model.canEditProject(id: projectID, in: workspace) else { return true }
        guard let project = model.project(id: projectID, in: workspace), project.archivedAt == nil else { return true }
        guard let id = card?.id else { return false }
        guard let current = project.cards.first(where: { $0.id == id }) else { return true }
        return current.archivedAt != nil
    }

    private var interactionLocked: Bool {
        saving || reviewingConflict || discarding || replacingDraft || persistenceFailed
            || errorMessage != nil || (pending.confirmed != nil && !receiptPersisted)
    }

    private var submissionDisabled: Bool {
        !sessionIsCurrent || saving || reviewingConflict || draftLoadFailed
            || (pending.confirmed == nil && (isReadOnly || pending.requiresConflictReview == true
                || pending.draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !columns.contains(where: { $0.id == pending.draft.columnId })))
    }

    var body: some View {
        Group {
            if presentation == .inline { inlineEditor }
            else { navigationEditor }
        }
        .interactiveDismissDisabled(interactionLocked)
        .task {
            guard !loadedDraft, model.signedIn else { return }
            draftOwnerID = model.ownerID
            draftSessionID = model.sessionID
            loadedDraft = true
            do {
                if let saved = try model.drafts.load(ownerID: draftOwnerID, resourceKey: resourceKey, as: PendingCardDraft.self) {
                    pending = saved
                    recoveredDraft = true
                    receiptPersisted = saved.confirmed != nil && !model.drafts.hasRecovery(ownerID: draftOwnerID, resourceKey: resourceKey)
                    createdCard = saved.confirmed?.createdCard
                }
                if pending.draft.columnId.isEmpty { pending.draft.columnId = columns.first?.id ?? "" }
            } catch { draftLoadFailed = true; errorMessage = "The retained draft could not be opened. Cancel and retry, or explicitly discard the draft. \(error.localizedDescription)" }
            if pending.requiresConflictReview == true { await reviewConflict() }
        }
        .onChange(of: interactionLocked, initial: true) { _, locked in onInteractionLockChanged?(locked) }
        .onDisappear {
            persist()
            onInteractionLockChanged?(false)
        }
        .onChange(of: model.sessionID) { _, _ in invalidateSession() }
        .onChange(of: model.signedIn) { _, signedIn in if !signedIn { invalidateSession() } }
        .onChange(of: model.ownerID) { _, _ in if !sessionIsCurrent { invalidateSession() } }
        .onChange(of: pending) { _, _ in if loadedDraft && !cleanupComplete { persist() } }
        .alert(pending.confirmed != nil ? "Unable to remove local draft" : "Unable to save Card", isPresented: Binding(get: { errorMessage != nil && sessionIsCurrent }, set: { if !$0 { errorMessage = nil } })) {
            Button("OK", role: .cancel) { errorMessage = nil }
        } message: { Text(errorMessage ?? "") }
        .confirmationDialog("Replace this local draft with the saved Card?", isPresented: $replacingDraft, titleVisibility: .visible) {
            Button("Replace Local Draft", role: .destructive) {
                guard sessionIsCurrent, let latest else { return }
                pending = PendingCardDraft(draft: CardDraft(card: latest), key: UUID().uuidString)
                self.latest = nil
                persist()
            }
            Button("Keep Local Draft", role: .cancel) {}
        } message: {
            Text("Your local edits will be discarded. The saved Card on the server will stay unchanged.")
        }
        .confirmationDialog("Discard this local draft?", isPresented: $discarding, titleVisibility: .visible) {
            Button("Discard draft", role: .destructive) {
                guard sessionIsCurrent else { return }
                do { try model.drafts.remove(ownerID: draftOwnerID, resourceKey: resourceKey); cleanupComplete = true; close() }
                catch { errorMessage = error.localizedDescription }
            }
        } message: {
            Text(pending.submitted == nil ? "The saved Card will remain unchanged." : "A previous request may already have saved changes on the server.")
        }
    }

    private var navigationEditor: some View {
        NavigationStack {
            editorForm
                .frame(minWidth: 500, idealWidth: 600, minHeight: 540, idealHeight: 720)
                .navigationTitle(presentation == .window ? "Edit \(card?.title ?? "Card")" : (card == nil ? "New Card" : "Edit Card"))
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { cancelButton }
                    ToolbarItem(placement: .confirmationAction) {
                        if presentation == .window {
                            saveButton.keyboardShortcut("s", modifiers: .command)
                        } else {
                            saveButton.keyboardShortcut(.defaultAction)
                        }
                    }
                }
        }
    }

    private var inlineEditor: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Edit Card").font(.headline)
                Spacer(minLength: 8)
                cancelButton
                saveButton.keyboardShortcut("s", modifiers: .command)
            }
            .padding()
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Card edit controls")
            Divider()
            editorForm.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 320, maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Edit Card")
        .accessibilityIdentifier("card.inline-editor.\(card?.id ?? "new")")
    }

    private var editorForm: some View {
        Form {
            if hasProminentDraftStatus { draftStatus }
            if saving {
                Section { ProgressView(pending.confirmed == nil ? "Saving Card…" : "Card saved. Finishing…") }
            } else if pending.confirmed != nil {
                Section { Text(cleanupComplete ? "Card saved." : "Card saved. Finish removing the local draft.") }
            } else if pending.submitted != nil {
                Section { Text("The save result is uncertain. Retry the same save to confirm whether it reached the server.") }
            }
            refreshStatus
            if isReadOnly && pending.confirmed == nil {
                Section { Text(model.canEditProject(id: projectID, in: workspace)
                    ? "This Card is unavailable or archived, or its Project is archived. Your local draft is retained."
                    : "This board is read-only in this session. Your local draft is retained.") }
            }
            Section {
                TextField("Title (required)", text: $pending.draft.title)
                    .accessibilityIdentifier("editor.title")
                Picker("Column", selection: $pending.draft.columnId) {
                    if !columns.contains(where: { $0.id == pending.draft.columnId }) {
                        Text(pending.draft.columnId.isEmpty ? "Choose a Column" : "Unavailable Column").tag(pending.draft.columnId)
                    }
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
                if let validationMessage, pending.confirmed == nil {
                    Text(validationMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("editor.validation")
                }
            } header: {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Card")
                    Text("\(model.project(id: projectID, in: workspace)?.name ?? "Unavailable") · \(workspace.name)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(saving || draftLoadFailed || isReadOnly || pending.submitted != nil || pending.confirmed != nil)
            Section {
                TextEditor(text: $pending.draft.body)
                    .frame(minHeight: 180)
                    .accessibilityLabel("Description")
                    .accessibilityIdentifier("editor.body")
            } header: {
                Text("Description")
            } footer: {
                if !hasProminentDraftStatus && pending.confirmed == nil {
                    Text("Cancel keeps a draft on this Mac. Discard Draft removes it.")
                        .accessibilityIdentifier("editor.draft-status")
                }
            }.disabled(saving || draftLoadFailed || isReadOnly || pending.submitted != nil || pending.confirmed != nil)
            if pending.requiresConflictReview == true {
                Section("Review saved changes") {
                    Text("This Card changed after your draft began. Your draft is above; the saved values are below. Keeping your draft means the next save replaces every editable field, including fields you did not change locally.")
                    if let latest {
                        Text("Different fields: \(CardDraftComparison.differingFields(pending.draft, from: latest).joined(separator: ", ")).")
                        SavedCardValues(card: latest, columns: columns)
                        Button("Keep My Draft for Next Save") {
                            guard sessionIsCurrent else { return }
                            pending.draft.version = latest.version
                            pending.draft.archivedAt = latest.archivedAt
                            pending.draft.externalKey = latest.externalKey
                            if pending.draft.columnId == latest.columnId {
                                pending.draft.position = latest.position
                            }
                            pending.submitted = nil
                            pending.key = UUID().uuidString
                            pending.requiresConflictReview = false
                            self.latest = nil
                            persist()
                        }.accessibilityIdentifier("editor.keep-draft").disabled(isReadOnly)
                        Button("Use Saved Card…") { replacingDraft = true }
                            .accessibilityIdentifier("editor.use-saved")
                    } else {
                        Button("Load Latest Saved Card") { Task { await reviewConflict() } }
                            .accessibilityIdentifier("editor.load-conflict")
                    }
                }.disabled(saving || reviewingConflict)
            }
            if pending.confirmed == nil {
                Section { Button("Discard draft", role: .destructive) { discarding = true }.disabled(saving) }
            }
        }
        .formStyle(.grouped)
    }

    private var cancelButton: some View {
        Button(cleanupComplete ? "Done" : "Cancel") {
            persist()
            if draftLoadFailed || !persistenceFailed { close() }
        }
        .keyboardShortcut(.cancelAction)
        .accessibilityIdentifier("editor.cancel")
        .disabled(saving)
    }

    private var saveButton: some View {
        Button(confirmationLabel) { Task { await save() } }
            .accessibilityIdentifier("editor.save")
            .disabled(submissionDisabled)
    }

    private func close() {
        if let onClose { onClose() }
        else { dismiss() }
    }

    private var validationMessage: String? {
        if columns.isEmpty { return "This Project has no available Columns. Refresh the Project before creating or moving a Card." }
        if !columns.contains(where: { $0.id == pending.draft.columnId }) {
            return "The Column in this draft is unavailable. Choose an available Column before saving."
        }
        return nil
    }

    private var confirmationLabel: String {
        if saving { return pending.confirmed == nil ? "Saving…" : "Finishing…" }
        if cleanupComplete { return "Done" }
        if pending.confirmed != nil { return "Retry Cleanup" }
        return pending.submitted == nil ? (card == nil ? "Create" : "Save") : "Retry Save"
    }

    @ViewBuilder private var draftStatus: some View {
        Section {
            Text(recoveredDraft ? "Recovered draft. Cancel retains your draft for this account; it does not change the saved Card." : "Cancel keeps a draft on this Mac without changing the saved Card. Use Discard Draft to remove it.")
                .accessibilityIdentifier("editor.draft-status")
            if let persistenceError {
                Text(persistenceError)
                DraftRecoveryActions(text: "Title: \(pending.draft.title)\nColumn: \(pending.draft.columnId)\nNext actor: \(pending.draft.nextActor?.label ?? "Unassigned")\nPriority: \(pending.draft.priority?.rawValue ?? "Unset")\nNext action: \(pending.draft.nextAction)\nBlocker: \(pending.draft.blockedReason)\n\n\(pending.draft.body)", filename: "card-draft", isActive: sessionIsCurrent) { errorMessage = $0 }
                Button("Retry Saving Local Draft") { persist() }.disabled(saving)
            }
        }
    }

    @ViewBuilder private var refreshStatus: some View {
        if let refreshError, onRefreshFailure == nil {
            Section("Saved; refresh failed") {
                Text(refreshError)
                Button("Retry Refresh") { Task { await retryRefresh() } }.disabled(saving)
            }
        }
    }

    private func recordConfirmation() {
        guard sessionIsCurrent else { return }
        pending.confirmed = ConfirmedDraftReceipt(confirmedAt: ServerTimestamp.string())
        persist()
    }

    private func reportRefreshFailure(_ message: String) {
        guard sessionIsCurrent else { return }
        refreshError = message
        onRefreshFailure?(message)
    }

    private func retryRefresh() async {
        guard sessionIsCurrent, !saving else { return }
        saving = true
        defer { saving = false }
        do { try await model.loadProject(id: projectID, in: workspace); refreshError = nil }
        catch { if sessionIsCurrent { refreshError = error.localizedDescription } }
    }

    private func invalidateSession() {
        guard loadedDraft, !sessionIsCurrent else { return }
        if !draftLoadFailed && !cleanupComplete { try? model.drafts.retainForRecovery(pending, ownerID: draftOwnerID, resourceKey: resourceKey) }
        cleanupComplete = true
        pending = PendingCardDraft(draft: CardDraft(columnId: ""), key: UUID().uuidString)
        latest = nil
        createdCard = nil
        replacingDraft = false
        persistenceError = nil
        refreshError = nil
        errorMessage = nil
        close()
    }

    private func persist() {
        guard sessionIsCurrent, !draftLoadFailed, !cleanupComplete else { return }
        do {
            try model.drafts.save(pending, ownerID: draftOwnerID, resourceKey: resourceKey)
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

    private func reviewConflict() async {
        guard sessionIsCurrent, let id = pending.draft.id, !reviewingConflict else { return }
        reviewingConflict = true
        defer { reviewingConflict = false }
        do {
            try await model.loadProject(id: projectID, in: workspace)
            guard sessionIsCurrent else { return }
            latest = model.project(id: projectID, in: workspace)?.cards.first { $0.id == id }
            if latest == nil { errorMessage = "This Card is no longer available. Your local draft is retained." }
        } catch {
            guard sessionIsCurrent else { return }
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
            else { errorMessage = error.localizedDescription }
        }
    }

    private func save() async {
        guard sessionIsCurrent, !saving, !draftLoadFailed else { return }
        saving = true
        defer { saving = false }
        if cleanupComplete { close(); return }
        if pending.confirmed != nil { cleanupConfirmedDraft(); return }
        guard !isReadOnly, pending.requiresConflictReview != true else { return }
        let retryingUncertainRequest = pending.submitted != nil
        if pending.submitted == nil {
            if let project = model.project(id: projectID, in: workspace) {
                let oldColumn = project.cards.first { $0.id == pending.draft.id }?.columnId
                if pending.draft.id == nil || oldColumn != pending.draft.columnId {
                    pending.draft.position = (project.cards.filter { $0.columnId == pending.draft.columnId && $0.id != pending.draft.id }.map(\.position).max() ?? -1) + 1
                }
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
                onConfirmed: { recordConfirmation() },
                onSavedCard: { saved in
                    guard sessionIsCurrent, card == nil else { return }
                    createdCard = saved
                    pending.confirmed?.createdCard = saved
                    persist()
                },
                onRefreshFailure: { message in reportRefreshFailure(message) })
        } catch {
            guard sessionIsCurrent else { return }
            if pending.confirmed != nil { reportRefreshFailure(error.localizedDescription); cleanupConfirmedDraft(); return }
            if model.isConflict(error), pending.draft.id != nil {
                pending.submitted = nil
                pending.requiresConflictReview = true
                pending.key = UUID().uuidString
                persist()
                await reviewConflict()
                return
            } else if let apiError = error as? APIError, let status = apiError.statusCode, status < 500, status != 408 {
                pending.submitted = nil
                pending.key = UUID().uuidString
            }
            persist()
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
            else { errorMessage = error.localizedDescription }
            return
        }
        guard sessionIsCurrent else { return }
        cleanupConfirmedDraft()
    }

    private func cleanupConfirmedDraft() {
        guard sessionIsCurrent, pending.confirmed != nil else { return }
        if !receiptPersisted { persist() }
        guard receiptPersisted else { return }
        do {
            try model.drafts.remove(ownerID: draftOwnerID, resourceKey: resourceKey)
            cleanupComplete = true
            if refreshError == nil || onRefreshFailure != nil { close() }
            if let createdCard, !creationRevealed {
                creationRevealed = true
                onCreated?(createdCard)
            }
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
    var requiresConflictReview: Bool?
}

struct ProjectEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let workspace: Workspace
    var project: Project? = nil
    let onRefreshFailure: ((String) -> Void)?
    @State private var pending: PendingProjectDraft
    @State private var saving = false
    @State private var loadedDraft = false
    @State private var draftOwnerID = ""
    @State private var draftSessionID: UUID?
    @State private var draftLoadFailed = false
    @State private var errorMessage: String?
    @State private var latest: Project?
    @State private var replacingDraft = false
    @State private var reviewingConflict = false
    @State private var persistenceFailed = false
    @State private var discarding = false
    @State private var receiptPersisted = false
    @State private var cleanupComplete = false
    @State private var recoveredDraft = false
    @State private var persistenceError: String?
    @State private var refreshError: String?

    init(workspace: Workspace, project: Project? = nil, onRefreshFailure: ((String) -> Void)? = nil) {
        self.workspace = workspace
        self.project = project
        self.onRefreshFailure = onRefreshFailure
        _pending = State(initialValue: PendingProjectDraft(draft: Self.metadataDraft(project), key: UUID().uuidString))
    }

    private static func metadataDraft(_ project: Project?) -> ProjectDraft {
        guard let project else { return ProjectDraft() }
        var draft = ProjectDraft(project: project)
        draft.columns = nil
        draft.archivedAt = nil
        return draft
    }

    private var resourceKey: String { "workspace:\(workspace.id):project:\(project?.id ?? "new"):metadata" }
    private var hasProminentDraftStatus: Bool { recoveredDraft || persistenceError != nil }
    private var requiredCreationName: String? { project == nil ? model.requiredProjectCreationName : nil }
    private var creationNameIsValid: Bool {
        requiredCreationName.map { pending.draft.name == $0 } ?? true
    }

    private var sessionIsCurrent: Bool {
        loadedDraft && model.signedIn && model.ownerID == draftOwnerID && model.sessionID == draftSessionID
    }

    private var isReadOnly: Bool {
        guard let id = project?.id else { return !model.canCreateProject(in: workspace) }
        guard model.canEditProject(id: id, in: workspace) else { return true }
        guard let current = model.project(id: id, in: workspace) else { return true }
        return current.archivedAt != nil
    }

    var body: some View {
        NavigationStack {
            Form {
                if hasProminentDraftStatus { draftStatus }
                if saving { Section { ProgressView(pending.confirmed == nil ? "Saving Project…" : "Project saved. Finishing…") } }
                else if pending.confirmed != nil { Section { Text(cleanupComplete ? "Project saved." : "Project saved. Finish removing the local draft.") } }
                else if pending.submitted != nil { Section { Text("The save result is uncertain. Retry the same save to confirm whether it reached the server.") } }
                refreshStatus
                if isReadOnly && pending.confirmed == nil { Section { Text(project.map { model.canEditProject(id: $0.id, in: workspace) } ?? model.canCreateProject(in: workspace)
                    ? "This Project is unavailable or archived. Restore it before editing; your local draft is retained."
                    : "This board is read-only in this session. Your local draft is retained.") } }
                Section {
                    TextField("Name (required)", text: $pending.draft.name).accessibilityIdentifier("project-name")
                } header: {
                    Text(workspace.name)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } footer: {
                    if let name = requiredCreationName {
                        Text("Only a board named “\(name)” can be created in this verification session.")
                    }
                    if !hasProminentDraftStatus && pending.confirmed == nil {
                        Text("Cancel keeps a draft on this Mac. Discard Draft removes it.")
                            .accessibilityIdentifier("editor.draft-status")
                    }
                }
                .disabled(saving || draftLoadFailed || isReadOnly || pending.submitted != nil || pending.confirmed != nil)
                if pending.requiresConflictReview == true {
                    Section("Review saved changes") {
                        Text("This Project changed after your draft began. Your draft is above; the saved values are below. Keeping your draft means the next save replaces both Name and Description, including a field you did not change locally.")
                        if let latest {
                            Text("Different fields: \(ProjectDraftComparison.differingFields(pending.draft, from: latest).joined(separator: ", ")).")
                            LabeledContent("Name", value: latest.name)
                            Text(verbatim: latest.description).textSelection(.enabled)
                            LabeledContent("Revision", value: String(latest.revision))
                            Button("Keep My Draft for Next Save") {
                                guard sessionIsCurrent else { return }
                                pending.draft.revision = latest.revision
                                pending.submitted = nil
                                pending.key = UUID().uuidString
                                pending.requiresConflictReview = false
                                self.latest = nil
                                persist()
                            }.accessibilityIdentifier("project.keep-draft").disabled(isReadOnly)
                            Button("Use Saved Project…") { replacingDraft = true }
                                .accessibilityIdentifier("project.use-saved")
                        } else {
                            Button("Load Latest Saved Project") { Task { await reviewConflict() } }
                                .accessibilityIdentifier("project.load-conflict")
                        }
                    }.disabled(saving || reviewingConflict)
                }
                if pending.confirmed == nil {
                    Section { Button("Discard draft", role: .destructive) { discarding = true }.disabled(saving) }
                }
            }
            .formStyle(.grouped)
            .frame(minWidth: 480, idealWidth: 560, minHeight: 340, idealHeight: 460)
            .navigationTitle(project == nil ? "New Project" : "Edit Project")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(cleanupComplete ? "Done" : "Cancel") { persist(); if draftLoadFailed || !persistenceFailed { dismiss() } }.keyboardShortcut(.cancelAction).accessibilityIdentifier("editor.cancel").disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(confirmationLabel) { Task { await save() } }
                        .keyboardShortcut(.defaultAction).accessibilityIdentifier("editor.save")
                        .disabled(!sessionIsCurrent || saving || reviewingConflict || draftLoadFailed || (pending.confirmed == nil && (isReadOnly || !creationNameIsValid || pending.requiresConflictReview == true || pending.draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)))
                }
            }
            .interactiveDismissDisabled(saving || persistenceFailed || (pending.confirmed != nil && !receiptPersisted))
            .task {
                guard !loadedDraft, model.signedIn else { return }
                draftOwnerID = model.ownerID
                draftSessionID = model.sessionID
                loadedDraft = true
                do {
                    if let saved = try model.drafts.load(ownerID: draftOwnerID, resourceKey: resourceKey, as: PendingProjectDraft.self) {
                        pending = saved
                        recoveredDraft = true
                        receiptPersisted = saved.confirmed != nil && !model.drafts.hasRecovery(ownerID: draftOwnerID, resourceKey: resourceKey)
                    } else if project == nil, let name = model.requiredProjectCreationName {
                        pending.draft.name = name
                    }
                }
                catch { draftLoadFailed = true; errorMessage = "The retained draft could not be opened. Cancel and retry, or explicitly discard the draft. \(error.localizedDescription)" }
                if pending.requiresConflictReview == true { await reviewConflict() }
            }
            .onChange(of: model.sessionID) { _, _ in invalidateSession() }
            .onChange(of: model.signedIn) { _, signedIn in if !signedIn { invalidateSession() } }
            .onChange(of: model.ownerID) { _, _ in if !sessionIsCurrent { invalidateSession() } }
            .onChange(of: pending) { _, _ in if loadedDraft && !cleanupComplete { persist() } }
            .alert(pending.confirmed != nil ? "Unable to remove local draft" : "Unable to save Project", isPresented: Binding(get: { errorMessage != nil && sessionIsCurrent }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: { Text(errorMessage ?? "") }
            .confirmationDialog("Replace this local draft with the saved Project?", isPresented: $replacingDraft, titleVisibility: .visible) {
                Button("Replace Local Draft", role: .destructive) {
                    guard sessionIsCurrent, let latest else { return }
                    pending = PendingProjectDraft(draft: Self.metadataDraft(latest), key: UUID().uuidString)
                    self.latest = nil
                    persist()
                }
                Button("Keep Local Draft", role: .cancel) {}
            } message: {
                Text("Your local Name and Description edits will be discarded. The saved Project on the server will stay unchanged.")
            }
            .confirmationDialog("Discard this local draft?", isPresented: $discarding, titleVisibility: .visible) {
                Button("Discard draft", role: .destructive) {
                    guard sessionIsCurrent else { return }
                    do { try model.drafts.remove(ownerID: draftOwnerID, resourceKey: resourceKey); cleanupComplete = true; dismiss() }
                    catch { errorMessage = error.localizedDescription }
                }
            } message: {
                Text(pending.submitted == nil ? "The saved Project will remain unchanged." : "A previous request may already have saved changes on the server.")
            }
        }
    }

    private var confirmationLabel: String {
        if saving { return pending.confirmed == nil ? "Saving…" : "Finishing…" }
        if cleanupComplete { return "Done" }
        if pending.confirmed != nil { return "Retry Cleanup" }
        return pending.submitted == nil ? (project == nil ? "Create" : "Save") : "Retry Save"
    }

    @ViewBuilder private var draftStatus: some View {
        Section {
            Text(recoveredDraft ? "Recovered draft. Cancel retains your draft for this account; it does not change the saved Project." : "Cancel keeps a draft on this Mac without changing the saved Project. Use Discard Draft to remove it.")
                .accessibilityIdentifier("editor.draft-status")
            if let persistenceError {
                Text(persistenceError)
                DraftRecoveryActions(text: "Name: \(pending.draft.name)\n\n\(pending.draft.description)", filename: "project-draft", isActive: sessionIsCurrent) { errorMessage = $0 }
                Button("Retry Saving Local Draft") { persist() }.disabled(saving)
            }
        }
    }

    @ViewBuilder private var refreshStatus: some View {
        if let refreshError, onRefreshFailure == nil {
            Section("Saved; refresh failed") {
                Text(refreshError)
                Button("Retry Refresh") { Task { await retryRefresh() } }.disabled(saving)
            }
        }
    }

    private func recordConfirmation() {
        guard sessionIsCurrent else { return }
        pending.confirmed = ConfirmedDraftReceipt(confirmedAt: ServerTimestamp.string())
        persist()
    }

    private func reportRefreshFailure(_ message: String) {
        guard sessionIsCurrent else { return }
        refreshError = message
        onRefreshFailure?(message)
    }

    private func retryRefresh() async {
        guard sessionIsCurrent, !saving else { return }
        saving = true
        defer { saving = false }
        do {
            if let id = project?.id ?? pending.draft.id {
                try await model.loadProject(id: id, in: workspace)
            } else {
                try await model.refreshInventory(workspaceID: workspace.id, projectID: nil)
            }
            guard sessionIsCurrent else { return }
            refreshError = nil
        } catch {
            if sessionIsCurrent { refreshError = error.localizedDescription }
        }
    }

    private func invalidateSession() {
        guard loadedDraft, !sessionIsCurrent else { return }
        if !draftLoadFailed && !cleanupComplete { try? model.drafts.retainForRecovery(pending, ownerID: draftOwnerID, resourceKey: resourceKey) }
        cleanupComplete = true
        pending = PendingProjectDraft(draft: ProjectDraft(), key: UUID().uuidString)
        latest = nil
        replacingDraft = false
        persistenceError = nil
        refreshError = nil
        errorMessage = nil
        dismiss()
    }

    private func persist() {
        guard sessionIsCurrent, !draftLoadFailed, !cleanupComplete else { return }
        do {
            try model.drafts.save(pending, ownerID: draftOwnerID, resourceKey: resourceKey)
            persistenceFailed = false
            persistenceError = nil
            receiptPersisted = pending.confirmed != nil
        } catch {
            persistenceFailed = true
            persistenceError = pending.confirmed != nil
                ? "Project saved. This Mac could not record completion. Retry cleanup. \(error.localizedDescription)"
                : "This Mac could not write the draft to disk. Your text is retained in this app for your account. Copy or export it before quitting. \(error.localizedDescription)"
        }
    }

    private func reviewConflict() async {
        guard sessionIsCurrent, let id = pending.draft.id, !reviewingConflict else { return }
        reviewingConflict = true
        defer { reviewingConflict = false }
        do {
            try await model.loadProject(id: id, in: workspace)
            guard sessionIsCurrent else { return }
            latest = model.project(id: id, in: workspace)
            if latest == nil { errorMessage = "This Project is no longer available. Your local draft is retained." }
        } catch {
            guard sessionIsCurrent else { return }
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
            else { errorMessage = error.localizedDescription }
        }
    }

    private func save() async {
        guard sessionIsCurrent, !saving, !draftLoadFailed else { return }
        saving = true
        defer { saving = false }
        if cleanupComplete { dismiss(); return }
        if pending.confirmed != nil { cleanupConfirmedDraft(); return }
        guard !isReadOnly, creationNameIsValid, pending.requiresConflictReview != true else { return }
        let retryingUncertainRequest = pending.submitted != nil
        pending.submitted = pending.submitted ?? pending.draft
        persist()
        guard !persistenceFailed else {
            if !retryingUncertainRequest { pending.submitted = nil; persist() }
            return
        }
        do {
            _ = try await model.saveProject(pending.submitted!, in: workspace, key: pending.key,
                onConfirmed: { recordConfirmation() }, onRefreshFailure: { message in reportRefreshFailure(message) })
        } catch {
            guard sessionIsCurrent else { return }
            if pending.confirmed != nil { reportRefreshFailure(error.localizedDescription); cleanupConfirmedDraft(); return }
            if model.isConflict(error), pending.draft.id != nil {
                pending.submitted = nil
                pending.requiresConflictReview = true
                pending.key = UUID().uuidString
                persist()
                await reviewConflict()
                return
            } else if let status = (error as? APIError)?.statusCode, status < 500, status != 408 {
                pending.submitted = nil
                pending.key = UUID().uuidString
            }
            persist()
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
            else { errorMessage = error.localizedDescription }
            return
        }
        guard sessionIsCurrent else { return }
        cleanupConfirmedDraft()
    }

    private func cleanupConfirmedDraft() {
        guard sessionIsCurrent, pending.confirmed != nil else { return }
        if !receiptPersisted { persist() }
        guard receiptPersisted else { return }
        do {
            try model.drafts.remove(ownerID: draftOwnerID, resourceKey: resourceKey)
            cleanupComplete = true
            if refreshError == nil || onRefreshFailure != nil { dismiss() }
        } catch {
            errorMessage = "Project saved. The local draft could not be removed. Retry cleanup. \(error.localizedDescription)"
        }
    }
}

struct PendingCommentDraft: Codable, Equatable {
    var body = ""
    var key = UUID().uuidString
    var submitted: String?
    var confirmed: ConfirmedDraftReceipt?
}

struct CommentEditor: View {
    enum Presentation: Equatable { case sheet, inline }
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let workspace: Workspace
    let projectID: String
    let cardID: String
    var onRefreshFailure: ((String) -> Void)? = nil
    var presentation: Presentation = .sheet
    var focusRequest: UUID? = nil
    var onClose: (() -> Void)? = nil
    var onInteractionLockChanged: ((Bool) -> Void)? = nil
    @FocusState private var commentFocused: Bool
    @State private var pending = PendingCommentDraft()
    @State private var saving = false
    @State private var loadedDraft = false
    @State private var draftOwnerID = ""
    @State private var draftSessionID: UUID?
    @State private var draftLoadFailed = false
    @State private var persistenceFailed = false
    @State private var errorMessage: String?
    @State private var discarding = false
    @State private var receiptPersisted = false
    @State private var cleanupComplete = false
    @State private var recoveredDraft = false
    @State private var persistenceError: String?
    @State private var refreshError: String?
    private var resourceKey: String { "workspace:\(workspace.id):project:\(projectID):card:\(cardID):comment" }
    private var hasProminentDraftStatus: Bool { recoveredDraft || persistenceError != nil }

    private var sessionIsCurrent: Bool {
        loadedDraft && model.signedIn && model.ownerID == draftOwnerID && model.sessionID == draftSessionID
    }

    private var isReadOnly: Bool {
        guard model.canEditProject(id: projectID, in: workspace) else { return true }
        guard let project = model.project(id: projectID, in: workspace), project.archivedAt == nil,
              let current = project.cards.first(where: { $0.id == cardID }) else { return true }
        return current.archivedAt != nil
    }

    private var interactionLocked: Bool {
        saving || persistenceFailed || discarding || errorMessage != nil
            || (pending.confirmed != nil && !receiptPersisted)
    }
    private var submissionDisabled: Bool {
        !sessionIsCurrent || saving || draftLoadFailed
            || (pending.confirmed == nil && (isReadOnly || pending.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
    }
    private var editingDisabled: Bool {
        saving || draftLoadFailed || isReadOnly || pending.submitted != nil || pending.confirmed != nil
    }

    var body: some View {
        Group {
            if presentation == .inline { inlineEditor }
            else { sheetEditor }
        }
        .interactiveDismissDisabled(saving || persistenceFailed || (pending.confirmed != nil && !receiptPersisted))
        .task {
            guard !loadedDraft, model.signedIn else { return }
            draftOwnerID = model.ownerID
            draftSessionID = model.sessionID
            loadedDraft = true
            do {
                if let saved = try model.drafts.load(ownerID: draftOwnerID, resourceKey: resourceKey, as: PendingCommentDraft.self) {
                    pending = saved
                    recoveredDraft = true
                    receiptPersisted = saved.confirmed != nil && !model.drafts.hasRecovery(ownerID: draftOwnerID, resourceKey: resourceKey)
                }
            }
            catch { draftLoadFailed = true; errorMessage = "The retained draft could not be opened. Cancel and retry, or explicitly discard the draft. \(error.localizedDescription)" }
            if presentation == .inline { commentFocused = true }
        }
        .onChange(of: focusRequest) { _, _ in if presentation == .inline { commentFocused = true } }
        .onChange(of: interactionLocked, initial: true) { _, locked in onInteractionLockChanged?(locked) }
        .onDisappear {
            persist()
            onInteractionLockChanged?(false)
        }
        .onChange(of: model.sessionID) { _, _ in invalidateSession() }
        .onChange(of: model.signedIn) { _, signedIn in if !signedIn { invalidateSession() } }
        .onChange(of: model.ownerID) { _, _ in if !sessionIsCurrent { invalidateSession() } }
        .onChange(of: pending) { _, _ in if loadedDraft && !cleanupComplete { persist() } }
        .alert(pending.confirmed != nil ? "Unable to remove local draft" : "Unable to add Comment", isPresented: Binding(get: { errorMessage != nil && sessionIsCurrent }, set: { if !$0 { errorMessage = nil } })) {
            Button("OK", role: .cancel) { errorMessage = nil }
        } message: { Text(errorMessage ?? "") }
        .confirmationDialog("Discard this local draft?", isPresented: $discarding, titleVisibility: .visible) {
            Button("Discard draft", role: .destructive) {
                guard sessionIsCurrent else { return }
                do { try model.drafts.remove(ownerID: draftOwnerID, resourceKey: resourceKey); cleanupComplete = true; finish() }
                catch { errorMessage = error.localizedDescription }
            }
        } message: {
            Text(pending.submitted == nil ? "The saved Card will remain unchanged." : "A previous request may already have added the Comment on the server.")
        }
    }

    private var sheetEditor: some View {
        NavigationStack {
            Form {
                if hasProminentDraftStatus { draftStatus }
                if saving { Section { ProgressView(pending.confirmed == nil ? "Adding Comment…" : "Comment added. Finishing…") } }
                else if pending.confirmed != nil { Section { Text(cleanupComplete ? "Comment added." : "Comment added. Finish removing the local draft.") } }
                else if pending.submitted != nil { Section { Text("The Comment result is uncertain. Retry the same Comment to confirm whether it reached the server.") } }
                refreshStatus
                if isReadOnly && pending.confirmed == nil {
                    Section { Text(model.canEditProject(id: projectID, in: workspace)
                        ? "This Card is unavailable or archived, or its Project is archived. Your local draft is retained."
                        : "This board is read-only in this session. Your local draft is retained.") }
                }
                Section {
                    commentBody.frame(minHeight: 180)
                } header: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Comment (required)")
                        Text(model.project(id: projectID, in: workspace)?.cards.first(where: { $0.id == cardID })?.title ?? "Unavailable Card")
                        Text("\(model.project(id: projectID, in: workspace)?.name ?? "Unavailable") · \(workspace.name)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } footer: {
                    if !hasProminentDraftStatus && pending.confirmed == nil {
                        Text("Cancel keeps a draft on this Mac. Discard Draft removes it.")
                            .accessibilityIdentifier("editor.draft-status")
                    }
                }.disabled(editingDisabled)
                if pending.confirmed == nil {
                    Section {
                        Button("Discard draft", role: .destructive) { discarding = true }
                            .accessibilityIdentifier("comment.discard").disabled(saving)
                    }
                }
            }
            .formStyle(.grouped)
            .frame(minWidth: 480, idealWidth: 560, minHeight: 380, idealHeight: 480)
            .navigationTitle("Add Comment")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { cancelButton }
                ToolbarItem(placement: .confirmationAction) {
                    submitButton.keyboardShortcut(.defaultAction)
                }
            }
        }
    }

    private var inlineEditor: some View {
        VStack(alignment: .leading, spacing: 10) {
            if hasProminentDraftStatus { draftStatusContent }
            if saving { ProgressView(pending.confirmed == nil ? "Adding Comment…" : "Comment added. Finishing…") }
            else if pending.confirmed != nil { Text(cleanupComplete ? "Comment added." : "Comment added. Finish removing the local draft.") }
            else if pending.submitted != nil { Text("The Comment result is uncertain. Retry the same Comment to confirm whether it reached the server.") }
            if let refreshError, onRefreshFailure == nil {
                Text("Comment added; refresh failed.").font(.headline)
                Text(refreshError)
                Button("Retry Refresh") { Task { await retryRefresh() } }.disabled(saving)
            }
            if isReadOnly && pending.confirmed == nil {
                Text("This Card is read-only. Your local draft is retained.")
            }
            Text("Comment (required)").font(.subheadline)
            commentBody.frame(minHeight: 120, idealHeight: 140, maxHeight: 180)
                .disabled(editingDisabled)
            if !hasProminentDraftStatus && pending.confirmed == nil {
                Text("Cancel keeps a draft on this Mac. Discard Draft removes it.")
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("editor.draft-status")
            }
            HStack {
                if pending.confirmed == nil {
                    Button("Discard draft", role: .destructive) { discarding = true }
                        .accessibilityIdentifier("comment.discard").disabled(saving)
                }
                Spacer(minLength: 8)
                cancelButton
                submitButton.keyboardShortcut(.return, modifiers: .command)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Add Comment")
        .accessibilityIdentifier("card.comment-composer.\(cardID)")
    }

    private var commentBody: some View {
        TextEditor(text: $pending.body)
            .focused($commentFocused)
            .accessibilityLabel("Comment")
            .accessibilityIdentifier("comment.body")
    }

    private var cancelButton: some View {
        Button(cleanupComplete ? "Done" : "Cancel") {
            persist()
            if draftLoadFailed || !persistenceFailed { finish() }
        }
        .keyboardShortcut(.cancelAction)
        .accessibilityIdentifier(presentation == .inline ? "comment.cancel" : "editor.cancel")
        .disabled(saving)
    }

    private var submitButton: some View {
        Button(confirmationLabel) { Task { await send() } }
            .accessibilityIdentifier("comment.save")
            .disabled(submissionDisabled)
    }

    private func finish() {
        commentFocused = false
        if presentation == .inline { onClose?() }
        else { dismiss() }
    }

    private var confirmationLabel: String {
        if saving { return pending.confirmed == nil ? "Adding…" : "Finishing…" }
        if cleanupComplete { return "Done" }
        if pending.confirmed != nil { return "Retry Cleanup" }
        return pending.submitted == nil ? ("Add Comment") : "Retry Comment"
    }

    private var draftStatus: some View {
        Section { draftStatusContent }
    }

    @ViewBuilder private var draftStatusContent: some View {
        Text(recoveredDraft ? "Recovered draft. Cancel retains your draft for this account; it does not add a Comment." : "Cancel keeps a draft on this Mac without adding a Comment. Use Discard Draft to remove it.")
            .accessibilityIdentifier("editor.draft-status")
        if let persistenceError {
            Text(persistenceError)
            DraftRecoveryActions(text: pending.body, filename: "comment-draft", isActive: sessionIsCurrent) { errorMessage = $0 }
            Button("Retry Saving Local Draft") { persist() }.disabled(saving)
        }
}

    @ViewBuilder private var refreshStatus: some View {
        if let refreshError, onRefreshFailure == nil {
            Section("Saved; refresh failed") {
                Text(refreshError)
                Button("Retry Refresh") { Task { await retryRefresh() } }.disabled(saving)
            }
        }
    }

    private func recordConfirmation() {
        guard sessionIsCurrent else { return }
        pending.confirmed = ConfirmedDraftReceipt(confirmedAt: ServerTimestamp.string())
        persist()
    }

    private func reportRefreshFailure(_ message: String) {
        guard sessionIsCurrent else { return }
        refreshError = message
        onRefreshFailure?(message)
    }

    private func retryRefresh() async {
        guard sessionIsCurrent, !saving else { return }
        saving = true
        defer { saving = false }
        do { try await model.loadProject(id: projectID, in: workspace); refreshError = nil }
        catch { if sessionIsCurrent { refreshError = error.localizedDescription } }
    }

    private func invalidateSession() {
        guard loadedDraft, !sessionIsCurrent else { return }
        if !draftLoadFailed && !cleanupComplete { try? model.drafts.retainForRecovery(pending, ownerID: draftOwnerID, resourceKey: resourceKey) }
        cleanupComplete = true
        pending = PendingCommentDraft()
        persistenceError = nil
        refreshError = nil
        errorMessage = nil
        finish()
    }

    private func persist() {
        guard sessionIsCurrent, !draftLoadFailed, !cleanupComplete else { return }
        do {
            try model.drafts.save(pending, ownerID: draftOwnerID, resourceKey: resourceKey)
            persistenceFailed = false
            persistenceError = nil
            receiptPersisted = pending.confirmed != nil
        } catch {
            persistenceFailed = true
            persistenceError = pending.confirmed != nil
                ? "Comment added. This Mac could not record completion. Retry cleanup. \(error.localizedDescription)"
                : "This Mac could not write the draft to disk. Your text is retained in this app for your account. Copy or export it before quitting. \(error.localizedDescription)"
        }
    }

    private func send() async {
        guard sessionIsCurrent, !saving, !draftLoadFailed else { return }
        saving = true
        defer { saving = false }
        if cleanupComplete { finish(); return }
        if pending.confirmed != nil { cleanupConfirmedDraft(); return }
        guard !isReadOnly else { return }
        let retryingUncertainRequest = pending.submitted != nil
        pending.submitted = pending.submitted ?? pending.body
        persist()
        guard !persistenceFailed else {
            if !retryingUncertainRequest { pending.submitted = nil; persist() }
            return
        }
        do {
            try await model.addComment(pending.submitted!, cardID: cardID, projectID: projectID, in: workspace, key: pending.key,
                onConfirmed: { recordConfirmation() }, onRefreshFailure: { message in reportRefreshFailure(message) })
        } catch {
            guard sessionIsCurrent else { return }
            if pending.confirmed != nil { reportRefreshFailure(error.localizedDescription); cleanupConfirmedDraft(); return }
            if let status = (error as? APIError)?.statusCode, status < 500, status != 408 { pending.submitted = nil; pending.key = UUID().uuidString }
            persist()
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
            else { errorMessage = error.localizedDescription }
            return
        }
        guard sessionIsCurrent else { return }
        cleanupConfirmedDraft()
    }

    private func cleanupConfirmedDraft() {
        guard sessionIsCurrent, pending.confirmed != nil else { return }
        if !receiptPersisted { persist() }
        guard receiptPersisted else { return }
        do {
            try model.drafts.remove(ownerID: draftOwnerID, resourceKey: resourceKey)
            cleanupComplete = true
            if refreshError == nil || onRefreshFailure != nil { finish() }
        } catch {
            errorMessage = "Comment added. The local draft could not be removed. Retry cleanup. \(error.localizedDescription)"
        }
    }
}

struct SavedCardValues: View {
    let card: Card
    let columns: [Column]
    var body: some View {
        LabeledContent("Title", value: card.title)
        LabeledContent("Column", value: columns.first { $0.id == card.columnId }?.name ?? "Unavailable")
        LabeledContent("Next actor", value: card.nextActor?.label ?? "Unassigned")
        LabeledContent("Priority", value: card.priority?.rawValue ?? "Unset")
        LabeledContent("Next action", value: card.nextAction.isEmpty ? "No next action yet" : card.nextAction)
        LabeledContent("Blocker", value: card.blockedReason.isEmpty ? "None" : card.blockedReason)
        Text(verbatim: card.body).textSelection(.enabled).accessibilityLabel("Latest saved description")
        LabeledContent("Version", value: String(card.version))
    }
}


enum CardDraftComparison {
    static func differingFields(_ draft: CardDraft, from card: Card) -> [String] {
        var fields: [String] = []
        if draft.title != card.title { fields.append("Title") }
        if draft.body != card.body { fields.append("Description") }
        if draft.columnId != card.columnId { fields.append("Column") }
        if draft.nextActor != card.nextActor { fields.append("Next actor") }
        if draft.priority != card.priority { fields.append("Priority") }
        if draft.nextAction != card.nextAction { fields.append("Next action") }
        if draft.blockedReason != card.blockedReason { fields.append("Blocker") }
        return fields.isEmpty ? ["None"] : fields
    }
}

enum ProjectDraftComparison {
    static func differingFields(_ draft: ProjectDraft, from project: Project) -> [String] {
        var fields: [String] = []
        if draft.name != project.name { fields.append("Name") }
        if draft.description != project.description { fields.append("Description") }
        return fields.isEmpty ? ["None"] : fields
    }
}

struct DraftRecoveryActions: View {
    let text: String
    let filename: String
    let isActive: Bool
    let onError: (String) -> Void
    @State private var exporting = false
    @State private var copied = false

    var body: some View {
        HStack {
            Button(copied ? "Copied" : "Copy Draft") {
                NSPasteboard.general.clearContents()
                if NSPasteboard.general.setString(text, forType: .string) { copied = true }
                else { onError("The draft could not be copied. Try again or export it to a file.") }
            }
            Button("Export Draft…") { exporting = true }
        }
        .disabled(!isActive)
        .onChange(of: text) { _, _ in copied = false }
        .onChange(of: isActive) { _, active in if !active { exporting = false } }
        .fileExporter(isPresented: $exporting, document: DraftTextDocument(text: text), contentType: .plainText, defaultFilename: filename) { result in
            if case .failure(let error) = result { onError("The draft could not be exported. \(error.localizedDescription)") }
        }
    }
}

private struct DraftTextDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.plainText]
    var text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws {
        text = String(decoding: configuration.file.regularFileContents ?? Data(), as: UTF8.self)
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}
