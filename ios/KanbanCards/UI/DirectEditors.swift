import SwiftUI
import UIKit

struct DirectCardForm: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Bindable var session: CardEditingSession
    @State private var confirmingRevert = false
    @State private var archiving = false
    private var columns: [Column] { (model.loadedProjects[session.projectID]?.columns ?? []).sorted { $0.position < $1.position } }
    private var frozen: Bool { session.busy || session.unresolvedOperation || session.pending.confirmed != nil || session.readOnly }

    var body: some View {
        Form {
            if session.projectReadOnly {
                Section {
                    Text("Archived Project. This Card is read-only. Confirming a retained draft protects it on this iPhone without changing server data.")
                        .accessibilityIdentifier("archive.notice")
                }
            }
            if session.loadFailed {
                Section("Retained draft could not be opened") {
                    Text("The original record is unchanged. Retry reading before editing or saving.")
                    Button("Retry reading retained draft") { session.retryLoading() }
                    if let text = session.retainedRecordText {
                        Button("Copy retained record") { UIPasteboard.general.string = text }
                        ShareLink("Export retained record", item: text)
                    }
                }
            }
            if session.legacyNeedsScope {
                Section("Confirm retained draft Workspace") {
                    Text("This older draft did not record its Workspace. Confirm this is its original Workspace before editing or retrying any request.")
                    Text(session.workspace.url.absoluteString).textSelection(.enabled)
                    if session.projectReadOnly {
                        LabeledContent("Project", value: model.loadedProjects[session.projectID]?.name ?? session.projectID)
                        LabeledContent("Saved Card", value: session.latest.title)
                    }
                    Button("This is the original Workspace") { session.recoverLegacy() }
                        .disabled(session.pending.draft.id != session.cardID)
                    Button("Copy retained draft") { UIPasteboard.general.string = String(decoding: (try? JSONEncoder().encode(session.pending)) ?? Data(), as: UTF8.self) }
                    ShareLink("Export retained draft", item: String(decoding: (try? JSONEncoder().encode(session.pending)) ?? Data(), as: UTF8.self))
                }
            }
            Section {
                Text(session.loadFailed ? "Retained draft unavailable" : session.pending.confirmed != nil ? "Saved; local cleanup pending" : session.unresolvedOperation ? "Outcome unconfirmed" : session.dirty ? "Local draft" : "Saved")
                    .accessibilityIdentifier("card.editing-state")
                if let message = session.message { Text(message).textSelection(.enabled) }
                if session.latest.archivedAt != nil && !session.projectReadOnly { Text("Archived. Restore before editing; local text is retained.") }
                if session.unavailable { Text("Unavailable. Local recovery does not recreate the resource.") }
                if let requested = session.pending.move {
                    LabeledContent("Requested Column", value: columns.first { $0.id == requested.columnId }?.name ?? requested.columnId)
                    Text("The requested destination is not confirmed. Saved placement is shown below.")
                }
                if session.unresolvedOperation && !session.legacyNeedsScope && !session.projectReadOnly {
                    Button("Reconcile saved values") { Task { await session.save() } }.disabled(session.busy)
                }
                if session.pending.confirmed != nil && !session.legacyNeedsScope && !session.projectReadOnly {
                    Button("Retry cleanup") { Task { await session.save() } }.disabled(session.busy)
                }
            }
            if !session.loadFailed && (session.persistenceFailed || (session.readOnly && session.dirty)) {
                Section(session.persistenceFailed ? "Local draft protection failed" : "Local draft recovery") {
                    if session.persistenceFailed {
                        Text("The newest text remains in this app while it stays open. Relaunch can recover only data successfully written to this iPhone.")
                        Button("Retry local protection") { session.persist() }
                    } else { Text("The resource is read-only. Copy or export the retained local draft without changing server data.") }
                    Button("Copy draft") { UIPasteboard.general.string = session.recoveryText }
                    ShareLink("Export draft", item: session.recoveryText)
                }
            }
            Section("Card") {
                TextField("Title", text: $session.pending.draft.title).accessibilityIdentifier("card-title")
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
            }.disabled(frozen)
            Section("Description") {
                TextEditor(text: $session.pending.draft.body)
                    .accessibilityLabel("Description").accessibilityIdentifier("card-description")
            }.disabled(frozen)
            Section("Column") {
                LabeledContent("Saved Column", value: columns.first { $0.id == session.latest.columnId }?.name ?? session.latest.columnId)
                Menu("Move") {
                    ForEach(columns.filter { $0.id != session.latest.columnId }) { column in
                        Button("Move to \(column.name)") { Task { await session.move(to: column.id) } }
                    }
                }.disabled(session.busy || session.readOnly || session.unresolvedOperation)
            }
            ForEach(CardDraftField.allCases.filter { session.conflicts.contains($0) }, id: \.self) { field in
                Section("Resolve \(field.label)") {
                    Text("Your draft: \(session.pending.draft.value(for: field))").textSelection(.enabled)
                    Text("Saved: \(CardDraft(card: session.latest).value(for: field))").textSelection(.enabled)
                    Button("Use saved \(field.label)") { session.resolve(field, useSaved: true) }
                    if field == .placement {
                        Button("Move to retained destination") { Task { await session.move(to: session.pending.draft.columnId) } }
                            .disabled(!columns.contains { $0.id == session.pending.draft.columnId })
                        Text("Saving text never enacts a retained destination. Choose saved placement or a separate Move.")
                    } else {
                        Button("Keep my \(field.label)") { session.resolve(field, useSaved: false) }
                    }
                }.disabled(session.busy || session.unresolvedOperation || session.projectReadOnly)
            }
            Section {
                NavigationLink("Comments (\(session.latest.comments.count))") {
                    CommentsView(workspace: session.workspace, projectID: session.projectID, cardID: session.cardID, readOnly: session.projectReadOnly)
                }
                NavigationLink("Activity") { ActivityView(projectID: session.projectID, cardID: session.cardID) }
                Button("Refresh") { Task { await session.refresh() } }.disabled(session.busy || session.loadFailed)
                if !session.projectReadOnly {
                    Button(session.latest.archivedAt == nil ? "Archive Card" : "Restore Card", role: session.latest.archivedAt == nil ? .destructive : nil) {
                        Task {
                            archiving = true
                            defer { archiving = false }
                            do {
                                try await model.archive(session.latest, projectID: session.projectID, in: session.workspace, archived: session.latest.archivedAt == nil)
                                if let saved = model.loadedProjects[session.projectID]?.cards.first(where: { $0.id == session.cardID }) { session.receive(saved) }
                            } catch { model.handle(error) }
                        }
                    }.disabled(archiving || session.busy || session.unresolvedOperation || session.unavailable || session.legacyNeedsScope || session.loadFailed)
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(session.latest.title)
        .navigationBarBackButtonHidden(session.busy || session.persistenceFailed)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Save") { Task { await session.save() } }
                    .disabled(frozen || !session.conflicts.isEmpty || !session.dirty)
                    .keyboardShortcut("s", modifiers: .command)
                    .accessibilityIdentifier("card.save")
            }
            ToolbarItem(placement: .secondaryAction) {
                Button("Revert", role: .destructive) { confirmingRevert = true }
                    .disabled(session.busy || session.loadFailed || session.legacyNeedsScope || session.unresolvedOperation || session.pending.confirmed != nil || session.projectReadOnly || !session.dirty)
            }
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") { session.persist(); if !session.persistenceFailed { dismiss() } }
                    .disabled(session.busy || session.persistenceFailed)
            }
        }
        .confirmationDialog("Revert local edits to the latest saved Card? No server write will be undone.", isPresented: $confirmingRevert, titleVisibility: .visible) {
            Button("Revert local edits", role: .destructive) { Task { await session.revert() } }
        }
        .onChange(of: session.pending.draft) { _, _ in session.edited() }
        .onDisappear { session.persist() }
    }
}

