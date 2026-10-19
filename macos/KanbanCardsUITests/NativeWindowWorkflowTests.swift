import Foundation
import XCTest

@MainActor
final class NativeWindowWorkflowTests: XCTestCase {
    private let homepage = "demo-card-homepage"
    private let signup = "demo-card-signup"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSI005MoveWithDirtyTitleThenExplicitSavePreservesNewColumn() throws {
        let app = launch()
        let first = viewer(homepage, in: app)
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        focus(homepage, in: app)
        let title = first.textFields["editor.title"]
        replace(title, with: "Draft title retained during Move")
        XCTAssertTrue(first.buttons["editor.save"].isEnabled)
        XCTAssertFalse(first.popUpButtons["editor.column"].exists)
        app.menuBars.menuBarItems["Card"].click()
        app.menuItems["Move Card…"].click()
        let move = app.sheets.firstMatch
        XCTAssertTrue(move.waitForExistence(timeout: 5))
        move.popUpButtons.firstMatch.click()
        app.menuItems["Done"].firstMatch.click()
        move.buttons["Move"].click()
        XCTAssertTrue(move.waitForNonExistence(timeout: 5))
        XCTAssertEqual(title.value as? String, "Draft title retained during Move")
        first.typeKey("s", modifierFlags: .command)
        let saved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == false"), object: first.buttons["editor.save"])
        XCTAssertEqual(XCTWaiter.wait(for: [saved], timeout: 5), .completed)
        showBoard(app)
        let done = board(in: app).descendants(matching: .any).matching(identifier: "board.column.done").firstMatch
        XCTAssertTrue(done.buttons["board.card.\(homepage)"].exists)
        assertLabel(done.buttons["board.card.\(homepage)"], contains: "Draft title retained during Move")
        focus(homepage, in: app, windowTitle: "Draft title retained during Move")
        first.buttons[XCUIIdentifierCloseWindow].click()
        showBoard(app)
        board(in: app).buttons["board.card.\(homepage)"].click()
        XCTAssertEqual(viewer(homepage, in: app).textFields["editor.title"].value as? String, "Draft title retained during Move")
        app.terminate()
    }

