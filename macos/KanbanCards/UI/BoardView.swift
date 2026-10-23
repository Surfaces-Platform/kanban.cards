import AppKit
import SwiftUI

struct BoardView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @Environment(\.scenePhase) private var scenePhase
    @State private var workspaceID: String?
    @State private var projectID: String?
    @State private var creatingProject = false
    @State private var creatingWorkspace = false
    @State private var showingWorkspaceActivity = false
    @State private var newProjectPresentation = UUID()
    @State private var openedExamples = false
    @State private var refreshing = false
    @State private var navigationError: String?
    @State private var cardInteractionLocked = false

    private var workspace: Workspace? { model.workspaces.first { $0.id == workspaceID } }
    private var hasNavigationSheet: Bool { creatingProject || creatingWorkspace || showingWorkspaceActivity }
    private var canCreateWorkspace: Bool { model.canCreateWorkspace && !hasNavigationSheet && !cardInteractionLocked && !refreshing }
    private var minimumWidth: CGFloat {
        let mode = CardInteractionMode.current
        return mode == .windows ? 760 : 1024
    }

    var body: some View {
        Group {
            if model.restoring {
                ProgressView("Opening kanban.cards")
            } else if model.signOutPending {
                ContentUnavailableView {
                    Label("Sign-out pending", systemImage: "person.crop.circle")
                } description: {
                    Text("Retry to confirm that this session has ended on the server.")
                } actions: {
                    Button("Retry sign-out") { Task { await model.signOut() } }
                        .disabled(model.endingSession)
                }
            } else if model.signedIn {
                NavigationSplitView {
                    sidebar.disabled(cardInteractionLocked).accessibilityElement(children: .contain).accessibilityLabel("Workspaces and Projects")
                } detail: {
                    if let workspace, let projectID {
                        ProjectBoard(workspace: workspace, projectID: projectID, parentSheet: hasNavigationSheet, onInteractionLockChanged: { cardInteractionLocked = $0 }, refreshInventory: { await refreshNavigation() })
                            .id("\(model.sessionID):\(workspace.id):\(projectID)")
                            .accessibilityElement(children: .contain).accessibilityLabel("Project board contents")
                    } else {
                        ContentUnavailableView("Select a Project", systemImage: "folder",
                            description: Text("Choose a Project to open its board."))
                    }
                }
            } else {
                Form {
                    Section {
                        Text("Open your Projects and keep work moving.")
                        Button("Continue with passkey", systemImage: "person.badge.key") {
                            Task { await model.signIn() }
                        }
                        .accessibilityIdentifier("session.sign-in")
                        .disabled(model.signingIn)
                        if model.signingIn { ProgressView("Signing in") }
                    } footer: {
                        Text("Use a passkey for your existing kanban.cards account.")
                    }
                }
                .formStyle(.grouped)
                .frame(maxWidth: 560)
            }
        }
        .frame(minWidth: minimumWidth, minHeight: 560)
        .background { NativeWindowAccessibility(label: "Project board").frame(width: 1, height: 1).accessibilityHidden(true) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Project board")
        .accessibilityIdentifier("board.window")
        .task { await model.restore(); selectWorkspace() }
        .onChange(of: model.workspaces) { _, _ in selectWorkspace() }
        .onChange(of: model.signedIn) { _, signedIn in
            if !signedIn { workspaceID = nil; projectID = nil; creatingProject = false; creatingWorkspace = false; showingWorkspaceActivity = false }
        }
        .onChange(of: model.sessionID) { _, _ in creatingWorkspace = false; creatingProject = false; showingWorkspaceActivity = false }
        .onChange(of: workspaceID) { _, _ in projectID = nil; showingWorkspaceActivity = false }
        .task(id: workspaceID) { await loadProjects() }
        .sheet(isPresented: $creatingProject) {
            if let workspace, model.signedIn {
                ProjectEditor(workspace: workspace, onRefreshFailure: { navigationError = $0 }).environment(model).id(newProjectPresentation)
            }
        }
        .sheet(isPresented: $creatingWorkspace) {
            WorkspaceEditor { created in
                workspaceID = created.id
                projectID = nil
                navigationError = nil
            }.environment(model)
        }
        .sheet(isPresented: $showingWorkspaceActivity) {
            if let workspace, model.signedIn {
                WorkspaceActivity(workspace: workspace).environment(model)
                    .id("\(model.sessionID):\(workspace.id):\(workspace.url)")
            }
        }
        .focusedSceneValue(\.boardWindowActions, BoardWindowActions(
            canCreateWorkspace: canCreateWorkspace,
            canCreateProject: workspace.map { model.canCreateProject(in: $0) } == true && !hasNavigationSheet && !cardInteractionLocked && !refreshing,
            canRefresh: model.signedIn && !hasNavigationSheet && !cardInteractionLocked && !refreshing,
            createWorkspace: { if canCreateWorkspace { creatingWorkspace = true } },
            createProject: {
                if let workspace, model.canCreateProject(in: workspace), !hasNavigationSheet, !cardInteractionLocked {
                    newProjectPresentation = UUID(); creatingProject = true
                }
            },
            refresh: { Task { await refreshNavigation() } }))
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.validateSession(); Task { await refreshNavigation() } }
        }
        .safeAreaInset(edge: .bottom) {
            if let message = navigationError ?? model.errorMessage {
                VStack(alignment: .leading) {
                    Text(message).textSelection(.enabled)
                    HStack {
                        if model.signedIn { Button("Retry refresh") { Task { await refreshNavigation() } } }
                        Button("Dismiss") { navigationError = nil; model.errorMessage = nil }
                    }
                }.padding().accessibilityElement(children: .contain)
            }
        }
    }

    private var sidebar: some View {
        List(selection: $projectID) {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Workspace").font(.caption).foregroundStyle(.primary)
                    if !model.workspaces.isEmpty {
                        NativePopUpPicker(label: "Workspace", selection: $workspaceID,
                            options: model.workspaces.map { NativePopUpOption(title: $0.name, value: Optional($0.id)) },
                            identifier: "board.workspace", actions: [
                                NativeMenuAction(title: "New Workspace…", systemImage: "plus", isEnabled: canCreateWorkspace,
                                    perform: { if canCreateWorkspace { creatingWorkspace = true } })
                            ])
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if model.workspaces.isEmpty {
                    Button("New Workspace…", systemImage: "plus") { creatingWorkspace = true }
                        .accessibilityIdentifier("board.new-workspace")
                        .disabled(!canCreateWorkspace)
                }
                if model.loadingWorkspaces { ProgressView("Loading Workspaces") }
                if workspace != nil {
                    Button("Workspace Activity", systemImage: "clock") { showingWorkspaceActivity = true }
                        .accessibilityIdentifier("board.workspace-activity")
                        .disabled(hasNavigationSheet)
                }
                if model.workspaces.isEmpty && !model.loadingWorkspaces {
                    Text(model.workspaceLoadFailed ? "Workspaces unavailable" : "No Workspaces")
                    Button("Retry") { Task { await model.refreshWorkspaces() } }
                }
            }
            if let workspace {
                let projects = model.projects(in: workspace)
                let activeProjects = projects.filter { $0.archivedAt == nil }
                Section {
                    ForEach(activeProjects) { project in
                        Label(project.name, systemImage: "folder").tag(project.id)
                            .accessibilityIdentifier("board.project.\(project.id)")
                    }
                    if model.projectListLoading(in: workspace) { ProgressView("Loading Projects") }
                    else if let error = model.projectListError(in: workspace) {
                        Text("Projects could not be refreshed. \(error)")
                        Button("Retry Projects") { Task { await loadProjects() } }
                    } else if activeProjects.isEmpty {
                        Text(projects.isEmpty ? "No Projects" : "No active Projects")
                    }
                    Button("New Project…", systemImage: "plus") { newProjectPresentation = UUID(); creatingProject = true }
                        .disabled(hasNavigationSheet || !model.canCreateProject(in: workspace))
                } header: {
                    Text("Projects")
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("Projects")
                        .accessibilityAddTraits(.isHeader)
                }
                let archived = projects.filter { $0.archivedAt != nil }
                if !archived.isEmpty {
                    Section("Archived Projects") {
                        ForEach(archived) { project in
                            Label(project.name, systemImage: "archivebox").tag(project.id)
                        }
                    }
                }
            }
            Section {
                if model.isDemo { Text("Demo data").foregroundStyle(.primary) }
                Button("Sign Out", systemImage: "person.crop.circle") { Task { await model.signOut() } }
                    .accessibilityIdentifier("session.sign-out")
            }
        }
        .navigationTitle("kanban.cards")
        .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 300)
    }

    private func selectWorkspace() {
        guard model.signedIn else { return }
        if !model.workspaces.contains(where: { $0.id == workspaceID }) {
            workspaceID = model.workspaces.first?.id
        }
    }

    private func loadProjects() async {
        guard let workspace, model.signedIn else { return }
        let session = model.sessionID
        do {
            try await model.loadProjects(in: workspace, includeArchived: true)
            guard session == model.sessionID, workspaceID == workspace.id else { return }
            if projectID == nil { projectID = model.projects(in: workspace).first(where: { $0.archivedAt == nil })?.id }
            #if DEBUG
            if model.isDemo, !openedExamples, ProcessInfo.processInfo.arguments.contains("--open-example-cards"), let projectID {
                openedExamples = true
                if let project = model.project(id: projectID, in: workspace) {
                    for cardID in ["demo-card-homepage", "demo-card-signup"] {
                        if let card = project.cards.first(where: { $0.id == cardID }) {
                            openWindow(id: "card", value: CardWindowID(ownerID: model.ownerID,
                                workspaceID: workspace.id, projectID: projectID, cardID: card.id))
                        }
                    }
                }
            }
            #endif
        } catch {
            guard !(error is CancellationError) else { return }
            navigationError = error.localizedDescription
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
        }
    }

    private func refreshNavigation() async {
        guard model.signedIn, !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            try await model.refreshInventory(workspaceID: workspaceID, projectID: projectID)
            selectWorkspace()
            if let workspace, !model.projects(in: workspace).contains(where: { $0.id == projectID }) {
                projectID = model.projects(in: workspace).first(where: { $0.archivedAt == nil })?.id
            }
            navigationError = nil
        } catch {
            guard !(error is CancellationError) else { return }
            navigationError = error.localizedDescription
        }
    }
}

