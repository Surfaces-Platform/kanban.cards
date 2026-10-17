import Foundation
import XCTest

/// Workspace creation uses the normal native controls and synthetic demo data.
/// Run these interactive cases inside the dedicated macOS VM.
@MainActor
final class WorkspaceCreationTests: XCTestCase {
    private var runningApp: XCUIApplication?

    override func setUp() async throws { continueAfterFailure = false }
    override func tearDown() async throws { runningApp?.terminate(); runningApp = nil }

    func testCreateSelectsEmptyWorkspaceAndPreservesExistingCardDraft() throws {
        let app = launch()
        let board = board(in: app)
        attach(board, named: "New Workspace default board")
        attachTree(board, named: "New Workspace default board AX tree")
        board.buttons["board.card.demo-card-homepage"].click()
        let title = board.textFields["editor.title"]
        replace(title, with: "Retained Card draft across Workspaces")

        let sheet = openWorkspaceForm(in: app, board: board)
        replace(sheet.textFields["workspace.name"], with: "Pilot Workspace")
        replace(sheet.textFields["workspace.slug"], with: "pilot-workspace")
        XCTAssertTrue(sheet.buttons["workspace.create"].isEnabled)
        attach(sheet, named: "Native New Workspace form")
        sheet.buttons["workspace.create"].click()
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 10))
        assertValue(board.popUpButtons["board.workspace"], equals: "Pilot Workspace")
        XCTAssertTrue(text("No Projects", in: board).waitForExistence(timeout: 5))
        XCTAssertTrue(board.buttons["New Project…"].isEnabled)
        XCTAssertFalse(board.buttons["board.card.demo-card-homepage"].exists)
        XCTAssertEqual(app.windows.count, 1)
        attach(board, named: "Created Workspace selected with no Projects")

        choose("Studio Workspace", from: board.popUpButtons["board.workspace"], in: app)
        let originalCard = board.buttons["board.card.demo-card-homepage"]
        XCTAssertTrue(originalCard.waitForExistence(timeout: 5))
        originalCard.click()
        assertValue(board.textFields["editor.title"], equals: "Retained Card draft across Workspaces")
        XCTAssertEqual(app.windows.count, 1)
    }

    func testWorkspaceMenuCommandKeepsCurrentSelectionWhenCanceled() throws {
        let app = launch()
        let board = board(in: app)
        XCTAssertFalse(board.buttons["board.new-workspace"].exists,
                       "Existing Workspaces use the switcher menu for creation.")
        let picker = board.popUpButtons["board.workspace"]
        assertValue(picker, equals: "Studio Workspace")
        picker.click()
        let action = app.menuItems["board.workspace.action.0"]
        XCTAssertTrue(action.waitForExistence(timeout: 5))
        XCTAssertTrue(action.isEnabled)
        let current = app.menuItems["Studio Workspace"].firstMatch
        XCTAssertTrue(current.exists)
        let menu = app.menus.containing(.menuItem, identifier: "board.workspace.action.0").firstMatch
        attach(menu, named: "Workspace switcher with current selection and creation command")
        attachTree(menu, named: "Workspace switcher AX tree")
        action.click()
        let sheet = app.sheets.firstMatch
        XCTAssertTrue(sheet.waitForExistence(timeout: 5))
        assertValue(picker, equals: "Studio Workspace")
        sheet.buttons["workspace.cancel"].click()
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 5))
        assertValue(picker, equals: "Studio Workspace")
        XCTAssertTrue(board.buttons["board.card.demo-card-homepage"].exists)
        XCTAssertEqual(app.windows.count, 1)
    }

    func testFileMenuFormValidatesAddressAndRetainsFieldsAfterDuplicateError() throws {
        let app = launch()
        let board = board(in: app)
        app.menuBars.menuBarItems["File"].click()
        let action = app.menuItems["New Workspace…"].firstMatch
        XCTAssertTrue(action.waitForExistence(timeout: 5))
        XCTAssertTrue(action.isEnabled)
        action.click()
        let sheet = app.sheets.firstMatch
        XCTAssertTrue(sheet.waitForExistence(timeout: 5))
        let name = sheet.textFields["workspace.name"]
        let slug = sheet.textFields["workspace.slug"]
        let create = sheet.buttons["workspace.create"]
        XCTAssertFalse(create.isEnabled)
        replace(name, with: "Another Workspace")
        replace(slug, with: "-invalid")
        XCTAssertFalse(create.isEnabled)
        XCTAssertTrue(sheet.staticTexts["workspace.error"].exists)
        replace(slug, with: "auth")
        XCTAssertFalse(create.isEnabled)
        replace(slug, with: "studio")
        XCTAssertTrue(create.isEnabled)
        create.click()
        let error = sheet.staticTexts["workspace.error"]
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        XCTAssertTrue(sheet.exists)
        assertValue(name, equals: "Another Workspace")
        assertValue(slug, equals: "studio")
        XCTAssertTrue(create.isEnabled)
        attach(sheet, named: "Duplicate Workspace address retains the form")
        replace(slug, with: "another-workspace")
        XCTAssertFalse(error.exists)
        sheet.buttons["workspace.cancel"].click()
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 5))
        assertValue(board.popUpButtons["board.workspace"], equals: "Studio Workspace")
        board.popUpButtons["board.workspace"].click()
        XCTAssertFalse(app.menuItems["Another Workspace"].exists)
        app.typeKey(XCUIKeyboardKey.escape.rawValue, modifierFlags: [])
    }

    func testOwnerWithoutWorkspacesCanCreateFirstWorkspaceAndProject() throws {
        let app = launch(extraArguments: ["--demo-empty-workspaces"])
        let board = board(in: app)
        XCTAssertTrue(text("No Workspaces", in: board).waitForExistence(timeout: 5))
        XCTAssertTrue(board.buttons["board.new-workspace"].isEnabled)
        let sheet = openWorkspaceForm(in: app, board: board)
        replace(sheet.textFields["workspace.name"], with: "First Workspace")
        replace(sheet.textFields["workspace.slug"], with: "first-workspace")
        sheet.buttons["workspace.create"].click()
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 10))
        assertValue(board.popUpButtons["board.workspace"], equals: "First Workspace")
        XCTAssertTrue(text("No Projects", in: board).waitForExistence(timeout: 5))
        board.buttons["New Project…"].click()
        let projectSheet = app.sheets.firstMatch
        XCTAssertTrue(projectSheet.waitForExistence(timeout: 5))
        replace(projectSheet.textFields["project-name"], with: "First board")
        projectSheet.buttons["editor.save"].click()
        XCTAssertTrue(projectSheet.waitForNonExistence(timeout: 10))
        let project = board.descendants(matching: .any).matching(NSPredicate(
            format: "identifier BEGINSWITH %@ AND (label == %@ OR value == %@)",
            "board.project.", "First board", "First board")).firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 5))
        project.click()
        XCTAssertTrue(board.descendants(matching: .any).matching(identifier: "board.control-strip")
            .firstMatch.waitForExistence(timeout: 5))
        attach(board, named: "First Workspace and first Project created through native forms")
    }

    private func launch(extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--reset-demo-drafts", "--reset-demo-window-layout",
                               "-ApplePersistenceIgnoreState", "YES"] + extraArguments
        app.launch()
        runningApp = app
        app.typeKey("0", modifierFlags: .command)
        XCTAssertTrue(board(in: app).waitForExistence(timeout: 10))
        return app
    }

    private func board(in app: XCUIApplication) -> XCUIElement {
        app.windows.containing(.button, identifier: "session.sign-out").firstMatch
    }

    private func openWorkspaceForm(in app: XCUIApplication, board: XCUIElement) -> XCUIElement {
        let button = board.buttons["board.new-workspace"]
        if button.exists {
            XCTAssertTrue(button.isHittable)
            button.click()
        } else {
            XCTAssertFalse(button.exists)
            let picker = board.popUpButtons["board.workspace"]
            XCTAssertTrue(picker.waitForExistence(timeout: 5))
            XCTAssertTrue(picker.isHittable)
            picker.click()
            let action = app.menuItems["board.workspace.action.0"]
            XCTAssertTrue(action.waitForExistence(timeout: 5))
            XCTAssertTrue(action.isEnabled)
            action.click()
        }
        let sheet = app.sheets.firstMatch
        XCTAssertTrue(sheet.waitForExistence(timeout: 5))
        XCTAssertTrue(sheet.textFields["workspace.name"].isHittable)
        XCTAssertTrue(sheet.textFields["workspace.slug"].isHittable)
        return sheet
    }

    private func replace(_ field: XCUIElement, with value: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.click()
        field.typeKey("a", modifierFlags: .command)
        field.typeKey(XCUIKeyboardKey.delete.rawValue, modifierFlags: [])
        if !value.isEmpty { field.typeText(value) }
        assertValue(field, equals: value)
    }

    private func assertValue(_ element: XCUIElement, equals value: String) {
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            element.exists && element.value as? String == value
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed)
    }

    private func choose(_ value: String, from picker: XCUIElement, in app: XCUIApplication) {
        picker.click()
        let item = app.menuItems[value].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        item.click()
        assertValue(picker, equals: value)
    }

    private func text(_ value: String, in element: XCUIElement) -> XCUIElement {
        element.staticTexts.matching(NSPredicate(format: "label == %@ OR value == %@", value, value)).firstMatch
    }

    private func attach(_ element: XCUIElement, named name: String) {
        let attachment = XCTAttachment(screenshot: element.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attachTree(_ element: XCUIElement, named name: String) {
        let attachment = XCTAttachment(string: element.debugDescription)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