    func testBoardOpensTwoUniqueViewersAndEachClosesIndependently() throws {
        let app = launch()
        let board = board(in: app)
        let first = viewer(homepage, in: app)
        let second = viewer(signup, in: app)
        XCTAssertTrue(board.waitForExistence(timeout: 10))
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        attach(app, named: "Board and two independent Card windows")
        let separated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !first.frame.intersects(second.frame) }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [separated], timeout: 5), .completed, "The first two Card windows must start side by side: \(first.frame), \(second.frame)")
        let desktop = XCTAttachment(screenshot: board.screenshot())
        desktop.name = "direction-a-native-board-and-two-cards"
        desktop.lifetime = .keepAlways
        add(desktop)

        showBoard(app)
        board.buttons["board.card.\(homepage)"].click()
        XCTAssertEqual(app.windows.containing(.any, identifier: "card.window.\(homepage)").count, 1)
        XCTAssertTrue(second.exists)
        focus(homepage, in: app)
        first.buttons[XCUIIdentifierCloseWindow].click()
        XCTAssertTrue(first.waitForNonExistence(timeout: 5))
        XCTAssertTrue(second.exists)
        XCTAssertTrue(board.exists)
        focus(signup, in: app)
        second.buttons[XCUIIdentifierCloseWindow].click()
        XCTAssertTrue(second.waitForNonExistence(timeout: 5))
        XCTAssertTrue(board.exists)
    }

    func testMovingAndResizingOneCardLeavesTheOtherUnchanged() throws {
        let app = launch()
        let first = viewer(homepage, in: app)
        let second = viewer(signup, in: app)
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        focus(homepage, in: app)
        let originalFirst = first.frame
        let originalSecond = second.frame
        let titlebar = first.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: 95, dy: 26))
        // Move away from the adjacent viewer so the resize gesture has free space
        // instead of ending at the native neighboring-window snap boundary.
        titlebar.click(forDuration: 0.4, thenDragTo: titlebar.withOffset(CGVector(dx: -35, dy: -25)))

        let moved = first.frame
        XCTAssertGreaterThan(hypot(moved.minX - originalFirst.minX, moved.minY - originalFirst.minY), 20)
        assertFrame(second.frame, equals: originalSecond)
        XCTAssertEqual(moved.width, originalFirst.width, accuracy: 2)
        XCTAssertEqual(moved.height, originalFirst.height, accuracy: 2)

        let rightEdge = first.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.6))
            .withOffset(CGVector(dx: -1, dy: 0))
        rightEdge.click(forDuration: 0.4, thenDragTo: rightEdge.withOffset(CGVector(dx: 45, dy: 0)))
        let wider = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            first.frame.width > moved.width + 20
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [wider], timeout: 5), .completed)
        XCTAssertGreaterThan(first.frame.width, moved.width + 20)
        assertFrame(second.frame, equals: originalSecond)
        let bottomEdge = first.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 1))
            .withOffset(CGVector(dx: 0, dy: -1))
        bottomEdge.click(forDuration: 0.4, thenDragTo: bottomEdge.withOffset(CGVector(dx: 0, dy: 30)))
        let taller = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            first.frame.height > moved.height + 10
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [taller], timeout: 5), .completed)

        let resized = first.frame
        XCTAssertGreaterThan(resized.width, moved.width + 20)
        XCTAssertGreaterThan(resized.height, moved.height + 10)
        assertFrame(second.frame, equals: originalSecond)
        attach(app, named: "One Card moved and resized independently")
    }

    func testSaveSharesBoardStateAndRevertKeepsTheWindowEditable() throws {
        let app = launch()
        let first = viewer(homepage, in: app)
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        focus(homepage, in: app)
        let title = first.textFields["editor.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        let nextAction = first.textFields.matching(NSPredicate(
            format: "value == %@", "Choose the preferred heading order")).firstMatch
        let body = first.textViews["editor.body"]
        XCTAssertTrue(nextAction.waitForExistence(timeout: 5))
        XCTAssertTrue(body.waitForExistence(timeout: 5))
        let oldValues = try [XCTUnwrap(title.value as? String),
                             XCTUnwrap(nextAction.value as? String),
                             XCTUnwrap(body.value as? String)]
        replace(title, with: "Confirmed homepage title")
        replace(nextAction, with: "Verify saved labels.")
        replace(body, with: "Saved Card description.")
        first.buttons["editor.save"].click()
        XCTAssertTrue(title.exists, "Save keeps the Card editable in its existing window.")
        assertLabel(board(in: app).buttons["board.card.\(homepage)"], contains: "Confirmed homepage title")
        for value in ["Confirmed homepage title", "Verify saved labels.", "Saved Card description."] {
            let savedText = first.descendants(matching: .any).matching(NSPredicate(
                format: "label == %@ OR value == %@", value, value)).firstMatch
            XCTAssertTrue(savedText.waitForExistence(timeout: 5), "The complete saved value must be accessible: \(value)")
        }
        let staleLabels = first.descendants(matching: .any).matching(NSPredicate(
            format: "label IN %@ OR value IN %@", oldValues, oldValues))
        let labelsUpdated = XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == 0"), object: staleLabels)
        XCTAssertEqual(XCTWaiter.wait(for: [labelsUpdated], timeout: 3), .completed,
                       "No Card accessibility element may retain a superseded saved value.")
        replace(title, with: "Keep this unsaved title")
        showBoard(app)
        board(in: app).buttons["board.card.\(homepage)"].click()
        XCTAssertEqual(title.value as? String, "Keep this unsaved title")
        XCTAssertEqual(app.windows.containing(.any, identifier: "card.window.\(homepage)").count, 1)
        first.buttons["editor.revert"].click()
        let revert = app.buttons["editor.revert-confirm"].firstMatch
        XCTAssertTrue(revert.waitForExistence(timeout: 5))
        revert.click()
        let reverted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            title.value as? String == "Confirmed homepage title"
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [reverted], timeout: 5), .completed)
        assertLabel(board(in: app).buttons["board.card.\(homepage)"], contains: "Confirmed homepage title")
        attach(app, named: "Save updates shared data and Revert preserves the editable Card window")
    }

    func testEveryCardWindowIsEditableAndSignOutClearsAllWindows() throws {
        let app = launch()
        let first = viewer(homepage, in: app)
        let second = viewer(signup, in: app)
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        for (cardID, window) in [(homepage, first), (signup, second)] {
            focus(cardID, in: app)
            let title = window.textFields["editor.title"]
            XCTAssertTrue(title.waitForExistence(timeout: 5))
            XCTAssertTrue(title.isEnabled)
            XCTAssertFalse(window.buttons["card.edit.\(cardID)"].exists)
            XCTAssertFalse(window.buttons["editor.cancel"].exists)
        }
        showBoard(app)
        board(in: app).buttons["session.sign-out"].click()
        XCTAssertTrue(app.buttons["session.sign-in"].waitForExistence(timeout: 5))
        XCTAssertTrue(first.waitForNonExistence(timeout: 5))
        XCTAssertTrue(second.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.textFields.matching(NSPredicate(format: "value == %@", "Review homepage hierarchy")).firstMatch.exists)
        XCTAssertFalse(app.textFields.matching(NSPredicate(format: "value == %@", "Simplify the signup introduction")).firstMatch.exists)
        attach(app, named: "Sign-out removes private data from every editable Card window")
    }

    func testClosingBoardPreservesViewersAndShowBoardReopensOnlyOneBoard() throws {
        let app = launch()
        let first = viewer(homepage, in: app)
        let second = viewer(signup, in: app)
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        showBoard(app)
        let originalBoard = board(in: app)
        originalBoard.buttons[XCUIIdentifierCloseWindow].click()
        XCTAssertTrue(originalBoard.waitForNonExistence(timeout: 5))
        XCTAssertTrue(first.exists)
        XCTAssertTrue(second.exists)

        focus(homepage, in: app)
        showBoard(app)
        XCTAssertTrue(board(in: app).waitForExistence(timeout: 5))
        showBoard(app)
        XCTAssertEqual(app.windows.containing(.button, identifier: "session.sign-out").count, 1)
        XCTAssertTrue(first.exists)
        XCTAssertTrue(second.exists)
        attach(app, named: "Board reopened while both Card viewers remain open")
    }

    func testMenuCommandsUseFocusedWindowAndPreserveStandardFindShortcut() throws {
        let app = launch()
        showBoard(app)
        assertMenu(app, named: "File", enabled: ["New Card…", "New Project…", "Show Board"])
        assertMenu(app, named: "Project", enabled: ["Edit Project…", "Activity…", "Archive Project…"])
        assertMenu(app, named: "View", enabled: ["Refresh"])
        app.typeKey("n", modifierFlags: [.command, .shift])
        let projectName = board(in: app).textFields["project-name"]
        XCTAssertTrue(projectName.waitForExistence(timeout: 5))
        board(in: app).buttons["editor.cancel"].click()
        app.typeKey("n", modifierFlags: .command)
        let cardTitle = board(in: app).textFields["editor.title"]
        XCTAssertTrue(cardTitle.waitForExistence(timeout: 5))
        board(in: app).buttons["editor.cancel"].click()

        focus(homepage, in: app)
        let first = viewer(homepage, in: app)
        assertMenu(app, named: "Card", enabled: ["Add Comment", "Move Card…", "Activity…", "Archive Card…"])
        assertMenu(app, named: "View", enabled: ["Refresh"])
        let title = first.textFields["editor.title"]
        XCTAssertTrue(title.exists)
        let originalTitle = title.value as? String
        title.click()
        title.typeKey("a", modifierFlags: .command)
        app.typeKey("e", modifierFlags: .command)
        XCTAssertEqual(title.value as? String, originalTitle,
                       "Command-E remains the standard system Find selection command.")
        XCTAssertEqual(app.sheets.count, 0)
        replace(title, with: "Saved with the File command")
        assertMenu(app, named: "File", enabled: ["Save"])
        app.typeKey("s", modifierFlags: .command)
        assertLabel(board(in: app).buttons["board.card.\(homepage)"], contains: "Saved with the File command")
        XCTAssertTrue(title.exists)
        attach(app, named: "Focused File Save and native Find shortcuts preserve the always-editable Card")
    }

    func testCommentCommandRunsInlineAlongsideAnUnfinishedCardDraft() throws {
        let app = launch()
        focus(homepage, in: app)
        let first = viewer(homepage, in: app)
        let title = first.textFields["editor.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        let unfinished = "Unfinished Card while composing a Comment"
        replace(title, with: unfinished)
        assertMenu(app, named: "Card", enabled: ["Add Comment", "Move Card…", "Activity…", "Archive Card…"])
        app.typeKey("m", modifierFlags: [.command, .shift])
        XCTAssertTrue(first.textViews["comment.body"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.sheets.count, 0)
        XCTAssertEqual(title.value as? String, unfinished)
        first.buttons["comment.cancel"].click()
        XCTAssertTrue(first.textViews["comment.body"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(title.exists)
        XCTAssertEqual(title.value as? String, unfinished)
        attach(app, named: "Inline Comments coexist with the unfinished Card draft")
    }

    func testContextualCommentActionKeepsToolbarCompactAndOpensEditor() throws {
        let app = launch()
        defer { attach(app, named: "Contextual Comment editing and compact Card toolbar") }
        focus(homepage, in: app)
        let first = viewer(homepage, in: app)
        let commentAction = first.buttons["card.add-comment.\(homepage)"]
        XCTAssertTrue(commentAction.waitForExistence(timeout: 5))
        XCTAssertEqual(first.buttons.matching(identifier: "card.add-comment.\(homepage)").count, 1,
                       "Comments should have one contextual Add Comment action.")
        XCTAssertFalse(first.toolbars.buttons.matching(identifier: "card.add-comment.\(homepage)").firstMatch.exists,
                       "The Card toolbar should not duplicate the contextual Comment action.")
        assertLabel(commentAction, contains: "Add Comment")
        commentAction.click()
        XCTAssertTrue(first.textViews["comment.body"].waitForExistence(timeout: 5))
        first.buttons["comment.cancel"].click()
        XCTAssertTrue(first.textViews["comment.body"].waitForNonExistence(timeout: 5))
        let actions = first.descendants(matching: .any).matching(identifier: "card.actions.\(homepage)").firstMatch
        XCTAssertTrue(actions.exists)
        assertLabel(actions, contains: "More Card actions")
        actions.click()
        let activity = app.menuItems["card.actions.\(homepage).action.0"]
        XCTAssertTrue(activity.waitForExistence(timeout: 5))
        XCTAssertEqual(activity.title, "Activity…", "Native menu items expose their action name as a title.")
        XCTAssertTrue(activity.isEnabled)
        activity.click()
        let done = first.buttons["Done"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 5), "The native pull-down action must open Activity.")
        done.click()
        XCTAssertTrue(done.waitForNonExistence(timeout: 5))
        assertMenu(app, named: "Card", enabled: ["Add Comment", "Activity…", "Archive Card…"])
    }

    func testRequiredTitleAndRetainedDraftAreExplained() throws {
        let app = launch()
        defer { attach(app, named: "Required title validation and recovered local draft") }
        showBoard(app)
        app.typeKey("n", modifierFlags: .command)
        let board = board(in: app)
        let title = board.textFields["editor.title"]
        let requiredLabel = board.staticTexts.matching(NSPredicate(format: "label == %@ OR value == %@",
            "Title (required)", "Title (required)")).firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertFalse(board.buttons["editor.save"].isEnabled)
        XCTAssertTrue(requiredLabel.isHittable, "The required-field label must remain visible beside the native field.")
        XCTAssertTrue(board.staticTexts["editor.draft-status"].exists)
        replace(title, with: "   ")
        XCTAssertFalse(board.buttons["editor.save"].isEnabled)
        XCTAssertTrue(requiredLabel.isHittable, "A filled field must retain its required-field label.")
        replace(title, with: "Retained creation draft")
        XCTAssertTrue(board.buttons["editor.save"].isEnabled)
        board.buttons["editor.cancel"].click()
        app.typeKey("n", modifierFlags: .command)
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.value as? String, "Retained creation draft")
        assertLabel(board.staticTexts["editor.draft-status"], contains: "Recovered draft")
        board.buttons["editor.cancel"].click()
    }

    func testCreatedCardOpensViewerEvenWhenBoardFiltersExcludeIt() throws {
        let app = launch()
        showBoard(app)
        let board = board(in: app)
        openFilters(in: board, app: app)
        choose("You", from: app.popUpButtons["board.filter.actor"], in: app)
        choose("High", from: app.popUpButtons["board.filter.priority"], in: app)
        closeFilters(in: app)
        app.typeKey("n", modifierFlags: .command)
        let title = board.textFields["editor.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        let createdTitle = "Created while filters exclude Unassigned Cards"
        replace(title, with: createdTitle)
        board.buttons["editor.save"].click()
        XCTAssertTrue(title.waitForNonExistence(timeout: 5))
        let created = app.windows.containing(NSPredicate(
            format: "identifier == %@ AND value == %@", "editor.title", createdTitle)).firstMatch
        XCTAssertTrue(created.waitForExistence(timeout: 5), "Creation must reveal the confirmed editable Card.")
        XCTAssertEqual(created.textFields["editor.title"].value as? String, createdTitle)
        showBoard(app)
        openFilters(in: board, app: app)
        XCTAssertEqual(app.popUpButtons["board.filter.actor"].value as? String, "You")
        XCTAssertEqual(app.popUpButtons["board.filter.priority"].value as? String, "High")
        closeFilters(in: app)
        XCTAssertFalse(board.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@",
                                                          "board.card.", createdTitle)).firstMatch.exists)
        attach(app, named: "Created Card remains reachable while filters stay applied")
    }

    func testNativeBoardPopupsUpdateBindingsAndClearRestoresInventory() throws {
        let app = launch()
        showBoard(app)
        let board = board(in: app)
        let workspace = board.popUpButtons["board.workspace"]
        let actor = app.popUpButtons["board.filter.actor"]
        let priority = app.popUpButtons["board.filter.priority"]
        let blocked = app.popUpButtons["board.filter.blocked"]
        func assertCount(_ visible: Int, file: StaticString = #filePath, line: UInt = #line) {
            let rows = board.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "board.card."))
            let updated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in rows.count == visible }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed,
                           "Expected \(visible) visible Card rows; actual: \(rows.count).", file: file, line: line)
        }

        assertCount(9)
        choose("Studio Workspace", from: workspace, in: app)
        XCTAssertEqual(workspace.value as? String, "Studio Workspace")
        assertCount(9)
        openFilters(in: board, app: app)
        choose("You", from: actor, in: app)
        assertCount(4)
        XCTAssertEqual(actor.value as? String, "You")
        choose("High", from: priority, in: app)
        assertCount(3)
        XCTAssertEqual(priority.value as? String, "High")
        choose("Blocked", from: blocked, in: app)
        assertCount(0)
        XCTAssertEqual(blocked.value as? String, "Blocked")
        filterControls(in: app).buttons["board.clear-filters"].click()
        assertCount(9)
        XCTAssertEqual(actor.value as? String, "All actors")
        XCTAssertEqual(priority.value as? String, "All priorities")
        XCTAssertEqual(blocked.value as? String, "All")

        choose("Blocked", from: blocked, in: app)
        assertCount(1)
        XCTAssertTrue(board.buttons["board.card.demo-card-licenses"].exists)
        XCTAssertFalse(board.buttons["board.card.\(homepage)"].exists)
        choose("Unblocked", from: blocked, in: app)
        assertCount(8)
        XCTAssertEqual(blocked.value as? String, "Unblocked")
        XCTAssertFalse(board.buttons["board.card.demo-card-licenses"].exists)
        XCTAssertTrue(board.buttons["board.card.\(homepage)"].exists)
        choose("All", from: blocked, in: app)
        assertCount(9)
        XCTAssertTrue(filterControls(in: app).buttons["board.clear-filters"].exists)
        XCTAssertFalse(filterControls(in: app).buttons["board.clear-filters"].isEnabled)
        closeFilters(in: app)
        XCTAssertFalse(board.staticTexts["board.filter-summary"].exists)
        XCTAssertEqual(workspace.value as? String, "Studio Workspace")
        attach(app, named: "Native board popup bindings and restored filter inventory")
    }

    func testArchivedProjectCanBeRestoredAndEditingResumes() throws {
        let app = launch()
        showBoard(app)
        let board = board(in: app)
        clickMenu(app, named: "Project", item: "Archive Project…")
        let confirm = board.buttons["project.archive-confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.click()
        assertLabel(board.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@",
                                                         "Archived Project", "Archived Project")).firstMatch,
                    contains: "read-only")
        XCTAssertFalse(board.buttons["board.new-card"].isEnabled)
        XCTAssertFalse(viewer(homepage, in: app).textFields["editor.title"].isEnabled)
        assertMenu(app, named: "Project", enabled: ["Restore Project…"], disabled: ["Edit Project…"])
        clickMenu(app, named: "Project", item: "Restore Project…")
        let restore = board.buttons["project.restore-confirm"]
        XCTAssertTrue(restore.waitForExistence(timeout: 5))
        restore.click()
        assertEnabled(board.buttons["board.new-card"])
        assertEnabled(viewer(homepage, in: app).textFields["editor.title"])
        app.typeKey("n", modifierFlags: .command)
        XCTAssertTrue(board.textFields["editor.title"].waitForExistence(timeout: 5))
        board.buttons["editor.cancel"].click()
        attach(app, named: "Project restoration re-enables board and Card editing")
    }

    func testGracefulRelaunchRestoresIndependentWindowsGeometryAndLocalDraft() throws {
        // The first launch resets only synthetic draft/frame fixtures. Both launches
        // allow normal macOS state restoration; the second does not force example windows.
        let app = launch(restoration: true)
        // The preceding case may restore no board. Establish this test's starting
        // fixture through the normal command; the second launch stays unforced.
        showBoard(app)
        XCTAssertTrue(board(in: app).waitForExistence(timeout: 10))
        // Establish a synthetic initial workspace through the normal UI, without
        // racing forced example opening against the system's restoration transaction.
        for cardID in [homepage, signup] {
            for window in app.windows.containing(.any, identifier: "card.window.\(cardID)").allElementsBoundByIndex {
                window.buttons[XCUIIdentifierCloseWindow].click()
            }
        }
        showBoard(app)
        board(in: app).buttons["board.card.\(homepage)"].click()
        XCTAssertTrue(viewer(homepage, in: app).waitForExistence(timeout: 5))
        showBoard(app)
        board(in: app).buttons["board.card.\(signup)"].click()
        let first = viewer(homepage, in: app)
        let second = viewer(signup, in: app)
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        focus(homepage, in: app)
        let titlebar = first.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 95, dy: 26))
        titlebar.click(forDuration: 0.4, thenDragTo: titlebar.withOffset(CGVector(dx: 35, dy: -20)))
        let title = first.textFields["editor.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        replace(title, with: "Draft recovered after normal app relaunch")
        focus(signup, in: app)
        let rightEdge = second.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.6))
            .withOffset(CGVector(dx: -1, dy: 0))
        rightEdge.click(forDuration: 0.4, thenDragTo: rightEdge.withOffset(CGVector(dx: 30, dy: 0)))
        let firstFrame = first.frame
        let secondFrame = second.frame
        app.typeKey("q", modifierFlags: .command)
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 10))

        app.launchArguments = ["--demo", "-NSQuitAlwaysKeepsWindows", "YES", "-ApplePersistenceIgnoreState", "NO"]
        app.launch()
        let restoredFirst = viewer(homepage, in: app)
        let restoredSecond = viewer(signup, in: app)
        XCTAssertTrue(board(in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(restoredFirst.waitForExistence(timeout: 10))
        XCTAssertTrue(restoredSecond.waitForExistence(timeout: 10))
        XCTAssertEqual(app.windows.containing(.button, identifier: "session.sign-out").count, 1)
        XCTAssertEqual(app.windows.containing(.any, identifier: "card.window.\(homepage)").count, 1)
        XCTAssertEqual(app.windows.containing(.any, identifier: "card.window.\(signup)").count, 1)
        assertFrame(restoredFirst.frame, equals: firstFrame)
        assertFrame(restoredSecond.frame, equals: secondFrame)
        focus(homepage, in: app)
        let recoveredTitle = restoredFirst.textFields["editor.title"]
        XCTAssertTrue(recoveredTitle.waitForExistence(timeout: 5))
        XCTAssertEqual(recoveredTitle.value as? String, "Draft recovered after normal app relaunch")
        assertLabel(restoredFirst.staticTexts["editor.draft-status"], contains: "Recovered draft")
        attach(app, named: "Normal relaunch restores viewers geometry and retained draft")
    }

    func testLongContentKeepsControlsReachableInLightAndDarkAppearance() throws {
        for appearance in ["--appearance-light", "--appearance-dark"] {
            let app = launch(extraArguments: [appearance, "--audit-long-content"])
            let board = board(in: app)
            XCTAssertTrue(board.waitForExistence(timeout: 10))
            showBoard(app)
            let rightEdge = board.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.6))
                .withOffset(CGVector(dx: -1, dy: 0))
            let contraction = max(0, board.frame.width - 1024)
            if contraction > 2 {
                rightEdge.click(forDuration: 0.4, thenDragTo: rightEdge.withOffset(CGVector(dx: -contraction, dy: 0)))
            }
            XCTAssertTrue(board.buttons["board.new-card"].isHittable)
            XCTAssertFalse(board.buttons["board.filters"].exists)
            openFilters(in: board, app: app)
            let filters = filterControls(in: app)
            assertFiltersFit(filters)
            choose("Unassigned", from: app.popUpButtons["board.filter.actor"], in: app)
            choose("High", from: app.popUpButtons["board.filter.priority"], in: app)
            choose("Unblocked", from: app.popUpButtons["board.filter.blocked"], in: app)
            XCTAssertEqual(app.popUpButtons["board.filter.actor"].value as? String, "Unassigned")
            XCTAssertEqual(app.popUpButtons["board.filter.priority"].value as? String, "High")
            XCTAssertEqual(app.popUpButtons["board.filter.blocked"].value as? String, "Unblocked")
            XCTAssertTrue(filters.buttons["board.clear-filters"].isHittable)
            assertFiltersFit(filters)
            closeFilters(in: app)
            assertLabel(board.staticTexts["board.filter-summary"], contains: "Unassigned")
            assertLabel(board.staticTexts["board.filter-summary"], contains: "High")
            assertLabel(board.staticTexts["board.filter-summary"], contains: "Unblocked")
            for column in ["next", "doing", "done"] {
                XCTAssertTrue(board.descendants(matching: .any).matching(identifier: "board.column.\(column)").firstMatch.exists)
            }
            app.typeKey("n", modifierFlags: .command)
            XCTAssertTrue(board.textFields["editor.title"].waitForExistence(timeout: 5))
            XCTAssertTrue(board.buttons["editor.cancel"].isHittable)
            XCTAssertTrue(board.buttons["editor.save"].isHittable)
            board.buttons["editor.cancel"].click()
            attach(app, named: "Long content at minimum board width \(appearance)")
            app.terminate()
        }
    }

    func testNativeVoiceOverCommonTasksUseSpeechAndNativeActions() throws {
        guard #available(macOS 27.0, *) else { XCTFail("Requires the macOS 27 VoiceOver test service."); return }
        try withVoiceOverDemo("Board navigation and filters") { flow in
            let app = flow.app
            let board = board(in: app)
            try flow.enter("Enter sidebar")
            try flow.seekBackward("Workspace", terms: ["Workspace", "Studio Workspace"], role: "pop up button", limit: 6)
            try flow.activate("Open Workspace popup")
            XCTAssertTrue(app.menuItems["Studio Workspace"].firstMatch.waitForExistence(timeout: 5))
            try flow.require("Selected Workspace", terms: ["Studio Workspace"])
            try flow.activate("Keep Studio Workspace selected")
            XCTAssertEqual(board.popUpButtons["board.workspace"].value as? String, "Studio Workspace")
            try flow.seekForward("Projects heading", terms: ["Projects"], role: "heading", limit: 5)
            try flow.leave("Leave sidebar", terms: ["Workspaces and Projects"])
            try flow.enterBoardContents()
            try flow.enter("Enter inline board filters")
            XCTAssertFalse(board.buttons["board.filters"].exists)
            XCTAssertTrue(board.popUpButtons["board.filter.actor"].isHittable)
            try flow.selectPopup("Next actor", identifier: "board.filter.actor", value: "You", expectedCount: 4)
            try flow.selectPopup("Priority", identifier: "board.filter.priority", value: "High", expectedCount: 3)
            try flow.selectPopup("Blocked", identifier: "board.filter.blocked", value: "Blocked", expectedCount: 0)
            try flow.seekForward("Clear", terms: ["Clear"], role: "button", limit: 5)
            try flow.activate("Clear board filters")
            flow.assertCount(9)
            XCTAssertFalse(board.buttons["board.clear-filters"].isEnabled)
            try flow.leave("Leave Board controls", terms: ["Board controls"])
            try flow.seekForward("Columns scroll area", terms: [], role: "scroll area", limit: 6)
            try flow.enter("Next Column", terms: ["Next", "4 Cards"], role: "group")
            for (index, column) in [("Next", 4), ("Doing", 3), ("Done", 2)].enumerated() {
                if index > 0 {
                    try flow.forward("Column splitter", terms: ["splitter"])
                    try flow.forward("\(column.0) Column", terms: [column.0, "\(column.1) Cards"], role: "group")
                }
                try flow.enter("\(column.0) heading", terms: [column.0, "\(column.1) Cards"], role: "heading")
                try flow.leave("Leave \(column.0) Column", terms: [column.0])
            }
        }
    }

    func testNativeVoiceOverChangesCardPopupsAndPreservesSavedValues() throws {
        guard #available(macOS 27.0, *) else { XCTFail("Requires the macOS 27 VoiceOver test service."); return }
        try withVoiceOverDemo("Card popup activation, draft changes, and saved values",
                              openExampleCards: true, resetBoardCursor: false) { flow in
            let app = flow.app
            focus(homepage, in: app)
            let first = viewer(homepage, in: app)
            XCTAssertFalse(first.popUpButtons["editor.column"].exists, "Existing Card placement uses the separate Move action.")
            let actor = first.popUpButtons["editor.next-actor"]
            let priority = first.popUpButtons["editor.priority"]
            for popup in [actor, priority] {
                XCTAssertTrue(popup.waitForExistence(timeout: 5))
                XCTAssertTrue(popup.isEnabled)
            }
            XCTAssertEqual(actor.value as? String, "You")
            XCTAssertEqual(priority.value as? String, "High")

            @MainActor
            func selectCardPopup(_ label: String, popup: XCUIElement,
                                 oldValue: String, newValue: String) throws {
                try flow.scan("Card \(label) popup", terms: [label, oldValue], role: "pop up button", limit: 16)
                try flow.activate("Open Card \(label) popup")
                XCTAssertTrue(app.menuItems[newValue].firstMatch.waitForExistence(timeout: 5),
                              "VO-Space must open the Card popup's native menu.")
                for index in 1...8 {
                    if flow.lastSpeech.localizedCaseInsensitiveContains(newValue) { break }
                    app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [.control, .option])
                    try flow.current("Card \(label) menu item \(index)")
                }
                try flow.require("Card \(label) target option", terms: [newValue])
                try flow.activate("Select Card \(label): \(newValue)")
                XCTAssertEqual(popup.value as? String, newValue,
                               "The accessibility action must update the Card draft binding.")
            }

            try flow.startCardReading()
            try selectCardPopup("Next actor", popup: actor, oldValue: "You", newValue: "Agent")
            try selectCardPopup("Priority", popup: priority, oldValue: "High", newValue: "Low")
            assertEnabled(first.buttons["editor.save"])
            let board = board(in: app)
            let boardCard = board.buttons["board.card.\(homepage)"]
            assertLabel(boardCard, contains: "You")
            assertLabel(boardCard, contains: "High priority")
            XCTAssertFalse(boardCard.label.contains("Low priority"), "Popup changes stay in the draft until Save.")

            // Popup opening and selection above use actual VoiceOver actions.
            // Cmd-S and ordinary window reopening establish the saved-state checks below.
            first.typeKey("s", modifierFlags: .command)
            assertLabel(boardCard, contains: "Agent")
            assertLabel(boardCard, contains: "Low priority")
            let doingColumn = board.descendants(matching: .any).matching(identifier: "board.column.doing").firstMatch
            XCTAssertTrue(doingColumn.buttons["board.card.\(homepage)"].exists,
                          "Saving Card fields must preserve the saved placement.")
            first.buttons[XCUIIdentifierCloseWindow].click()
            XCTAssertTrue(first.waitForNonExistence(timeout: 5))
            showBoard(app)
            board.buttons["board.card.\(homepage)"].click()
            let reopened = viewer(homepage, in: app)
            XCTAssertTrue(reopened.waitForExistence(timeout: 5))
            XCTAssertFalse(reopened.popUpButtons["editor.column"].exists)
            XCTAssertEqual(reopened.popUpButtons["editor.next-actor"].value as? String, "Agent")
            XCTAssertEqual(reopened.popUpButtons["editor.priority"].value as? String, "Low")
            XCTAssertEqual(viewer(signup, in: app).popUpButtons["editor.priority"].value as? String, "Medium",
                           "Changing the focused Card must preserve the other Card's values.")
            XCTAssertEqual(app.windows.containing(.any, identifier: "card.window.\(homepage)").count, 1)
        }
    }

    func testNativeVoiceOverReadsCurrentCardContentAfterSave() throws {
        guard #available(macOS 27.0, *) else { XCTFail("Requires the macOS 27 VoiceOver test service."); return }
        try withVoiceOverDemo("Current Card speech after Save",
                              openExampleCards: true, resetBoardCursor: false) { flow in
            let app = flow.app
            focus(homepage, in: app)
            let first = viewer(homepage, in: app)
            let title = first.textFields["editor.title"]
            let action = first.textFields.matching(NSPredicate(
                format: "value == %@", "Choose the preferred heading order")).firstMatch
            let body = first.textViews["editor.body"]
            XCTAssertTrue(title.waitForExistence(timeout: 5))
            XCTAssertTrue(action.waitForExistence(timeout: 5))
            XCTAssertTrue(body.waitForExistence(timeout: 5))
            let savedTitle = "Saved title"
            let savedAction = "Saved next action"
            // The service caps utterances at 64 characters, including the field label
            // and cursor hint. Require the entire replacement body within that limit.
            let savedBody = "Saved body"
            replace(title, with: savedTitle)
            replace(action, with: savedAction)
            replace(body, with: savedBody)
            XCTAssertEqual(title.value as? String, savedTitle)
            XCTAssertEqual(body.value as? String, savedBody)
            first.buttons["editor.save"].click()
            XCTAssertTrue(title.exists, "Save leaves the native Title field editable.")
            let setup = XCTAttachment(string: "Native Window-menu focus, editor interaction, and Save establish the synthetic data change as setup; these actions do not prove VoiceOver activation. The following native VoiceOver traversal must speak the newly saved title, action, and description and must not speak the original content. The shared helper retains the actual speech transcript and screenshot.")
            setup.name = "Saved Card setup and actual speech boundary"
            setup.lifetime = .keepAlways
            add(setup)

            let firstReadingStep = flow.transcript.count
            try flow.startCardReading()
            try flow.scan("Updated Card Title field", terms: [savedTitle, "Title"], role: "edit text", limit: 20)
            try flow.scan("Updated Next action field", terms: [savedAction, "Next action"], role: "edit text", limit: 20)
            try flow.scan("Updated Description field", terms: [savedBody, "Description"], role: "edit text", limit: 16)
            let capturedSpeech = flow.transcript.dropFirst(firstReadingStep).joined(separator: "\n")
            for oldContent in ["Review homepage hierarchy", "Choose the preferred heading order", "Help a first-time visitor"] {
                XCTAssertFalse(capturedSpeech.localizedCaseInsensitiveContains(oldContent),
                               "VoiceOver must not read superseded Card content after Save: \(oldContent)")
            }
            XCTAssertTrue(viewer(signup, in: app).exists)
            XCTAssertTrue(board(in: app).exists)
        }
    }

    func testNativeVoiceOverCardReadingAndCommentTask() throws {
        guard #available(macOS 27.0, *) else { XCTFail("Requires the macOS 27 VoiceOver test service."); return }
        try withVoiceOverDemo("Card reading and contextual Comment") { flow in
            let first = try flow.openCard(homepage)
            func assertCommentDuration(after author: String, speech: String) {
                let escapedAuthor = NSRegularExpression.escapedPattern(for: author)
                let units = "(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)"
                let pattern = "^\(escapedAuthor)(?:,\\s*|\\s+)\\d+\\s*\(units)\\b"
                XCTAssertNotNil(speech.range(of: pattern, options: [.regularExpression, .caseInsensitive]),
                                "The Comment must announce a native relative duration immediately after its author: \(speech)")
            }
            try flow.startCardReading()
            try flow.scan("Card Title field", terms: ["Review homepage hierarchy", "Title"], role: "edit text", limit: 20)
            try flow.scan("Next actor popup", terms: ["Next actor", "You"], role: "pop up button", limit: 12)
            try flow.scan("Priority popup", terms: ["Priority", "High"], role: "pop up button", limit: 8)
            try flow.scan("Next action field", terms: ["Next action"], role: "edit text", limit: 8)
            try flow.scan("Blocker field", terms: ["Blocker"], role: "edit text", limit: 8)
            try flow.scan("Description field", terms: ["Description"], role: "edit text", limit: 10)
            try flow.scan("Comments", terms: ["Comments (2)"], limit: 10)
            try flow.scan("First Comment author and time", terms: ["Studio assistant"], limit: 8)
            assertCommentDuration(after: "Studio assistant", speech: flow.lastSpeech)
            try flow.scan("First Comment spoken prefix", terms: ["The revised order puts"], limit: 4)
            let captureBoundary = XCTAttachment(string: "This host has returned at most 64 characters per VoiceOver utterance. Native Comment grouping can announce the author, relative duration, and body together or as consecutive items. The short body prefix is checked in the actual speech, including when it belongs to that same item. The complete body is checked separately in the native accessibility value; this does not prove the complete body was spoken.")
            captureBoundary.name = "Comment speech capture and native List grouping boundary"
            captureBoundary.lifetime = .keepAlways
            add(captureBoundary)
            let firstBody = "The revised order puts the offer before implementation detail."
            let firstText = first.staticTexts.matching(NSPredicate(format: "label == %@ OR value == %@", firstBody, firstBody)).firstMatch
            XCTAssertTrue(firstText.exists)
            XCTAssertTrue(firstText.label == firstBody || firstText.value as? String == firstBody)
            try flow.scan("Second Comment author and time", terms: ["You"], limit: 4)
            assertCommentDuration(after: "You", speech: flow.lastSpeech)
            try flow.scan("Second Comment spoken prefix", terms: ["Keep the short explanation; compare"], limit: 4)
            let secondBody = "Keep the short explanation; compare the two heading options."
            let secondText = first.staticTexts.matching(NSPredicate(format: "label == %@ OR value == %@", secondBody, secondBody)).firstMatch
            XCTAssertTrue(secondText.exists)
            XCTAssertTrue(secondText.label == secondBody || secondText.value as? String == secondBody)
            try flow.scan("Add Comment", terms: ["Add Comment"], role: "button", limit: 6)
            try flow.activate("Open Comment editor")
            XCTAssertTrue(first.textViews["comment.body"].waitForExistence(timeout: 5))
            // The empty TextEditor starts in text interaction and can announce
            // only "actions available". Leave that interaction to hear the
            // native field's label and role before navigating its siblings.
            try flow.leave("Leave autofocused Comment text interaction")
            try flow.beginContentScan("Comment editor")
            try flow.scan("Comment field", terms: ["Comment"], role: "edit text", limit: 12)
            try flow.scan("Cancel Comment", terms: ["Cancel"], role: "button", limit: 20)
            try flow.activate("Cancel Comment")
            XCTAssertTrue(first.textViews["comment.body"].waitForNonExistence(timeout: 5))
            XCTAssertTrue(first.textFields["editor.title"].isEnabled)
            XCTAssertEqual(flow.app.sheets.count, 0)
        }
    }

    func testNativeVoiceOverRequiredTitleAndIndependentCardEditing() throws {
        guard #available(macOS 27.0, *) else { XCTFail("Requires the macOS 27 VoiceOver test service."); return }
        try withVoiceOverDemo("Required Title and independent editable Cards",
                              openExampleCards: true, resetBoardCursor: false) { flow in
            let app = flow.app
            let setup = XCTAttachment(string: "The demo opens the board and two synthetic Card windows. The native Window menu and Title click establish the focused field as setup; actual VoiceOver speech must identify its value, required label, and edit-text role. Native VoiceOver activation must invoke Revert and confirm it. The other Card must keep its original Title.")
            setup.name = "Independent editable Card setup and VoiceOver proof boundary"
            setup.lifetime = .keepAlways
            add(setup)
            focus(homepage, in: app)
            let first = viewer(homepage, in: app)
            let firstTitle = first.textFields["editor.title"]
            XCTAssertTrue(firstTitle.waitForExistence(timeout: 5))
            firstTitle.click()
            try flow.beginContentScan("Focused homepage Title")
            try flow.scan("Homepage Title field", terms: ["Review homepage hierarchy", "Title"], role: "edit text", limit: 20)
            try flow.activate("Edit homepage Title")
            app.typeKey("a", modifierFlags: .command)
            app.typeKey(XCUIKeyboardKey.delete.rawValue, modifierFlags: [])
            XCTAssertEqual(firstTitle.value as? String, "")
            XCTAssertFalse(first.buttons["editor.save"].isEnabled)
            app.typeText("Draft")
            XCTAssertEqual(firstTitle.value as? String, "Draft")
            assertEnabled(first.buttons["editor.save"])
            try flow.current("Short required Title")
            if !flow.lastSpeech.localizedCaseInsensitiveContains("Title")
                || !flow.lastSpeech.localizedCaseInsensitiveContains("required")
                || !flow.lastSpeech.localizedCaseInsensitiveContains("edit text") {
                try flow.leave("Leave Title text interaction for its complete label")
                try flow.beginContentScan("Required Title after text interaction")
                try flow.scan("Complete required Title field", terms: ["Title", "required"], role: "edit text", limit: 20)
            }
            try flow.require("Complete required Title field", terms: ["Title", "required"], role: "edit text")
            try flow.leave("Leave homepage Title text interaction")
            try flow.beginContentScan("Homepage Card actions")
            try flow.scan("Revert homepage changes", terms: ["Revert"], role: "button", limit: 24)
            try flow.activate("Request homepage Revert")
            let confirmation = app.buttons["editor.revert-confirm"].firstMatch
            XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
            try flow.beginContentScan("Revert confirmation")
            try flow.scan("Confirm Revert Changes", terms: ["Revert Changes"], role: "button", limit: 12)
            try flow.activate("Confirm homepage Revert")
            let reverted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                firstTitle.value as? String == "Review homepage hierarchy"
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [reverted], timeout: 5), .completed)
            XCTAssertTrue(firstTitle.exists, "Revert preserves the editable Card field.")
            focus(signup, in: app)
            let second = viewer(signup, in: app)
            let secondTitle = second.textFields["editor.title"]
            XCTAssertTrue(secondTitle.waitForExistence(timeout: 5))
            XCTAssertEqual(secondTitle.value as? String, "Simplify the signup introduction")
            secondTitle.click()
            try flow.beginContentScan("Focused signup Title")
            try flow.scan("Signup Title field", terms: ["Simplify the signup introduction", "Title"], role: "edit text", limit: 20)
            XCTAssertEqual(app.windows.containing(.any, identifier: "card.window.\(homepage)").count, 1)
            XCTAssertEqual(app.windows.containing(.any, identifier: "card.window.\(signup)").count, 1)
            XCTAssertTrue(board(in: app).exists)
            XCTAssertTrue(firstTitle.exists)
            XCTAssertFalse(second.textViews["comment.body"].exists)
            XCTAssertEqual(app.sheets.count, 0)
        }
    }

    // The former five-heading reader tests were retired with read/edit modes.
    // Native form labels, values, Save/Revert, and inline Comments are covered above.

    @available(macOS 27.0, *)
    private func withVoiceOverDemo(_ name: String, openExampleCards: Bool = false,
                                  resetBoardCursor: Bool = true,
                                  body: (VoiceOverWorkflow) throws -> Void) throws {
        let vo = XCUIDevice.shared.voiceOverService
        let initiallyEnabled = vo.isEnabled
        let app = XCUIApplication()
        addTeardownBlock {
            try await MainActor.run {
                defer { XCTAssertEqual(vo.isEnabled, initiallyEnabled, "Restore the original VoiceOver state.") }
                if vo.isEnabled != initiallyEnabled {
                    if initiallyEnabled { try vo.enable() } else { try vo.disable() }
                }
            }
        }
        app.launchArguments = ["--demo", "--card-view", "windows", "--reset-demo-drafts", "--reset-demo-window-layout",
                               "-ApplePersistenceIgnoreState", "YES"]
        if openExampleCards { app.launchArguments.append("--open-example-cards") }
        app.launch()
        showBoard(app)
        XCTAssertTrue(board(in: app).waitForExistence(timeout: 10))
        if openExampleCards {
            XCTAssertTrue(viewer(homepage, in: app).waitForExistence(timeout: 10))
            XCTAssertTrue(viewer(signup, in: app).waitForExistence(timeout: 10))
            XCTAssertEqual(app.windows.count, 3)
        } else {
            XCTAssertEqual(app.windows.count, 1)
        }
        // Initialize the test service even when VoiceOver was enabled natively.
        // The preceding successful speech run used this sequence before focus.
        try vo.enable()
        XCTAssertTrue(vo.isEnabled)
        app.activate()
        showBoard(app)
        let flow = VoiceOverWorkflow(test: self, app: app)
        defer {
            let speech = XCTAttachment(string: flow.transcript.joined(separator: "\n"))
            speech.name = "\(name): actual VoiceOver speech"
            speech.lifetime = .keepAlways
            add(speech)
            attach(app, named: name)
        }
        if resetBoardCursor { try flow.resetBoardCursor() }
        try body(flow)
    }

    @available(macOS 27.0, *)
    @MainActor
    private final class VoiceOverWorkflow {
        unowned let test: NativeWindowWorkflowTests
        let app: XCUIApplication
        private let vo = XCUIDevice.shared.voiceOverService
        private let started = Date()
        private var calls = 0
        private var scanDepth = 0
        private var scanSeen: [Set<String>] = [Set()]
        private var entered: Set<String> = []
        private var climbsWithoutKnownParent = 0
        private(set) var transcript: [String] = []
        private(set) var lastSpeech = ""

        init(test: NativeWindowWorkflowTests, app: XCUIApplication) {
            self.test = test
            self.app = app
        }

        private func checkBudget() throws {
            guard calls < 120, Date().timeIntervalSince(started) < 280 else {
                throw failure("Exceeded the 120-operation or 280-second VoiceOver workflow budget.")
            }
            calls += 1
        }

        private func failure(_ message: String) -> NSError {
            NSError(domain: "KanbanCardsUITests.VoiceOverNavigation", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "\(message) Last speech: \(lastSpeech)"])
        }

        private func record(_ step: String, _ speech: String) {
            XCTAssertFalse(speech.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                           "VoiceOver returned no actual speech for \(step).")
            lastSpeech = speech
            let entry = "\(step): \(speech)"
            transcript.append(entry)
            print("VOICEOVER TASK \(entry)")
        }

        private func matches(_ terms: [String], role: String?) -> Bool {
            (terms + (role.map { [$0] } ?? [])).allSatisfy { lastSpeech.localizedCaseInsensitiveContains($0) }
        }

        func require(_ step: String, terms: [String], role: String? = nil) throws {
            guard matches(terms, role: role) else {
                throw failure("\(step) must announce \((terms + (role.map { [$0] } ?? [])).joined(separator: ", ")).")
            }
        }

        func current(_ step: String, terms: [String] = [], role: String? = nil) throws {
            try checkBudget()
            record(step, try vo.currentSpeech().utterance)
            try require(step, terms: terms, role: role)
        }

        func forward(_ step: String, terms: [String] = [], role: String? = nil) throws {
            try checkBudget()
            record(step, try vo.moveForward().utterance)
            try require(step, terms: terms, role: role)
        }

        func enter(_ step: String, terms: [String] = [], role: String? = nil) throws {
            try checkBudget()
            record(step, try vo.moveIn().utterance)
            try require(step, terms: terms, role: role)
        }

        func leave(_ step: String, terms: [String] = []) throws {
            try checkBudget()
            record(step, try vo.moveOut().utterance)
            try require(step, terms: terms)
        }

        func activate(_ step: String) throws {
            try checkBudget()
            app.typeKey(XCUIKeyboardKey.space.rawValue, modifierFlags: [.control, .option])
            try current("After VO-Space: \(step)")
        }

        func seekForward(_ step: String, terms: [String], role: String? = nil, limit: Int) throws {
            if matches(terms, role: role) { return }
            for index in 1...limit {
                try forward("\(step), next \(index)")
                if matches(terms, role: role) { return }
            }
            throw failure("Could not reach \(step) within \(limit) forward operations.")
        }

        func seekBackward(_ step: String, terms: [String], role: String? = nil, limit: Int) throws {
            if matches(terms, role: role) { return }
            for index in 1...limit {
                try checkBudget()
                record("\(step), previous \(index)", try vo.moveBackward().utterance)
                if matches(terms, role: role) { return }
            }
            throw failure("Could not reach \(step) within \(limit) backward operations.")
        }

        func resetBoardCursor() throws {
            // One root command per board entry, never one per landmark.
            app.typeKey(XCUIKeyboardKey.escape.rawValue, modifierFlags: [.control, .option, .shift])
            // XCTest's keyboard wait can outlast the identity announcement and
            // capture a later toolbar hint. Native movement returns the next
            // item identity synchronously; require the actual root before entry.
            try current("After board root command")
            try seekForward("Board root", terms: ["Project board"], role: "group", limit: 8)
            try require("Board root", terms: ["Project board"], role: "group")
            for level in 1...3 {
                try enter("Board root level \(level)")
                if matches(["Workspaces and Projects"], role: "table") { return }
                try require("Board wrapper", terms: ["Project board"], role: "group")
            }
            throw failure("Could not enter the board sidebar through the native root.")
        }

        func enterBoardContents() throws {
            try seekForward("Board contents", terms: ["Project board contents"], role: "group", limit: 3)
            // SwiftUI applies the enclosing Project-board label to board.surface.
            // Native VO enters that actual group directly at its Board controls child.
            try enter("Board controls", terms: ["Board controls"], role: "group")
        }

        func assertCount(_ count: Int) {
            let rows = test.board(in: app).buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "board.card."))
            let updated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in rows.count == count }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed,
                           "Expected \(count) visible Card rows; actual: \(rows.count).")
        }

        func selectPopup(_ label: String, identifier: String, value: String, expectedCount: Int) throws {
            try seekForward(label, terms: [label], role: "pop up button", limit: 4)
            try activate("Open \(label)")
            XCTAssertTrue(app.menuItems[value].firstMatch.waitForExistence(timeout: 5))
            for index in 1...8 {
                if matches([value], role: nil) { break }
                try checkBudget()
                app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [.control, .option])
                try current("\(label) menu item \(index)")
            }
            try require("Selected \(label) menu item", terms: [value])
            try activate("Select \(value)")
            XCTAssertEqual(app.popUpButtons[identifier].value as? String, value)
            assertCount(expectedCount)
        }

        func openCard(_ cardID: String) throws -> XCUIElement {
            try enterBoardContents()
            try seekForward("Columns scroll area", terms: [], role: "scroll area", limit: 14)
            try enter("Next Column", terms: ["Next", "4 Cards"], role: "group")
            let targetColumn = cardID == test.homepage ? "Doing" : "Done"
            for column in ["Doing", "Done"] {
                try forward("Column splitter", terms: ["splitter"])
                try forward("\(column) Column", terms: [column], role: "group")
                if column == targetColumn { break }
            }
            try enter("\(targetColumn) heading", terms: [targetColumn], role: "heading")
            try seekForward("\(targetColumn) Cards", terms: ["\(targetColumn) Cards"], role: "table", limit: 3)
            try enter("Enter \(targetColumn) Cards")
            try beginContentScan("Card list")
            let title = cardID == test.homepage ? "Review homepage hierarchy" : "Simplify the signup introduction"
            let metadata = cardID == test.homepage ? ["You", "High"] : ["Agent", "Medium"]
            try scan("Card identity and metadata", terms: [title] + metadata, limit: 12)
            let button = test.board(in: app).descendants(matching: .any).matching(identifier: "board.card.\(cardID)").firstMatch
            XCTAssertTrue(button.exists)
            XCTAssertEqual(button.elementType, .button)
            let boundary = XCTAttachment(string: "Prior host runs captured at most 64 characters per VoiceOver utterance. Card identity and metadata must be returned as actual speech. The native button role and successful VO-Space window result are verified separately; this does not prove complete long-sentence audio.")
            boundary.name = "Observed VoiceOver speech capture boundary"
            boundary.lifetime = .keepAlways
            test.add(boundary)
            try activate("Open \(title)")
            let window = test.viewer(cardID, in: app)
            XCTAssertTrue(window.waitForExistence(timeout: 5), "VO-Space must open the matching Card window.")
            return window
        }

        func startCardReading() throws {
            app.typeKey(XCUIKeyboardKey.escape.rawValue, modifierFlags: [.control, .option, .shift])
            try current("After Card root command")
            try seekForward("Card root", terms: ["Card details"], role: "group", limit: 8)
            try require("Card root", terms: ["Card details"], role: "group")
            try beginContentScan("Card contents")
        }

        func beginContentScan(_ step: String) throws {
            resetContentScanState()
            try current(step)
        }

        private func resetContentScanState() {
            scanDepth = 0
            scanSeen = [Set()]
            entered = []
            climbsWithoutKnownParent = 0
        }

        private var isContainer: Bool {
            let patterns = [
                // An entered item's speech can name its parent table first.
                // Treat only a terminal container role as the current item.
                #"\b(?:table(?:\s+Row)?|group|scroll(?:\s+area)?|list)\s*$"#,
                #"\bRow\s+\d+\s+of\s+\d+\b"#
            ]
            return patterns.contains { lastSpeech.range(of: $0, options: [.regularExpression, .caseInsensitive]) != nil }
        }

        func scan(_ step: String, terms: [String], role: String? = nil, limit: Int) throws {
            // Continue from the existing cursor. Enter only encountered native
            // containers, never rewind or restart the complete window for a label.
            for index in 0..<limit {
                if matches(terms, role: role), role != nil || !isContainer { return }
                let key = "\(scanDepth):\(lastSpeech)"
                if isContainer, scanDepth < 8, entered.insert(key).inserted {
                    let before = lastSpeech
                    do {
                        try enter("\(step), enter container \(index)")
                        if lastSpeech != before {
                            scanDepth += 1
                            scanSeen.append(Set())
                            continue
                        }
                    } catch {
                        let error = error as NSError
                        guard error.domain == XCUIVoiceOverServiceErrorDomain,
                              error.code == XCUIVoiceOverService.Error.Code.noSpeech.rawValue else { throw error }
                    }
                }
                let previous = lastSpeech
                scanSeen[scanDepth].insert(previous)
                try forward("\(step), next \(index)")
                if lastSpeech == previous || scanSeen[scanDepth].contains(lastSpeech) {
                    try leave("\(step), leave completed container")
                    if scanDepth > 0 {
                        scanDepth -= 1
                        scanSeen.removeLast()
                    } else {
                        climbsWithoutKnownParent += 1
                        guard climbsWithoutKnownParent <= 3 else { throw failure("Reached the native traversal boundary while locating \(step).") }
                    }
                    try forward("\(step), next after container")
                }
            }
            throw failure("Could not reach \(step) within \(limit) native traversal steps.")
        }

        func readMetadata(_ label: String, value: String) throws {
            try scan(label, terms: [label], limit: 8)
            if !matches([value], role: nil) {
                try scan("\(label) value", terms: [value], limit: 3)
            }
            try require("\(label) value", terms: [value])
        }
    }

    func testNativeAccessibilityAuditForBoardAndCardDescriptions() throws {
        var unexpectedIssues: [String] = []
        var acceptedDiagnostics: [String] = []
        var reviewedBoardDiagnostics: [String] = []
        let containerReview = ReviewedBoardContainerDiagnostics()
        for appearance in ["--appearance-light", "--appearance-dark"] {
            let app = XCUIApplication()
            // Audit a single unobstructed window. Other workflows still exercise
            // the board plus two viewers and preserve their separate raw evidence.
            app.launchArguments = ["--demo", "--card-view", "windows", "--reset-demo-drafts", "--reset-demo-window-layout",
                                   "-ApplePersistenceIgnoreState", "YES", appearance]
            app.launch()
            showBoard(app)
            let board = board(in: app)
            XCTAssertTrue(board.waitForExistence(timeout: 10))
            XCTAssertEqual(app.windows.count, 1, "The board audit must start without restored/example Card windows.")
            if board.frame.width < 1320 {
                let rightEdge = board.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.6))
                    .withOffset(CGVector(dx: -1, dy: 0))
                rightEdge.click(forDuration: 0.4,
                    thenDragTo: rightEdge.withOffset(CGVector(dx: 1320 - board.frame.width, dy: 0)))
            }
            XCTAssertTrue(board.buttons["board.card.\(homepage)"].isHittable)
            XCTAssertTrue(board.buttons["board.card.\(signup)"].isHittable,
                          "All three Columns must be visible during the ordinary-width board audit.")
            settlePointerAwayFromHelpTags(in: board, app: app)
            attach(app, named: "Isolated board accessibility audit \(appearance)")
            let boardAudit = try collectAccessibilityAudit(app, context: "Isolated board \(appearance)",
                window: board, containerReview: containerReview)
            unexpectedIssues += boardAudit.unexpected
            acceptedDiagnostics += boardAudit.accepted
            reviewedBoardDiagnostics += boardAudit.reviewed

            board.buttons["board.card.\(homepage)"].click()
            let card = viewer(homepage, in: app)
            XCTAssertTrue(card.waitForExistence(timeout: 5))
            showBoard(app)
            board.buttons[XCUIIdentifierCloseWindow].click()
            XCTAssertTrue(board.waitForNonExistence(timeout: 5))
            focus(homepage, in: app)
            XCTAssertEqual(app.windows.count, 1, "The Card audit must contain only the focused viewer.")
            settlePointerAwayFromHelpTags(in: card, app: app)
            attach(app, named: "Isolated Card accessibility audit \(appearance)")
            let cardAudit = try collectAccessibilityAudit(app, context: "Isolated Card \(appearance)",
                window: card, containerReview: containerReview)
            unexpectedIssues += cardAudit.unexpected
            acceptedDiagnostics += cardAudit.accepted
            reviewedBoardDiagnostics += cardAudit.reviewed
            app.terminate()
        }
        let diagnostics = XCTAttachment(string: acceptedDiagnostics.isEmpty
            ? "No accepted accessibility diagnostics."
            : acceptedDiagnostics.joined(separator: "\n\n"))
        diagnostics.name = "Accepted exact framework and fixture accessibility diagnostics"
        diagnostics.lifetime = .keepAlways
        add(diagnostics)

        // Disclose only the reviewed Board wrappers, separately from the existing exact
        // TouchBar/fixture exceptions. These native reports remain present.
        let counts = containerReview.disclosureCounts
        var disclosure = ["Reviewed Board container diagnostics remain present in the raw audit. Card contexts expect zero reviewed containers.",
                          "Existing TouchBar/fixture diagnostics: \(acceptedDiagnostics.count) (separate attachment)."]
        for context in ReviewedBoardContainerDiagnostics.expectedDisclosureCounts.keys.sorted() {
            let expected = ReviewedBoardContainerDiagnostics.expectedDisclosureCounts[context]!
            let missing = containerReview.missingCategories(in: context).sorted()
            disclosure.append("\(context): \(counts[context] ?? 0)/\(expected) reviewed wrappers; missing: \(missing.joined(separator: ", "))")
        }
        let nativeDiagnostics = XCTAttachment(string:
            disclosure.joined(separator: "\n") + "\n\n" + reviewedBoardDiagnostics.joined(separator: "\n\n"))
        nativeDiagnostics.name = "Reviewed Board container diagnostics - 12 expected, Card 0, all raw issues retained"
        nativeDiagnostics.lifetime = .keepAlways
        add(nativeDiagnostics)

        XCTAssertTrue(unexpectedIssues.isEmpty, unexpectedIssues.joined(separator: "\n\n"))
        XCTAssertEqual(reviewedBoardDiagnostics.count, 12,
                       "Board wrapper diagnostics changed; review the raw audit instead of broadening acceptance.")
        for (context, expected) in ReviewedBoardContainerDiagnostics.expectedDisclosureCounts {
            XCTAssertEqual(counts[context], expected, "Reviewed wrapper count changed in \(context).")
            XCTAssertTrue(containerReview.missingCategories(in: context).isEmpty,
                          "A reviewed wrapper category is missing or changed in \(context).")
        }
    }

    private func collectAccessibilityAudit(_ app: XCUIApplication, context: String,
        window: XCUIElement, containerReview: ReviewedBoardContainerDiagnostics
    ) throws -> (unexpected: [String], accepted: [String], reviewed: [String]) {
        var unexpected: [String] = []
        var accepted: [String] = []
        var reviewed: [String] = []
        try app.performAccessibilityAudit(for: .all) { issue in
            let raw = "\(context)\n\(issue.auditType.rawValue): \(issue.compactDescription)\nDetails: \(issue.detailedDescription)\nElement: \(issue.element?.debugDescription ?? "No element returned")"
            let detail = XCTAttachment(string: raw)
            detail.name = "\(context) raw accessibility issue"
            detail.lifetime = .keepAlways
            self.add(detail)
            if let reason = self.acceptedAccessibilityDiagnostic(issue) {
                accepted.append("\(reason)\n\(raw)")
                let acceptedDetail = XCTAttachment(string: "\(reason)\n\(raw)")
                acceptedDetail.name = "Accepted accessibility diagnostic"
                acceptedDetail.lifetime = .keepAlways
                self.add(acceptedDetail)
            } else if let category = containerReview.category(for: issue, context: context, in: window),
                      let origin = ReviewedBoardContainerDiagnostics.frameworkOrigin(for: category) {
                let record = "Reviewed native wrapper: \(category)\n\(origin)\n\(raw)"
                reviewed.append(record)
                let reviewedDetail = XCTAttachment(string: record)
                reviewedDetail.name = "Reviewed native container diagnostic: \(category)"
                reviewedDetail.lifetime = .keepAlways
                self.add(reviewedDetail)
            } else {
                unexpected.append(raw)
            }
            // Continue collecting. Every unmatched issue fails the final assertion.
            return true
        }
        return (unexpected, accepted, reviewed)
    }

    private func settlePointerAwayFromHelpTags(in window: XCUIElement, app: XCUIApplication) {
        // Snapshotting can leave the pointer over a Card's tooltip. Audit the
        // stable window rather than a transient native help popup from that hover.
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1))
            .withOffset(CGVector(dx: 0, dy: -2)).hover()
        XCTAssertTrue(app.descendants(matching: .helpTag).firstMatch.waitForNonExistence(timeout: 3),
                      "Transient help popups must dismiss before auditing the window.")
    }

    private func acceptedAccessibilityDiagnostic(_ issue: XCUIAccessibilityAuditIssue) -> String? {
        guard issue.auditType == .sufficientElementDescription, let element = issue.element else { return nil }
        if issue.compactDescription == "Label duplicates role description",
           element.elementType == .button,
           element.identifier == "board.card.demo-card-buttons",
           element.label == "Replace unclear button labels, You · High priority, No next action yet" {
            return "Accepted fixture content collision: 'button' is part of the Card title, not an appended accessibility role."
        }
        if issue.compactDescription == "Element has no description",
           element.elementType == .touchBar, !element.isEnabled,
           element.identifier.isEmpty, element.label.isEmpty,
           element.children(matching: .any).count == 0 {
            return "Accepted empty system TouchBar container: no app content, actions, identifier, label, or children."
        }
        return nil
    }

    private func launch(restoration: Bool = false, extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--card-view", "windows", "--open-example-cards", "--reset-demo-drafts", "--reset-demo-window-layout"]
        if restoration {
            app.launchArguments.removeAll { $0 == "--open-example-cards" }
            app.launchArguments += ["-NSQuitAlwaysKeepsWindows", "YES", "-ApplePersistenceIgnoreState", "NO"]
        }
        else { app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"] }
        app.launchArguments += extraArguments
        app.launch()
        if !restoration { app.typeKey("0", modifierFlags: .command) }
        return app
    }

    private func board(in app: XCUIApplication) -> XCUIElement {
        app.windows.containing(.button, identifier: "session.sign-out").firstMatch
    }

    private func viewer(_ cardID: String, in app: XCUIApplication) -> XCUIElement {
        app.windows.containing(.any, identifier: "card.window.\(cardID)").firstMatch
    }

    private func showBoard(_ app: XCUIApplication) {
        app.typeKey("0", modifierFlags: .command)
        XCTAssertTrue(board(in: app).waitForExistence(timeout: 5))
    }

    private func focus(_ cardID: String, in app: XCUIApplication, windowTitle: String? = nil) {
        let title = windowTitle ?? (cardID == homepage ? "Review homepage hierarchy" : "Simplify the signup introduction")
        let menu = app.menuBars.menuBarItems["Window"]
        XCTAssertTrue(menu.waitForExistence(timeout: 5))
        menu.click()
        let item = menu.menus.menuItems["\(title) (Studio Workspace / Atlas website)"]
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        item.click()
    }

    private func assertMenu(_ app: XCUIApplication, named name: String,
                            enabled: [String] = [], disabled: [String] = [],
                            file: StaticString = #filePath, line: UInt = #line) {
        let menu = app.menuBars.menuBarItems[name]
        XCTAssertTrue(menu.waitForExistence(timeout: 5), file: file, line: line)
        menu.click()
        for title in enabled {
            let item = menu.menus.menuItems[title]
            XCTAssertTrue(item.waitForExistence(timeout: 5), "Missing \(name) → \(title)", file: file, line: line)
            XCTAssertTrue(item.isEnabled, "Unavailable \(name) → \(title)", file: file, line: line)
        }
        for title in disabled {
            let item = menu.menus.menuItems[title]
            XCTAssertTrue(item.waitForExistence(timeout: 5), "Missing \(name) → \(title)", file: file, line: line)
            XCTAssertFalse(item.isEnabled, "\(name) → \(title) must be unavailable during this task", file: file, line: line)
        }
        app.typeKey(XCUIKeyboardKey.escape.rawValue, modifierFlags: [])
    }

    private func clickMenu(_ app: XCUIApplication, named name: String, item title: String) {
        let menu = app.menuBars.menuBarItems[name]
        XCTAssertTrue(menu.waitForExistence(timeout: 5))
        menu.click()
        let item = menu.menus.menuItems[title]
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        XCTAssertTrue(item.isEnabled)
        item.click()
    }

    private func filterPopover(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "board.filter-popover").firstMatch
    }

    private func filterControls(in app: XCUIApplication) -> XCUIElement {
        let popover = filterPopover(in: app)
        return popover.exists ? popover : board(in: app).descendants(matching: .any)
            .matching(identifier: "board.control-strip").firstMatch
    }

    private func openFilters(in board: XCUIElement, app: XCUIApplication) {
        if board.popUpButtons["board.filter.actor"].exists {
            XCTAssertFalse(board.buttons["board.filters"].exists)
            XCTAssertTrue(board.popUpButtons["board.filter.actor"].isHittable)
            return
        }
        board.buttons["board.filters"].click()
        XCTAssertTrue(filterPopover(in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(app.popUpButtons["board.filter.actor"].isHittable)
    }

    private func closeFilters(in app: XCUIApplication) {
        guard filterPopover(in: app).exists else {
            XCTAssertTrue(board(in: app).popUpButtons["board.filter.actor"].isHittable)
            return
        }
        app.buttons["board.filters.done"].click()
        XCTAssertTrue(filterPopover(in: app).waitForNonExistence(timeout: 5))
    }

    private func choose(_ value: String, from picker: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(picker.waitForExistence(timeout: 5))
        picker.click()
        let item = app.menuItems[value].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        item.click()
    }

    private func replace(_ field: XCUIElement, with text: String) {
        field.click()
        field.typeKey("a", modifierFlags: .command)
        field.typeText(text)
    }

    private func assertEnabled(_ element: XCUIElement,
                               file: StaticString = #filePath, line: UInt = #line) {
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 5), .completed, file: file, line: line)
    }

    private func assertFrame(_ actual: CGRect, equals expected: CGRect,
                             file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.minX, expected.minX, accuracy: 2, file: file, line: line)
        XCTAssertEqual(actual.minY, expected.minY, accuracy: 2, file: file, line: line)
        XCTAssertEqual(actual.width, expected.width, accuracy: 2, file: file, line: line)
        XCTAssertEqual(actual.height, expected.height, accuracy: 2, file: file, line: line)
    }

    private func assertFiltersFit(_ filters: XCUIElement,
                                  file: StaticString = #filePath, line: UInt = #line) {
        let controls = [filters.popUpButtons["board.filter.actor"],
                        filters.popUpButtons["board.filter.priority"],
                        filters.popUpButtons["board.filter.blocked"],
                        filters.checkBoxes["board.filter.archived"]]
        for control in controls {
            XCTAssertTrue(control.isHittable, "Adaptive filters must remain reachable.", file: file, line: line)
            XCTAssertGreaterThan(control.frame.width, 20, file: file, line: line)
            XCTAssertGreaterThanOrEqual(control.frame.minX, filters.frame.minX - 1, file: file, line: line)
            XCTAssertLessThanOrEqual(control.frame.maxX, filters.frame.maxX + 1,
                                     "Filter controls must fit their native container at the narrow board width.", file: file, line: line)
            XCTAssertGreaterThanOrEqual(control.frame.minY, filters.frame.minY - 1, file: file, line: line)
            XCTAssertLessThanOrEqual(control.frame.maxY, filters.frame.maxY + 1, file: file, line: line)
        }
        for (index, control) in controls.enumerated() {
            for other in controls.dropFirst(index + 1) {
                XCTAssertFalse(control.frame.intersects(other.frame),
                               "Adaptive filter controls must not overlap.", file: file, line: line)
            }
        }
    }

    private func assertLabel(_ element: XCUIElement, contains title: String,
                             file: StaticString = #filePath, line: UInt = #line) {
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in element.exists && (element.label.contains(title) || (element.value as? String)?.contains(title) == true) }, object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed, file: file, line: line)
    }

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
}

