import SwiftUI

struct ConfirmedDraftReceipt: Codable, Equatable {
    var confirmedAt: String
}

struct PendingCardDraft: Codable, Equatable {
    var draft: CardDraft
    var key: String
    var submitted: CardDraft?
    var confirmed: ConfirmedDraftReceipt?
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

    init(workspace: Workspace, projectID: String, card: Card?) {
        self.workspace = workspace
        self.projectID = projectID
        self.card = card
        var draft = card.map(CardDraft.init(card:)) ?? CardDraft(columnId: "")
        if card == nil { draft.externalKey = "native-draft:\(UUID().uuidString)" }
        _pending = State(initialValue: PendingCardDraft(draft: draft, key: UUID().uuidString))
    }

    private var resourceKey: String { "card:\(projectID):\(card?.id ?? "new")" }
    private var columns: [Column] { (model.loadedProjects[projectID]?.columns ?? []).sorted { $0.position < $1.position } }

    var body: some View {
        NavigationStack {
            Form {
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
                .disabled(saving || pending.submitted != nil || pending.confirmed != nil)
                Section("Description") {
                    TextEditor(text: $pending.draft.body)
                        .accessibilityLabel("Description")
                        .accessibilityIdentifier("card-description")
                }.disabled(saving || pending.submitted != nil || pending.confirmed != nil)
                if let latest {
                    Section("Latest saved Card") { Text(latest.title) }
                    CardFields(card: latest, columns: columns)
                    Section {
                        Button("Continue editing with latest version") {
                            pending.draft.version = latest.version
                            pending.submitted = nil
                            self.latest = nil
                            persist()
                        }
                    } footer: {
                        Text("Your draft remains in the editor above. Review and reconcile the saved values before saving again.")
                    }
                }
                if pending.confirmed == nil {
                    Section { Button("Discard draft", role: .destructive) { discarding = true }.disabled(saving) }
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
                        .disabled(saving || (pending.confirmed == nil && (latest != nil || pending.draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || pending.draft.columnId.isEmpty)))
                }
            }
            .interactiveDismissDisabled(saving || persistenceFailed || (pending.confirmed != nil && !receiptPersisted))
            .task {
                guard !loadedDraft else { return }
                draftOwnerID = model.ownerID
                loadedDraft = true
                do {
                    if let saved = try model.drafts.load(ownerID: draftOwnerID, resourceKey: resourceKey, as: PendingCardDraft.self) {
                        pending = saved
                        receiptPersisted = saved.confirmed != nil
                    }
                    if pending.draft.columnId.isEmpty { pending.draft.columnId = columns.first?.id ?? "" }
                } catch { errorMessage = error.localizedDescription }
            }
            .onChange(of: pending) { _, _ in if loadedDraft && !cleanupComplete { persist() } }
            .alert(pending.confirmed != nil ? "Unable to remove local draft" : "Unable to save Card", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: { Text(errorMessage ?? "") }
            .confirmationDialog("Discard this local draft? A previous request may already have saved changes on the server.", isPresented: $discarding, titleVisibility: .visible) {
                Button("Discard draft", role: .destructive) {
                    do { try model.drafts.remove(ownerID: draftOwnerID, resourceKey: resourceKey); dismiss() }
                    catch { errorMessage = error.localizedDescription }
                }
            }
        }
    }

    private func persist() {
        guard !draftOwnerID.isEmpty else { return }
        do {
            try model.drafts.save(pending, ownerID: draftOwnerID, resourceKey: resourceKey)
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
        saving = true
        defer { saving = false }
        if pending.confirmed != nil { cleanupConfirmedDraft(); return }
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
        guard !persistenceFailed else { return }
        do {
            _ = try await model.saveCard(pending.submitted!, projectID: projectID, in: workspace, key: pending.key)
        } catch {
            if model.isConflict(error), let id = pending.draft.id {
                pending.submitted = nil
                do {
                    try await model.loadProject(id: projectID, in: workspace)
                    latest = model.loadedProjects[projectID]?.cards.first { $0.id == id }
                } catch { errorMessage = error.localizedDescription }
            } else if let apiError = error as? APIError, let status = apiError.statusCode, status < 500 {
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
        guard pending.confirmed != nil else { return }
        if !receiptPersisted { persist() }
        do {
            try model.drafts.remove(ownerID: draftOwnerID, resourceKey: resourceKey)
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

    private var resourceKey: String { "project:\(workspace.id):\(project?.id ?? "new")" }

    var body: some View {
        NavigationStack {
            Form {
                if pending.confirmed != nil { Section { Text("Project saved. Remove the local draft to finish.") } }
                else if pending.submitted != nil { Section { Text("The previous save may have reached the server. Retry the same save to confirm its result.") } }
                Section {
                    TextField("Name", text: $pending.draft.name).accessibilityIdentifier("project-name")
                    TextField("Description", text: $pending.draft.description, axis: .vertical)
                }.disabled(saving || pending.submitted != nil || pending.confirmed != nil)
                if let latest {
                    Section("Latest saved Project") {
                        LabeledContent("Name", value: latest.name)
                        Text(latest.description)
                        Button("Continue editing with latest revision") { pending.draft.revision = latest.revision; pending.submitted = nil; self.latest = nil }
                    }
                }
                if pending.confirmed == nil {
                    Section { Button("Discard draft", role: .destructive) { discarding = true }.disabled(saving) }
                }
            }
            .navigationTitle(project == nil ? "New Project" : "Edit Project")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { persist(); if !persistenceFailed { dismiss() } }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(pending.confirmed != nil ? "Retry cleanup" : pending.submitted == nil ? (project == nil ? "Create" : "Save") : "Retry Save") { Task { await save() } }
                        .disabled(saving || (pending.confirmed == nil && (latest != nil || pending.draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)))
                }
            }
            .interactiveDismissDisabled(saving || persistenceFailed || (pending.confirmed != nil && !receiptPersisted))
            .task {
                guard !loadedDraft else { return }
                draftOwnerID = model.ownerID
                loadedDraft = true
                do {
                    if let saved = try model.drafts.load(ownerID: draftOwnerID, resourceKey: resourceKey, as: PendingProjectDraft.self) {
                        pending = saved
                        receiptPersisted = saved.confirmed != nil
                    }
                }
                catch { errorMessage = error.localizedDescription }
            }
            .onChange(of: pending) { _, _ in if loadedDraft && !cleanupComplete { persist() } }
            .alert(pending.confirmed != nil ? "Unable to remove local draft" : "Unable to save Project", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: { Text(errorMessage ?? "") }
            .confirmationDialog("Discard this local draft? A previous request may already have saved changes on the server.", isPresented: $discarding, titleVisibility: .visible) {
                Button("Discard draft", role: .destructive) {
                    do { try model.drafts.remove(ownerID: draftOwnerID, resourceKey: resourceKey); dismiss() }
                    catch { errorMessage = error.localizedDescription }
                }
            }
        }
    }

    private func persist() {
        guard !draftOwnerID.isEmpty else { return }
        do {
            try model.drafts.save(pending, ownerID: draftOwnerID, resourceKey: resourceKey)
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
        saving = true
        defer { saving = false }
        if pending.confirmed != nil { cleanupConfirmedDraft(); return }
        pending.submitted = pending.submitted ?? pending.draft
        persist()
        guard !persistenceFailed else { return }
        do {
            _ = try await model.saveProject(pending.submitted!, in: workspace, key: pending.key)
        } catch {
            if model.isConflict(error), let id = pending.draft.id {
                pending.submitted = nil
                do { try await model.loadProject(id: id, in: workspace); latest = model.loadedProjects[id] }
                catch { errorMessage = error.localizedDescription }
            } else if let status = (error as? APIError)?.statusCode, status < 500 { pending.submitted = nil }
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
        guard pending.confirmed != nil else { return }
        if !receiptPersisted { persist() }
        do {
            try model.drafts.remove(ownerID: draftOwnerID, resourceKey: resourceKey)
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
    @State private var composing = false
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
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("Add Comment", systemImage: "square.and.pencil") { composing = true } } }
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
    @Environment(\.dismiss) private var dismiss
    let workspace: Workspace
    let projectID: String
    let cardID: String
    @State private var pending = PendingCommentDraft()
    @State private var saving = false
    @State private var loadedDraft = false
    @State private var draftOwnerID = ""
    @State private var persistenceFailed = false
    @State private var errorMessage: String?
    @State private var receiptPersisted = false
    @State private var cleanupComplete = false
    private var resourceKey: String { "comment:\(projectID):\(cardID)" }

    var body: some View {
        NavigationStack {
            Form {
                if pending.confirmed != nil { Section { Text("Comment sent. Remove the local draft to finish.") } }
                else if pending.submitted != nil { Section { Text("The previous Comment may have reached the server. Retry the same Comment to confirm its result.") } }
                Section("Comment") {
                    TextEditor(text: $pending.body).accessibilityLabel("Comment").accessibilityIdentifier("comment-body")
                }.disabled(saving || pending.submitted != nil || pending.confirmed != nil)
            }
            .navigationTitle("Add Comment")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { persist(); if !persistenceFailed { dismiss() } }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(pending.confirmed != nil ? "Retry cleanup" : pending.submitted == nil ? "Send" : "Retry Send") { Task { await send() } }
                        .disabled(saving || (pending.confirmed == nil && pending.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
            }
            .interactiveDismissDisabled(saving || persistenceFailed || (pending.confirmed != nil && !receiptPersisted))
            .task {
                guard !loadedDraft else { return }
                draftOwnerID = model.ownerID
                loadedDraft = true
                do {
                    if let saved = try model.drafts.load(ownerID: draftOwnerID, resourceKey: resourceKey, as: PendingCommentDraft.self) {
                        pending = saved
                        receiptPersisted = saved.confirmed != nil
                    }
                }
                catch { errorMessage = error.localizedDescription }
            }
            .onChange(of: pending) { _, _ in if loadedDraft && !cleanupComplete { persist() } }
            .alert(pending.confirmed != nil ? "Unable to remove local draft" : "Unable to send Comment", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: { Text(errorMessage ?? "") }
        }
    }

    private func persist() {
        guard !draftOwnerID.isEmpty else { return }
        do {
            try model.drafts.save(pending, ownerID: draftOwnerID, resourceKey: resourceKey)
            persistenceFailed = false
            receiptPersisted = pending.confirmed != nil
        } catch {
            persistenceFailed = true
            errorMessage = pending.confirmed != nil
                ? "Comment sent. This iPhone could not record completion. Keep the editor open and retry cleanup. \(error.localizedDescription)"
                : error.localizedDescription
        }
    }

    private func send() async {
        saving = true
        defer { saving = false }
        if pending.confirmed != nil { cleanupConfirmedDraft(); return }
        pending.submitted = pending.submitted ?? pending.body
        persist()
        guard !persistenceFailed else { return }
        do {
            try await model.addComment(pending.submitted!, cardID: cardID, projectID: projectID, in: workspace, key: pending.key)
        } catch {
            if let status = (error as? APIError)?.statusCode, status < 500 { pending.submitted = nil }
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
        guard pending.confirmed != nil else { return }
        if !receiptPersisted { persist() }
        do {
            try model.drafts.remove(ownerID: draftOwnerID, resourceKey: resourceKey)
            cleanupComplete = true
            dismiss()
        } catch {
            errorMessage = "Comment sent. The local draft could not be removed. Retry cleanup. \(error.localizedDescription)"
        }
    }
}
