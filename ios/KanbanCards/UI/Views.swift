import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var workspaceID: String?
    @State private var creatingWorkspace = false
    private var workspace: Workspace? { model.workspaces.first { $0.id == workspaceID } }

    var body: some View {
        NavigationStack {
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
                if let workspace {
                    ProjectsView(workspace: workspace, workspaceID: $workspaceID,
                        createWorkspace: { creatingWorkspace = true })
                        .id(workspace.id)
                } else {
                    List {
                        if model.loadingWorkspaces { ProgressView("Loading Workspaces") }
                        ForEach(model.workspaces) { workspace in
                            Button(workspace.name) { workspaceID = workspace.id }
                        }
                        if !model.loadingWorkspaces && model.workspaces.isEmpty {
                            ContentUnavailableView(model.workspaceLoadFailed ? "Workspaces unavailable" : "No Workspaces", systemImage: "folder")
                            Button("New Workspace", systemImage: "plus") { creatingWorkspace = true }
                                .accessibilityIdentifier("workspace.new")
                                .disabled(!model.canCreateWorkspace)
                            Button("Retry loading Workspaces") { Task { await model.refreshWorkspaces() } }
                        }
                    }
                    .refreshable { await model.refreshWorkspaces() }
                    .navigationTitle("Workspaces")
                    .toolbar { ToolbarItem { NavigationLink { AccountView() } label: { Label("Account", systemImage: "person.crop.circle") } } }
                }
            } else {
                Form {
                    Section {
                        Text("Open your Projects and keep work moving.")
                        Button("Continue with passkey", systemImage: "person.badge.key") { Task { await model.signIn() } }
                            .disabled(model.signingIn)
                        if model.signingIn { ProgressView("Signing in") }
                    } footer: {
                        Text("Use a passkey for your existing kanban.cards account.")
                    }
                }
                .navigationTitle("kanban.cards")
            }
        }
        .id(model.ownerID)
        .task { await model.restore(); selectWorkspace() }
        .onChange(of: model.workspaces) { _, _ in selectWorkspace() }
        .onChange(of: model.signedIn) { _, signedIn in
            if !signedIn { workspaceID = nil; creatingWorkspace = false }
        }
        .sheet(isPresented: $creatingWorkspace) {
            WorkspaceEditor { workspaceID = $0.id }.environment(model)
        }
        .alert("Unable to complete the action", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("OK", role: .cancel) { model.errorMessage = nil }
        } message: { Text(model.errorMessage ?? "") }
    }

    private func selectWorkspace() {
        if !model.workspaces.contains(where: { $0.id == workspaceID }) {
            workspaceID = model.workspaces.first?.id
        }
    }
}

struct AccountView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Form {
            if model.isDemo { Section { Text("Demo data. Changes stay in memory and never reach the server.") } }
            Section {
                Button("Sign out", role: .destructive) { Task { await model.signOut() } }
                    .disabled(model.endingSession)
            }
        }
        .navigationTitle("Account")
    }
}

struct ProjectsView: View {
    @Environment(AppModel.self) private var model
    let workspace: Workspace
    @Binding var workspaceID: String?
    let createWorkspace: () -> Void
    @State private var loading = false
    @State private var creating = false
    private var activeProjects: [ProjectSummary] { (model.projectLists[workspace.id] ?? []).filter { $0.archivedAt == nil } }

    var body: some View {
        List {
            if loading { ProgressView("Loading Projects") }
            ForEach(activeProjects) { project in
                NavigationLink { ProjectView(workspace: workspace, projectID: project.id) } label: {
                    LabeledContent(project.name, value: "\(project.cardCount) Cards")
                }
            }
            if !loading && activeProjects.isEmpty {
                ContentUnavailableView("No Projects", systemImage: "folder", description: Text("Create a Project to start organizing work."))
                Button("Create Project") { creating = true }
            }
            Section {
                NavigationLink("Archived Projects") { ArchivedProjectsView(workspace: workspace) }
                    .accessibilityIdentifier("project.archived")
            }
        }
        .navigationTitle(workspace.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarTitleMenu {
            Picker("Workspace", selection: $workspaceID) {
                ForEach(model.workspaces) { Text($0.name).tag(Optional($0.id)) }
            }
            Divider()
            Button("New Workspace…", systemImage: "plus", action: createWorkspace)
                .accessibilityIdentifier("workspace.new")
                .disabled(!model.canCreateWorkspace || creating)
        }
        .toolbar {
            ToolbarItem { NavigationLink { AccountView() } label: { Label("Account", systemImage: "person.crop.circle") } }
            ToolbarItem(placement: .primaryAction) { Button("New Project", systemImage: "plus") { creating = true } }
        }
        .sheet(isPresented: $creating) { ProjectEditor(workspace: workspace) }
        .task { await refresh() }
        .refreshable { await refresh() }
    }

    private func refresh() async {
        loading = true
        defer { loading = false }
        do { try await model.loadProjects(in: workspace) } catch { model.handle(error) }
    }
}

struct ArchivedProjectsView: View {
    @Environment(AppModel.self) private var model
    let workspace: Workspace
    @State private var loading = true
    @State private var loadFailed = false
    private var projects: [ProjectSummary] { (model.projectLists[workspace.id] ?? []).filter { $0.archivedAt != nil } }

