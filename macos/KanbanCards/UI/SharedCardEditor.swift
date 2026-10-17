import SwiftUI

struct SharedCardEditorView: View {
    @Environment(\.isEnabled) private var isEnabled
    @Bindable var session: SharedCardEditingSession
    var presentation: CardEditor.Presentation
    var onInteractionLockChanged: ((Bool) -> Void)? = nil
    var cardEditingDisabled = false
    var additionalContent: AnyView? = nil
    var additionalContentFocusRequest: UUID? = nil
    @State private var confirmingRevert = false
    @State private var confirmingAlternativeRemoval = false

    private var commandsEnabled: Bool {
        isEnabled && !cardEditingDisabled && !confirmingRevert && !confirmingAlternativeRemoval
    }

    private var interactionLocked: Bool {
        session.interactionLocked || confirmingRevert || confirmingAlternativeRemoval
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                if session.isDirty { Text("Unsaved changes").font(.caption).foregroundStyle(.secondary) }
                else if let savedMessage = session.savedMessage { Text(savedMessage).font(.caption).foregroundStyle(.secondary) }
                Spacer(minLength: 8)
                Button("Revert") { confirmingRevert = true }
                    .disabled(!commandsEnabled || !session.canRevert)
                    .accessibilityIdentifier("editor.revert")
                Button(session.confirmationLabel) { Task { await session.save() } }
                    .disabled(!commandsEnabled || !session.canSave)
                    .accessibilityIdentifier("editor.save")
            }
            .padding()
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Card edit controls")
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        editorForm
                        if let additionalContent {
                            additionalContent
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id("card-comments")
                                .task(id: additionalContentFocusRequest) {
                                    guard additionalContentFocusRequest != nil else { return }
                                    proxy.scrollTo("card-comments", anchor: .bottom)
                                }
                        }
                    }
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityIdentifier("card.contents-scroll.\(session.cardID)")
            }
        }
        .frame(minWidth: presentation == .inline ? 320 : 500, maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Card")
        .accessibilityIdentifier("card.inline-editor.\(session.cardID)")
        .focusedSceneValue(\.cardDraftActions, CardDraftActions(
            canSave: commandsEnabled && session.canSave, canRevert: commandsEnabled && session.canRevert,
            save: {
                guard commandsEnabled, session.canSave else { return }
                Task { await session.save() }
            },
            revert: { if commandsEnabled && session.canRevert { confirmingRevert = true } }))
        .onChange(of: interactionLocked, initial: true) { _, locked in onInteractionLockChanged?(locked) }
        .onDisappear { onInteractionLockChanged?(false) }
        .task {
            if session.pending.confirmed != nil { await session.retryRefresh() }
            else if session.pending.requiresConflictReview == true { await session.reviewConflict() }
        }
        .confirmationDialog("Revert changes to this Card?", isPresented: $confirmingRevert, titleVisibility: .visible) {
            Button("Revert Changes", role: .destructive) { Task { await session.revert() } }
                .accessibilityIdentifier("editor.revert-confirm")
            Button("Keep Changes", role: .cancel) {}
        } message: {
            Text(session.pending.submitted == nil
                ? "Your unsaved edits and other retained drafts for this Card will be replaced by the latest saved values in every open view."
                : "A previous request may already have saved changes. Revert loads the latest saved Card and removes the local draft in every open view.")
        }
        .confirmationDialog("Remove the other retained drafts?", isPresented: $confirmingAlternativeRemoval, titleVisibility: .visible) {
            Button("Keep Current Draft and Remove Others", role: .destructive) { session.keepCurrentDraftRemovingAlternatives() }
                .accessibilityIdentifier("editor.keep-current-confirm")
            Button("Keep All Drafts", role: .cancel) {}
        } message: {
            Text("The draft shown in this editor will remain. The other retained local drafts will be removed without changing the saved Card.")
        }
    }

    private var editorForm: some View {
        Form {
            if session.saving {
                Section { ProgressView(session.pending.confirmed == nil ? "Saving Card…" : "Card saved. Finishing…") }
            } else if session.pending.confirmed != nil {
                Section { Text("Card saved. Finish recording the saved values before continuing.") }
            } else if session.pending.submitted != nil {
                Section { Text("The save result is uncertain. Retry the same save to confirm whether it reached the server.") }
            }
            if session.recoveredDraft {
                Section {
                    Text("Recovered draft. Edits are shared across this Card's open views and stay on this Mac until you save or revert.")
                        .accessibilityIdentifier("editor.draft-status")
                }
            }
            if let persistenceError = session.persistenceError {
                Section("Local draft") {
                    Text(persistenceError)
                    DraftRecoveryActions(text: session.recoveryText, filename: "card-draft", isActive: session.sessionIsCurrent) { session.errorMessage = $0 }
                    Button("Retry Saving Local Draft") { session.persist() }.disabled(session.saving)
                }
            }
            if let errorMessage = session.errorMessage {
                Section {
                    Text(errorMessage).textSelection(.enabled).accessibilityIdentifier("editor.error")
                    if session.draftLoadFailed {
                        Button("Retry Loading Draft") { session.retryLoading() }
                            .accessibilityIdentifier("editor.retry-draft")
                    } else {
                        Button("Dismiss") { session.errorMessage = nil }
                    }
                }
            }
            if let refreshError = session.refreshError {
                Section("Saved; refresh failed") {
                    Text(refreshError)
                    Button("Retry Refresh") { Task { await session.retryRefresh() } }.disabled(session.saving)
                        .accessibilityIdentifier("editor.retry-refresh")
                }
            }
            if !session.alternatives.isEmpty {
                Section("Other retained drafts") {
                    Text("Different local drafts were recovered from earlier views. Choose the draft you want to keep, then remove the others before saving.")
                    ForEach(session.alternatives) { alternative in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(alternative.label).font(.headline)
                            Text(alternative.pending.draft.title)
                            Text(alternative.pending.draft.body).lineLimit(4).textSelection(.enabled)
                            Button("Use This Draft") { session.useAlternative(id: alternative.id) }
                                .accessibilityIdentifier("editor.use-alternative.\(alternative.id)")
                        }
                    }
                    Button("Keep Current Draft and Remove Others…") { confirmingAlternativeRemoval = true }
                        .accessibilityIdentifier("editor.keep-current")
                }.disabled(session.saving || session.reviewingConflict)
            }
            if session.isReadOnly {
                Section { Text("This Card or its Project is unavailable, archived, or read-only. Your local draft is retained.") }
            }
            Section {
                TextField("Title (required)", text: $session.pending.draft.title)
                    .accessibilityIdentifier("editor.title")
                Picker("Column", selection: $session.pending.draft.columnId) {
                    if !session.columns.contains(where: { $0.id == session.pending.draft.columnId }) {
                        Text(session.pending.draft.columnId.isEmpty ? "Choose a Column" : "Unavailable Column")
                            .tag(session.pending.draft.columnId)
                    }
                    ForEach(session.columns) { Text($0.name).tag($0.id) }
                }
                Picker("Next actor", selection: $session.pending.draft.nextActor) {
                    Text("Unassigned").tag(CardNextActor?.none)
                    ForEach(CardNextActor.allCases) { Text($0.label).tag(Optional($0)) }
                }
                Picker("Priority", selection: $session.pending.draft.priority) {
                    Text("Unset").tag(CardPriority?.none)
                    ForEach(CardPriority.allCases) { Text($0.rawValue).tag(Optional($0)) }
                }
                TextField("Next action", text: $session.pending.draft.nextAction, axis: .vertical)
                TextField("Blocker", text: $session.pending.draft.blockedReason, axis: .vertical)
                if session.columns.isEmpty {
                    Text("This Project has no available Columns. Refresh the Project before saving.")
                        .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("editor.validation")
                } else if !session.columns.contains(where: { $0.id == session.pending.draft.columnId }) {
                    Text("The Column in this draft is unavailable. Choose an available Column before saving.")
                        .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("editor.validation")
                }
            } header: {
                Text("Card")
            }
            .disabled(session.editingDisabled || cardEditingDisabled)
            Section("Description") {
                TextEditor(text: $session.pending.draft.body)
                    .frame(minHeight: 180)
                    .accessibilityLabel("Description")
                    .accessibilityIdentifier("editor.body")
            }.disabled(session.editingDisabled || cardEditingDisabled)
            if session.pending.requiresConflictReview == true {
                Section("Review saved changes") {
                    Text("This Card changed after your draft began. Your draft is above; the saved values are below. Keeping your draft means the next save replaces every editable field, including fields you did not change locally.")
                    if let latest = session.latest {
                        Text("Different fields: \(CardDraftComparison.differingFields(session.pending.draft, from: latest).joined(separator: ", ")).")
                        SavedCardValues(card: latest, columns: session.columns)
                        Button("Keep My Draft for Next Save") { session.keepDraftForNextSave() }
                            .accessibilityIdentifier("editor.keep-draft").disabled(session.isReadOnly)
                        Button("Use Saved Card…") { confirmingRevert = true }
                            .accessibilityIdentifier("editor.use-saved")
                    } else {
                        Button("Load Latest Saved Card") { Task { await session.reviewConflict() } }
                            .accessibilityIdentifier("editor.load-conflict")
                    }
                }.disabled(session.saving || session.reviewingConflict)
            }
        }
        .formStyle(.columns)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }
}