/// Test-only Board classifier proposal. Retain separate completed Board VoiceOver evidence.
/// Retain every raw issue, disclose classified counts, and fail all nil results.
/// One instance covers exactly one four-context audit of the unchanged default demo fixture.
/// Card contexts expect zero: no Card diagnostic is classified by this helper.
///
/// Reviewed source: NavigationSplitView sidebar/detail panes, HSplitView Column panes,
/// and the Projects List Section header in BoardView.swift.
/// Reviewed Board evidence: AccessibilityPrimaryMetadata, macOS 27.0.1.
/// These are observed disabled host groups around named children of public native components;
/// this classification does not claim that the framework diagnostics are repaired or absent.
@MainActor
private final class ReviewedBoardContainerDiagnostics {
    private typealias Snapshot = any XCUIElementSnapshot
    private var seen = Set<String>()

    static let expectedDisclosureCounts = [
        "Isolated board --appearance-light": 6,
        "Isolated Card --appearance-light": 0,
        "Isolated board --appearance-dark": 6,
        "Isolated Card --appearance-dark": 0
    ]

    /// A duplicate category in the same context returns nil and must remain a failing issue.
    /// The supplied window must be the only window in the caller's isolated application audit.
    func category(for issue: XCUIAccessibilityAuditIssue, context: String,
                           in window: XCUIElement) -> String? {
        // Only the two exact Board contexts are eligible. Card diagnostics stay unreviewed.
        guard Self.expectedDisclosureCounts[context] == 6,
              issue.auditType == .sufficientElementDescription,
              issue.compactDescription == "Element has no description",
              let element = issue.element,
              let wrapper = try? element.snapshot(),
              Self.isUnnamedDisabledGroup(wrapper), wrapper.children.count == 1,
              let root = try? window.snapshot(), Self.isExpectedBoardWindow(root),
              Self.descendants(of: root).filter({ Self.sameWrapper($0, as: wrapper) }).count == 1
        else { return nil }

        let child = wrapper.children[0]
        let candidate: String?
        if Self.isSidebar(child) { candidate = "board.sidebar-pane" }
        else if Self.isDetail(child) { candidate = "board.detail-pane" }
        else if let column = Self.columns.first(where: { Self.isColumn(child, fixture: $0) }) {
            candidate = "board.column.\(column.id)-pane"
        } else if Self.isLeafHeading(child, label: "Projects") {
            candidate = "board.section.projects-header"
        } else { candidate = nil }

        guard let candidate, Self.expectedCategories(in: context).contains(candidate),
              seen.insert(context + "|" + candidate).inserted else { return nil }
        return candidate
    }