    var body: some View {
        List {
            if loading { ProgressView("Loading Archived Projects") }
            ForEach(projects) { project in
                NavigationLink { ProjectView(workspace: workspace, projectID: project.id, readOnly: true) } label: {
                    LabeledContent(project.name, value: "\(project.cardCount) Cards")
                }
                .accessibilityIdentifier("archive.project.\(project.id)")
            }
            if loadFailed {
                ContentUnavailableView {
                    Label("Archived Projects unavailable", systemImage: "archivebox")
                } actions: {
                    Button("Retry") { Task { await refresh() } }
                }
            } else if !loading && projects.isEmpty {
                ContentUnavailableView("No archived Projects", systemImage: "archivebox")
            }
        }
        .navigationTitle("Archived Projects")
        .task { await refresh() }
        .refreshable { await refresh() }
    }

    private func refresh() async {
        loading = true
        defer { loading = false }
        do {
            try await model.loadProjects(in: workspace)
            loadFailed = false
        } catch {
            loadFailed = true
            model.handle(error)
        }
    }
}

struct CardFilter: Equatable {
    var actor = "all"
    var priority = "all"
    var blocked = "all"
    var active: Bool { self != CardFilter() }
    func includes(_ card: Card) -> Bool {
        (actor == "all" || (card.nextActor?.rawValue ?? "unassigned") == actor)
        && (priority == "all" || (card.priority?.rawValue ?? "unset") == priority)
        && (blocked == "all" || (card.blockedReason.isEmpty ? "false" : "true") == blocked)
    }
}

struct ProjectView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    let workspace: Workspace
    let projectID: String
    let readOnly: Bool
    @State private var creating = false
    @State private var editing = false
    @State private var filtering = false
    @State private var filter = CardFilter()
    @State private var loading = false
    private var project: Project? { model.loadedProjects[projectID] }
    private var projectReadOnly: Bool { readOnly || project?.archivedAt != nil }

    init(workspace: Workspace, projectID: String, readOnly: Bool = false) {
        self.workspace = workspace
        self.projectID = projectID
        self.readOnly = readOnly
    }

    var body: some View {
        Group {
            if let project {
                List {
                    if model.isDemo { Section { Text("Demo data") } }
                    if projectReadOnly {
                        Section {
                            Text("Archived Project. Cards, Comments, and Activity are read-only. Retained drafts can be recovered locally.")
                                .accessibilityIdentifier("archive.notice")
                        }
                    }
                    if filter.active {
                        Section {
                            Text("\(project.cards.filter { $0.archivedAt == nil && filter.includes($0) }.count) of \(project.cards.filter { $0.archivedAt == nil }.count) Cards")
                            Button("Clear filters") { filter = CardFilter() }
                        }
                    }
                    ForEach(project.columns.sorted { $0.position < $1.position }) { column in
                        Section(column.name) {
                            let cards = project.cards.filter { $0.archivedAt == nil && $0.columnId == column.id && filter.includes($0) }.sorted { $0.position < $1.position }
                            ForEach(cards) { card in
                                NavigationLink { CardView(workspace: workspace, projectID: projectID, cardID: card.id, readOnly: projectReadOnly) } label: {
                                    LabeledContent(card.title, value: cardContext(card))
                                }
                            }
                            if cards.isEmpty { Text(filter.active ? "No matching Cards" : "No Cards") }
                        }
                    }
                    Section {
                        NavigationLink("Activity") { ActivityView(projectID: projectID) }
                        NavigationLink("Archived Cards") { ArchivedCardsView(workspace: workspace, projectID: projectID, readOnly: projectReadOnly) }
                        if !projectReadOnly { Button("Edit Project") { editing = true } }
                    }
                }
                .refreshable { await refresh() }
                .sheet(isPresented: $creating) { CardEditor(workspace: workspace, projectID: projectID, card: nil) }
                .sheet(isPresented: $editing) { ProjectEditor(workspace: workspace, project: project) }
                .sheet(isPresented: $filtering) { FilterView(filter: $filter) }
            } else if loading {
                ProgressView("Loading Project")
            } else {
                ContentUnavailableView {
                    Label("Project unavailable", systemImage: "folder")
                } actions: { Button("Retry") { Task { await refresh() } } }
            }
        }
        .navigationTitle(project?.name ?? "Project")
        .toolbar {
            ToolbarItem { Button("Filter", systemImage: "line.3.horizontal.decrease") { filtering = true }.disabled(project == nil) }
            if !projectReadOnly {
                ToolbarItem(placement: .primaryAction) { Button("New Card", systemImage: "plus") { creating = true }.disabled(project == nil) }
            }
        }
        .task { await refresh() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await refresh() } } }
    }

    private func refresh() async {
        loading = true
        defer { loading = false }
        do { try await model.loadProject(id: projectID, in: workspace) } catch { model.handle(error) }
    }
}

