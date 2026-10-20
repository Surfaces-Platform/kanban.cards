import SwiftUI

struct CreationPreviewDetail: Identifiable, Equatable {
    let label: String
    let value: String
    var id: String { label.lowercased().replacingOccurrences(of: " ", with: "-") }
}

private struct CreationTextField: View {
    let label: String
    @Binding var text: String
    let identifier: String
    var required = false
    var multiline = false

    var body: some View {
        if multiline {
            Section {
                TextField(
                    "", text: $text, prompt: Text(required ? "Required" : "Optional"),
                    axis: .vertical
                )
                .lineLimit(3...8).accessibilityLabel(label).accessibilityIdentifier(identifier)
            } header: {
                Text(label).accessibilityIdentifier("\(identifier)-label")
            }
        } else {
            LabeledContent {
                TextField("", text: $text, prompt: Text(required ? "Required" : "Optional"))
                    .accessibilityLabel(label).accessibilityIdentifier(identifier)
            } label: {
                Text(label).accessibilityIdentifier("\(identifier)-label")
            }
        }
    }
}

protocol CreationPayload: Codable, Equatable {
    static var itemName: String { get }
    var previewTitle: String { get }
    var previewBody: String { get }
    var exportText: String { get }
    var hasContent: Bool { get }
    var canCreate: Bool { get }
    func differsFromEmpty(_ baseline: Self) -> Bool
    var requestWasSent: Bool { get }
    var saveWasConfirmed: Bool { get }
    func validateCreationIdentity() throws
    func freshCopy() -> Self
    mutating func prepareRequest()
    mutating func confirmRequest()
    mutating func rejectRequest()
}

extension PendingCardDraft: CreationPayload {
    static var itemName: String { "Card" }
    var previewTitle: String { draft.title.isEmpty ? "Untitled card" : draft.title }
    var previewBody: String { draft.body }
    func previewDetails(columnName: String) -> [CreationPreviewDetail] {
        [
            CreationPreviewDetail(label: "Column", value: columnName),
            CreationPreviewDetail(
                label: "Next actor", value: draft.nextActor?.label ?? "Unassigned"),
            CreationPreviewDetail(label: "Priority", value: draft.priority?.rawValue ?? "Unset"),
            CreationPreviewDetail(
                label: "Next action", value: draft.nextAction.isEmpty ? "None" : draft.nextAction),
            CreationPreviewDetail(
                label: "Blocker", value: draft.blockedReason.isEmpty ? "None" : draft.blockedReason),
        ]
    }
    var exportText: String {
        [
            "Title:\n\(draft.title)", "Description:\n\(draft.body)", "Column:\n\(draft.columnId)",
            "Next actor:\n\(draft.nextActor?.label ?? "Unassigned")",
            "Priority:\n\(draft.priority?.rawValue ?? "Unset")",
            "Next action:\n\(draft.nextAction)", "Blocker:\n\(draft.blockedReason)",
        ].joined(separator: "\n\n")
    }
    var hasContent: Bool {
        !draft.title.isEmpty || !draft.body.isEmpty || draft.nextActor != nil
            || draft.priority != nil
            || !draft.nextAction.isEmpty || !draft.blockedReason.isEmpty
    }
    func differsFromEmpty(_ baseline: Self) -> Bool {
        hasContent || draft.columnId != baseline.draft.columnId
    }
    var canCreate: Bool {
        !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !draft.columnId.isEmpty
    }
    var requestWasSent: Bool { submitted != nil }
    var saveWasConfirmed: Bool { confirmed != nil }
    func validateCreationIdentity() throws { try validateIdentity(cardID: nil) }
    func freshCopy() -> Self {
        var value = draft
        value.id = nil
        value.version = nil
        value.archivedAt = nil
        value.position = 0
        value.externalKey = "native-draft:\(UUID().uuidString)"
        return Self(draft: value, key: UUID().uuidString)
    }
    mutating func prepareRequest() { submitted = submitted ?? draft }
    mutating func confirmRequest() {
        confirmed = ConfirmedDraftReceipt(confirmedAt: ServerTimestamp.string())
    }
    mutating func rejectRequest() { submitted = nil }
}

