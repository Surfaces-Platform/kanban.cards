import SwiftUI

struct WorkspaceActivity: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let workspace: Workspace

    private var state: WorkspaceActivityState { model.workspaceActivity(in: workspace) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(workspace.name).font(.headline)
                    Text("Activity across all Projects, including archived Projects.").foregroundStyle(.secondary)
                }
                ForEach(state.activity, id: \.scopedID) { item in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(item.projectName ?? "Project").font(.headline)
                            if item.projectArchivedAt != nil { Label("Archived", systemImage: "archivebox").font(.caption) }
                        }
                        if let cardTitle = item.cardTitle { Text(cardTitle).font(.subheadline) }
                        Text(item.summary)
                        Text("By \(item.actor.label)").font(.caption).foregroundStyle(.secondary)
                        if let date = ServerTimestamp.date(from: item.createdAt) {
                            Text(date, format: .dateTime).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("workspace-activity.event.\(item.scopedID)")
                }
                if let error = state.error {
                    Section {
                        Text("Activity could not be \(state.failedLoadMore || !state.hasLoaded ? "loaded" : "refreshed"). \(error)")
                            .textSelection(.enabled)
                        Button("Retry") { Task { await load(loadMore: state.failedLoadMore) } }
                            .accessibilityIdentifier("workspace-activity.retry")
                            .disabled(state.isLoading)
                    }
                }
                if state.isLoading {
                    ProgressView("Loading Activity")
                } else if state.hasLoaded && state.activity.isEmpty && state.error == nil {
                    ContentUnavailableView("No Workspace Activity", systemImage: "clock",
                        description: Text("Changes to Projects and Cards appear here."))
                }
                if state.nextCursor != nil {
                    Button("Load more") { Task { await load(loadMore: true) } }
                        .accessibilityIdentifier("workspace-activity.load-more")
                        .disabled(state.isLoading)
                }
            }
            .accessibilityIdentifier("workspace-activity.list")
            .navigationTitle("Workspace Activity")
            .toolbar {
                ToolbarItem(placement: .automatic) {
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
                        .accessibilityIdentifier("workspace-activity.refresh")
                        .disabled(state.isLoading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
                }
            }
        }
        .frame(minWidth: 500, minHeight: 440)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load(loadMore: Bool = false) async {
        do { try await model.loadWorkspaceActivity(in: workspace, loadMore: loadMore) }
        catch { /* AppModel retains the scoped rows and exposes retry state. */ }
    }
}