private func cardContext(_ card: Card) -> String {
    [card.nextActor?.label, card.priority?.rawValue, card.blockedReason.isEmpty ? nil : "Blocked"].compactMap { $0 }.joined(separator: ", ")
}

struct FilterView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var filter: CardFilter
    var body: some View {
        NavigationStack {
            Form {
                Picker("Next actor", selection: $filter.actor) {
                    Text("All").tag("all")
                    Text("You").tag("human")
                    Text("Agent").tag("agent")
                    Text("Unassigned").tag("unassigned")
                }
                Picker("Priority", selection: $filter.priority) {
                    Text("All").tag("all")
                    ForEach(CardPriority.allCases) { Text($0.rawValue).tag($0.rawValue) }
                    Text("Unset").tag("unset")
                }
                Picker("Blocked", selection: $filter.blocked) {
                    Text("All").tag("all")
                    Text("Blocked").tag("true")
                    Text("Unblocked").tag("false")
                }
                Button("Clear filters") { filter = CardFilter() }
            }
            .navigationTitle("Filters")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

struct CardView: View {
    @Environment(AppModel.self) private var model
    let workspace: Workspace
    let projectID: String
    let cardID: String
    let readOnly: Bool
    @State private var editingSession: CardEditingSession?
    private var card: Card? { model.loadedProjects[projectID]?.cards.first { $0.id == cardID } }

    init(workspace: Workspace, projectID: String, cardID: String, readOnly: Bool = false) {
        self.workspace = workspace
        self.projectID = projectID
        self.cardID = cardID
        self.readOnly = readOnly
    }

    var body: some View {
        Group {
            if let editingSession { DirectCardForm(session: editingSession) }
            else { ProgressView("Opening Card") }
        }
        .task {
            if let card {
                let session = model.cardEditingSession(workspace: workspace, projectID: projectID, card: card, readOnly: readOnly)
                editingSession = session
                session.load()
            }
        }
        .onChange(of: card) { _, saved in
            if let saved { editingSession?.receive(saved) }
            else { editingSession?.missing() }
        }
        .onChange(of: model.ownerID) { _, owner in
            if owner != editingSession?.ownerID { editingSession = nil }
        }
    }
}

struct CardFields: View {
    let card: Card
    let columns: [Column]
    var body: some View {
        Section("Details") {
            LabeledContent("Column", value: columns.first { $0.id == card.columnId }?.name ?? card.columnId)
            LabeledContent("Next actor", value: card.nextActor?.label ?? "Unassigned")
            LabeledContent("Priority", value: card.priority?.rawValue ?? "Unset")
            LabeledContent("Next action", value: card.nextAction.isEmpty ? "None" : card.nextAction)
            LabeledContent("Blocker", value: card.blockedReason.isEmpty ? "None" : card.blockedReason)
        }
        Section("Description") { Text(verbatim: card.body.isEmpty ? "No description" : card.body).textSelection(.enabled) }
    }
}

struct ArchivedCardsView: View {
    @Environment(AppModel.self) private var model
    let workspace: Workspace
    let projectID: String
    let readOnly: Bool

    init(workspace: Workspace, projectID: String, readOnly: Bool = false) {
        self.workspace = workspace
        self.projectID = projectID
        self.readOnly = readOnly
    }

    var body: some View {
        List {
            let cards = model.loadedProjects[projectID]?.cards.filter { $0.archivedAt != nil } ?? []
            ForEach(cards) { card in NavigationLink(card.title) { CardView(workspace: workspace, projectID: projectID, cardID: card.id, readOnly: readOnly) } }
            if cards.isEmpty { ContentUnavailableView("No archived Cards", systemImage: "archivebox") }
        }
        .navigationTitle("Archived Cards")
    }
}

struct ActivityView: View {
    @Environment(AppModel.self) private var model
    let projectID: String
    var cardID: String? = nil
    var body: some View {
        List {
            let activity = (model.loadedProjects[projectID]?.activity ?? []).filter { cardID == nil || $0.cardId == cardID }.reversed()
            ForEach(Array(activity)) { item in
                Section {
                    Text(item.summary)
                    LabeledContent("By", value: item.actor.label)
                    if let date = ServerTimestamp.date(from: item.createdAt) { Text(date, format: .dateTime) }
                }
            }
            if activity.isEmpty { ContentUnavailableView("No Activity", systemImage: "clock") }
        }
        .navigationTitle("Activity")
    }
}