extension PendingProjectDraft: CreationPayload {
    static var itemName: String { "Project" }
    var previewTitle: String { draft.name.isEmpty ? "Untitled project" : draft.name }
    var previewBody: String { draft.description }
    var exportText: String {
        "Name:\n\(draft.name)\n\nDescription:\n\(draft.description)"
    }
    var hasContent: Bool { !draft.name.isEmpty || !draft.description.isEmpty }
    func differsFromEmpty(_ baseline: Self) -> Bool { hasContent }
    var canCreate: Bool { !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var requestWasSent: Bool { submitted != nil }
    var saveWasConfirmed: Bool { confirmed != nil }
    func validateCreationIdentity() throws { try validateIdentity(projectID: nil) }
    func freshCopy() -> Self {
        Self(
            draft: ProjectDraft(name: draft.name, description: draft.description),
            key: UUID().uuidString)
    }
    mutating func prepareRequest() { submitted = submitted ?? draft }
    mutating func confirmRequest() {
        confirmed = ConfirmedDraftReceipt(confirmedAt: ServerTimestamp.string())
    }
    mutating func rejectRequest() { submitted = nil }
}

struct NewCardEditor: View {
    @Environment(AppModel.self) private var model
    let workspace: Workspace
    let projectID: String
    var recoveryOnly = false
    private var columns: [Column] {
        (model.loadedProjects[projectID]?.columns ?? []).sorted { $0.position < $1.position }
    }
    private var initial: PendingCardDraft {
        var draft = CardDraft(columnId: columns.first?.id ?? "")
        draft.externalKey = "native-draft:\(UUID().uuidString)"
        return PendingCardDraft(draft: draft, key: UUID().uuidString)
    }
    var body: some View {
        CreationEditor(
            workspace: workspace, projectID: projectID, resourceKey: "card:\(projectID):new",
            initial: initial,
            readOnly: recoveryOnly || model.loadedProjects[projectID]?.archivedAt != nil,
            normalize: { pending in
                var value = pending
                if !value.requestWasSent {
                    if !columns.contains(where: { $0.id == value.draft.columnId }) {
                        value.draft.columnId = columns.first?.id ?? ""
                    }
                    value.draft.position =
                        (model.loadedProjects[projectID]?.cards.filter {
                            $0.columnId == value.draft.columnId
                        }
                        .map(\.position).max() ?? -1) + 1
                }
                return value
            },
            previewDetails: { pending in
                pending.previewDetails(
                    columnName: columns.first { $0.id == pending.draft.columnId }?.name
                        ?? "Previous column")
            },
            save: { pending in
                _ = try await model.saveCard(
                    pending.submitted ?? pending.draft, projectID: projectID, in: workspace,
                    key: pending.key)
            }
        ) { pending in
            Section {
                CreationTextField(
                    label: "Title", text: pending.draft.title, identifier: "card-title",
                    required: true)
            }
            CreationTextField(
                label: "Description", text: pending.draft.body, identifier: "card-description",
                multiline: true)
            Section {
                Picker("Column", selection: pending.draft.columnId) {
                    ForEach(columns) { Text($0.name).tag($0.id) }
                }
            }
            Section {
                DisclosureGroup("More details") {
                    Picker("Next actor", selection: pending.draft.nextActor) {
                        Text("Unassigned").tag(CardNextActor?.none)
                        ForEach(CardNextActor.allCases) { Text($0.label).tag(Optional($0)) }
                    }
                    Picker("Priority", selection: pending.draft.priority) {
                        Text("Unset").tag(CardPriority?.none)
                        ForEach(CardPriority.allCases) { Text($0.rawValue).tag(Optional($0)) }
                    }
                    CreationTextField(
                        label: "Next action", text: pending.draft.nextAction,
                        identifier: "card-next-action", multiline: true)
                    CreationTextField(
                        label: "Blocker", text: pending.draft.blockedReason,
                        identifier: "card-blocker", multiline: true)
                }
            }
        }
    }
}

struct NewProjectEditor: View {
    @Environment(AppModel.self) private var model
    let workspace: Workspace
    var body: some View {
        CreationEditor(
            workspace: workspace, projectID: "new", resourceKey: "project:\(workspace.id):new",
            initial: PendingProjectDraft(draft: ProjectDraft(), key: UUID().uuidString),
            save: { pending in
                _ = try await model.saveProject(
                    pending.submitted ?? pending.draft, in: workspace, key: pending.key)
            }
        ) { pending in
            Section {
                CreationTextField(
                    label: "Name", text: pending.draft.name, identifier: "project-name",
                    required: true)
            }
            CreationTextField(
                label: "Description", text: pending.draft.description,
                identifier: "project-description", multiline: true)
        }
    }
}

private struct RecoveryCandidate<Payload: CreationPayload>: Identifiable {
    let id: String
    var payload: Payload?
    var recordID: UUID?
    var sourceFingerprint: String?
    var requiresCopy = false
    var savedAt: Date?
    var rawText: String?
    var title: String { payload?.previewTitle ?? "Draft unavailable" }
}

private struct CreationEditor<Payload: CreationPayload, Fields: View>: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let workspace: Workspace
    let projectID: String
    let resourceKey: String
    var readOnly = false
    var normalize: (Payload) -> Payload
    let previewDetails: (Payload) -> [CreationPreviewDetail]
    let save: @MainActor (Payload) async throws -> Void
    let fields: (Binding<Payload>) -> Fields
    @State private var baseline: Payload
    @State private var pending: Payload
    @State private var draftID = UUID()
    @State private var sourceFingerprint: String?
    @State private var ownerID = ""
    @State private var loaded = false
    @State private var saving = false
    @State private var checkingSave = false
    @State private var finishing = false
    @State private var showingCancel = false
    @State private var showingRecovery = false
    @State private var selectedRecovery: RecoveryCandidate<Payload>?
    @State private var recoveries: [RecoveryCandidate<Payload>] = []
    @State private var errorMessage: String?
    @State private var persistenceFailed = false
    @State private var recoveryError: String?

