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
            let contraction = max(0, board.frame.width - 1024)
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
            XCTAssertFalse(board.buttons["board.filters"].exists)
            let header = board.descendants(matching: .any).matching(identifier: "board.control-strip").firstMatch
            XCTAssertTrue(header.exists)
            let inlineControls = [header.popUpButtons["board.filter.actor"],
                                  header.popUpButtons["board.filter.priority"],
                                  header.popUpButtons["board.filter.blocked"],
                                  header.checkBoxes["board.filter.archived"]]
            for control in inlineControls {
                XCTAssertTrue(control.isHittable)
                XCTAssertGreaterThanOrEqual(control.frame.minX, header.frame.minX - 1)
                XCTAssertLessThanOrEqual(control.frame.maxX, header.frame.maxX + 1)
                XCTAssertGreaterThanOrEqual(control.frame.minY, header.frame.minY - 1)
                XCTAssertLessThanOrEqual(control.frame.maxY, header.frame.maxY + 1)
                XCTAssertGreaterThanOrEqual(control.frame.minX, board.frame.minX - 1)
                XCTAssertLessThanOrEqual(control.frame.maxX, board.frame.maxX + 1)
            }
            let inlineScreenshot = XCTAttachment(screenshot: board.screenshot())
            inlineScreenshot.name = "Long Workspace and inline board filters at minimum width \(appearance)"
            inlineScreenshot.lifetime = .keepAlways
            add(inlineScreenshot)

            board.buttons["board.card.demo-card-homepage"].click()
            XCTAssertTrue(board.popUpButtons["board.focused-column"].waitForExistence(timeout: 5))
            XCTAssertFalse(board.popUpButtons["board.filter.actor"].exists,
                           "The compact Column must retain its Filters popover.")
            XCTAssertTrue(board.buttons["board.filters"].isHittable)
            board.buttons["board.filters"].click()
            let filters = app.descendants(matching: .any).matching(identifier: "board.filter-popover").firstMatch
            XCTAssertTrue(filters.waitForExistence(timeout: 5))
            XCTAssertTrue(app.popUpButtons["board.filter.actor"].isHittable)
            app.buttons["board.filters.done"].click()
            XCTAssertTrue(filters.waitForNonExistence(timeout: 5))
            let screenshot = XCTAttachment(screenshot: board.screenshot())
            screenshot.name = "Long Workspace native popup at minimum width \(appearance)"
            screenshot.lifetime = .keepAlways
            add(screenshot)
            app.terminate()
        }
    }
}