struct CoordinatedCommentForm: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Bindable var session: CommentEditingSession
    @State private var confirmingDiscard = false
    private var projectReadOnly: Bool { model.loadedProjects[session.projectID]?.archivedAt != nil }
    var body: some View {
        NavigationStack {
            Form {
                if projectReadOnly {
                    Section { Text("Archived Project. Comments are read-only; your local draft is retained.") }
                }
                if session.loadFailed {
                    Section("Retained Comment could not be opened") {
                        Text("The original record is unchanged. Retry reading before editing, posting, or discarding.")
                        Button("Retry reading retained Comment") { session.retryLoading() }
                        if let text = session.retainedRecordText {
                            Button("Copy retained record") { UIPasteboard.general.string = text }
                            ShareLink("Export retained record", item: text)
                        }
                    }
                }
                if session.legacyNeedsScope {
                    Section("Confirm retained Comment Workspace") {
                        Text("This older Comment did not record its Workspace. Confirm its original Workspace before posting or retrying.")
                        Text(session.workspace.url.absoluteString).textSelection(.enabled)
                        Button("This is the original Workspace") { session.recoverLegacy() }
                        Button("Copy retained Comment") { UIPasteboard.general.string = String(decoding: (try? JSONEncoder().encode(session.pending)) ?? Data(), as: UTF8.self) }
                        ShareLink("Export retained Comment", item: String(decoding: (try? JSONEncoder().encode(session.pending)) ?? Data(), as: UTF8.self))
                    }
                }
                if let message = session.message { Section { Text(message).textSelection(.enabled) } }
                if session.pending.submitted != nil {
                    Section { Text("Comment outcome unconfirmed. Retry the same submitted text and operation; closing does not undo a server write.") }
                }
                if session.persistenceFailed {
                    Section("Local Comment protection failed") {
                        Text("Only this running app may hold the newest text. Retry or copy/export before leaving.")
                        Button("Retry local protection") { session.persist() }
                        Button("Copy Comment") { UIPasteboard.general.string = session.pending.body }
                        ShareLink("Export Comment", item: session.pending.body)
                    }
                }
                Section("Comment") {
                    TextEditor(text: $session.pending.body).accessibilityLabel("Comment").accessibilityIdentifier("comment-body")
                }.disabled(session.busy || session.frozen || !session.authorized || projectReadOnly)
                Button("Discard Comment draft", role: .destructive) { confirmingDiscard = true }
                    .disabled(session.busy || session.frozen || projectReadOnly)
            }
            .navigationTitle("Add Comment")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { session.persist(); if !session.persistenceFailed { dismiss() } }
                        .disabled(session.busy || session.persistenceFailed)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(session.pending.confirmed != nil ? "Retry cleanup" : session.pending.submitted != nil ? "Retry Post" : "Post") { Task { await session.post() } }
                        .disabled(session.busy || session.loadFailed || session.legacyNeedsScope || !session.authorized || projectReadOnly || (session.pending.confirmed == nil && session.pending.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
            }
            .interactiveDismissDisabled(session.busy || session.persistenceFailed)
            .confirmationDialog("Discard this unsubmitted Comment draft?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
                Button("Discard Comment draft", role: .destructive) {
                    guard !projectReadOnly else { return }
                    session.discard()
                }
            }
        }
        .onChange(of: session.pending.body) { _, _ in session.persist() }
        .onDisappear { session.persist() }
    }
}
