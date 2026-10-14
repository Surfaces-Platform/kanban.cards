import SwiftUI

struct CardWindowView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.openWindow) private var openWindow
    @Environment(\.scenePhase) private var scenePhase
    let identity: CardWindowID
    private enum CardSheetKind { case edit, comment, move, activity }
    private struct CardSheet: Identifiable {
        var id = UUID()
        var kind: CardSheetKind
    }
    @State private var activeSheet: CardSheet?
    @State private var confirmingArchive = false
    @State private var mutating = false
    @State private var loading = false
    @State private var loadError: String?

    private var workspace: Workspace? {
        guard model.signedIn, model.ownerID == identity.ownerID else { return nil }
        return model.workspaces.first { $0.id == identity.workspaceID }
    }
    private var project: Project? {
        guard let workspace else { return nil }
        return model.project(id: identity.projectID, in: workspace)
    }
    private var card: Card? { project?.cards.first { $0.id == identity.cardID } }
    private var hasSheet: Bool { activeSheet != nil || confirmingArchive }
    private var canWrite: Bool { workspace.map { model.canEditProject(id: identity.projectID, in: $0) } == true }
    private var canEdit: Bool { model.signedIn && card?.archivedAt == nil && project?.archivedAt == nil && card != nil && !mutating && !hasSheet && canWrite }
    private var canRefresh: Bool { workspace != nil && !loading && !mutating && !hasSheet }
    private var canShowActivity: Bool { card != nil && canRefresh }
    private var canArchive: Bool { card != nil && project != nil && project?.archivedAt == nil && !hasSheet && !mutating && canWrite }

    var body: some View {
        VStack(spacing: 0) {
            NativeCardWindowGeometry(identity: identity, resetDemoLayout: model.isDemo && ProcessInfo.processInfo.arguments.contains("--reset-demo-window-layout"))
                .frame(width: 1, height: 1)
                .accessibilityHidden(true)
            content
        }
        .frame(minWidth: 460, minHeight: 480)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Card details")
        .accessibilityIdentifier("card.viewer.\(identity.cardID)")
        .navigationTitle(card?.title ?? "Card")
        .navigationSubtitle([workspace?.name, project?.name].compactMap { $0 }.joined(separator: " / "))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Edit") { activeSheet = CardSheet(kind: .edit) }.disabled(!canEdit)
                    .accessibilityIdentifier("card.edit.\(identity.cardID)")
            }
            ToolbarItem { Button("Move…") { activeSheet = CardSheet(kind: .move) }.disabled(!canEdit) }
            ToolbarItem { Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }.disabled(!canRefresh) }
            ToolbarItem {
                NativePullDownMenu(title: "Card actions", systemImage: "ellipsis", label: "More Card actions",
                    identifier: "card.actions.\(identity.cardID)", actions: [
                    NativeMenuAction(title: "Activity…", systemImage: "clock", isEnabled: canShowActivity) {
                        guard canShowActivity else { return }
                        activeSheet = CardSheet(kind: .activity)
                    },
                    NativeMenuAction(title: card?.archivedAt == nil ? "Archive Card…" : "Restore Card…",
                        isEnabled: canArchive, beginsGroup: true) {
                        guard canArchive else { return }
                        confirmingArchive = true
                    }
                ])
            }
        }
        .focusedSceneValue(\.cardWindowActions, CardWindowActions(
            canEdit: canEdit, canRefresh: canRefresh,
            canShowActivity: canShowActivity,
            canArchive: canArchive,
            archived: card?.archivedAt != nil,
            edit: { if canEdit { activeSheet = CardSheet(kind: .edit) } },
            comment: { if canEdit { activeSheet = CardSheet(kind: .comment) } },
            move: { if canEdit { activeSheet = CardSheet(kind: .move) } },
            activity: { if canShowActivity { activeSheet = CardSheet(kind: .activity) } },
            archive: { if canArchive { confirmingArchive = true } },
            refresh: { if canRefresh { Task { await refresh() } } }))
        .task { await model.restore(); await refresh(); closeIfUnauthorized() }
        .onChange(of: card?.id) { _, id in if id == nil { activeSheet = nil; confirmingArchive = false } }
        .onChange(of: model.signedIn) { _, _ in closeIfUnauthorized() }
        .onChange(of: model.sessionID) { _, _ in
            activeSheet = nil; confirmingArchive = false
            closeIfUnauthorized()
        }
        .onChange(of: scenePhase) { _, phase in if phase == .active { model.validateSession(); Task { await refresh() } } }
    }

    private var content: some View {
        Group {
            if model.restoring { ProgressView("Opening Card") }
            else if let workspace, let project, let card {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(project.columns.first { $0.id == card.columnId }?.name ?? "Column unavailable")
                                .font(.caption).foregroundStyle(.primary)
                            Text(card.title).font(.title2).fontWeight(.semibold).textSelection(.enabled)
                                .accessibilityAddTraits(.isHeader)
                                .accessibilityHeading(.h1)
                                .accessibilityValue(Text(verbatim: card.title))
                            if card.archivedAt != nil { Label("Archived Card", systemImage: "archivebox") }
                            if project.archivedAt != nil { Text("Archived Project. This Card is read-only.") }
                            else if !canWrite { Label("Read-only", systemImage: "lock") }
                            if loading { ProgressView("Refreshing Card") }
                            if mutating { ProgressView("Updating Card") }
                            if let loadError {
                                Text(loadError).foregroundStyle(.secondary)
                                Button("Retry refresh") { Task { await refresh() } }
                            }
                            sectionHeader("Next action").padding(.top, 8)
                            Text(verbatim: card.nextAction.isEmpty ? "No next action yet" : card.nextAction)
                                .font(.body).textSelection(.enabled)
                                .accessibilityValue(Text(verbatim: card.nextAction.isEmpty ? "No next action yet" : card.nextAction))
                            sectionHeader("Details").padding(.top, 8)
                            metadataRow("Next actor", value: card.nextActor?.label ?? "Unassigned")
                            metadataRow("Priority", value: card.priority?.rawValue ?? "Unset")
                            metadataRow("Blocker", value: card.blockedReason.isEmpty ? "None" : card.blockedReason)
                        }
                        .padding(.vertical, 3)

                        VStack(alignment: .leading, spacing: 8) {
                            sectionHeader("Description")
                            Text(verbatim: card.body.isEmpty ? "No description" : card.body)
                                .foregroundStyle(card.body.isEmpty ? Color.secondary : Color.primary)
                                .textSelection(.enabled)
                                .accessibilityValue(Text(verbatim: card.body.isEmpty ? "No description" : card.body))
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            sectionHeader(card.comments.isEmpty ? "Comments" : "Comments (\(card.comments.count))")
                            ForEach(card.comments) { comment in
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                                        Text(comment.author).font(.body).fontWeight(.semibold).foregroundStyle(.primary)
                                        if let date = ServerTimestamp.date(from: comment.createdAt) {
                                            Text(date, style: .relative).font(.subheadline).foregroundStyle(.secondary)
                                        }
                                    }
                                    .accessibilityElement(children: .combine)
                                    Text(verbatim: comment.body).font(.body).textSelection(.enabled)
                                }.padding(.vertical, 4)
                                Divider()
                            }
                            if card.comments.isEmpty {
                                Text("No comments yet").foregroundStyle(.secondary)
                            }
                            Button("Add Comment…") { activeSheet = CardSheet(kind: .comment) }
                                .disabled(!canEdit)
                                .accessibilityIdentifier("card.add-comment.\(identity.cardID)")
                                .padding(.vertical, 4)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Card contents")
                }
                .sheet(item: $activeSheet) { sheet in
                    switch sheet.kind {
                    case .edit:
                        CardEditor(workspace: workspace, projectID: project.id, card: card,
                            onRefreshFailure: { loadError = $0 }).environment(model).id(sheet.id)
                    case .comment:
                        CommentEditor(workspace: workspace, projectID: project.id, cardID: card.id,
                            onRefreshFailure: { loadError = $0 }).environment(model).id(sheet.id)
                    case .move:
                        MoveCardSheet(workspace: workspace, projectID: project.id, card: card,
                            onRefreshFailure: { loadError = $0 }).environment(model).id(sheet.id)
                    case .activity:
                        ProjectActivity(workspace: workspace, projectID: project.id, cardID: card.id).environment(model).id(sheet.id)
                    }
                }
                .confirmationDialog(card.archivedAt == nil ? "Archive this Card?" : "Restore this Card to its previous Column?", isPresented: $confirmingArchive, titleVisibility: .visible) {
                    Button(card.archivedAt == nil ? "Archive Card" : "Restore Card", role: card.archivedAt == nil ? .destructive : nil) {
                        Task { await archive(card, workspace: workspace, archived: card.archivedAt == nil) }
                    }
                }
            } else if loading { ProgressView("Loading Card") }
            else {
                ContentUnavailableView {
                    Label("Card unavailable", systemImage: "rectangle")
                } description: {
                    Text(workspace == nil
                        ? "This Workspace is no longer available. Open the board to choose another Project."
                        : loadError ?? "The Card is no longer available. Refresh to check its current state.")
                } actions: {
                    if workspace != nil {
                        Button("Refresh") { Task { await refresh() } }.disabled(!canRefresh)
                    } else {
                        Button("Show Board") { openWindow(id: "board", value: BoardWindowID.main) }
                    }
                    Button("Close Window") { dismissWindow(id: "card", value: identity) }
                }
            }
        }
    }

    private func metadataRow(_ label: String, value: String) -> some View {
        LabeledContent(label) {
            Text(verbatim: value)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }.font(.body)
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.headline)
            .foregroundStyle(.primary)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(title)
            .accessibilityAddTraits(.isHeader)
            .accessibilityHeading(.h2)
    }

    private func closeIfUnauthorized() {
        if !model.restoring && (!model.signedIn || model.ownerID != identity.ownerID) {
            dismissWindow(id: "card", value: identity)
        }
    }

    private func refresh() async {
        guard let workspace else { return }
        loading = true
        defer { loading = false }
        do { try await model.loadProject(id: identity.projectID, in: workspace); loadError = nil }
        catch {
            guard !(error is CancellationError) else { return }
            loadError = error.localizedDescription
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
        }
    }

    private func archive(_ card: Card, workspace: Workspace, archived: Bool) async {
        mutating = true
        defer { mutating = false }
        do {
            try await model.archive(card, projectID: identity.projectID, in: workspace, archived: archived,
                onRefreshFailure: { loadError = $0 })
        } catch {
            guard !(error is CancellationError) else { return }
            loadError = model.isConflict(error) ? "The Card changed. Refresh and review it before trying again." : error.localizedDescription
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
        }
    }
}

