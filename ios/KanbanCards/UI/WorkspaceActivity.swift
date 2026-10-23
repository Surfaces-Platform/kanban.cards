import SwiftUI
import Observation

@MainActor
@Observable
final class WorkspaceActivityState {
    private(set) var activity: [Activity] = []
    private(set) var nextCursor: String?
    private(set) var loading = false
    private(set) var loadingMore = false
    private(set) var hasLoaded = false
    private(set) var errorMessage: String?
    private(set) var failedPage = false
    private var context: String?
    private var requestID: UUID?

    func refresh(context: String, load: @MainActor (String?) async throws -> WorkspaceActivityPage) async {
        await fetch(context: context, cursor: nil, load: load)
    }

    func loadMore(context: String, load: @MainActor (String?) async throws -> WorkspaceActivityPage) async {
        guard self.context == context, !loading, let nextCursor else { return }
        await fetch(context: context, cursor: nextCursor, load: load)
    }

    func cancel() {
        requestID = nil
        context = nil
        loading = false
        loadingMore = false
        activity = []
        nextCursor = nil
        hasLoaded = false
        errorMessage = nil
        failedPage = false
    }

    private func fetch(context: String, cursor: String?,
                       load: @MainActor (String?) async throws -> WorkspaceActivityPage) async {
        if self.context != context {
            cancel()
            self.context = context
        }
        let request = UUID()
        requestID = request
        loading = true
        loadingMore = cursor != nil
        errorMessage = nil
        failedPage = false
        defer { if requestID == request { loading = false; loadingMore = false } }
        do {
            let page = try await load(cursor)
            guard !Task.isCancelled, requestID == request, self.context == context else { return }
            var seen = Set<String>()
            activity = ((cursor == nil ? [] : activity) + page.activity).filter { seen.insert($0.scopedID).inserted }
            nextCursor = page.nextCursor
            hasLoaded = true
        } catch {
            guard !(error is CancellationError), !Task.isCancelled,
                  requestID == request, self.context == context else { return }
            // A failed refresh or older-page request never discards readable rows.
            errorMessage = error.localizedDescription
            failedPage = cursor != nil
        }
    }
}

struct WorkspaceActivityView: View {
    @Environment(AppModel.self) private var model
    let workspace: Workspace
    @State private var state = WorkspaceActivityState()

    private var context: String {
        "\(model.ownerID):\(model.api.sessionGeneration):\(workspace.id):\(workspace.url.absoluteString)"
    }

    var body: some View {
        List {
            if state.loading { ProgressView(state.loadingMore ? "Loading more Activity" : "Loading Activity") }
            ForEach(state.activity, id: \.scopedID) { item in
                Section {
                    Text(item.summary)
                    LabeledContent("Project", value: item.projectName ?? item.projectId)
                    if item.projectArchivedAt != nil { Text("Archived Project") }
                    if let title = item.cardTitle { LabeledContent("Card", value: title) }
                    LabeledContent("By", value: item.actor.label)
                    if let date = ServerTimestamp.date(from: item.createdAt) { Text(date, format: .dateTime) }
                }
                .accessibilityIdentifier("workspace.activity.\(item.scopedID)")
            }
            if let error = state.errorMessage {
                Section {
                    Text(state.activity.isEmpty ? "Workspace Activity unavailable" : "Activity could not be updated")
                    Text(error)
                    Button("Retry") { Task { await retry() } }
                        .disabled(state.loading)
                }
            } else if state.hasLoaded && !state.loading && state.activity.isEmpty {
                ContentUnavailableView("No Workspace Activity", systemImage: "clock",
                    description: Text("Activity from all Projects, including archived Projects, appears here."))
            }
            if state.nextCursor != nil {
                Button("Load more") { Task { await loadMore() } }
                    .accessibilityIdentifier("activity.loadMore")
                    .disabled(state.loading)
            }
        }
        .navigationTitle("Workspace Activity")
        .toolbar {
            ToolbarItem { Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }
                .accessibilityIdentifier("activity.refresh")
                .disabled(state.loading) }
        }
        .task(id: context) { await refresh() }
        .refreshable { await refresh() }
        .onDisappear { state.cancel() }
    }

    private func refresh() async {
        await state.refresh(context: context) { cursor in
            try await model.workspaceActivity(in: workspace, cursor: cursor)
        }
    }

    private func loadMore() async {
        await state.loadMore(context: context) { cursor in
            try await model.workspaceActivity(in: workspace, cursor: cursor)
        }
    }

    private func retry() async {
        if state.failedPage { await loadMore() }
        else { await refresh() }
    }
}