    var disclosureCounts: [String: Int] {
        Self.expectedDisclosureCounts.mapValues { _ in 0 }.merging(
            Dictionary(grouping: seen, by: { String($0.split(separator: "|")[0]) }).mapValues(\.count),
            uniquingKeysWith: { _, observed in observed })
    }

    func missingCategories(in context: String) -> Set<String> {
        Self.expectedCategories(in: context).filter { !seen.contains(context + "|" + $0) }
    }

    static func frameworkOrigin(for category: String) -> String? {
        switch category {
        case "board.sidebar-pane", "board.detail-pane":
            return "SwiftUI NavigationSplitView pane host; its named sidebar or Project content child remains exposed."
        case "board.column.next-pane", "board.column.doing-pane", "board.column.done-pane":
            return "SwiftUI HSplitView child host; its named Column, heading, Card list, and buttons remain exposed."
        case "board.section.projects-header":
            return "SwiftUI List Section header host; its single named static-text heading remains exposed."
        default: return nil
        }
    }

    private static func expectedCategories(in context: String) -> Set<String> {
        switch context {
        case "Isolated board --appearance-light", "Isolated board --appearance-dark":
            return ["board.sidebar-pane", "board.detail-pane", "board.column.next-pane",
                    "board.column.doing-pane", "board.column.done-pane", "board.section.projects-header"]
        default: return []
        }
    }