struct ProjectBoard: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @Environment(\.scenePhase) private var scenePhase
    let workspace: Workspace
    let projectID: String
    var parentSheet = false
    var onInteractionLockChanged: (Bool) -> Void = { _ in }
    @State private var inspectorPresented = false
    @State private var focusedColumnID: String?
    @State private var showingColumnDetail = false
    @State private var embeddedInteractionLocked = false
    var refreshInventory: () async -> Void = {}
    @State private var confirmingArchive = false
    @State private var mutating = false
    @State private var filter = CardFilter()
    @State private var filtersPresented = false
    @State private var selectedCardID: String?
    @FocusState private var columnListFocused: Bool
    @State private var creating = false
    @State private var cardPresentation = UUID()
    @State private var projectPresentation = UUID()
    @State private var editing = false
    private enum ContextSheetKind { case move, activity }
    private struct ContextSheet: Identifiable {
        let id = UUID()
        let card: Card
        let kind: ContextSheetKind
    }
    @State private var contextSheet: ContextSheet?
    @State private var contextArchiveCard: Card?
    @State private var showingActivity = false
    @State private var loading = false
    @State private var loadError: String?
    private var project: Project? { model.project(id: projectID, in: workspace) }
    private var interactionMode: CardInteractionMode { .current }
    private var selectedCard: Card? { project?.cards.first { $0.id == selectedCardID } }
    private var hasSheet: Bool { parentSheet || creating || editing || showingActivity || confirmingArchive || contextSheet != nil || contextArchiveCard != nil || embeddedInteractionLocked }
    private var canEdit: Bool { project != nil && project?.archivedAt == nil && !hasSheet && !mutating && model.canEditProject(id: projectID, in: workspace) }

    var body: some View {
        ZStack {
            if let project {
                Group {
                    if interactionMode == .columnList && showingColumnDetail {
                        columnDetail(project)
                    } else if interactionMode == .inspector, inspectorPresented, let card = selectedCard {
                        HSplitView {
                            boardSurface(project)
                                .frame(minWidth: 230, maxWidth: .infinity, maxHeight: .infinity)
                            embeddedCard(card)
                                .frame(minWidth: 320, idealWidth: 380, maxWidth: 520, maxHeight: .infinity)
                        }
                    } else {
                        boardSurface(project)
                    }
                }
                .sheet(isPresented: $creating) {
                    CardEditor(workspace: workspace, projectID: projectID, card: nil,
                        onCreated: { card in creating = false; open(card) }, onRefreshFailure: { loadError = $0 }).environment(model).id(cardPresentation)
                }
                .sheet(isPresented: $editing) {
                    ProjectEditor(workspace: workspace, project: project, onRefreshFailure: { loadError = $0 }).environment(model).id(projectPresentation)
                }
                .sheet(isPresented: $showingActivity) { ProjectActivity(workspace: workspace, projectID: projectID).environment(model) }
                .confirmationDialog(project.archivedAt == nil ? "Archive this Project?" : "Restore this Project?", isPresented: $confirmingArchive, titleVisibility: .visible) {
                    Button(project.archivedAt == nil ? "Archive Project" : "Restore Project", role: project.archivedAt == nil ? .destructive : nil) {
                        Task { await archiveProject(project) }
                    }.accessibilityIdentifier(project.archivedAt == nil ? "project.archive-confirm" : "project.restore-confirm")
                } message: { Text("Cards remain in the Project. Archived Projects are read-only until restored.") }
            } else if loading {
                ProgressView("Loading Project")
            } else {
                ContentUnavailableView {
                    Label("Project unavailable", systemImage: "folder")
                } description: { Text(loadError ?? "Refresh to open this Project.") }
                actions: { Button("Retry") { Task { await refresh() } } }
            }
        }
        .sheet(item: $contextSheet) { item in
            switch item.kind {
            case .move:
                MoveCardSheet(workspace: workspace, projectID: projectID, card: item.card,
                    onRefreshFailure: { loadError = $0 }).environment(model)
            case .activity:
                ProjectActivity(workspace: workspace, projectID: projectID, cardID: item.card.id).environment(model)
            }
        }
        .confirmationDialog(contextArchiveCard?.archivedAt == nil ? "Archive this Card?" : "Restore this Card to its previous Column?",
            isPresented: Binding(get: { contextArchiveCard != nil }, set: { if !$0 { contextArchiveCard = nil } }),
            titleVisibility: .visible) {
            if let card = contextArchiveCard {
                Button(card.archivedAt == nil ? "Archive Card" : "Restore Card", role: card.archivedAt == nil ? .destructive : nil) {
                    contextArchiveCard = nil
                    Task { await archiveCard(card) }
                }.accessibilityIdentifier("card.archive-confirm.\(card.id)")
            }
        }
        .navigationTitle(project?.name ?? "Project")
        .navigationSubtitle(workspace.name)
        .searchable(text: $filter.search, prompt: "Search Cards")
        .toolbar {
            ToolbarItem { Button("Activity…", systemImage: "clock") { showingActivity = true }.disabled(project == nil || hasSheet) }
            ToolbarItem { Button("Refresh", systemImage: "arrow.clockwise") { Task { await refreshInventory() } }.disabled(hasSheet || loading || mutating) }
            ToolbarItem(placement: .primaryAction) {
                Button("New Card", systemImage: "plus") { cardPresentation = UUID(); creating = true }
                    .accessibilityIdentifier("board.new-card")
                    .disabled(!canEdit || project?.columns.isEmpty == true)
            }
        }
        .focusedSceneValue(\.projectWindowActions, ProjectWindowActions(
            hasSheet: hasSheet, canEdit: canEdit,
            canCreateCard: canEdit && project?.columns.isEmpty == false,
            canShowActivity: project != nil && !hasSheet && !mutating,
            canArchive: project != nil && !hasSheet && !mutating && model.canEditProject(id: projectID, in: workspace),
            archived: project?.archivedAt != nil,
            edit: { if canEdit { projectPresentation = UUID(); editing = true } },
            createCard: { if canEdit { cardPresentation = UUID(); creating = true } },
            activity: { if project != nil && !hasSheet { showingActivity = true } },
            archive: { if project != nil && !hasSheet && !mutating && model.canEditProject(id: projectID, in: workspace) { confirmingArchive = true } }))
        .task { await refresh() }
        .onChange(of: filter) { _, _ in reconcileColumnSelection() }
        .onChange(of: project?.revision) { _, _ in reconcileColumnSelection() }
        .onChange(of: embeddedInteractionLocked) { _, locked in
            if !locked { reconcileColumnSelection() }
        }
        .onChange(of: selectedCard?.columnId) { _, columnID in
            if interactionMode == .columnList, let columnID { focusedColumnID = columnID }
        }
        .onChange(of: selectedCard?.id) { _, id in
            if id == nil { inspectorPresented = false }
        }
        .onChange(of: creating || editing || showingActivity || confirmingArchive || contextSheet != nil || contextArchiveCard != nil || embeddedInteractionLocked || mutating, initial: true) { _, locked in onInteractionLockChanged(locked) }
        .onDisappear { onInteractionLockChanged(false) }
        .onChange(of: project?.id) { _, id in
            if id == nil { creating = false; editing = false; showingActivity = false; confirmingArchive = false; contextSheet = nil; contextArchiveCard = nil }
        }
    }

    private func boardSurface(_ project: Project) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                actorFilter
                priorityFilter
                blockedFilter
                archivedFilter
                clearFiltersButton.disabled(filter.refinementCount == 0)
                Spacer(minLength: 0)
            }
            .lineLimit(1)
            .controlSize(.small)
            .frame(minHeight: 24)
            .padding(.horizontal)
            .padding(.vertical, 12)
            .disabled(hasSheet || mutating)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Board controls")
            .accessibilityIdentifier("board.control-strip")
            Divider()
            boardStatus(project)
            boardColumns(project)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Board surface")
        .accessibilityIdentifier("board.surface")
    }

    @ViewBuilder private func boardStatus(_ project: Project) -> some View {
        if project.archivedAt != nil || !model.canEditProject(id: projectID, in: workspace)
            || loadError != nil || loading || mutating || filter.active {
            VStack(alignment: .leading, spacing: 8) {
                if project.archivedAt != nil {
                    Text("Archived Project. Cards are read-only.").foregroundStyle(.secondary)
                } else if !model.canEditProject(id: projectID, in: workspace) {
                    Label("Read-only", systemImage: "lock").font(.subheadline)
                }
                if let loadError {
                    Text(loadError).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("board.error")
                    Button("Retry refresh") { Task { await refresh() } }
                        .disabled(loading || hasSheet || mutating)
                }
                if loading { ProgressView("Refreshing Project") }
                if mutating { ProgressView("Updating Project") }
                if filter.active {
                    Text(activeFilterSummary)
                        .font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("board.filter-summary")
                }
            }
            .controlSize(.small)
            .padding()
        }
    }

    @ViewBuilder private func boardColumns(_ project: Project) -> some View {
        if project.columns.isEmpty {
            ContentUnavailableView("No Columns", systemImage: "rectangle.split.3x1")
        } else {
            ScrollView(.horizontal) {
                HSplitView {
                    ForEach(project.columns.sorted { $0.position < $1.position }) { column in
                        BoardColumn(column: column,
                            cards: project.cards.filter { $0.columnId == column.id && filter.includes($0) }
                                .sorted { $0.position < $1.position },
                            filtered: filter.active, selectedCardID: cardSelection,
                            compact: interactionMode == .inspector, opensWindow: interactionMode == .windows,
                            interactionDisabled: hasSheet || mutating, open: open, contextMenu: cardContextMenu)
                    }
                }
                .containerRelativeFrame(.horizontal) { width, _ in
                    max(width, CGFloat(project.columns.count) * 250)
                }
            }
        }
    }

    private func showInspector() {
        inspectorPresented = true
    }

    private func embeddedCard(_ card: Card) -> some View {
        CardWindowView(identity: CardWindowID(ownerID: model.ownerID, workspaceID: workspace.id,
            projectID: projectID, cardID: card.id), embedded: true,
            interactionDisabled: parentSheet || creating || editing || showingActivity || confirmingArchive || contextSheet != nil || contextArchiveCard != nil || mutating,
            onClose: {
                selectedCardID = nil
                inspectorPresented = false
                showingColumnDetail = false
            }, onInteractionLockChanged: { embeddedInteractionLocked = $0 })
            .id(card.id)
    }

    private func columnDetail(_ project: Project) -> some View {
        let columnID = focusedColumnID ?? project.columns.sorted { $0.position < $1.position }.first?.id
        let columnCards = project.cards.filter { $0.columnId == columnID }
        let cards = columnCards.filter(filter.includes).sorted { $0.position < $1.position }
        return HSplitView {
            VStack(alignment: .leading, spacing: 0) {
                columnHeader(project)
                Divider()
                boardStatus(project)
                List(selection: cardSelection) {
                    ForEach(cards) { card in
                        Button { open(card) } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(card.title).font(.headline)
                                Text([card.nextActor?.label ?? "Unassigned", card.priority.map { "\($0.rawValue) priority" } ?? "Unset priority"].joined(separator: " · "))
                                    .font(.caption).foregroundStyle(.secondary)
                                if !card.blockedReason.isEmpty { Text("Blocked").font(.caption) }
                                if card.archivedAt != nil { Label("Archived", systemImage: "archivebox").font(.caption) }
                            }.padding(.vertical, 6).padding(.horizontal).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).tag(card.id)
                        .listRowInsets(.horizontal, 0)
                        .contextMenu { cardContextMenu(card) }
                        .help("Show Card details")
                        .accessibilityIdentifier("board.card.\(card.id)")
                    }
                    if cards.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(filter.active ? "No matching Cards" : "No Cards").foregroundStyle(.secondary)
                            if filter.refinementCount > 0 {
                                Button("Clear filters") { filter.clearRefinements() }
                                    .accessibilityIdentifier("board.empty.clear-filters")
                            }
                            if !filter.search.isEmpty {
                                Button("Clear search") { filter.search = "" }
                                    .accessibilityIdentifier("board.empty.clear-search")
                            }
                        }.padding(.vertical, 8)
                    }
                }.listStyle(.plain)
                    .focused($columnListFocused)
                    .accessibilityLabel("Selected Column Cards")
            }
            .disabled(hasSheet || mutating)
            .frame(minWidth: 230, idealWidth: 360, maxWidth: 440, maxHeight: .infinity)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Column list")
            .accessibilityIdentifier("board.column-list")
            // Keep the split pane stable while the selected Card viewer changes.
            VStack(spacing: 0) {
                if let card = selectedCard { embeddedCard(card) }
                else { ContentUnavailableView("Select a Card", systemImage: "rectangle", description: Text("Choose a Card from this Column.")) }
            }.frame(minWidth: 320, maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func columnHeader(_ project: Project) -> some View {
        HStack(spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    returnToBoard.labelStyle(.titleAndIcon)
                    LabeledContent("Column") { focusedColumnPicker(project) }
                }.fixedSize(horizontal: true, vertical: false)
                HStack(spacing: 8) {
                    returnToBoard.labelStyle(.iconOnly).fixedSize()
                    focusedColumnPicker(project)
                }
            }.layoutPriority(1)
            Spacer(minLength: 0)
            filtersControl
        }
        .controlSize(.small)
        .frame(minHeight: 24)
        .padding(.horizontal)
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Column controls")
        .accessibilityIdentifier("board.column-header")
    }

    private var returnToBoard: some View {
        Button("Board", systemImage: "rectangle.split.3x1") {
            filtersPresented = false
            showingColumnDetail = false; selectedCardID = nil
        }
        .accessibilityLabel("Back to board")
        .accessibilityIdentifier("board.return-to-board")
        .help("Back to board")
    }

    private func focusedColumnPicker(_ project: Project) -> some View {
        NativePopUpPicker(label: "Column", selection: Binding(
            get: { focusedColumnID ?? project.columns.sorted { $0.position < $1.position }.first?.id ?? "" },
            set: { selectColumn($0, project: project) }),
            options: project.columns.sorted { $0.position < $1.position }.map { .init(title: $0.name, value: $0.id) },
            identifier: "board.focused-column")
    }

    private var filtersControl: some View {
        ViewThatFits(in: .horizontal) {
            filtersButton.labelStyle(.titleAndIcon).fixedSize()
            filtersButton.labelStyle(.iconOnly).fixedSize()
        }
        .popover(isPresented: $filtersPresented, arrowEdge: .trailing) { filterPopover }
    }

    private var filtersButton: some View {
        Button(filter.refinementCount == 0 ? "Filters" : "Filters (\(filter.refinementCount))",
               systemImage: "line.3.horizontal.decrease") { filtersPresented.toggle() }
            .accessibilityLabel("Filters")
            .accessibilityValue(filter.refinementCount == 0 ? "No active filters" : "\(filter.refinementCount) active filters")
            .accessibilityIdentifier("board.filters")
            .help(filter.refinementCount == 0 ? "Filters" : "Filters (\(filter.refinementCount))")
    }

    private var filterPopover: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Filters").font(.headline)
                Spacer()
                Button("Done") { filtersPresented = false }
                    .accessibilityIdentifier("board.filters.done")
                    .keyboardShortcut(.defaultAction)
            }
            actorFilter
            priorityFilter
            blockedFilter
            archivedFilter
            clearFilters
        }
        .controlSize(.small).padding().frame(width: 300)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("board.filter-popover")
    }

    private var activeFilterSummary: String {
        var criteria: [String] = []
        if filter.actor != "all" {
            let actor = filter.actor == "human" ? "You" : filter.actor == "agent" ? "Agent" : "Unassigned"
            criteria.append("Next actor: \(actor)")
        }
        if filter.priority != "all" {
            criteria.append("Priority: \(filter.priority == "unset" ? "Unset" : filter.priority)")
        }
        if filter.blocked != "all" {
            criteria.append(filter.blocked == "true" ? "Blocked" : "Unblocked")
        }
        if filter.includesArchived { criteria.append("Include archived") }
        if !filter.search.isEmpty { criteria.append("Search: \(filter.search)") }
        return criteria.joined(separator: " · ")
    }

    private func reconcileColumnSelection() {
        guard interactionMode == .columnList, showingColumnDetail, !hasSheet, !mutating, let project else { return }
        if selectedCard.map({ !filter.includes($0) }) ?? true {
            selectColumn(focusedColumnID ?? project.columns.sorted { $0.position < $1.position }.first?.id ?? "", project: project)
        }
    }

    private func selectColumn(_ columnID: String, project: Project) {
        focusedColumnID = columnID
        selectedCardID = project.cards.filter { $0.columnId == columnID && filter.includes($0) }
            .sorted { $0.position < $1.position }.first?.id
    }

    private var actorFilter: some View {
        LabeledContent("Next actor") {
            NativePopUpPicker(label: "Next actor", selection: $filter.actor, options: [
                .init(title: "All actors", value: "all"), .init(title: "You", value: "human"),
                .init(title: "Agent", value: "agent"), .init(title: "Unassigned", value: "unassigned")
            ], identifier: "board.filter.actor")
        }
    }

    private var priorityFilter: some View {
        LabeledContent("Priority") {
            NativePopUpPicker(label: "Priority", selection: $filter.priority,
                options: [.init(title: "All priorities", value: "all")]
                    + CardPriority.allCases.map { NativePopUpOption(title: $0.rawValue, value: $0.rawValue) }
                    + [.init(title: "Unset", value: "unset")], identifier: "board.filter.priority")
        }
    }

    private var blockedFilter: some View {
        LabeledContent("Blocked") {
            NativePopUpPicker(label: "Blocked", selection: $filter.blocked, options: [
                .init(title: "All", value: "all"), .init(title: "Blocked", value: "true"),
                .init(title: "Unblocked", value: "false")
            ], identifier: "board.filter.blocked")
        }
    }

    private var archivedFilter: some View {
        Toggle("Include archived", isOn: $filter.includesArchived)
            .accessibilityIdentifier("board.filter.archived")
    }

    private var clearFiltersButton: some View {
        Button("Clear filters") { filter.clearRefinements() }
            .accessibilityIdentifier("board.clear-filters")
    }

    @ViewBuilder private var clearFilters: some View {
        if filter.refinementCount > 0 { clearFiltersButton }
    }

    private var cardSelection: Binding<String?> {
        Binding(get: { selectedCardID }, set: { id in
            // Opening a native context menu must not activate its Card.
            if let event = NSApp.currentEvent,
               event.type == .rightMouseDown || event.type == .rightMouseUp
               || (event.modifierFlags.contains(.control)
                   && (event.type == .leftMouseDown || event.type == .leftMouseUp)) { return }
            guard !hasSheet, !mutating else { return }
            selectedCardID = id
            if interactionMode != .windows, let card = project?.cards.first(where: { $0.id == id }) { open(card) }
        })
    }

    private func openCardWindow(_ card: Card) {
        guard model.signedIn, !hasSheet, !mutating else { return }
        openWindow(id: "card", value: CardWindowID(ownerID: model.ownerID,
            workspaceID: workspace.id, projectID: projectID, cardID: card.id))
    }

    private func cardContextMenu(_ card: Card) -> CardContextMenu {
        let available = model.signedIn && !hasSheet && !mutating
        let writable = available && project?.archivedAt == nil && model.canEditProject(id: projectID, in: workspace)
        return CardContextMenu(archived: card.archivedAt != nil,
            canOpen: available, canEdit: writable && card.archivedAt == nil, canArchive: writable,
            open: { openCardWindow(card) },
            move: { contextSheet = ContextSheet(card: card, kind: .move) },
            activity: { contextSheet = ContextSheet(card: card, kind: .activity) },
            archive: { contextArchiveCard = card })
    }

    private func archiveCard(_ card: Card) async {
        mutating = true
        defer { mutating = false }
        do {
            try await model.archive(card, projectID: projectID, in: workspace, archived: card.archivedAt == nil,
                onRefreshFailure: { loadError = $0 })
        } catch {
            guard !(error is CancellationError) else { return }
            loadError = model.isConflict(error) ? "The Card changed. Refresh and review it before trying again." : error.localizedDescription
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
        }
    }

    private func open(_ card: Card) {
        guard model.signedIn, !hasSheet, !mutating else { return }
        selectedCardID = card.id
        switch interactionMode {
        case .windows:
            openWindow(id: "card", value: CardWindowID(ownerID: model.ownerID,
                workspaceID: workspace.id, projectID: projectID, cardID: card.id))
        case .inspector:
            showInspector()
        case .columnList:
            focusedColumnID = card.columnId
            showingColumnDetail = true
            columnListFocused = true
        }
    }

    private func refresh() async {
        loading = true
        defer { loading = false }
        do { try await model.loadProject(id: projectID, in: workspace); loadError = nil }
        catch {
            guard !(error is CancellationError) else { return }
            loadError = error.localizedDescription
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
        }
    }

    private func archiveProject(_ project: Project) async {
        mutating = true
        defer { mutating = false }
        do {
            loadError = nil
            try await model.archiveProject(project, in: workspace, archived: project.archivedAt == nil, onRefreshFailure: { loadError = $0 })
        } catch {
            guard !(error is CancellationError) else { return }
            loadError = model.isConflict(error) ? "The Project changed. Refresh and review it before trying again." : error.localizedDescription
            if (error as? APIError)?.isUnauthorized == true { model.handle(error) }
        }
    }
}

