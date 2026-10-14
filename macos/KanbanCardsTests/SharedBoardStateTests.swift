import Foundation
import XCTest
@testable import KanbanCards

@MainActor
final class SharedBoardStateTests: XCTestCase {
    private var directory: URL!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("macos-board-\(UUID().uuidString)", isDirectory: true)
        suite = "cards.kanban.macos.tests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
    }

    func testConfirmedEditUpdatesSharedBoardAndPreservesOtherDraft() async throws {
        let model = makeModel()
        let workspace = try XCTUnwrap(model.workspaces.first)
        let project = try XCTUnwrap(model.project(id: "demo-project", in: workspace))
        let first = try XCTUnwrap(project.cards.first { $0.id == "demo-card-homepage" })
        let second = try XCTUnwrap(project.cards.first { $0.id == "demo-card-signup" })
        var secondDraft = CardDraft(card: second)
        secondDraft.title = "Keep this unsaved signup title"
        let secondKey = "workspace/project/\(second.id)"
        try model.drafts.save(secondDraft, ownerID: model.ownerID, resourceKey: secondKey)
        var edit = CardDraft(card: first)
        edit.title = "Confirmed homepage title"
        edit.body = "  # Exact Markdown\n\n- Keep source  \n"
        edit.columnId = try XCTUnwrap(project.columns.last?.id)

        let saved = try await model.saveCard(edit, projectID: project.id, in: workspace, key: "edit-homepage")
        let current = try XCTUnwrap(model.project(id: project.id, in: workspace))
        XCTAssertEqual(current.cards.first { $0.id == first.id }, saved)
        XCTAssertEqual(saved.title, edit.title)
        XCTAssertEqual(saved.body, edit.body)
        XCTAssertEqual(saved.columnId, edit.columnId)
        XCTAssertEqual(saved.version, first.version + 1)
        XCTAssertEqual(current.cards.first { $0.id == second.id }, second)
        XCTAssertEqual(try model.drafts.load(ownerID: model.ownerID, resourceKey: secondKey, as: CardDraft.self), secondDraft)
    }

    func testNewCommentMakesPreviouslyOpenedEditStaleWithoutOverwritingIt() async throws {
        let model = makeModel()
        let workspace = try XCTUnwrap(model.workspaces.first)
        let project = try XCTUnwrap(model.project(id: "demo-project", in: workspace))
        let card = try XCTUnwrap(project.cards.first)
        var edit = CardDraft(card: card)
        edit.title = "My unsaved title"
        try await model.addComment("A separately saved comment", cardID: card.id,
            projectID: project.id, in: workspace, key: "comment-once")

        do {
            _ = try await model.saveCard(edit, projectID: project.id, in: workspace, key: "stale-edit")
            XCTFail("A draft opened before a Comment must reconcile the newer Card version.")
        } catch {
            XCTAssertTrue(model.isConflict(error))
        }
        let current = try XCTUnwrap(model.project(id: project.id, in: workspace)?.cards.first { $0.id == card.id })
        XCTAssertEqual(current.title, card.title)
        XCTAssertEqual(current.version, card.version + 1)
        XCTAssertEqual(current.comments.last?.body, "A separately saved comment")
        XCTAssertEqual(edit.title, "My unsaved title")
        XCTAssertEqual(edit.version, card.version)
    }

    func testSignOutHidesSharedStateAndInvalidatesAllExistingWindowSessions() async throws {
        let model = makeModel()
        let workspace = try XCTUnwrap(model.workspaces.first)
        let session = model.sessionID
        let key = "demo-project/demo-card-homepage"
        var edit = CardDraft(columnId: "next")
        edit.title = "Retained private draft"
        try model.drafts.save(edit, ownerID: model.ownerID, resourceKey: key)

        await model.signOut()

        XCTAssertFalse(model.signedIn)
        XCTAssertNotEqual(model.sessionID, session)
        XCTAssertTrue(model.workspaces.isEmpty)
        XCTAssertTrue(model.projects(in: workspace).isEmpty)
        XCTAssertNil(model.project(id: "demo-project", in: workspace))
        XCTAssertEqual(try model.drafts.load(ownerID: "demo-owner", resourceKey: key, as: CardDraft.self), edit)
        XCTAssertNil(try model.drafts.load(ownerID: "another-owner", resourceKey: key, as: CardDraft.self))
        do {
            _ = try await model.saveCard(edit, projectID: "demo-project", in: workspace, key: "after-signout")
            XCTFail("An old viewer must not save after sign-out.")
        } catch is CancellationError { }
    }

    func testRetryingCreationAndCommentDoesNotDuplicateConfirmedWork() async throws {
        let model = makeModel()
        let workspace = try XCTUnwrap(model.workspaces.first)
        let project = try XCTUnwrap(model.project(id: "demo-project", in: workspace))
        var edit = CardDraft(columnId: try XCTUnwrap(project.columns.first?.id))
        edit.title = "One newly created Card"
        let first = try await model.saveCard(edit, projectID: project.id, in: workspace, key: "same-create")
        let retry = try await model.saveCard(edit, projectID: project.id, in: workspace, key: "same-create")
        XCTAssertEqual(first.id, retry.id)
        for _ in 0..<2 {
            try await model.addComment("One comment", cardID: first.id, projectID: project.id,
                in: workspace, key: "same-comment")
        }
        let current = try XCTUnwrap(model.project(id: project.id, in: workspace))
        XCTAssertEqual(current.cards.count, project.cards.count + 1)
        XCTAssertEqual(current.cards.first { $0.id == first.id }?.comments.count, 1)
    }

    func testArchivedProjectLeavesViewersReadableAndRejectsEdits() async throws {
        let model = makeModel()
        let workspace = try XCTUnwrap(model.workspaces.first)
        let project = try XCTUnwrap(model.project(id: "demo-project", in: workspace))
        let card = try XCTUnwrap(project.cards.first)
        try await model.archiveProject(project, in: workspace, archived: true)
        XCTAssertNotNil(model.project(id: project.id, in: workspace)?.archivedAt)
        XCTAssertEqual(model.project(id: project.id, in: workspace)?.cards.first { $0.id == card.id }, card)

        do {
            _ = try await model.saveCard(CardDraft(card: card), projectID: project.id, in: workspace, key: "read-only")
            XCTFail("Archived Projects must reject edits from an already open viewer.")
        } catch { }
    }

    private func makeModel() -> AppModel {
        AppModel(drafts: DraftStore(directory: directory), defaults: defaults, demo: true)
    }
}