    private static func isExpectedBoardWindow(_ root: Snapshot) -> Bool {
        guard root.elementType == .window else { return false }
        let nodes = descendants(of: root)
        return root.identifier == "board-AppWindow-1"
            && root.title == "Atlas website – Studio Workspace"
            && nodes.filter { $0.identifier == "board.window" && $0.label == "Project board" }.count == 1
    }

    private struct ColumnFixture {
        let id: String
        let title: String
        let cardNames: [String]
        var label: String { "\(title), \(cardNames.count) Cards" }
    }

    private static let columns = [
        ColumnFixture(id: "next", title: "Next", cardNames: ["pricing", "checklist", "footer", "research"]),
        ColumnFixture(id: "doing", title: "Doing", cardNames: ["homepage", "keyboard", "licenses"]),
        ColumnFixture(id: "done", title: "Done", cardNames: ["signup", "buttons"])
    ]

    private static let cardLabels = [
        "pricing": "Clarify the pricing comparison, You · High priority, Choose the comparison criteria",
        "checklist": "Draft the launch checklist, Agent · Medium priority, Turn the agreed scope into a checklist",
        "footer": "Review footer navigation, Unassigned · Unset priority, No next action yet",
        "research": "Organize the research notes, Agent · Low priority, Group notes by reader question",
        "homepage": "Review homepage hierarchy, You · High priority, Choose the preferred heading order",
        "keyboard": "Check keyboard navigation, Agent · High priority, Complete the navigation pass",
        "licenses": "Confirm illustration licenses, You · Medium priority, No next action yet, Blocked: Waiting for the license receipt",
        "signup": "Simplify the signup introduction, Agent · Medium priority, Introduction updated",
        "buttons": "Replace unclear button labels, You · High priority, No next action yet"
    ]