private struct BoardColumn: View {
    let column: Column
    let cards: [Card]
    let filtered: Bool
    @Binding var selectedCardID: String?
    var compact = false
    var opensWindow = true
    var interactionDisabled = false
    let open: (Card) -> Void
    let contextMenu: (Card) -> CardContextMenu

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(column.name).font(.headline)
                Spacer()
                Text("\(cards.count)").foregroundStyle(.primary)
            }
            .padding()
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(column.name), \(cards.count) Cards")
            .accessibilityAddTraits(.isHeader)
            List(selection: $selectedCardID) {
                ForEach(cards) { card in
                    Button { open(card) } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(card.title).font(.headline).lineLimit(2)
                            Text([card.nextActor?.label ?? "Unassigned", card.priority.map { "\($0.rawValue) priority" } ?? "Unset priority"].joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                            if !compact {
                                Text(card.nextAction.isEmpty ? "No next action yet" : card.nextAction)
                                    .font(.callout).foregroundStyle(.secondary).lineLimit(2)
                            }
                            if !card.blockedReason.isEmpty { Label("Blocked: \(card.blockedReason)", systemImage: "exclamationmark.circle").font(.caption).lineLimit(2) }
                            if card.archivedAt != nil { Label("Archived", systemImage: "archivebox").font(.caption) }
                        }
                        .padding(.vertical, 8)
                        .padding(.horizontal)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .tag(card.id)
                    .listRowInsets(.horizontal, 0)
                    .contextMenu { contextMenu(card) }
                    .help(opensWindow ? "Open Card in a window" : "Show Card details")
                    .disabled(interactionDisabled)
                    .accessibilityIdentifier("board.card.\(card.id)")
                }
                if cards.isEmpty { Text(filtered ? "No matching Cards" : "No Cards").foregroundStyle(.secondary) }
            }
            .listStyle(.plain)
            .disabled(interactionDisabled)
            .scrollContentBackground(.hidden)
            .accessibilityLabel("\(column.name) Cards")
        }
        .frame(minWidth: 230, idealWidth: 300, maxWidth: .infinity, maxHeight: .infinity)
        .background(.background.secondary)
        .padding(.horizontal, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(column.name), \(cards.count) Cards")
        .accessibilityIdentifier("board.column.\(column.id)")
    }
}

struct ProjectActivity: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let workspace: Workspace
    let projectID: String
    var cardID: String? = nil
    var body: some View {
        NavigationStack {
            List {
                let items = (model.project(id: projectID, in: workspace)?.activity ?? [])
                    .filter { cardID == nil || $0.cardId == cardID }.reversed()
                ForEach(Array(items)) { item in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(item.summary)
                        Text("By \(item.actor.label)").font(.caption).foregroundStyle(.secondary)
                        if let date = ServerTimestamp.date(from: item.createdAt) { Text(date, format: .dateTime).font(.caption).foregroundStyle(.secondary) }
                    }.padding(.vertical, 4)
                }
                if items.isEmpty { ContentUnavailableView("No Activity", systemImage: "clock") }
            }
            .navigationTitle("Activity")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.keyboardShortcut(.cancelAction) } }
        }
        .frame(minWidth: 460, minHeight: 400)
    }
}