    init(
        workspace: Workspace, projectID: String, resourceKey: String, initial: Payload,
        readOnly: Bool = false, normalize: @escaping (Payload) -> Payload = { $0 },
        previewDetails: @escaping (Payload) -> [CreationPreviewDetail] = { _ in [] },
        save: @escaping @MainActor (Payload) async throws -> Void,
        @ViewBuilder fields: @escaping (Binding<Payload>) -> Fields
    ) {
        self.workspace = workspace
        self.projectID = projectID
        self.resourceKey = resourceKey
        self.readOnly = readOnly
        self.normalize = normalize
        self.previewDetails = previewDetails
        self.save = save
        self.fields = fields
        _pending = State(initialValue: initial)
        _baseline = State(initialValue: initial)
    }
    private var contextIsCurrent: Bool {
        loaded && model.signedIn && ownerID == model.ownerID
            && model.workspaces.contains { $0.id == workspace.id && $0.url == workspace.url }
    }
    private var hasWork: Bool {
        pending.differsFromEmpty(baseline) || pending.requestWasSent || pending.saveWasConfirmed
    }
    private var readableText: String { pending.exportText }

    var body: some View {
        NavigationStack {
            if readOnly { recoveryContent } else { editorContent }
        }
        .task {
            guard !loaded else { return }
            ownerID = model.ownerID
            loaded = true
            refreshRecoveries()
        }
        .onChange(of: readOnly) { _, _ in refreshRecoveries() }
        .onChange(of: model.api.sessionGeneration) { _, _ in dismiss() }
        .onChange(of: model.signedIn) { _, signedIn in if !signedIn { dismiss() } }
    }