    private static func isSidebar(_ scroll: Snapshot) -> Bool {
        guard isUnnamedDisabled(scroll, type: .scrollView), scroll.children.count == 1 else { return false }
        let outline = scroll.children[0]
        guard outline.elementType == .outline, outline.label == "Workspaces and Projects",
              outline.identifier.isEmpty, outline.isEnabled, outline.children.count == 9 else { return false }
        let rows = outline.children
        guard rows.prefix(8).allSatisfy({ $0.elementType == .outlineRow && $0.children.count == 1
            && $0.children[0].elementType == .cell }),
              rows[8].elementType == .tableColumn, rows[8].identifier == "ListColumn" else { return false }
        let cells = rows.prefix(8).map { $0.children[0] }
        guard isEmptyHeaderCell(cells[0]), isEmptyHeaderCell(cells[5]),
              cells[1].children.count == 2, isText(cells[1].children[0], text: "Workspace"),
              isPopup(cells[1].children[1], id: "board.workspace", label: "Workspace", value: "Studio Workspace"),
              cells[2].children.count == 1, isUnnamedDisabledGroup(cells[2].children[0]),
              cells[2].children[0].children.count == 1,
              isLeafHeading(cells[2].children[0].children[0], label: "Projects"),
              cells[3].children.count == 1,
              cells[3].children[0].identifier == "board.project.demo-project",
              isText(cells[3].children[0], text: "Atlas website"),
              cells[4].children.count == 1, isButton(cells[4].children[0], id: "", label: "New Project…"),
              cells[6].children.count == 1, isText(cells[6].children[0], text: "Demo data"),
              cells[7].children.count == 1,
              isButton(cells[7].children[0], id: "session.sign-out", label: "Sign Out") else { return false }
        return true
    }

