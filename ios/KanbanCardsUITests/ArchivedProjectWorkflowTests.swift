import XCTest

/// Synthetic native navigation and read-only checks. Run only in the disposable VM.
@MainActor
final class ArchivedProjectWorkflowTests: XCTestCase {
    private var runningApp: XCUIApplication?

    override func setUp() async throws { continueAfterFailure = false }
    override func tearDown() async throws { runningApp?.terminate(); runningApp = nil }

    func testEmptyArchivedProjectsRefreshAndBackPreserveActiveProject() {
        let app = launch()
        openArchivedProjects(in: app)
        let empty = app.staticTexts["No archived Projects"]
        XCTAssertTrue(empty.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(archivedProjectRows(in: app).count, 0)

        // Exercise the standard List pull-to-refresh from its top position.
        let list = nativeList(in: app)
        list.swipeDown()
        XCTAssertTrue(empty.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(archivedProjectRows(in: app).count, 0)
        attach(app, named: "Empty archived Projects after native refresh")

        goBack(in: app, to: "Demo Workspace")
        assertOriginalProjectRemainsEditable(in: app)
    }

    func testArchivedProjectKeepsCardReadOnlyAndHistoryReadable() {
        let app = launch(archivedProjects: true)
        openArchivedProject(in: app)
        reveal(app.buttons["Activity"].firstMatch, in: app)
        app.buttons["Activity"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Archived sample activity."].waitForExistence(timeout: 5), app.debugDescription)
        attach(app, named: "Archived Project activity remains readable")
        goBack(in: app, to: "Archived sample")

        let card = app.staticTexts["Read-only sample Card"].firstMatch
        reveal(card, in: app, towardTop: true)
        card.tap()
        assertReadOnlyCard(in: app, title: "Read-only sample Card", comment: "Read-only sample Comment")
        attach(app, named: "Unarchived Card inherits archived Project protection")
        app.buttons["Close"].tap()
        XCTAssertTrue(app.navigationBars["Archived sample"].waitForExistence(timeout: 5), app.debugDescription)
        goBack(in: app, to: "Archived Projects")
        goBack(in: app, to: "Demo Workspace")
        assertOriginalProjectRemainsEditable(in: app)
    }

    func testArchivedCardWithinArchivedProjectCannotRestoreOrPost() {
        let app = launch(archivedProjects: true)
        openArchivedProject(in: app)
        let archivedCards = app.buttons["Archived Cards"]
        reveal(archivedCards, in: app)
        archivedCards.tap()
        XCTAssertTrue(app.navigationBars["Archived Cards"].waitForExistence(timeout: 5), app.debugDescription)
        let card = app.staticTexts["Archived sample Card"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertFalse(app.staticTexts["Read-only sample Card"].exists)
        card.tap()
        assertReadOnlyCard(in: app, title: "Archived sample Card", comment: "Archived sample Comment")
        attach(app, named: "Archived Card cannot restore or post inside archived Project")
        app.buttons["Close"].tap()
        XCTAssertTrue(app.navigationBars["Archived Cards"].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Archived sample Card"].firstMatch.exists)
    }

    private func launch(archivedProjects: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        // These public synthetic cases run before the separate retained-draft case.
        // Teardown only terminates; it never resets the later private fixture.
        app.launchArguments = ["--demo", "--reset-demo-drafts"]
        if archivedProjects { app.launchArguments.append("--demo-archived-projects") }
        runningApp = app
        app.launch()
        XCTAssertTrue(app.staticTexts["iPhone app"].firstMatch.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(app.staticTexts["Archived sample"].exists, "The active Project list must exclude archived Projects.")
        return app
    }

    private func archivedProjectRows(in app: XCUIApplication) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "archive.project."))
    }

    private func openArchivedProjects(in app: XCUIApplication) {
        let archived = app.buttons["project.archived"]
        reveal(archived, in: app)
        archived.tap()
        XCTAssertTrue(app.navigationBars["Archived Projects"].waitForExistence(timeout: 5), app.debugDescription)
    }

    private func openArchivedProject(in app: XCUIApplication) {
        openArchivedProjects(in: app)
        let project = app.buttons["archive.project.demo-archived-project"]
        XCTAssertTrue(project.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(archivedProjectRows(in: app).count, 1, "Only the archived fixture belongs in this list.")
        XCTAssertFalse(app.staticTexts["iPhone app"].exists)
        project.tap()
        XCTAssertTrue(app.navigationBars["Archived sample"].waitForExistence(timeout: 5), app.debugDescription)
        let notice = app.staticTexts["archive.notice"]
        XCTAssertTrue(notice.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertFalse(app.buttons["New Card"].exists)
        // Reach the final Project section before checking that edit/restore
        // actions are absent, rather than relying on an offscreen row query.
        reveal(app.buttons["Archived Cards"], in: app)
        for title in ["Edit Project", "Archive Project", "Restore Project", "New Card"] {
            XCTAssertFalse(app.buttons[title].exists, "Archived Projects must not expose \(title).")
        }
        XCTAssertTrue(app.buttons["Activity"].firstMatch.exists)
        attach(app, named: "Archived Project offers read-only navigation")
    }

    private func assertReadOnlyCard(in app: XCUIApplication, title: String, comment: String) {
        let titleField = app.textFields["card-title"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 5), app.debugDescription)
        assertValue(titleField, equals: title, in: app)
        XCTAssertFalse(titleField.isEnabled, "An archived Project must freeze even an unarchived Card's title.")
        let save = app.buttons["card.save"]
        XCTAssertTrue(save.exists)
        XCTAssertFalse(save.isEnabled)

        let description = app.textViews["card-description"]
        reveal(description, in: app, requireHittable: false)
        assertValue(description, equals: "Check the native Card workflow.", in: app)
        XCTAssertFalse(description.isEnabled)

        let moveRow = app.buttons["Move"].firstMatch
        reveal(moveRow, in: app, requireHittable: false)
        // iOS may expose a Menu as its Form row plus a nested native Button.
        let nestedMove = moveRow.buttons.firstMatch
        let move = nestedMove.exists ? nestedMove : moveRow
        XCTAssertFalse(move.isEnabled, "Destination-only Move must also be blocked by the archived Project.")

        let refresh = app.buttons["Refresh"]
        reveal(refresh, in: app)
        app.swipeUp()
        for title in ["Archive Card", "Restore Card"] {
            XCTAssertFalse(app.buttons[title].exists, "Read-only archived Project Cards must not expose \(title).")
        }
        let comments = app.buttons["Comments (1)"]
        reveal(comments, in: app)
        comments.tap()
        XCTAssertTrue(app.navigationBars["Comments"].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(app.staticTexts[comment].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertFalse(app.buttons["Add Comment"].exists)
        attach(app, named: "Saved Comments readable without a composer")
        goBack(in: app, to: title)

        let activity = app.buttons["Activity"].firstMatch
        reveal(activity, in: app)
        activity.tap()
        XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5), app.debugDescription)
        // The fixture has Project activity, with no events scoped to either Card.
        XCTAssertTrue(app.staticTexts["No Activity"].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertFalse(app.buttons["Add Comment"].exists)
        goBack(in: app, to: title)
        XCTAssertFalse(app.buttons["card.save"].isEnabled)
    }

    private func assertOriginalProjectRemainsEditable(in app: XCUIApplication) {
        let original = app.staticTexts["iPhone app"].firstMatch
        XCTAssertTrue(original.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertFalse(app.staticTexts["Archived sample"].exists)
        original.tap()
        let card = app.staticTexts["Review the iPhone app"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(app.buttons["New Card"].isEnabled)
        card.tap()
        let title = app.textFields["card-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5), app.debugDescription)
        assertValue(title, equals: "Review the iPhone app", in: app)
        XCTAssertTrue(title.isEnabled, "Archived navigation must not make the active Project read-only.")
        app.buttons["Close"].tap()
    }

    private func nativeList(in app: XCUIApplication) -> XCUIElement {
        let list = app.collectionViews.firstMatch
        if list.waitForExistence(timeout: 5) { return list }
        let table = app.tables.firstMatch
        XCTAssertTrue(table.waitForExistence(timeout: 5), app.debugDescription)
        return table
    }

    private func goBack(in app: XCUIApplication, to title: String) {
        let back = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForExistence(timeout: 5), app.debugDescription)
        back.tap()
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5), app.debugDescription)
    }

    private func reveal(_ element: XCUIElement, in app: XCUIApplication, towardTop: Bool = false, requireHittable: Bool = true) {
        for _ in 0..<10 {
            if element.exists && (requireHittable ? element.isHittable : isVisible(element, in: app)) { return }
            if towardTop || (element.exists && element.frame.maxY <= app.frame.minY) { app.swipeDown() }
            else { app.swipeUp() }
        }
        attach(app, named: "Expected native Form control was not visible")
        XCTAssertTrue(element.exists && (requireHittable ? element.isHittable : isVisible(element, in: app)), app.debugDescription)
    }

    private func isVisible(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        !element.frame.isEmpty && app.frame.intersects(element.frame)
    }

    private func assertValue(_ element: XCUIElement, equals expected: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let exactValue = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", expected), object: element)
        let result = XCTWaiter.wait(for: [exactValue], timeout: 5)
        if result != .completed { attach(app, named: "Expected read-only value was not visible") }
        XCTAssertEqual(result, .completed, app.debugDescription, file: file, line: line)
    }

    private func attach(_ app: XCUIApplication, named name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + " accessibility tree"; tree.lifetime = .keepAlways; add(tree)
    }
}