    private var editorContent: some View {
        Form {
            if saving {
                Section {
                    ProgressView(
                        checkingSave
                            ? "Checking save…" : "Creating \(Payload.itemName.lowercased())…"
                    )
                    .accessibilityIdentifier("creation.progress")
                }
            } else if pending.saveWasConfirmed {
                Section {
                    Text("\(Payload.itemName) created. Finish removing its saved draft.")
                    Button("Finish") { finishCreated() }
                }
            } else if pending.requestWasSent {
                Section {
                    Text(
                        "The save hasn’t been confirmed yet. Check its result before making changes."
                    )
                    Button("Check Save") { Task { await create() } }.disabled(saving)
                }
            }
            fields($pending).disabled(
                !loaded || saving || pending.requestWasSent || pending.saveWasConfirmed || readOnly)
            if let errorMessage {
                Section {
                    Text(errorMessage)
                    if persistenceFailed {
                        Button(hasWork ? "Retry Saving Draft" : "Retry Removing Draft") {
                            if hasWork { _ = persist() } else { clearEmptyDraft() }
                        }
                        ShareLink("Export Draft Text", item: readableText)
                    }
                }
            }
            if hasWork && !persistenceFailed && !pending.requestWasSent && !pending.saveWasConfirmed
            {
                Section {
                    Text("Draft saved on this iPhone. You can finish it later.").foregroundStyle(
                        .secondary)
                }
            }
            if !recoveries.isEmpty {
                Section {
                    Button("Saved drafts (\(recoveries.count))", systemImage: "tray") {
                        refreshRecoveries()
                        showingRecovery = true
                    }
                    .accessibilityIdentifier("creation.saved-drafts").disabled(
                        saving || pending.saveWasConfirmed)
                } footer: {
                    Text(
                        "Earlier drafts are kept separately from this new \(Payload.itemName.lowercased())."
                    )
                }
            }
        }
        .navigationTitle("New \(Payload.itemName)")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") {
                    if hasWork {
                        showingCancel = true
                    } else if persistenceFailed {
                        clearEmptyDraft()
                        if !persistenceFailed { dismiss() }
                    } else {
                        dismiss()
                    }
                }
                .accessibilityIdentifier("creation.cancel").disabled(saving)
                .confirmationDialog(
                    "Keep this draft?", isPresented: $showingCancel, titleVisibility: .visible
                ) {
                    Button("Keep Draft") { if persist() { dismiss() } }
                    if !pending.requestWasSent && !pending.saveWasConfirmed {
                        Button("Discard Draft", role: .destructive) { discard() }
                    }
                    Button("Continue Editing") {}
                } message: {
                    Text(
                        pending.requestWasSent
                            ? "Keep it on this iPhone so you can check the save later."
                            : "Keep your work on this iPhone to finish later.")
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(
                    saving
                        ? (checkingSave ? "Checking…" : "Creating…")
                        : pending.saveWasConfirmed
                            ? "Finish" : pending.requestWasSent ? "Check Save" : "Create"
                ) { Task { await create() } }
                .accessibilityIdentifier("creation.primary")
                .disabled(
                    !loaded || saving || readOnly
                        || (!pending.saveWasConfirmed && !pending.requestWasSent
                            && !pending.canCreate)
                )
            }
        }
        .interactiveDismissDisabled(saving || persistenceFailed)
        .onChange(of: pending) { _, _ in
            if loaded && !finishing {
                if hasWork { _ = persist() } else { clearEmptyDraft() }
            }
        }
        .navigationDestination(isPresented: $showingRecovery) { recoveryContent }
    }

    private var recoveryContent: some View {
        List {
            if readOnly {
                Section {
                    Text(
                        "This Project is archived. You can preview and export saved drafts here. To continue a draft on this iPhone, restore the Project in the Mac app first."
                    )
                    .accessibilityIdentifier("recovery.archived-notice")
                }
            }
            if let recoveryError { Section { Text(recoveryError) } }
            if recoveries.isEmpty {
                ContentUnavailableView("No saved drafts", systemImage: "tray")
            }
            ForEach(recoveries) { item in
                NavigationLink {
                    Form {
                        if let recoveryError { Section { Text(recoveryError) } }
                        if let payload = item.payload {
                            Section {
                                Text(payload.previewTitle).accessibilityIdentifier("recovery.title")
                                if !payload.previewBody.isEmpty {
                                    Text(payload.previewBody).textSelection(.enabled)
                                }
                            }
                            if !previewDetails(payload).isEmpty {
                                Section("Details") {
                                    ForEach(previewDetails(payload)) { detail in
                                        LabeledContent(detail.label) {
                                            Text(detail.value).textSelection(.enabled)
                                        }.accessibilityElement(children: .combine)
                                            .accessibilityIdentifier("recovery.detail.\(detail.id)")
                                    }
                                }
                            }
                            Section {
                                if hasWork && !readOnly && !payload.saveWasConfirmed {
                                    Text("Your current draft will stay in Saved drafts.")
                                }
                                if readOnly {
                                    Text(
                                        "This Project is archived. Export this draft to keep a copy of its contents."
                                    )
                                } else if item.requiresCopy {
                                    Text(
                                        "This draft came from an earlier app version. Its Workspace is unknown. You can use a copy here; the original will stay saved."
                                    )
                                    if payload.requestWasSent {
                                        Text(
                                            "It may already have been created. Check your existing \(Payload.itemName.lowercased())s before creating a copy."
                                        )
                                    }
                                    recoveryButton(
                                        "Copy to New \(Payload.itemName)",
                                        identifier: "recovery.copy", item: item)
                                } else if payload.saveWasConfirmed {
                                    Text(
                                        "This \(Payload.itemName.lowercased()) was already created. Its saved draft can be removed."
                                    )
                                    Button("Remove Saved Draft") { resolve(item) }
                                } else {
                                    Text("Saved for \(workspace.name) on this iPhone.")
                                    if payload.requestWasSent {
                                        Text(
                                            "Continue to check the earlier save. This keeps the same request and avoids creating a duplicate."
                                        )
                                    }
                                    recoveryButton(
                                        "Continue Draft", identifier: "recovery.resume", item: item)
                                }
                                ShareLink("Export Draft", item: payload.exportText)
                                    .accessibilityIdentifier("recovery.export")
                            }
                        } else {
                            Section {
                                Text(
                                    readOnly
                                        ? "This draft can’t be previewed. The original is still saved. Export the original record to keep a copy."
                                        : "This draft can’t be previewed. The original is still saved, and you can create a new \(Payload.itemName.lowercased())."
                                )
                                if let rawText = item.rawText {
                                    ShareLink("Export Original Record", item: rawText)
                                        .accessibilityIdentifier(
                                            "recovery.export")
                                }
                            }
                        }
                    }
                    .navigationTitle("Saved \(Payload.itemName)")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Close") { closeRecovery() }.accessibilityIdentifier(
                                "recovery.close")
                        }
                    }
                } label: {
                    Text(item.title)
                    if let date = item.savedAt {
                        Text(date, style: .date)
                    } else {
                        Text("From an earlier app version")
                    }
                }
            }
        }
        .navigationTitle("Saved drafts")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") { closeRecovery() }.accessibilityIdentifier(
                    "recovery.close")
            }
        }
    }

    private func recoveryButton(
        _ title: String, identifier: String, item: RecoveryCandidate<Payload>
    ) -> some View {
        Button(
            hasWork
                ? (item.requiresCopy
                    ? "Keep Current and Copy Draft" : "Keep Current and Open Draft") : title
        ) { chooseRecovery(item) }
        .accessibilityIdentifier(identifier)
    }

    private func closeRecovery() {
        if readOnly { dismiss() } else { showingRecovery = false }
    }

    private func persist() -> Bool {
        guard contextIsCurrent, !finishing else { return false }
        guard hasWork else { return true }
        do {
            _ = try model.drafts.saveCreationDraft(
                pending, id: draftID, ownerID: ownerID, workspace: workspace,
                projectID: projectID, resourceKey: resourceKey, sourceFingerprint: sourceFingerprint
            )
            if persistenceFailed { errorMessage = nil }
            persistenceFailed = false
            return true
        } catch {
            persistenceFailed = true
            errorMessage =
                "Your latest changes couldn’t be saved on this iPhone. Retry or export the text before closing."
            return false
        }
    }

    private func clearEmptyDraft() {
        guard contextIsCurrent, !saving else { return }
        do {
            try model.drafts.discardCreationDraft(
                id: draftID, ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey)
            draftID = UUID()
            sourceFingerprint = nil
            if persistenceFailed { errorMessage = nil }
            persistenceFailed = false
        } catch {
            persistenceFailed = true
            errorMessage =
                "The earlier saved text couldn’t be removed. Retry removing it before closing."
        }
    }

    private func discard() {
        guard contextIsCurrent, !pending.requestWasSent else { return }
        do {
            try model.drafts.discardCreationDraft(
                id: draftID, ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey)
            finishing = true
            dismiss()
        } catch { errorMessage = "The draft couldn’t be removed. Try again." }
    }

    private func create() async {
        guard contextIsCurrent, !readOnly, !saving else { return }
        if pending.saveWasConfirmed {
            finishCreated()
            return
        }
        guard pending.canCreate || pending.requestWasSent else { return }
        checkingSave = pending.requestWasSent
        errorMessage = nil
        saving = true
        defer { saving = false }
        let operationID = draftID
        let hadRequest = pending.requestWasSent
        pending = normalize(pending)
        pending.prepareRequest()
        guard persist() else {
            if !hadRequest { pending.rejectRequest() }
            return
        }
        do {
            try await save(pending)
            guard contextIsCurrent, draftID == operationID else { return }
            pending.confirmRequest()
            guard persist() else { return }
            finishCreated()
        } catch {
            guard contextIsCurrent, draftID == operationID else { return }
            if let failure = error as? APIError, let status = failure.statusCode, status < 500,
                !failure.isAmbiguousMutation
            {
                pending.rejectRequest()
            }
            _ = persist()
            if (error as? APIError)?.isUnauthorized == true {
                model.handle(error)
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func finishCreated() {
        guard contextIsCurrent else { return }
        do {
            try model.drafts.resolveCreationDraft(
                id: draftID, ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey)
            finishing = true
            dismiss()
        } catch {
            errorMessage = "\(Payload.itemName) created. Tap Finish to remove its saved draft."
        }
    }

    private func chooseRecovery(_ item: RecoveryCandidate<Payload>) {
        guard !saving else { return }
        recoveryError = nil
        selectedRecovery = item
        if hasWork && !persist() {
            recoveryError =
                "Your current draft couldn’t be saved. Go back to retry or export its text."
            return
        }
        applyRecovery()
    }

    private func applyRecovery() {
        guard contextIsCurrent, !saving, let item = selectedRecovery, let payload = item.payload
        else {
            return
        }
        let value = normalize(item.requiresCopy ? payload.freshCopy() : payload)
        let nextID = item.requiresCopy ? UUID() : item.recordID ?? UUID()
        let nextSource = item.requiresCopy ? nil : item.sourceFingerprint
        do {
            _ = try model.drafts.saveCreationDraft(
                value, id: nextID, ownerID: ownerID, workspace: workspace,
                projectID: projectID, resourceKey: resourceKey, sourceFingerprint: nextSource)
            draftID = nextID
            sourceFingerprint = nextSource
            errorMessage = nil
            persistenceFailed = false
            pending = value
            selectedRecovery = nil
            showingRecovery = false
            refreshRecoveries()
        } catch {
            recoveryError =
                "The saved draft couldn’t be opened. Its original is still saved. Try again."
        }
    }

    private func resolve(_ item: RecoveryCandidate<Payload>) {
        guard contextIsCurrent, !saving, let payload = item.payload else { return }
        do {
            let id = item.recordID ?? UUID()
            if item.recordID == nil {
                _ = try model.drafts.saveCreationDraft(
                    payload, id: id, ownerID: ownerID, workspace: workspace,
                    projectID: projectID, resourceKey: resourceKey,
                    sourceFingerprint: item.sourceFingerprint)
            }
            try model.drafts.resolveCreationDraft(
                id: id, ownerID: ownerID, workspace: workspace, projectID: projectID,
                resourceKey: resourceKey)
            refreshRecoveries()
        } catch { recoveryError = "The saved draft couldn’t be removed. Try again." }
    }

    private func refreshRecoveries() {
        guard contextIsCurrent else { return }
        let listing = model.drafts.listCreationDrafts(
            ownerID: ownerID, workspace: workspace, projectID: projectID, resourceKey: resourceKey)
        let imported = Set(listing.records.compactMap(\.sourceFingerprint))
        var items: [RecoveryCandidate<Payload>] = []
        for record in listing.records
        where record.state == .active && (readOnly || record.id != draftID) {
            let value = try? JSONDecoder().decode(Payload.self, from: record.payload)
            let valid = value.flatMap { candidate -> Payload? in
                guard (try? candidate.validateCreationIdentity()) != nil else { return nil }
                return candidate
            }
            items.append(
                RecoveryCandidate(
                    id: record.id.uuidString, payload: valid, recordID: record.id,
                    sourceFingerprint: record.sourceFingerprint, savedAt: record.savedAt,
                    rawText: String(data: record.payload, encoding: .utf8)))
        }
        for failure in listing.failures {
            items.append(
                RecoveryCandidate(
                    id: failure.id,
                    rawText: failure.rawData.flatMap { String(data: $0, encoding: .utf8) }))
        }
        let scoped = model.drafts.scopedKey(
            workspace: workspace, projectID: projectID, resourceKey: resourceKey)
        func appendOld(_ data: Data, unknown: Bool) {
            let fingerprint = DraftStore.fingerprint(data)
            guard !imported.contains(fingerprint) else { return }
            let value = try? JSONDecoder().decode(Payload.self, from: data)
            let valid = value.flatMap { candidate -> Payload? in
                guard (try? candidate.validateCreationIdentity()) != nil else { return nil }
                return candidate
            }
            items.append(
                RecoveryCandidate(
                    id: "old:\(fingerprint)", payload: valid, sourceFingerprint: fingerprint,
                    requiresCopy: unknown, rawText: String(data: data, encoding: .utf8)))
        }
        do {
            let scopedData = try model.drafts.rawRecordData(ownerID: ownerID, resourceKey: scoped)
            if let scopedData { appendOld(scopedData, unknown: false) }
            let binding = try model.drafts.rawRecordData(
                ownerID: ownerID, resourceKey: "legacy-scope:v2:\(resourceKey)")
            if binding == nil {
                if let old = try model.drafts.rawRecordData(
                    ownerID: ownerID, resourceKey: resourceKey)
                {
                    appendOld(old, unknown: true)
                }
            } else if scopedData == nil,
                let _: Payload = try model.drafts.loadScoped(
                    ownerID: ownerID, workspace: workspace, projectID: projectID,
                    resourceKey: resourceKey,
                    legacyResourceKey: resourceKey, as: Payload.self),
                let old = try model.drafts.rawRecordData(ownerID: ownerID, resourceKey: resourceKey)
            {
                appendOld(old, unknown: false)
            }
        } catch {
            items.append(RecoveryCandidate(id: "old-unreadable"))
        }
        recoveries = items
    }
}
