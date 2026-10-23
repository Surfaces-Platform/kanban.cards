import XCTest

/// Uses derived in-memory history only. No server session or network access.
@MainActor
final class WorkspaceActivityWorkflowTests: XCTestCase {
    private var app: XCUIApplication?

    override func setUp() async throws { continueAfterFailure = false }
    override func tearDown() async throws { app?.terminate(); app = nil }

    func testWorkspaceHistoryIncludesArchivedProjectsAndAgentNamesAndRefreshes() {
        let app = launch(["--demo-archived-projects"])
        let activity = app.buttons["workspace.activity"]
        reveal(activity, in: app)
        activity.tap()
        XCTAssertTrue(app.navigationBars["Workspace Activity"].waitForExistence(timeout: 5), app.debugDescription)
        let codex = metadata("By", containing: "Codex Writer (demo)", in: app,
            eventID: "workspace.activity.demo-project:demo-codex-activity")
        reveal(codex, in: app)
        attach(app, named: "Workspace Activity newest event has Codex agent metadata")
        reveal(app.staticTexts["Archived sample activity."].firstMatch, in: app)
        reveal(metadata("Project", containing: "Archived sample", in: app,
            eventID: "workspace.activity.demo-archived-project:demo-archived-activity"), in: app)
        reveal(app.staticTexts["Archived Project"].firstMatch, in: app)
        attach(app, named: "Workspace Activity includes archived Project context")
        reveal(metadata("By", containing: "Claude Research (demo)", in: app,
            eventID: "workspace.activity.demo-project:demo-claude-activity"), in: app)
        attach(app, named: "Workspace Activity older event has Claude agent metadata")
        app.buttons["activity.refresh"].tap()
        reveal(codex, in: app, towardTop: true)
        attach(app, named: "Refreshed Workspace Activity preserves newest agent metadata")
    }

    func testWorkspaceActivityRemainsAvailableWithoutProjects() {
        let app = launch(["--demo-empty-projects"])
        XCTAssertTrue(app.staticTexts["No Projects"].waitForExistence(timeout: 5), app.debugDescription)
        let activity = app.buttons["workspace.activity"]
        reveal(activity, in: app)
        activity.tap()
        XCTAssertTrue(app.staticTexts["No Workspace Activity"].waitForExistence(timeout: 5), app.debugDescription)
        app.buttons["activity.refresh"].tap()
        XCTAssertTrue(app.staticTexts["No Workspace Activity"].waitForExistence(timeout: 5), app.debugDescription)
        attach(app, named: "Empty Workspace still offers Activity")
    }

    func testProjectAndCardActivityKeepAgentNamesVisible() {
        let app = launch([])
        let project = app.staticTexts["iPhone app"].firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 5), app.debugDescription)
        project.tap()
        let activity = app.buttons["Activity"].firstMatch
        reveal(activity, in: app)
        activity.tap()
        XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5), app.debugDescription)
        reveal(metadata("By", containing: "Codex Writer (demo)", in: app), in: app)
        reveal(metadata("By", containing: "Claude Research (demo)", in: app), in: app)
        attach(app, named: "Project Activity preserves agent metadata")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let card = app.staticTexts["Review the iPhone app"].firstMatch
        reveal(card, in: app, towardTop: true)
        card.tap()
        let cardActivity = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@ OR identifier == %@", "Activity", "Activity")).firstMatch
        reveal(cardActivity, in: app)
        cardActivity.tap()
        XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5), app.debugDescription)
        reveal(metadata("By", containing: "Codex Writer (demo)", in: app), in: app)
        reveal(metadata("By", containing: "Claude Research (demo)", in: app), in: app)
        attach(app, named: "Card Activity preserves agent metadata")
    }

    private func launch(_ arguments: [String]) -> XCUIApplication {
        let application = XCUIApplication()
        application.launchArguments = ["--demo", "--reset-demo-drafts"] + arguments
        app = application
        application.launch()
        XCTAssertTrue(application.navigationBars["Demo Workspace"].waitForExistence(timeout: 15), application.debugDescription)
        return application
    }

    private func reveal(_ element: XCUIElement, in app: XCUIApplication, towardTop: Bool = false) {
        for _ in 0..<10 {
            if element.exists && element.isHittable { return }
            if towardTop || (element.exists && element.frame.maxY <= app.frame.minY) { app.swipeDown() }
            else { app.swipeUp() }
        }
        XCTAssertTrue(element.exists && element.isHittable, app.debugDescription)
    }

    private func metadata(_ field: String, containing value: String, in app: XCUIApplication,
                          eventID: String? = nil) -> XCUIElement {
        // LabeledContent exposes the field and value as one native accessibility
        // label (for example "By, Codex Writer (demo)"). Match metadata, not a
        // summary that happens to contain the same agent or Project name.
        var predicates = [NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", field + ", ", value)]
        if let eventID { predicates.append(NSPredicate(format: "identifier == %@", eventID)) }
        return app.staticTexts.matching(NSCompoundPredicate(andPredicateWithSubpredicates: predicates)).firstMatch
    }

    private func attach(_ app: XCUIApplication, named name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + " accessibility tree"; tree.lifetime = .keepAlways; add(tree)
    }
}
