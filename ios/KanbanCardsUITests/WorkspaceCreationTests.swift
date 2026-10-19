import XCTest

/// Run these native flows in the dedicated VM's iOS Simulator with demo data.
@MainActor
final class WorkspaceCreationTests: XCTestCase {
    private var runningApp: XCUIApplication?

    override func setUp() async throws { continueAfterFailure = false }
    override func tearDown() async throws { runningApp?.terminate(); runningApp = nil }

    func testTitleMenuCreationCancelPreservesCurrentWorkspace() {
        let app = launch()
        openWorkspaceForm(in: app, current: "Demo Workspace")
        XCTAssertFalse(app.buttons["workspace.create"].isEnabled)
        replace(app.textFields["workspace.name"], with: "Canceled Workspace")
        replace(app.textFields["workspace.slug"], with: "canceled-workspace")
        XCTAssertTrue(app.buttons["workspace.create"].isEnabled)
        attach(app, named: "Native iOS Workspace form")
        app.buttons["workspace.cancel"].tap()
        XCTAssertTrue(app.textFields["workspace.name"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["iPhone app"].firstMatch.waitForExistence(timeout: 5))
        openWorkspaceMenu(in: app, current: "Demo Workspace")
        XCTAssertFalse(app.buttons["Canceled Workspace"].exists)
        newWorkspaceAction(in: app).tap()
        XCTAssertTrue(app.textFields["workspace.name"].waitForExistence(timeout: 5))
        app.buttons["workspace.cancel"].tap()
    }

    func testCreateSelectsEmptyWorkspaceAndPreservesExistingCardDraft() {
        let app = launch()
        app.staticTexts["iPhone app"].firstMatch.tap()
        app.staticTexts["Review the iPhone app"].firstMatch.tap()
        replace(app.textFields["card-title"], with: "Retained draft across Workspaces")
        app.buttons["Close"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()

        openWorkspaceForm(in: app, current: "Demo Workspace")
        replace(app.textFields["workspace.name"], with: "Pilot Workspace")
        replace(app.textFields["workspace.slug"], with: "pilot-workspace")
        app.buttons["workspace.create"].tap()
        XCTAssertTrue(app.textFields["workspace.name"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["No Projects"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["iPhone app"].exists)
        XCTAssertTrue(app.buttons["Create Project"].isEnabled)
        attach(app, named: "Created iOS Workspace with no Projects")

        openWorkspaceMenu(in: app, current: "Pilot Workspace")
        let original = app.buttons["Demo Workspace"].firstMatch
        XCTAssertTrue(original.waitForExistence(timeout: 5), app.debugDescription)
        original.tap()
        XCTAssertTrue(app.staticTexts["iPhone app"].firstMatch.waitForExistence(timeout: 5))
        app.staticTexts["iPhone app"].firstMatch.tap()
        app.staticTexts["Review the iPhone app"].firstMatch.tap()
        assertValue(app.textFields["card-title"], equals: "Retained draft across Workspaces")
        attach(app, named: "Existing Card draft preserved after switching Workspaces")
    }

    func testInvalidAndDuplicateAddressesRetainTheFormAndCurrentWorkspace() {
        let app = launch()
        openWorkspaceForm(in: app, current: "Demo Workspace")
        let name = app.textFields["workspace.name"]
        let slug = app.textFields["workspace.slug"]
        let create = app.buttons["workspace.create"]
        replace(name, with: "Another Workspace")
        replace(slug, with: "-invalid")
        XCTAssertFalse(create.isEnabled)
        XCTAssertTrue(app.staticTexts["workspace.error"].exists)
        replace(slug, with: "auth")
        XCTAssertFalse(create.isEnabled)
        replace(slug, with: "demo")
        XCTAssertTrue(create.isEnabled)
        create.tap()
        let error = app.staticTexts["workspace.error"]
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        XCTAssertEqual(error.label, "Workspace address is already in use.")
        assertValue(name, equals: "Another Workspace")
        assertValue(slug, equals: "demo")
        XCTAssertTrue(create.isEnabled)
        attach(app, named: "Duplicate iOS Workspace address retains entered fields")
        replace(slug, with: "another-workspace")
        XCTAssertTrue(error.waitForNonExistence(timeout: 5))
        app.buttons["workspace.cancel"].tap()
        XCTAssertTrue(app.staticTexts["iPhone app"].firstMatch.waitForExistence(timeout: 5))
        openWorkspaceMenu(in: app, current: "Demo Workspace")
        XCTAssertFalse(app.buttons["Another Workspace"].exists)
        newWorkspaceAction(in: app).tap()
        app.buttons["workspace.cancel"].tap()
    }

    func testOwnerWithoutWorkspacesCreatesFirstWorkspaceAndProject() {
        let app = launch(extraArguments: ["--demo-empty-workspaces"])
        XCTAssertTrue(app.staticTexts["No Workspaces"].waitForExistence(timeout: 10))
        let action = app.buttons["workspace.new"]
        XCTAssertTrue(action.isEnabled)
        action.tap()
        XCTAssertTrue(app.textFields["workspace.name"].waitForExistence(timeout: 5))
        replace(app.textFields["workspace.name"], with: "First Workspace")
        replace(app.textFields["workspace.slug"], with: "first-workspace")
        app.buttons["workspace.create"].tap()
        XCTAssertTrue(app.staticTexts["No Projects"].waitForExistence(timeout: 5))
        app.buttons["Create Project"].tap()
        replace(app.textFields["project-name"], with: "First board")
        app.buttons["Create"].tap()
        XCTAssertTrue(app.staticTexts["First board"].firstMatch.waitForExistence(timeout: 5))
        app.staticTexts["First board"].firstMatch.tap()
        XCTAssertTrue(app.buttons["New Card"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["New Card"].isEnabled)
        attach(app, named: "First iOS Workspace and Project created through native forms")
    }

    private func launch(extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--reset-demo-drafts"] + extraArguments
        app.launch()
        runningApp = app
        if !extraArguments.contains("--demo-empty-workspaces") {
            XCTAssertTrue(app.staticTexts["iPhone app"].firstMatch.waitForExistence(timeout: 15))
        }
        return app
    }

    private func openWorkspaceMenu(in app: XCUIApplication, current: String) {
        let titleButton = app.navigationBars.buttons.matching(NSPredicate(
            format: "label == %@ OR label BEGINSWITH %@", current, current + ",")).firstMatch
        let titleText = app.navigationBars[current].staticTexts[current].firstMatch
        let title = titleButton.exists ? titleButton : titleText
        XCTAssertTrue(title.waitForExistence(timeout: 5), app.debugDescription)
        title.tap()
        XCTAssertTrue(newWorkspaceAction(in: app).waitForExistence(timeout: 5), app.debugDescription)
        attach(app, named: "Native iOS Workspace title menu")
    }

    private func newWorkspaceAction(in app: XCUIApplication) -> XCUIElement {
        let identified = app.buttons["workspace.new"].firstMatch
        return identified.exists ? identified : app.buttons["New Workspace…"].firstMatch
    }

    private func openWorkspaceForm(in app: XCUIApplication, current: String) {
        openWorkspaceMenu(in: app, current: current)
        newWorkspaceAction(in: app).tap()
        XCTAssertTrue(app.textFields["workspace.name"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["workspace.slug"].isHittable)
    }

    private func replace(_ field: XCUIElement, with text: String,
                         file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(field.waitForExistence(timeout: 5), file: file, line: line)
        field.tap()
        let displayed = field.value as? String ?? ""
        let current = displayed == field.placeholderValue ? "" : displayed
        if !current.isEmpty { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count)) }
        if !text.isEmpty { field.typeText(text) }
        assertValue(field, equals: text, file: file, line: line)
    }

    private func assertValue(_ element: XCUIElement, equals value: String,
                             file: StaticString = #filePath, line: UInt = #line) {
        // Query the value directly instead of first resolving existence in a
        // separate accessibility snapshot after typing.
        let updated = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", value), object: element)
        let result = XCTWaiter.wait(for: [updated], timeout: 5)
        if result != .completed, let app = runningApp {
            attach(app, named: "Workspace text value did not settle: \(element.identifier)")
        }
        XCTAssertEqual(result, .completed,
                       "Expected \(element.identifier) value \(String(reflecting: value)); actual \(String(reflecting: element.value))",
                       file: file, line: line)
    }

    private func attach(_ app: XCUIApplication, named name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = name + " accessibility tree"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }
}
