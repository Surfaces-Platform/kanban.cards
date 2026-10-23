import Foundation
import XCTest

@MainActor
final class WorkspaceActivityTests: XCTestCase {
    func testWorkspaceHistoryShowsNamedAgentsAndArchivedProject() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--demo-workspace-activity"]
        app.launch()
        defer { app.terminate() }
        let activity = app.buttons["board.workspace-activity"]
        XCTAssertTrue(activity.waitForExistence(timeout: 10))
        activity.click()
        let sheet = app.sheets.firstMatch
        XCTAssertTrue(sheet.waitForExistence(timeout: 5))
        XCTAssertTrue(element(containing: "By Claude Research (demo)", in: sheet).waitForExistence(timeout: 5))
        XCTAssertTrue(element(containing: "By Codex Writer (demo)", in: sheet).exists)
        XCTAssertTrue(element(containing: "Archived research", in: sheet).exists)
        XCTAssertTrue(element(containing: "Updated homepage hierarchy.", in: sheet).exists)
        sheet.buttons["workspace-activity.refresh"].click()
        XCTAssertTrue(element(containing: "By Claude Research (demo)", in: sheet).exists)
        let screenshot = XCTAttachment(screenshot: sheet.screenshot())
        screenshot.name = "Workspace Activity with named agents and archived Project"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        sheet.buttons["Done"].click()
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 5))
        XCTAssertTrue(activity.exists)
    }

    func testProjectAndCardHistoryKeepStoredAgentNames() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--demo-workspace-activity"]
        app.launch()
        defer { app.terminate() }
        let homepage = app.buttons["board.card.demo-card-homepage"]
        XCTAssertTrue(homepage.waitForExistence(timeout: 10))

        let projectActivity = app.buttons["Activity…"].firstMatch
        XCTAssertTrue(projectActivity.isEnabled)
        projectActivity.click()
        let projectSheet = app.sheets.firstMatch
        XCTAssertTrue(projectSheet.waitForExistence(timeout: 5))
        XCTAssertTrue(element(containing: "Updated homepage hierarchy.", in: projectSheet).exists)
        XCTAssertTrue(element(containing: "By Codex Writer (demo)", in: projectSheet).exists)
        XCTAssertFalse(element(containing: "By Claude Research (demo)", in: projectSheet).exists,
                       "The Project feed must exclude the other Project's archived research history.")
        attach(projectSheet, named: "Project Activity preserves the stored agent name")
        projectSheet.buttons["Done"].click()
        XCTAssertTrue(projectSheet.waitForNonExistence(timeout: 5))

        homepage.click()
        let viewer = app.descendants(matching: .any).matching(identifier: "card.viewer.demo-card-homepage").firstMatch
        XCTAssertTrue(viewer.waitForExistence(timeout: 5))
        let actions = viewer.descendants(matching: .any).matching(identifier: "card.actions.demo-card-homepage").firstMatch
        XCTAssertTrue(actions.exists)
        actions.click()
        let cardActivity = app.menuItems["card.actions.demo-card-homepage.action.0"]
        XCTAssertTrue(cardActivity.waitForExistence(timeout: 5))
        XCTAssertTrue(cardActivity.isEnabled)
        cardActivity.click()
        let cardSheet = app.sheets.firstMatch
        XCTAssertTrue(cardSheet.waitForExistence(timeout: 5))
        XCTAssertTrue(element(containing: "Updated homepage hierarchy.", in: cardSheet).exists)
        XCTAssertTrue(element(containing: "By Codex Writer (demo)", in: cardSheet).exists)
        XCTAssertFalse(element(containing: "By Claude Research (demo)", in: cardSheet).exists)
        attach(cardSheet, named: "Card Activity preserves the stored agent name")
        cardSheet.buttons["Done"].click()
        XCTAssertTrue(cardSheet.waitForNonExistence(timeout: 5))
        XCTAssertTrue(viewer.exists)
    }

    private func attach(_ element: XCUIElement, named name: String) {
        let attachment = XCTAttachment(screenshot: element.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func element(containing text: String, in root: XCUIElement) -> XCUIElement {
        root.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", text, text)).firstMatch
    }
}