    private static func isDetail(_ surface: Snapshot) -> Bool {
        // Observed in the dedicated VM: the enclosing accessibility label is
        // applied to board.surface rather than creating a second native group.
        guard surface.elementType == .group, surface.identifier == "board.surface",
              surface.label == "Project board contents", surface.isEnabled,
              surface.children.count == 2 else { return false }
        let controls = surface.children[0]
        guard controls.elementType == .group, controls.identifier == "board.control-strip",
              controls.label == "Board controls", controls.isEnabled, controls.children.count == 8,
              isInlineFilterLabel(controls.children[0], label: "Next actor"),
              isPopup(controls.children[1], id: "board.filter.actor", label: "Next actor", value: "All actors"),
              isInlineFilterLabel(controls.children[2], label: "Priority"),
              isPopup(controls.children[3], id: "board.filter.priority", label: "Priority", value: "All priorities"),
              isInlineFilterLabel(controls.children[4], label: "Blocked"),
              isPopup(controls.children[5], id: "board.filter.blocked", label: "Blocked", value: "All"),
              controls.children[6].elementType == .checkBox,
              controls.children[6].identifier == "board.filter.archived",
              controls.children[6].label == "Include archived", controls.children[6].isEnabled,
              isZeroValue(controls.children[6]), controls.children[6].children.isEmpty,
              controls.children[7].elementType == .button,
              controls.children[7].identifier == "board.clear-filters",
              controls.children[7].label == "Clear filters", !controls.children[7].isEnabled,
              hasNoValue(controls.children[7]), controls.children[7].children.isEmpty,
              isUnnamedDisabled(surface.children[1], type: .scrollView),
              surface.children[1].children.count == 1 else { return false }
        let split = surface.children[1].children[0]
        guard split.elementType == .splitGroup, split.children.count == 5,
              split.children[1].elementType == .splitter, split.children[3].elementType == .splitter
        else { return false }
        for (index, column) in columns.enumerated() {
            let host = split.children[index * 2]
            guard isUnnamedDisabledGroup(host), host.children.count == 1,
                  isColumn(host.children[0], fixture: column) else { return false }
        }
        return true
    }

