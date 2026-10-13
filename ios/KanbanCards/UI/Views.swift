import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var model = model
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
                if let workspace = model.workspaces.first, model.workspaces.count == 1 {
                    ProjectsView(workspace: workspace)
                } else {
                    List {
                        if model.loadingWorkspaces { ProgressView("Loading Workspaces") }
                        ForEach(model.workspaces) { workspace in
                            NavigationLink(workspace.name) { ProjectsView(workspace: workspace) }
                        }
                        if !model.loadingWorkspaces && model.workspaces.isEmpty {
                            ContentUnavailableView(model.workspaceLoadFailed ? "Workspaces unavailable" : "No Workspaces", systemImage: "folder")
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
        .task { await model.restore() }
        .alert("Unable to complete the action", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("OK", role: .cancel) { model.errorMessage = nil }
        } message: { Text(model.errorMessage ?? "") }
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
    @State private var loading = false
    @State private var creating = false

    var body: some View {
        List {
            if loading { ProgressView("Loading Projects") }
            ForEach(model.projectLists[workspace.id] ?? []) { project in
                NavigationLink { ProjectView(workspace: workspace, projectID: project.id) } label: {
                    LabeledContent(project.name, value: "\(project.cardCount) Cards")
                }
            }
            if !loading && (model.projectLists[workspace.id] ?? []).isEmpty {
                ContentUnavailableView("No Projects", systemImage: "folder", description: Text("Create a Project to start organizing work."))
                Button("Create Project") { creating = true }
            }
        }
        .navigationTitle(workspace.name)
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
    @State private var creating = false
    @State private var editing = false
    @State private var filtering = false
    @State private var filter = CardFilter()
    @State private var loading = false
    private var project: Project? { model.loadedProjects[projectID] }

    var body: some View {
        Group {
            if let project {
                List {
                    if model.isDemo { Section { Text("Demo data") } }
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
                                NavigationLink { CardView(workspace: workspace, projectID: projectID, cardID: card.id) } label: {
                                    LabeledContent(card.title, value: cardContext(card))
                                }
                            }
                            if cards.isEmpty { Text(filter.active ? "No matching Cards" : "No Cards") }
                        }
                    }
                    Section {
                        NavigationLink("Activity") { ActivityView(projectID: projectID) }
                        NavigationLink("Archived Cards") { ArchivedCardsView(workspace: workspace, projectID: projectID) }
                        Button("Edit Project") { editing = true }
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
            ToolbarItem(placement: .primaryAction) { Button("New Card", systemImage: "plus") { creating = true }.disabled(project == nil) }
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
    @State private var editing = false
    @State private var archiving = false
    private var card: Card? { model.loadedProjects[projectID]?.cards.first { $0.id == cardID } }

    var body: some View {
        Group {
            if let card, let project = model.loadedProjects[projectID] {
                List {
                    if card.archivedAt != nil { Section { Text("Archived") } }
                    CardFields(card: card, columns: project.columns)
                    Section {
                        NavigationLink("Comments (\(card.comments.count))") { CommentsView(workspace: workspace, projectID: projectID, cardID: cardID) }
                        NavigationLink("Activity") { ActivityView(projectID: projectID, cardID: cardID) }
                    }
                    Section {
                        Button(card.archivedAt == nil ? "Archive Card" : "Restore Card", role: card.archivedAt == nil ? .destructive : nil) {
                            Task {
                                archiving = true
                                defer { archiving = false }
                                do { try await model.archive(card, projectID: projectID, in: workspace, archived: card.archivedAt == nil) } catch { model.handle(error) }
                            }
                        }.disabled(archiving)
                    }
                }
                .refreshable {
                    do { try await model.loadProject(id: projectID, in: workspace) } catch { model.handle(error) }
                }
                .sheet(isPresented: $editing) { CardEditor(workspace: workspace, projectID: projectID, card: card) }
            } else { ContentUnavailableView("Card unavailable", systemImage: "rectangle") }
        }
        .navigationTitle(card?.title ?? "Card")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = true }.disabled(card == nil) } }
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
    var body: some View {
        List {
            let cards = model.loadedProjects[projectID]?.cards.filter { $0.archivedAt != nil } ?? []
            ForEach(cards) { card in NavigationLink(card.title) { CardView(workspace: workspace, projectID: projectID, cardID: card.id) } }
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
