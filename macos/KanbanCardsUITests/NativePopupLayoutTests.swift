import XCTest

@MainActor
final class NativePopupLayoutTests: XCTestCase {
    func testLongWorkspacePopupFitsSidebarAndRetainsFullAccessibleValue() throws {
        continueAfterFailure = false
        let fullName = String(repeating: "Studio Workspace with a long multilingual name 日本語 العربية ", count: 4)
        for appearance in ["--appearance-light", "--appearance-dark"] {
            let app = XCUIApplication()
            app.launchArguments = ["--demo", "--audit-long-workspace", "--reset-demo-drafts",
                                   "--reset-demo-window-layout", "-ApplePersistenceIgnoreState", "YES", appearance]
            app.launch()
            app.typeKey("0", modifierFlags: .command)
            let board = app.windows.containing(.button, identifier: "session.sign-out").firstMatch
            XCTAssertTrue(board.waitForExistence(timeout: 10))
            let rightEdge = board.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.6))
                .withOffset(CGVector(dx: -1, dy: 0))
            let contraction = max(0, board.frame.width - 760)
            if contraction > 2 {
                rightEdge.click(forDuration: 0.4, thenDragTo: rightEdge.withOffset(CGVector(dx: -contraction, dy: 0)))
            }
            let sidebar = board.descendants(matching: .outline).matching(NSPredicate(format: "label == %@", "Workspaces and Projects")).firstMatch
            let workspace = board.popUpButtons["board.workspace"]
            XCTAssertTrue(sidebar.exists)
            XCTAssertTrue(workspace.isHittable)
            XCTAssertEqual(workspace.value as? String, fullName)
            XCTAssertGreaterThan(workspace.frame.width, 20)
            XCTAssertGreaterThanOrEqual(workspace.frame.minX, sidebar.frame.minX - 1)
            XCTAssertLessThanOrEqual(workspace.frame.maxX, sidebar.frame.maxX + 1,
                                     "The native popup must fit its sidebar even when the full Workspace name is long.")
            XCTAssertTrue(board.buttons["board.new-card"].isHittable)
            XCTAssertTrue(board.popUpButtons["board.filter.actor"].isHittable)
            let screenshot = XCTAttachment(screenshot: board.screenshot())
            screenshot.name = "Long Workspace native popup at minimum width \(appearance)"
            screenshot.lifetime = .keepAlways
            add(screenshot)
            app.terminate()
        }
    }
}
