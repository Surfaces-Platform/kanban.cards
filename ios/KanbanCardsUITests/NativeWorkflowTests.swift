import XCTest

final class NativeWorkflowTests: XCTestCase {
    @MainActor
    func testEditMoveCommentArchiveAndRestore() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--reset-demo-drafts"]
        app.launch()
        XCTAssertTrue(app.staticTexts["iPhone app"].waitForExistence(timeout: 15))
        app.staticTexts["iPhone app"].firstMatch.tap()
        attach(app, named: "Project grouped by Column")
        app.staticTexts["Review the iPhone app"].firstMatch.tap()
        app.buttons["Edit"].tap()
        let title = app.textFields["card-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        replace(title, with: "Verify the native workflow")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Column")).firstMatch.tap()
        app.buttons["Doing"].tap()
        attach(app, named: "Native Card editor")
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["Verify the native workflow"].firstMatch.waitForExistence(timeout: 5))
        attach(app, named: "Saved Card")
        app.buttons["Edit"].tap()
        let savedColumn = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Column")).firstMatch
        XCTAssertTrue(savedColumn.waitForExistence(timeout: 5))
        XCTAssertTrue(savedColumn.label.contains("Doing") || (savedColumn.value as? String) == "Doing",
            "The saved native Column Picker must select Doing. \(savedColumn.debugDescription)")
        app.buttons["Cancel"].tap()
        app.buttons["Activity"].tap()
        XCTAssertTrue(app.staticTexts["Saved Verify the native workflow."].waitForExistence(timeout: 5))
        attach(app, named: "Native Activity list")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["Filter"].tap()
        choose("Next actor", value: "You", in: app)
        choose("Priority", value: "High", in: app)
        choose("Blocked", value: "Unblocked", in: app)
        attach(app, named: "Combined native filters")
        app.buttons["Done"].tap()
        XCTAssertTrue(app.staticTexts["1 of 1 Cards"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Verify the native workflow"].exists)
        app.buttons["Filter"].tap()
        choose("Blocked", value: "Blocked", in: app)
        app.buttons["Done"].tap()
        XCTAssertTrue(app.staticTexts["0 of 1 Cards"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Verify the native workflow"].exists)
        app.buttons["Clear filters"].tap()
        app.staticTexts["Verify the native workflow"].firstMatch.tap()
        app.buttons["Comments (0)"].tap()
        app.buttons["Add Comment"].tap()
        let comment = app.textViews["comment-body"]
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        comment.tap()
        comment.typeText("Verified using standard Apple controls.")
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts["Verified using standard Apple controls."].waitForExistence(timeout: 5))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.swipeUp()
        app.buttons["Archive Card"].tap()
        XCTAssertTrue(app.buttons["Restore Card"].waitForExistence(timeout: 5))
        app.buttons["Restore Card"].tap()
        XCTAssertTrue(app.buttons["Archive Card"].waitForExistence(timeout: 5))
        attach(app, named: "Native Card after restore")
    }

    @MainActor
    func testCanceledEditRetainsFullDraft() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--reset-demo-drafts"]
        app.launch()
        XCTAssertTrue(app.staticTexts["iPhone app"].waitForExistence(timeout: 15))
        app.staticTexts["iPhone app"].firstMatch.tap()
        app.staticTexts["Review the iPhone app"].firstMatch.tap()
        app.buttons["Edit"].tap()
        let title = app.textFields["card-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        replace(title, with: "Keep this unsaved draft")
        app.buttons["Cancel"].tap()
        app.buttons["Edit"].tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.value as? String, "Keep this unsaved draft")
        app.terminate()
        app.launchArguments = ["--demo"]
        app.launch()
        XCTAssertTrue(app.staticTexts["iPhone app"].waitForExistence(timeout: 15))
        app.staticTexts["iPhone app"].firstMatch.tap()
        app.staticTexts["Review the iPhone app"].firstMatch.tap()
        app.buttons["Edit"].tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.value as? String, "Keep this unsaved draft")
    }

    @MainActor
    func testCreateProjectAndCard() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--reset-demo-drafts"]
        app.launch()
        XCTAssertTrue(app.buttons["New Project"].waitForExistence(timeout: 15))
        app.buttons["New Project"].tap()
        app.textFields["project-name"].tap()
        app.textFields["project-name"].typeText("Native sample")
        app.buttons["Create"].tap()
        XCTAssertTrue(app.staticTexts["Native sample"].waitForExistence(timeout: 5))
        app.staticTexts["Native sample"].tap()
        app.buttons["New Card"].tap()
        let title = app.textFields["card-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap()
        title.typeText("New work")
        app.buttons["Create"].tap()
        XCTAssertTrue(app.staticTexts["New work"].waitForExistence(timeout: 5))
    }

    @MainActor
    private func choose(_ picker: String, value: String, in app: XCUIApplication) {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", picker)).firstMatch.tap()
        app.buttons[value].tap()
    }

    @MainActor
    private func attach(_ app: XCUIApplication, named name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "\(name) accessibility tree"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }

    @MainActor
    private func replace(_ field: XCUIElement, with text: String) {
        field.tap()
        let current = field.value as? String ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        field.typeText(text)
    }
}
