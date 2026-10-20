import XCTest

/// Synthetic native flows. Run only in the dedicated VM's iOS Simulator.
@MainActor
final class NativeWorkflowTests: XCTestCase {
    private var app: XCUIApplication?
    override func setUp() async throws { continueAfterFailure = false }
    override func tearDown() async throws { app?.terminate(); app = nil }

    func testSI001SI005DirectEditingExplicitSaveAndSeparateMove() throws {
        let app = launch()
        openCard(app)
        let title = app.textFields["card-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5), "Opening a Card must expose its editable fields directly.")
        replace(title, with: "Verify the native workflow")
        XCTAssertEqual(title.value as? String, "Verify the native workflow")
        // AX exposes the Menu as a labeled Form row plus an unlabeled native
        // Button. The decorative label is not independently hittable on iOS 27.
        dismissKeyboard(in: app)
        let moveRow = app.buttons["Move"].firstMatch
        reveal(moveRow, in: app)
        let move = moveRow.buttons.firstMatch
        XCTAssertTrue(move.waitForExistence(timeout: 5), app.debugDescription)
        move.tap()
        let done = app.buttons["Move to Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5), app.debugDescription)
        done.tap()
        XCTAssertTrue(app.staticTexts["Saved Column, Done"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(title.value as? String, "Verify the native workflow", "Separate Move must retain dirty title.")
        app.buttons["card.save"].tap()
        let state = app.staticTexts["card.editing-state"]
        reveal(state, in: app, towardTop: true)
        XCTAssertEqual(state.label, "Saved")
        attach(app, named: "SI-005 saved title and Done destination")
        app.buttons["Close"].tap()
        XCTAssertTrue(app.staticTexts["Verify the native workflow"].firstMatch.waitForExistence(timeout: 5))
        app.staticTexts["Verify the native workflow"].firstMatch.tap()
        XCTAssertEqual(app.textFields["card-title"].value as? String, "Verify the native workflow")
        let savedDestination = app.staticTexts["Saved Column, Done"].firstMatch
        reveal(savedDestination, in: app)
        XCTAssertTrue(savedDestination.exists)
    }

    func testSI003CloseAndRelaunchRetainUnsubmittedDraftAndRevertDoesNotSave() throws {
        let app = launch()
        openCard(app)
        let title = app.textFields["card-title"]
        replace(title, with: "Keep this unsaved draft")
        app.buttons["Close"].tap()
        XCTAssertTrue(app.staticTexts["Review the iPhone app"].firstMatch.waitForExistence(timeout: 5), "Closing must not commit proposed title.")
        app.terminate()
        app.launchArguments = ["--demo"]
        app.launch()
        openCard(app)
        XCTAssertEqual(app.textFields["card-title"].value as? String, "Keep this unsaved draft")
        attach(app, named: "SI-003 recovered local draft after relaunch")
        // secondaryAction is in the standard navigation-bar More menu.
        let more = app.navigationBars.buttons["OverflowBarButtonItem"]
        XCTAssertTrue(more.waitForExistence(timeout: 5), app.debugDescription)
        more.tap()
        let revert = app.buttons["Revert"]
        XCTAssertTrue(revert.waitForExistence(timeout: 5), app.debugDescription)
        revert.tap()
        app.buttons["Revert local edits"].tap()
        // Revert reads current saved state asynchronously before replacing local
        // values. Await the visible result instead of racing that read.
        let reverted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let title = app.textFields["card-title"]
            return title.exists && title.value as? String == "Review the iPhone app"
                && app.staticTexts["card.editing-state"].label == "Saved"
        }, object: nil)
        let completed = XCTWaiter.wait(for: [reverted], timeout: 5)
        if completed != .completed { attach(app, named: "SI-003 Revert result did not arrive") }
        XCTAssertEqual(completed, .completed, app.debugDescription)
        app.buttons["Close"].tap()
        XCTAssertTrue(app.staticTexts["Review the iPhone app"].firstMatch.waitForExistence(timeout: 5))
    }

    func testSI004LocalFailureExposesStandardCopyExportAndPreventsSilentClose() throws {
        let app = launch(extra: ["--demo-draft-write-failure"])
        openCard(app)
        let title = app.textFields["card-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        replace(title, with: "Only in this running app")
        XCTAssertFalse(app.buttons["Close"].isEnabled)
        dismissKeyboard(in: app)
        // Recovery controls precede the fields. The old generic reveal helper
        // scrolled past them toward the end of the Form when they were hidden.
        reveal(app.buttons["Copy draft"], in: app, towardTop: true)
        XCTAssertTrue(app.buttons["Retry local protection"].exists)
        XCTAssertTrue(app.buttons["Copy draft"].isEnabled)
        XCTAssertTrue(app.buttons["Export draft"].isEnabled)
        app.buttons["Copy draft"].tap()
        attach(app, named: "SI-004 failed persistence with standard recovery controls")
    }

    func testCommentAndArchiveRestorePreserveExistingWorkflow() throws {
        let app = launch()
        openCard(app)
        reveal(app.buttons["Comments (0)"], in: app)
        app.buttons["Comments (0)"].tap()
        app.buttons["Add Comment"].tap()
        let comment = app.textViews["comment-body"]
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        comment.tap(); comment.typeText("Verified using standard Apple controls.")
        app.buttons["Post"].tap()
        XCTAssertTrue(app.staticTexts["Comment posted."].waitForExistence(timeout: 5))
        app.buttons["Close"].tap()
        XCTAssertTrue(app.staticTexts["Verified using standard Apple controls."].waitForExistence(timeout: 5))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        reveal(app.buttons["Archive Card"], in: app)
        app.buttons["Archive Card"].tap()
        XCTAssertTrue(app.buttons["Restore Card"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["card.save"].isEnabled)
        app.buttons["Restore Card"].tap()
        XCTAssertTrue(app.buttons["Archive Card"].waitForExistence(timeout: 5))
        attach(app, named: "Existing archive and Restore through direct editor")
    }

    func testCreateProjectAndCard() throws {
        let app = launch()
        XCTAssertTrue(app.buttons["New Project"].waitForExistence(timeout: 15))
        app.buttons["New Project"].tap()
        app.textFields["project-name"].tap(); app.textFields["project-name"].typeText("Native sample")
        app.buttons["Create"].tap()
        XCTAssertTrue(app.staticTexts["Native sample"].waitForExistence(timeout: 5))
        app.staticTexts["Native sample"].tap()
        app.buttons["New Card"].tap()
        let title = app.textFields["card-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap(); title.typeText("New work")
        app.buttons["Create"].tap()
        XCTAssertTrue(app.staticTexts["New work"].waitForExistence(timeout: 5))
    }

    func testUnreadCreationDraftsDoNotBlockNewFormsAfterRelaunch() throws {
        let app = launch(extra: ["--demo-unreadable-creation-drafts"])
        app.buttons["New Project"].tap()
        assertUnreadCreationDraft(in: app, field: "project-name")
        app.buttons["creation.cancel"].tap()
        app.staticTexts["iPhone app"].firstMatch.tap()
        app.buttons["New Card"].tap()
        assertUnreadCreationDraft(in: app, field: "card-title")
        app.buttons["creation.cancel"].tap()
        app.terminate()
        // Do not reseed or reset: both original unread records must still exist.
        app.launchArguments = ["--demo"]
        app.launch()
        XCTAssertTrue(app.staticTexts["iPhone app"].firstMatch.waitForExistence(timeout: 15))
        app.buttons["New Project"].tap()
        assertUnreadCreationDraft(in: app, field: "project-name")
        attach(app, named: "Unread Project draft retained after Cancel and relaunch")
        app.buttons["creation.cancel"].tap()
        app.staticTexts["iPhone app"].firstMatch.tap()
        app.buttons["New Card"].tap()
        assertUnreadCreationDraft(in: app, field: "card-title")
        attach(app, named: "Unread Card creation draft retained after Cancel and relaunch")
        app.buttons["creation.cancel"].tap()
    }

    private func assertUnreadCreationDraft(in app: XCUIApplication, field: String) {
        XCTAssertTrue(app.textFields[field].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(app.textFields[field].isEnabled, "An unread old draft must not disable a fresh form.")
        XCTAssertTrue(app.buttons["creation.saved-drafts"].exists, "The old draft must remain recoverable separately.")
        XCTAssertFalse(app.buttons["Retry reading retained draft"].exists)
        XCTAssertFalse(app.buttons["This is the original Workspace"].exists)
    }

    private func launch(extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--reset-demo-drafts"] + extra
        self.app = app; app.launch(); return app
    }
    private func openCard(_ app: XCUIApplication) {
        XCTAssertTrue(app.staticTexts["iPhone app"].firstMatch.waitForExistence(timeout: 15))
        app.staticTexts["iPhone app"].firstMatch.tap()
        app.staticTexts["Review the iPhone app"].firstMatch.tap()
    }
    private func dismissKeyboard(in app: XCUIApplication) {
        guard app.keyboards.firstMatch.exists else { return }
        let returnKey = app.keyboards.descendants(matching: .any).matching(identifier: "Return").firstMatch
        XCTAssertTrue(returnKey.exists, app.debugDescription)
        returnKey.tap()
        if !app.keyboards.firstMatch.waitForNonExistence(timeout: 3) {
            // The editor uses the standard interactive scroll-dismiss behavior.
            app.swipeDown()
        }
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5), app.debugDescription)
    }
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, towardTop: Bool = false) {
        for _ in 0..<10 {
            if element.exists && element.isHittable { return }
            if towardTop || (element.exists && element.frame.minY < 0) { app.swipeDown() }
            else { app.swipeUp() }
        }
        XCTAssertTrue(element.exists && element.isHittable, app.debugDescription)
    }
    private func replace(_ field: XCUIElement, with text: String) {
        field.tap()
        let current = field.value as? String ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        field.typeText(text)
    }
    private func attach(_ app: XCUIApplication, named name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
        let tree = XCTAttachment(string: app.debugDescription); tree.name = name + " accessibility tree"; tree.lifetime = .keepAlways; add(tree)
    }
}