private struct MoveCardSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let workspace: Workspace
    let projectID: String
    let card: Card
    var onRefreshFailure: ((String) -> Void)? = nil
    @State private var columnID: String
    @State private var saving = false
    @State private var reloading = false
    @State private var errorMessage: String?
    @State private var openingSession: UUID?

    private var project: Project? { model.project(id: projectID, in: workspace) }
    private var latest: Card? { project?.cards.first { $0.id == card.id } }
    private var validDestination: Bool { project?.columns.contains { $0.id == columnID } == true }
    private var readOnly: Bool { latest == nil || latest?.archivedAt != nil || project?.archivedAt != nil || !model.canEditProject(id: projectID, in: workspace) }

    init(workspace: Workspace, projectID: String, card: Card, onRefreshFailure: ((String) -> Void)? = nil) {
        self.workspace = workspace; self.projectID = projectID; self.card = card
        self.onRefreshFailure = onRefreshFailure
        _columnID = State(initialValue: card.columnId)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Card", value: latest?.title ?? card.title)
                    Picker("Column", selection: $columnID) {
                        ForEach(project?.columns.sorted { $0.position < $1.position } ?? []) { Text($0.name).tag($0.id) }
                    }.disabled(saving || reloading || readOnly)
                    if readOnly { Text("This Card or its Project is unavailable or archived. Reload to check its current state.") }
                    else if !validDestination { Text("This Column is no longer available. Choose another Column.") }
                    else if columnID == latest?.columnId { Text("The Card is already in the selected Column.") }
                    if saving { ProgressView("Moving Card") }
                    if reloading { ProgressView("Reloading Card") }
                    if let errorMessage { Text(errorMessage).textSelection(.enabled) }
                    Button("Reload Latest Card") { Task { await reload() } }.disabled(saving || reloading)
                }
            }.formStyle(.grouped)
            .navigationTitle("Move Card")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Move") { Task { await move() } }.keyboardShortcut(.defaultAction)
                        .disabled(saving || reloading || readOnly || !validDestination || columnID == latest?.columnId)
                }
            }
        }
        .frame(minWidth: 420, minHeight: 280)
        .interactiveDismissDisabled(saving)
        .task { openingSession = model.sessionID }
    }

    private func reload() async {
        guard openingSession == model.sessionID, model.signedIn else { return }
        reloading = true
        defer { reloading = false }
        do { try await model.loadProject(id: projectID, in: workspace); errorMessage = nil }
        catch {
            guard openingSession == model.sessionID, !(error is CancellationError) else { return }
            errorMessage = error.localizedDescription
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
        }
    }

    private func move() async {
        guard openingSession == model.sessionID, model.signedIn, !saving, !readOnly, validDestination else { return }
        saving = true
        defer { saving = false }
        do {
            _ = try await model.moveCard(cardID: card.id, to: columnID, projectID: projectID, in: workspace,
                onRefreshFailure: onRefreshFailure)
            if openingSession == model.sessionID { dismiss() }
        } catch {
            guard openingSession == model.sessionID, !(error is CancellationError) else { return }
            errorMessage = "The move could not be confirmed. Reload the latest Card, then retry the selected destination. \(error.localizedDescription)"
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
        }
    }
}
