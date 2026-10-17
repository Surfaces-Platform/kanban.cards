import Foundation
import XCTest

/// Run only against synthetic demo data inside the dedicated pilot VM.
@MainActor
final class CardContextMenuAndInlineEditTests: XCTestCase {
    private let homepage = "demo-card-homepage"
    private let licenses = "demo-card-licenses"
    private var runningApp: XCUIApplication?

    override func setUp() async throws { continueAfterFailure = false }
    override func tearDown() async throws { runningApp?.terminate(); runningApp = nil }

    func testBoardContextOpensOneEditableWindowWithoutChangingBoardOrDoubleClickBehavior() throws {
        let app = launch()
        let board = board(in: app)
        let originalFrame = board.frame
        let originalRows = cardRows(in: board)
        openContextMenu(homepage, in: board, app: app)
        for title in ["Open in New Window", "Move…", "Activity…", "Archive Card…"] {
            XCTAssertTrue(contextMenu(in: app).menuItems[title].firstMatch.isEnabled,
                          "A writable Card must expose its meaningful native action: \(title)")
        }
        XCTAssertFalse(contextMenu(in: app).menuItems["Edit in New Window"].exists,
                       "The always-editable Card needs one window action.")
        contextMenu(in: app).menuItems["Open in New Window"].firstMatch.click()
        let separate = cardWindow(homepage, in: app)
        assertValue("Review homepage hierarchy", of: separate.textFields["editor.title"])
        XCTAssertEqual(app.sheets.count, 0)
        assertWindowCount(2, in: app)
        assertFullBoard(board, rows: originalRows, frame: originalFrame)
        let separateFrame = separate.frame
        let retained = "Retained shared homepage draft"
        replace(separate.textFields["editor.title"], with: retained)

        showBoard(app)
        chooseContextAction("Open in New Window", for: homepage, in: board, app: app)
        XCTAssertEqual(cardWindows(homepage, in: app).count, 1)
        assertValue(retained, of: separate.textFields["editor.title"])
        assertFrame(separate.frame, equals: separateFrame)
        assertWindowCount(2, in: app)
        separate.buttons[XCUIIdentifierCloseWindow].click()
        XCTAssertTrue(separate.waitForNonExistence(timeout: 5))
        showBoard(app)
        assertFullBoard(board, rows: originalRows, frame: originalFrame)
        board.buttons["board.card.\(homepage)"].doubleClick()
        XCTAssertTrue(board.popUpButtons["board.focused-column"].waitForExistence(timeout: 5))
        let pane = editableCard(homepage, in: board)
        assertValue(retained, of: pane.textFields["editor.title"])
        XCTAssertEqual(app.sheets.count, 0)
        assertWindowCount(1, in: app)
        attach(board, named: "Context Open reuses one editable Card window and keeps the board in place")
    }

    func testColumnContextOpenPreservesSelectedCardFiltersSearchAndDivider() throws {
        let app = launch()
        let board = board(in: app)
        resize(board, toWidth: 1320)
        board.buttons["board.card.\(homepage)"].click()
        _ = editableCard(homepage, in: board)
        let list = columnList(in: board)
        resizeColumn(list, toWidth: 300)
        openFilters(in: board, app: app)
        choose("You", from: app.popUpButtons["board.filter.actor"], in: app)
        closeFilters(in: app)
        replace(board.searchFields.firstMatch, with: "i")
        assertRows([homepage, licenses], in: board)
        let boardFrame = board.frame
        let listFrame = list.frame
        let summary = board.staticTexts["board.filter-summary"]
        let summaryLabel = summary.label
        let summaryValue = summary.value as? String

        openContextMenu(licenses, in: board, app: app)
        XCTAssertTrue(viewer(homepage, in: board).exists,
                      "Another Card's context menu must preserve the current editable Card.")
        contextMenu(in: app).menuItems["Open in New Window"].firstMatch.click()
        let separate = cardWindow(licenses, in: app)
        assertValue("Confirm illustration licenses", of: separate.textFields["editor.title"])
        XCTAssertEqual(app.sheets.count, 0)
        assertWindowCount(2, in: app)
        XCTAssertTrue(viewer(homepage, in: board).exists)
        XCTAssertFalse(viewer(licenses, in: board).exists)
        XCTAssertEqual(board.searchFields.firstMatch.value as? String, "i")
        XCTAssertEqual(summary.label, summaryLabel)
        XCTAssertEqual(summary.value as? String, summaryValue)
        assertRows([homepage, licenses], in: board)
        assertFrame(board.frame, equals: boardFrame)
        assertFrame(list.frame, equals: listFrame)
        attach(app, named: "Open in New Window preserves the editable selection and Column context")
        separate.buttons[XCUIIdentifierCloseWindow].click()
        XCTAssertTrue(separate.waitForNonExistence(timeout: 5))
        showBoard(app)
        openFilters(in: board, app: app)
        XCTAssertEqual(app.popUpButtons["board.filter.actor"].value as? String, "You")
        closeFilters(in: app)
        _ = editableCard(homepage, in: board)
        assertFrame(list.frame, equals: listFrame)
    }

