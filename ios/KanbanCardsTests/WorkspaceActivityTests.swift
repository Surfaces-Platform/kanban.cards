import Foundation
import XCTest
@testable import KanbanCards

@MainActor
final class WorkspaceActivityTests: XCTestCase {
    func testFirstLoadFailureIsDifferentFromSuccessfulEmptyFeedAndCanRetry() async {
        let state = WorkspaceActivityState()
        await state.refresh(context: "owner/workspace") { _ in throw URLError(.timedOut) }
        XCTAssertFalse(state.hasLoaded)
        XCTAssertNotNil(state.errorMessage)
        XCTAssertFalse(state.loading)
        await state.refresh(context: "owner/workspace") { _ in WorkspaceActivityPage(activity: [], nextCursor: nil) }
        XCTAssertTrue(state.hasLoaded)
        XCTAssertTrue(state.activity.isEmpty)
        XCTAssertNil(state.errorMessage)
    }

    func testRefreshFailureRetainsReadableHistoryAndOlderPageCursor() async {
        let state = WorkspaceActivityState()
        let event = activity("one", project: "project-a", actor: "Claude Research")
        await state.refresh(context: "workspace-a") { _ in WorkspaceActivityPage(activity: [event], nextCursor: "older") }
        await state.refresh(context: "workspace-a") { cursor in
            XCTAssertNil(cursor)
            throw URLError(.notConnectedToInternet)
        }
        XCTAssertEqual(state.activity, [event])
        XCTAssertEqual(state.nextCursor, "older")
        XCTAssertTrue(state.hasLoaded)
        XCTAssertFalse(state.failedPage)
        XCTAssertNotNil(state.errorMessage)
    }

    func testPaginationFailureRetriesSameCursorAndUsesProjectScopedIdentity() async {
        let state = WorkspaceActivityState()
        let first = activity("same-id", project: "project-a", actor: "Claude Research")
        let second = activity("same-id", project: "project-b", actor: "Codex Writer")
        await state.refresh(context: "workspace-a") { _ in WorkspaceActivityPage(activity: [first], nextCursor: "older") }
        await state.loadMore(context: "workspace-a") { cursor in
            XCTAssertEqual(cursor, "older")
            throw URLError(.timedOut)
        }
        XCTAssertEqual(state.activity, [first])
        XCTAssertEqual(state.nextCursor, "older")
        XCTAssertTrue(state.failedPage)
        await state.loadMore(context: "workspace-a") { cursor in
            XCTAssertEqual(cursor, "older")
            return WorkspaceActivityPage(activity: [first, second], nextCursor: nil)
        }
        XCTAssertEqual(state.activity.map(\.scopedID), ["project-a:same-id", "project-b:same-id"])
        XCTAssertEqual(state.activity.map(\.actor.label), ["Claude Research", "Codex Writer"])
        XCTAssertNil(state.nextCursor)
        XCTAssertNil(state.errorMessage)
    }

    func testResponseFromReplacedWorkspaceCannotReplaceCurrentHistory() async {
        let state = WorkspaceActivityState()
        let gate = ActivityPageGate()
        let old = activity("old", project: "private", actor: "Old owner")
        let current = activity("current", project: "current", actor: "Current agent")
        let slow = Task { await state.refresh(context: "old-owner/workspace-a") { _ in await gate.load() } }
        await gate.waitForRequest()
        await state.refresh(context: "new-owner/workspace-b") { _ in WorkspaceActivityPage(activity: [current], nextCursor: nil) }
        gate.finish(WorkspaceActivityPage(activity: [old], nextCursor: "old-page"))
        await slow.value
        XCTAssertEqual(state.activity, [current])
        XCTAssertNil(state.nextCursor)
        XCTAssertNil(state.errorMessage)
        XCTAssertFalse(state.loading)
    }

    func testDismissedViewClearsHistoryAndRejectsInFlightResult() async {
        let state = WorkspaceActivityState()
        let event = activity("private", project: "private", actor: "Private agent")
        await state.refresh(context: "owner/workspace") { _ in WorkspaceActivityPage(activity: [event], nextCursor: nil) }
        let gate = ActivityPageGate()
        let slow = Task { await state.refresh(context: "owner/workspace") { _ in await gate.load() } }
        await gate.waitForRequest()
        state.cancel()
        gate.finish(WorkspaceActivityPage(activity: [event], nextCursor: nil))
        await slow.value
        XCTAssertTrue(state.activity.isEmpty)
        XCTAssertFalse(state.hasLoaded)
        XCTAssertFalse(state.loading)
        XCTAssertNil(state.nextCursor)
    }

    func testDemoHistoryIsDerivedWithoutAuthenticationAndIsWorkspaceScoped() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let model = AppModel(drafts: DraftStore(directory: directory), demo: true)
        let workspace = try XCTUnwrap(model.workspaces.first)
        XCTAssertNil(model.api.credential)
        let page = try await model.workspaceActivity(in: workspace)
        XCTAssertEqual(page.activity.map(\.actor.label), ["Codex Writer (demo)", "Claude Research (demo)"])
        XCTAssertTrue(page.activity.allSatisfy { $0.projectName == "iPhone app" && $0.cardTitle == "Review the iPhone app" })
        XCTAssertNil(page.nextCursor)
        let another = try await model.createWorkspace(name: "Empty", slug: "empty")
        let empty = try await model.workspaceActivity(in: another)
        XCTAssertTrue(empty.activity.isEmpty, "Cached Projects from another Workspace must not appear.")
        await model.signOut()
        do { _ = try await model.workspaceActivity(in: workspace); XCTFail("Signed-out demo should reject reads too.") }
        catch is CancellationError { }
    }

    private func activity(_ id: String, project: String, actor: String) -> Activity {
        Activity(id: id, action: "card.updated", actor: ActivityActor(channel: "api", label: actor),
            summary: "Updated a Card.", projectId: project, createdAt: "2026-10-19T23:00:00.000Z", projectName: project)
    }
}

@MainActor
private final class ActivityPageGate {
    private var continuation: CheckedContinuation<WorkspaceActivityPage, Never>?
    func load() async -> WorkspaceActivityPage {
        await withCheckedContinuation { continuation = $0 }
    }
    func waitForRequest() async {
        while continuation == nil { await Task.yield() }
    }
    func finish(_ result: WorkspaceActivityPage) {
        continuation?.resume(returning: result)
        continuation = nil
    }
}