    private static func isColumn(_ child: Snapshot, fixture: ColumnFixture) -> Bool {
        guard child.elementType == .group, child.identifier == "board.column." + fixture.id,
              child.label == fixture.label, child.isEnabled, child.children.count == 2,
              isLeafHeading(child.children[0], label: fixture.label),
              isUnnamedDisabled(child.children[1], type: .scrollView),
              child.children[1].children.count == 1 else { return false }
        let outline = child.children[1].children[0]
        guard outline.elementType == .outline, outline.label == fixture.title + " Cards",
              outline.identifier.isEmpty, outline.isEnabled,
              outline.children.count == fixture.cardNames.count + 1 else { return false }
        for (index, name) in fixture.cardNames.enumerated() {
            let row = outline.children[index]
            guard row.elementType == .outlineRow, row.children.count == 1,
                  row.children[0].elementType == .cell, row.children[0].children.count == 1,
                  let label = cardLabels[name],
                  isButton(row.children[0].children[0], id: "board.card.demo-card-" + name, label: label)
            else { return false }
        }
        let last = outline.children[fixture.cardNames.count]
        return last.elementType == .tableColumn && last.identifier == "ListColumn"
    }

    private static func isEmptyHeaderCell(_ cell: Snapshot) -> Bool {
        cell.children.count == 1 && isUnnamedDisabledGroup(cell.children[0])
            && cell.children[0].children.isEmpty
    }

    private static func isInlineFilterLabel(_ node: Snapshot, label: String) -> Bool {
        node.elementType == .staticText && node.identifier.isEmpty && node.label.isEmpty
            && (node.value as? String) == label && node.isEnabled && node.children.isEmpty
    }

    private static func isPopup(_ node: Snapshot, id: String, label: String, value: String) -> Bool {
        node.elementType == .popUpButton && node.identifier == id && node.label == label
            && node.isEnabled && (node.value as? String) == value && node.children.isEmpty
    }

    private static func isButton(_ node: Snapshot, id: String, label: String) -> Bool {
        node.elementType == .button && node.identifier == id && node.label == label
            && node.isEnabled && node.children.isEmpty
    }

    private static func isLeafHeading(_ node: Snapshot, label: String) -> Bool {
        node.elementType == .staticText && node.identifier.isEmpty && node.label == label
            && node.isEnabled && hasNoValue(node) && node.children.isEmpty
    }

    private static func isText(_ node: Snapshot, text: String) -> Bool {
        guard node.elementType == .staticText, node.label == text || (node.value as? String) == text else { return false }
        // Text selection can produce one disabled static-text host around the same enabled text.
        return node.children.isEmpty ? node.isEnabled
            : !node.isEnabled && node.children.count == 1 && node.children[0].isEnabled
                && node.children[0].children.isEmpty && isText(node.children[0], text: text)
    }

    private static func isUnnamedDisabledGroup(_ node: Snapshot) -> Bool {
        isUnnamedDisabled(node, type: .group)
    }

    private static func isUnnamedDisabled(_ node: Snapshot, type: XCUIElement.ElementType) -> Bool {
        node.elementType == type && !node.isEnabled && node.identifier.isEmpty
            && node.label.isEmpty && node.title.isEmpty && hasNoValue(node)
    }

    private static func hasNoValue(_ node: Snapshot) -> Bool {
        node.value == nil || (node.value as? String)?.isEmpty == true
    }

    private static func isZeroValue(_ node: Snapshot) -> Bool {
        (node.value as? String) == "0" || (node.value as? NSNumber) == NSNumber(value: 0)
    }

    private static func sameWrapper(_ node: Snapshot, as wrapper: Snapshot) -> Bool {
        isUnnamedDisabledGroup(node) && node.frame == wrapper.frame && node.children.count == 1
            && node.children[0].elementType == wrapper.children[0].elementType
            && node.children[0].identifier == wrapper.children[0].identifier
            && node.children[0].label == wrapper.children[0].label
    }

    private static func descendants(of node: Snapshot) -> [Snapshot] {
        node.children.flatMap { [$0] + descendants(of: $0) }
    }
}