    func testCardStartsEditableSaveStaysAndRevertFitsTheNarrowPane() throws {
        let app = launch()
        let board = board(in: app)
        resize(board, toWidth: 1320)
        board.buttons["board.card.\(homepage)"].click()
        let pane = editableCard(homepage, in: board)
        let list = columnList(in: board)
        let listFrame = list.frame
        assertWindowCount(1, in: app)
        XCTAssertEqual(app.sheets.count, 0)
        let title = pane.textFields["editor.title"]
        let body = pane.textViews["editor.body"]
        replace(title, with: "")
        XCTAssertFalse(pane.buttons["editor.save"].isEnabled,
                       "The always-editable Card must retain required Title validation.")
        let savedTitle = "Confirmed editable homepage title"
        let savedBody = "Saved directly in the current Card."
        replace(title, with: savedTitle)
        replace(body, with: savedBody)
        XCTAssertTrue(pane.buttons["editor.save"].isEnabled)
        pane.buttons["editor.save"].click()
        let saved = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            board.buttons["board.card.\(self.homepage)"].label.contains(savedTitle)
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [saved], timeout: 5), .completed)
        XCTAssertTrue(pane.exists, "Save must keep the current Card editable.")
        assertValue(savedTitle, of: title)
        assertValue(savedBody, of: body)
        assertFrame(list.frame, equals: listFrame)
        XCTAssertEqual(app.sheets.count, 0)
        assertWindowCount(1, in: app)

        resize(board, toWidth: 1024)
        resizeColumn(list, toWidth: 440)
        replace(title, with: "Unsaved narrow pane title")
        XCTAssertTrue(title.isHittable)
        XCTAssertTrue(pane.buttons["editor.save"].isHittable)
        XCTAssertTrue(pane.buttons["editor.revert"].isHittable)
        XCTAssertLessThanOrEqual(title.frame.maxX, board.frame.maxX + 1)
        XCTAssertLessThanOrEqual(body.frame.maxX, board.frame.maxX + 1)
        attach(board, named: "Always-editable Card retains Save and Revert in the narrow detail pane")
        revert(pane, in: app)
        assertValue(savedTitle, of: title)
        assertValue(savedBody, of: body)
        XCTAssertTrue(board.buttons["board.card.\(homepage)"].label.contains(savedTitle))
        XCTAssertTrue(pane.exists)
        XCTAssertEqual(app.sheets.count, 0)
        assertWindowCount(1, in: app)
    }

    func testSwitchingCardsRetainsEachSharedCardAndInlineCommentDraft() throws {
        let app = launch()
        let board = board(in: app)
        resize(board, toWidth: 1320)
        board.buttons["board.card.\(homepage)"].click()
        let home = editableCard(homepage, in: board)
        let homeDraft = "Homepage shared draft"
        replace(home.textFields["editor.title"], with: homeDraft)
        app.typeKey("m", modifierFlags: [.command, .shift])
        let commentDraft = "Homepage comment retained while editing Cards."
        replace(home.textViews["comment.body"], with: commentDraft)
        home.buttons["comment.cancel"].click()
        XCTAssertTrue(board.buttons["board.card.\(licenses)"].isEnabled,
                      "An unfinished Card must allow selection of another Card.")
        board.buttons["board.card.\(licenses)"].click()
        let other = editableCard(licenses, in: board)
        assertValue("Confirm illustration licenses", of: other.textFields["editor.title"])
        let otherDraft = "Licenses shared draft"
        replace(other.textFields["editor.title"], with: otherDraft)

        board.buttons["board.card.\(homepage)"].click()
        let recoveredHome = editableCard(homepage, in: board)
        assertValue(homeDraft, of: recoveredHome.textFields["editor.title"])
        app.typeKey("m", modifierFlags: [.command, .shift])
        assertValue(commentDraft, of: recoveredHome.textViews["comment.body"])
        recoveredHome.buttons["comment.cancel"].click()
        board.buttons["board.card.\(licenses)"].click()
        assertValue(otherDraft, of: editableCard(licenses, in: board).textFields["editor.title"])
        XCTAssertEqual(app.sheets.count, 0)
        assertWindowCount(1, in: app)
        attach(board, named: "Switching Cards preserves each shared Card draft and inline Comment draft")
    }

    func testKeyboardSelectionIsImmediatelyEditableAndArchivedCardsStayReadOnly() throws {
        let app = launch()
        let board = board(in: app)
        choose("You", from: board.popUpButtons["board.filter.actor"], in: app)
        board.buttons["board.card.\(homepage)"].click()
        _ = editableCard(homepage, in: board)
        assertRows([homepage, licenses], in: board)
        board.searchFields.firstMatch.click()
        board.buttons["board.card.\(homepage)"].click()
        app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
        let current = editableCard(licenses, in: board)
        assertValue("Confirm illustration licenses", of: current.textFields["editor.title"])
        XCTAssertEqual(app.sheets.count, 0)
        assertWindowCount(1, in: app)

        openFilters(in: board, app: app)
        app.checkBoxes["board.filter.archived"].click()
        closeFilters(in: app)
        chooseContextAction("Archive Card…", for: licenses, in: board, app: app)
        let archive = app.buttons["card.archive-confirm.\(licenses)"].firstMatch
        XCTAssertTrue(archive.waitForExistence(timeout: 5))
        archive.click()
        XCTAssertTrue(archive.waitForNonExistence(timeout: 5))
        let readOnly = viewer(licenses, in: board)
        XCTAssertTrue(readOnly.waitForExistence(timeout: 5))
        XCTAssertFalse(readOnly.buttons["editor.save"].isEnabled)
        if readOnly.textFields["editor.title"].exists {
            XCTAssertFalse(readOnly.textFields["editor.title"].isEnabled)
        }
        openContextMenu(licenses, in: board, app: app)
        XCTAssertFalse(contextMenu(in: app).menuItems["Edit in New Window"].exists)
        XCTAssertTrue(contextMenu(in: app).menuItems["Open in New Window"].firstMatch.isEnabled)
        XCTAssertTrue(contextMenu(in: app).menuItems["Restore Card…"].firstMatch.isEnabled)
        attach(app, named: "Archived Card stays read-only while Open and Restore remain available")
        contextMenu(in: app).menuItems["Restore Card…"].firstMatch.click()
        let restore = app.buttons["card.archive-confirm.\(licenses)"].firstMatch
        XCTAssertTrue(restore.waitForExistence(timeout: 5))
        restore.click()
        XCTAssertTrue(restore.waitForNonExistence(timeout: 5))
        let restored = editableCard(licenses, in: board)
        XCTAssertTrue(restored.textFields["editor.title"].isEnabled)
    }

    func testPaneAndWindowShareLiveDraftSaveAndRevertWithoutLeavingTheEditor() throws {
        let app = launch()
        let board = board(in: app)
        resize(board, toWidth: 1320)
        board.buttons["board.card.\(homepage)"].click()
        let pane = editableCard(homepage, in: board)
        let firstDraft = "Pane and window share this draft"
        replace(pane.textFields["editor.title"], with: firstDraft)
        chooseContextAction("Open in New Window", for: homepage, in: board, app: app)
        let separate = cardWindow(homepage, in: app)
        assertValue(firstDraft, of: separate.textFields["editor.title"])
        let savedTitle = "Confirmed from shared window draft"
        let savedBody = "A single draft appears in every Card surface."
        replace(separate.textFields["editor.title"], with: savedTitle)
        replace(separate.textViews["editor.body"], with: savedBody)
        assertValue(savedTitle, of: pane.textFields["editor.title"])
        assertValue(savedBody, of: pane.textViews["editor.body"])
        XCTAssertFalse(board.buttons["board.card.\(homepage)"].label.contains(savedTitle),
                       "Typing must retain the draft until Save commits it.")
        separate.typeKey("s", modifierFlags: .command)
        let saved = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            board.buttons["board.card.\(self.homepage)"].label.contains(savedTitle)
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [saved], timeout: 5), .completed)
        XCTAssertTrue(separate.exists, "Cmd-S must preserve the independent Card window.")
        XCTAssertTrue(pane.exists, "Saving a shared draft must preserve the current pane.")
        assertValue(savedTitle, of: separate.textFields["editor.title"])
        assertValue(savedBody, of: pane.textViews["editor.body"])
        assertWindowCount(2, in: app)
        XCTAssertEqual(app.sheets.count, 0)

        showBoard(app)
        let unsavedTitle = "Unsaved change from the pane"
        replace(pane.textFields["editor.title"], with: unsavedTitle)
        assertValue(unsavedTitle, of: separate.textFields["editor.title"])
        revert(pane, in: app)
        assertValue(savedTitle, of: pane.textFields["editor.title"])
        assertValue(savedTitle, of: separate.textFields["editor.title"])
        assertValue(savedBody, of: separate.textViews["editor.body"])
        assertWindowCount(2, in: app)
        XCTAssertEqual(app.sheets.count, 0)
        attach(app, named: "Pane and Card window share live changes, explicit Save, and confirmed Revert")
    }

    func testClosingAndRelaunchingRecoversTheOneSharedDraftInPaneAndWindow() throws {
        let app = launch()
        let board = board(in: app)
        chooseContextAction("Open in New Window", for: homepage, in: board, app: app)
        let separate = cardWindow(homepage, in: app)
        let retainedTitle = "Shared Card draft survives relaunch"
        let retainedBody = "Retained locally without saving to the board."
        replace(separate.textFields["editor.title"], with: retainedTitle)
        replace(separate.textViews["editor.body"], with: retainedBody)
        separate.buttons[XCUIIdentifierCloseWindow].click()
        XCTAssertTrue(separate.waitForNonExistence(timeout: 5))
        showBoard(app)
        board.buttons["board.card.\(homepage)"].click()
        let pane = editableCard(homepage, in: board)
        assertValue(retainedTitle, of: pane.textFields["editor.title"])
        assertValue(retainedBody, of: pane.textViews["editor.body"])
        XCTAssertFalse(board.buttons["board.card.\(homepage)"].label.contains(retainedTitle))
        app.terminate()
        runningApp = nil

        let relaunched = launch(resetDrafts: false)
        let restoredBoard = self.board(in: relaunched)
        restoredBoard.buttons["board.card.\(homepage)"].click()
        let restoredPane = editableCard(homepage, in: restoredBoard)
        assertValue(retainedTitle, of: restoredPane.textFields["editor.title"])
        assertValue(retainedBody, of: restoredPane.textViews["editor.body"])
        assertDraftRecovered(in: restoredPane)
        chooseContextAction("Open in New Window", for: homepage, in: restoredBoard, app: relaunched)
        let restoredWindow = cardWindow(homepage, in: relaunched)
        assertValue(retainedTitle, of: restoredWindow.textFields["editor.title"])
        assertValue(retainedBody, of: restoredWindow.textViews["editor.body"])
        XCTAssertFalse(restoredBoard.buttons["board.card.\(homepage)"].label.contains(retainedTitle))
        assertWindowCount(2, in: relaunched)
        XCTAssertEqual(relaunched.sheets.count, 0)
        attach(relaunched, named: "Relaunch recovers one shared Card draft in the pane and independent window")
    }

    func testNewCardSheetDoesNotSaveOrRevertTheBackgroundSharedDraft() throws {
        let app = launch()
        let board = board(in: app)
        board.buttons["board.card.\(homepage)"].click()
        let pane = editableCard(homepage, in: board)
        let retainedTitle = "Keep the background Card draft"
        replace(pane.textFields["editor.title"], with: retainedTitle)
        app.typeKey("n", modifierFlags: .command)
        let sheet = app.sheets.firstMatch
        XCTAssertTrue(sheet.waitForExistence(timeout: 5))
        let title = sheet.textFields["editor.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        let file = app.menuBars.menuBarItems["File"]
        file.click()
        XCTAssertFalse(file.menus.menuItems["Save"].isEnabled,
                       "The background Card's File Save must be disabled while creating another Card.")
        XCTAssertFalse(file.menus.menuItems["Revert to Saved…"].isEnabled)
        app.typeKey(XCUIKeyboardKey.escape.rawValue, modifierFlags: [])
        app.typeKey("s", modifierFlags: .command)
        XCTAssertTrue(sheet.exists, "Cmd-S must not dismiss or submit the New Card sheet.")
        XCTAssertFalse(board.buttons["board.card.\(homepage)"].label.contains(retainedTitle))
        assertValue(retainedTitle, of: pane.textFields["editor.title"])
        let createdTitle = "Created while another Card has a draft"
        replace(title, with: createdTitle)
        sheet.buttons["editor.save"].click()
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 5),
                      "Creating another Card must submit only the New Card form.")
        let created = board.textFields.matching(NSPredicate(format: "identifier == %@ AND value == %@",
                                                            "editor.title", createdTitle)).firstMatch
        XCTAssertTrue(created.waitForExistence(timeout: 5))
        choose("Doing", from: board.popUpButtons["board.focused-column"], in: app)
        board.buttons["board.card.\(homepage)"].click()
        assertValue(retainedTitle, of: editableCard(homepage, in: board).textFields["editor.title"])
        XCTAssertFalse(board.buttons["board.card.\(homepage)"].label.contains(retainedTitle))
        app.typeKey("n", modifierFlags: .command)
        XCTAssertTrue(sheet.waitForExistence(timeout: 5))
        sheet.buttons["editor.cancel"].click()
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 5))
        assertValue(retainedTitle, of: editableCard(homepage, in: board).textFields["editor.title"])
        XCTAssertEqual(app.sheets.count, 0)
        assertWindowCount(1, in: app)
        attach(board, named: "New Card Save and Cancel preserve the background shared Card draft")
    }

    private func launch(resetDrafts: Bool = true) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--reset-demo-window-layout",
                               "-ApplePersistenceIgnoreState", "YES"]
        if resetDrafts { app.launchArguments.append("--reset-demo-drafts") }
        app.launch()
        runningApp = app
        showBoard(app)
        assertWindowCount(1, in: app)
        return app
    }

    private func board(in app: XCUIApplication) -> XCUIElement {
        app.windows.containing(.button, identifier: "session.sign-out").firstMatch
    }

    private func viewer(_ cardID: String, in board: XCUIElement) -> XCUIElement {
        board.descendants(matching: .any).matching(identifier: "card.viewer.\(cardID)").firstMatch
    }

    private func inlineEditor(_ cardID: String, in board: XCUIElement) -> XCUIElement {
        board.descendants(matching: .any).matching(identifier: "card.inline-editor.\(cardID)").firstMatch
    }

    private func editableCard(_ cardID: String, in board: XCUIElement) -> XCUIElement {
        let surface = viewer(cardID, in: board)
        XCTAssertTrue(surface.waitForExistence(timeout: 5))
        XCTAssertTrue(surface.textFields["editor.title"].waitForExistence(timeout: 5),
                      "Opening an existing Card must immediately expose its editable fields.")
        XCTAssertFalse(surface.buttons["card.edit.\(cardID)"].exists)
        XCTAssertFalse(surface.buttons["editor.cancel"].exists)
        return surface
    }

    private func cardWindows(_ cardID: String, in app: XCUIApplication) -> XCUIElementQuery {
        app.windows.containing(.any, identifier: "card.window.\(cardID)")
    }

    private func cardWindow(_ cardID: String, in app: XCUIApplication) -> XCUIElement {
        let window = cardWindows(cardID, in: app).firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 5))
        XCTAssertTrue(window.textFields["editor.title"].waitForExistence(timeout: 5))
        return window
    }

    private func revert(_ surface: XCUIElement, in app: XCUIApplication) {
        let revert = surface.buttons["editor.revert"]
        XCTAssertTrue(revert.waitForExistence(timeout: 5))
        XCTAssertTrue(revert.isEnabled)
        revert.click()
        let confirmation = app.buttons["editor.revert-confirm"].firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        confirmation.click()
        XCTAssertTrue(confirmation.waitForNonExistence(timeout: 5))
    }

    private func assertValue(_ expected: String, of field: XCUIElement,
                             file: StaticString = #filePath, line: UInt = #line) {
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            field.exists && field.value as? String == expected
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed,
                       "Expected \(expected); actual: \(String(describing: field.value)).", file: file, line: line)
    }

    private func showBoard(_ app: XCUIApplication) {
        app.typeKey("0", modifierFlags: .command)
        XCTAssertTrue(board(in: app).waitForExistence(timeout: 10))
    }

    private func contextMenu(in app: XCUIApplication) -> XCUIElement {
        app.menus.containing(.menuItem, identifier: "Open in New Window").firstMatch
    }

    private func openContextMenu(_ cardID: String, in board: XCUIElement, app: XCUIApplication) {
        let row = board.buttons["board.card.\(cardID)"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(row.isHittable)
        row.rightClick()
        XCTAssertTrue(contextMenu(in: app).menuItems["Open in New Window"].firstMatch.waitForExistence(timeout: 5))
    }

    private func chooseContextAction(_ title: String, for cardID: String,
                                     in board: XCUIElement, app: XCUIApplication) {
        openContextMenu(cardID, in: board, app: app)
        let action = contextMenu(in: app).menuItems[title].firstMatch
        XCTAssertTrue(action.waitForExistence(timeout: 5))
        XCTAssertTrue(action.isEnabled)
        action.click()
    }

    private func columnList(in board: XCUIElement) -> XCUIElement {
        board.descendants(matching: .any).matching(identifier: "board.column-list").firstMatch
    }

    private func openFilters(in board: XCUIElement, app: XCUIApplication) {
        board.buttons["board.filters"].click()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "board.filter-popover").firstMatch.waitForExistence(timeout: 5))
    }

    private func closeFilters(in app: XCUIApplication) {
        app.buttons["board.filters.done"].click()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "board.filter-popover").firstMatch.waitForNonExistence(timeout: 5))
    }

    private func choose(_ value: String, from picker: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(picker.waitForExistence(timeout: 5))
        picker.click()
        let action = app.menuItems[value].firstMatch
        XCTAssertTrue(action.waitForExistence(timeout: 5))
        action.click()
        XCTAssertEqual(picker.value as? String, value)
    }

    private func replace(_ field: XCUIElement, with text: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.click()
        field.typeKey("a", modifierFlags: .command)
        field.typeKey(XCUIKeyboardKey.delete.rawValue, modifierFlags: [])
        if !text.isEmpty { field.typeText(text) }
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in field.value as? String == text }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed)
    }

    private func assertDraftRecovered(in element: XCUIElement) {
        let status = element.staticTexts["editor.draft-status"]
        let recovered = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            status.exists && (status.label.contains("Recovered draft") || (status.value as? String)?.contains("Recovered draft") == true)
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [recovered], timeout: 5), .completed)
    }

    private func assertText(_ text: String, in element: XCUIElement) {
        XCTAssertTrue(element.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@ OR value == %@", text, text)).firstMatch.waitForExistence(timeout: 5))
    }

    private func cardRows(in board: XCUIElement) -> Set<String> {
        Set(board.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "board.card."))
            .allElementsBoundByIndex.map(\.identifier))
    }

    private func assertRows(_ ids: [String], in board: XCUIElement) {
        let expected = Set(ids.map { "board.card.\($0)" })
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in self.cardRows(in: board) == expected }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed)
    }

    private func assertFullBoard(_ board: XCUIElement, rows: Set<String>, frame: CGRect) {
        XCTAssertFalse(board.popUpButtons["board.focused-column"].exists)
        XCTAssertEqual(cardRows(in: board), rows)
        assertFrame(board.frame, equals: frame)
    }

    private func assertFrame(_ actual: CGRect, equals expected: CGRect,
                             file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.minX, expected.minX, accuracy: 1, file: file, line: line)
        XCTAssertEqual(actual.minY, expected.minY, accuracy: 1, file: file, line: line)
        XCTAssertEqual(actual.width, expected.width, accuracy: 1, file: file, line: line)
        XCTAssertEqual(actual.height, expected.height, accuracy: 1, file: file, line: line)
    }

    private func assertWindowCount(_ count: Int, in app: XCUIApplication) {
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in app.windows.count == count }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed,
                       "Expected \(count) native windows; actual: \(app.windows.count).")
    }

    private func resizeColumn(_ list: XCUIElement, toWidth width: CGFloat) {
        let delta = width - list.frame.width
        if abs(delta) > 1 {
            let divider = list.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.6))
                .withOffset(CGVector(dx: 0.5, dy: 0))
            divider.click(forDuration: 0.4, thenDragTo: divider.withOffset(CGVector(dx: delta, dy: 0)))
        }
        let resized = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in abs(list.frame.width - width) < 3 }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [resized], timeout: 5), .completed)
    }

    private func resize(_ window: XCUIElement, toWidth width: CGFloat) {
        let delta = width - window.frame.width
        if abs(delta) > 2 {
            let edge = window.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.6))
                .withOffset(CGVector(dx: -1, dy: 0))
            edge.click(forDuration: 0.4, thenDragTo: edge.withOffset(CGVector(dx: delta, dy: 0)))
        }
        let resized = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in abs(window.frame.width - width) < 12 }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [resized], timeout: 5), .completed)
    }

    private func attach(_ element: XCUIElement, named name: String) {
        let attachment = XCTAttachment(screenshot: element.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
