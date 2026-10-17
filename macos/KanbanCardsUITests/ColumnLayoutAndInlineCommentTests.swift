import Foundation
import XCTest

/// Every launch uses synthetic data and suppresses restored windows. The normal
/// launch path intentionally has no presentation override or preference writes.
@MainActor
final class ColumnLayoutAndInlineCommentTests: XCTestCase {
    private let homepage = "demo-card-homepage"
    private let keyboard = "demo-card-keyboard"
    private let licenses = "demo-card-licenses"
    private let pricing = "demo-card-pricing"
    private let signup = "demo-card-signup"
    private var runningApp: XCUIApplication?

    override func setUp() async throws { continueAfterFailure = false }
    override func tearDown() async throws { runningApp?.terminate(); runningApp = nil }

    func testNormalLaunchUsesColumnDetailDespiteOldPreferenceAndHasNoPresentationSelectorOrCounts() throws {
        let app = launch(extraArguments: ["-cardInteractionMode", "windows"])
        let board = board(in: app)
        XCTAssertFalse(board.popUpButtons["board.card-view"].exists)
        assertNoCardCounts(in: board)
        board.buttons["board.card.\(homepage)"].click()
        XCTAssertTrue(board.popUpButtons["board.focused-column"].waitForExistence(timeout: 5),
                      "A normal launch must use C even if the old saved preference says A.")
        XCTAssertTrue(viewer(homepage, in: board).waitForExistence(timeout: 5))
        XCTAssertEqual(app.windows.count, 1)
        assertNoCardCounts(in: board)
        openFilters(in: board, app: app)
        assertNoCardCounts(in: app)
        attach(popover(in: app), named: "Native Filters popover without a Card count")
        closeFilters(in: app)
        attach(board, named: "Default Column list and detail without a presentation selector or Card counts")
    }

    func testColumnHeaderStaysInOneReachableRowAndPreservesWidthAtBothPaneLimits() throws {
        let app = launch()
        let board = board(in: app)
        resize(board, toWidth: 1320)
        board.buttons["board.card.\(homepage)"].click()
        let list = columnList(in: board)
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        for width in [CGFloat(440), CGFloat(230)] {
            resizeColumn(list, toWidth: width)
            let chosenWidth = list.frame.width
            assertHeaderRow(in: board, list: list)
            assertLabel(board.buttons["board.return-to-board"], contains: "Back to board")
            assertLabel(board.buttons["board.filters"], contains: "Filters")
            let header = board.descendants(matching: .any).matching(identifier: "board.column-header").firstMatch
            if width == 230 {
                XCTAssertFalse(header.staticTexts["Column"].exists,
                               "The narrow row must omit the redundant visible Column label.")
                XCTAssertLessThanOrEqual(board.buttons["board.return-to-board"].frame.width, 36)
                XCTAssertLessThanOrEqual(board.buttons["board.filters"].frame.width, 36)
            } else {
                XCTAssertTrue(header.staticTexts["Column"].exists,
                              "The wide row must retain the explicit Column label.")
            }
            assertNoCardCounts(in: board)

            openFilters(in: board, app: app)
            choose("You", from: app.popUpButtons["board.filter.actor"], in: app)
            closeFilters(in: app)
            assertRows([homepage, licenses], in: board)
            assertLabel(board.staticTexts["board.filter-summary"], contains: "You")
            XCTAssertEqual(list.frame.width, chosenWidth, accuracy: 1,
                           "Changing a filter must preserve the chosen native divider position.")
            assertHeaderRow(in: board, list: list)
            board.buttons["board.card.\(licenses)"].click()
            XCTAssertTrue(viewer(licenses, in: board).waitForExistence(timeout: 5))
            XCTAssertEqual(list.frame.width, chosenWidth, accuracy: 1)

            choose("Next", from: board.popUpButtons["board.focused-column"], in: app)
            assertRows([pricing], in: board)
            XCTAssertTrue(viewer(pricing, in: board).waitForExistence(timeout: 5))
            XCTAssertEqual(list.frame.width, chosenWidth, accuracy: 1,
                           "Choosing a Column must not resize the list or wrap its navigation controls.")
            assertHeaderRow(in: board, list: list)
            openFilters(in: board, app: app)
            choose("Agent", from: app.popUpButtons["board.filter.actor"], in: app)
            choose("High", from: app.popUpButtons["board.filter.priority"], in: app)
            closeFilters(in: app)
            assertRows([], in: board)
            XCTAssertEqual(list.frame.width, chosenWidth, accuracy: 1)
            board.buttons["board.empty.clear-filters"].click()
            assertRows([pricing, "demo-card-checklist", "demo-card-footer", "demo-card-research"], in: board)
            XCTAssertEqual(list.frame.width, chosenWidth, accuracy: 1)
            choose("Doing", from: board.popUpButtons["board.focused-column"], in: app)
            assertRows([homepage, keyboard, licenses], in: board)
            XCTAssertEqual(list.frame.width, chosenWidth, accuracy: 1)
            assertHeaderRow(in: board, list: list)
            assertNoCardCounts(in: board)
            attach(board, named: "Single native Column header row at \(Int(width))pt list width")
        }
        XCTAssertEqual(app.windows.count, 1)
    }

    func testFiltersStayVisibleAsCriteriaAndSearchHasIndependentEmptyResultRecovery() throws {
        let app = launch()
        let board = board(in: app)
        resize(board, toWidth: 1320)
        board.buttons["board.card.\(homepage)"].click()
        let column = board.popUpButtons["board.focused-column"]
        let search = board.searchFields.firstMatch
        replace(search, with: "Review")
        assertRows([homepage], in: board)
        assertLabel(board.staticTexts["board.filter-summary"], contains: "Review")
        openFilters(in: board, app: app)
        choose("Agent", from: app.popUpButtons["board.filter.actor"], in: app)
        assertRows([], in: board)
        popover(in: app).buttons["board.clear-filters"].click()
        XCTAssertEqual(app.popUpButtons["board.filter.actor"].value as? String, "All actors")
        closeFilters(in: app)
        assertRows([homepage], in: board)
        XCTAssertEqual(search.value as? String, "Review",
                       "Clear filters must preserve the separate search query.")
        XCTAssertEqual(column.value as? String, "Doing")
        XCTAssertFalse(board.buttons["board.clear-filters"].exists)

        openFilters(in: board, app: app)
        choose("Agent", from: app.popUpButtons["board.filter.actor"], in: app)
        let archived = app.checkBoxes["board.filter.archived"]
        archived.click()
        assertCheckbox(archived, isChecked: true)
        attach(popover(in: app), named: "Native inline filter controls with archived enabled")
        closeFilters(in: app)
        assertRows([], in: board)
        assertLabel(board.staticTexts["board.filter-summary"], contains: "Agent")
        assertLabel(board.staticTexts["board.filter-summary"], contains: "archived")
        XCTAssertTrue(board.buttons["board.empty.clear-filters"].isHittable)
        XCTAssertTrue(board.buttons["board.empty.clear-search"].isHittable)
        board.buttons["board.empty.clear-filters"].click()
        assertRows([homepage], in: board)
        XCTAssertEqual(search.value as? String, "Review")
        XCTAssertEqual(column.value as? String, "Doing")
        openFilters(in: board, app: app)
        assertCheckbox(app.checkBoxes["board.filter.archived"], isChecked: false)
        choose("You", from: app.popUpButtons["board.filter.actor"], in: app)
        closeFilters(in: app)
        replace(search, with: "keyboard")
        assertRows([], in: board)
        board.buttons["board.empty.clear-search"].click()
        assertRows([homepage, licenses], in: board)
        XCTAssertEqual(search.value as? String, "")
        assertLabel(board.staticTexts["board.filter-summary"], contains: "You")
        XCTAssertEqual(column.value as? String, "Doing")
        assertNoCardCounts(in: board)
        attach(board, named: "Active criteria remain visible without Card counts")

        board.buttons["board.return-to-board"].click()
        XCTAssertTrue(column.waitForNonExistence(timeout: 5))
        XCTAssertEqual(board.popUpButtons["board.filter.actor"].value as? String, "You")
        assertRows([pricing, homepage, licenses, "demo-card-buttons"], in: board)
        board.buttons["board.card.\(homepage)"].click()
        assertRows([homepage, licenses], in: board)
        assertLabel(board.staticTexts["board.filter-summary"], contains: "You")
        XCTAssertEqual(app.windows.count, 1)
    }

    func testColumnNavigationSelectsItsCardsAndBackReturnsToFullBoard() throws {
        let app = launch()
        let board = board(in: app)
        board.buttons["board.card.\(homepage)"].click()
        let column = board.popUpButtons["board.focused-column"]
        XCTAssertTrue(column.waitForExistence(timeout: 5))
        XCTAssertEqual(column.value as? String, "Doing")
        assertRows([homepage, keyboard, licenses], in: board)
        choose("Next", from: column, in: app)
        assertRows([pricing, "demo-card-checklist", "demo-card-footer", "demo-card-research"], in: board)
        XCTAssertTrue(viewer(pricing, in: board).waitForExistence(timeout: 5))
        choose("Done", from: column, in: app)
        assertRows([signup, "demo-card-buttons"], in: board)
        XCTAssertTrue(viewer(signup, in: board).waitForExistence(timeout: 5))
        board.buttons["board.return-to-board"].click()
        XCTAssertTrue(column.waitForNonExistence(timeout: 5))
        XCTAssertFalse(viewer(signup, in: board).exists)
        assertRows([pricing, "demo-card-checklist", "demo-card-footer", "demo-card-research",
                    homepage, keyboard, licenses, signup, "demo-card-buttons"], in: board)
        XCTAssertFalse(board.popUpButtons["board.card-view"].exists)
        assertNoCardCounts(in: board)
        XCTAssertEqual(app.windows.count, 1)
    }

    func testInlineCommentsSubmitWithoutSheetsAndKeepCanceledDraftsOnTheirOwnCard() throws {
        let app = launch()
        let board = board(in: app)
        resize(board, toWidth: 1320)
        board.buttons["board.card.\(homepage)"].click()
        let home = viewer(homepage, in: board)
        XCTAssertTrue(home.waitForExistence(timeout: 5))
        assertText("Comments (2)", in: home)
        app.typeKey("m", modifierFlags: [.command, .shift])
        let homeComposer = home.descendants(matching: .any).matching(identifier: "card.comment-composer.\(homepage)").firstMatch
        let homeBody = home.textViews["comment.body"]
        XCTAssertTrue(homeComposer.waitForExistence(timeout: 5))
        XCTAssertTrue(homeBody.waitForExistence(timeout: 5))
        XCTAssertTrue(homeBody.isHittable, "The keyboard Comment command must reveal the composer in the Card's native scroll view.")
        XCTAssertEqual(app.sheets.count, 0, "Add Comment must reveal an inline composer in the Card.")
        let homeDraft = "Retained homepage comment from the inline composer."
        replace(homeBody, with: homeDraft)
        home.buttons["comment.cancel"].click()
        XCTAssertTrue(homeBody.waitForNonExistence(timeout: 5))
        XCTAssertFalse(home.staticTexts[homeDraft].exists, "Cancel must retain a draft without posting it.")
        home.buttons["card.add-comment.\(homepage)"].click()
        XCTAssertTrue(homeBody.waitForExistence(timeout: 5))
        XCTAssertEqual(homeBody.value as? String, homeDraft)
        home.buttons["comment.cancel"].click()

        board.buttons["board.card.\(keyboard)"].click()
        let other = viewer(keyboard, in: board)
        XCTAssertTrue(other.waitForExistence(timeout: 5))
        other.buttons["card.add-comment.\(keyboard)"].click()
        let otherBody = other.textViews["comment.body"]
        XCTAssertTrue(otherBody.waitForExistence(timeout: 5))
        XCTAssertEqual(otherBody.value as? String, "", "Another Card must start with its own empty Comment draft.")
        let otherDraft = "A separate keyboard navigation comment draft."
        replace(otherBody, with: otherDraft)
        XCTAssertTrue(board.buttons["board.card.\(homepage)"].isEnabled,
                      "Typing an inline draft must allow selection of another Card.")
        board.buttons["board.card.\(homepage)"].click()
        XCTAssertTrue(home.waitForExistence(timeout: 5))
        home.buttons["card.add-comment.\(homepage)"].click()
        XCTAssertTrue(homeBody.waitForExistence(timeout: 5))
        XCTAssertEqual(homeBody.value as? String, homeDraft)
        XCTAssertEqual(app.sheets.count, 0)
        attach(homeComposer, named: "Inline Comment composer keeps its Card-specific draft")
        home.buttons["comment.save"].click()
        XCTAssertTrue(homeBody.waitForNonExistence(timeout: 5))
        assertText(homeDraft, in: home)
        // Selectable native Text can expose multiple AX static-text wrappers.
        // The Comments heading reads the actual Card collection's count.
        assertText("Comments (3)", in: home)
        XCTAssertFalse(home.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@ OR value == %@", "Comments (4)", "Comments (4)")).firstMatch.exists,
                       "Submitting once must add exactly one Comment to the two seeded Comments.")
        XCTAssertEqual(app.sheets.count, 0)
        XCTAssertEqual(app.windows.count, 1)
        attach(board, named: "Posted inline Comment appears once after the two seeded Comments")

        board.buttons["board.card.\(keyboard)"].click()
        XCTAssertTrue(other.waitForExistence(timeout: 5))
        other.buttons["card.add-comment.\(keyboard)"].click()
        XCTAssertTrue(otherBody.waitForExistence(timeout: 5))
        XCTAssertEqual(otherBody.value as? String, otherDraft,
                       "Submitting one Card's Comment must preserve another Card's retained draft.")
        XCTAssertFalse(other.staticTexts[homeDraft].exists)
        other.buttons["comment.cancel"].click()
        attach(board, named: "Inline Comment submission and per-Card draft isolation")
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

    private func viewer(_ cardID: String, in board: XCUIElement) -> XCUIElement {
        board.descendants(matching: .any).matching(identifier: "card.viewer.\(cardID)").firstMatch
    }

    private func columnList(in board: XCUIElement) -> XCUIElement {
        board.descendants(matching: .any).matching(identifier: "board.column-list").firstMatch
    }

    private func popover(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "board.filter-popover").firstMatch
    }

    private func openFilters(in board: XCUIElement, app: XCUIApplication) {
        board.buttons["board.filters"].click()
        XCTAssertTrue(popover(in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(app.popUpButtons["board.filter.actor"].isHittable)
    }

    private func closeFilters(in app: XCUIApplication) {
        app.buttons["board.filters.done"].click()
        XCTAssertTrue(popover(in: app).waitForNonExistence(timeout: 5))
    }

    private func assertHeaderRow(in board: XCUIElement, list: XCUIElement,
                                 file: StaticString = #filePath, line: UInt = #line) {
        let row = board.descendants(matching: .any).matching(identifier: "board.column-header").firstMatch
        let back = board.buttons["board.return-to-board"]
        let column = board.popUpButtons["board.focused-column"]
        let filters = board.buttons["board.filters"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), file: file, line: line)
        for control in [back, column, filters] {
            XCTAssertTrue(control.isHittable, file: file, line: line)
            XCTAssertGreaterThanOrEqual(control.frame.minX, list.frame.minX, file: file, line: line)
            XCTAssertLessThanOrEqual(control.frame.maxX, list.frame.maxX + 1, file: file, line: line)
        }
        XCTAssertEqual(back.frame.midY, column.frame.midY, accuracy: 4, file: file, line: line)
        XCTAssertEqual(filters.frame.midY, column.frame.midY, accuracy: 4, file: file, line: line)
        XCTAssertLessThanOrEqual(back.frame.maxX, column.frame.minX + 1, file: file, line: line)
        XCTAssertLessThanOrEqual(column.frame.maxX, filters.frame.minX + 1, file: file, line: line)
    }

    private func assertNoCardCounts(in container: XCUIElement,
                                    file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(container.descendants(matching: .any).matching(identifier: "board.filter-count").firstMatch.exists,
                       file: file, line: line)
        XCTAssertFalse(container.descendants(matching: .any).matching(identifier: "board.popover-filter-count").firstMatch.exists,
                       file: file, line: line)
        let pattern = "^[0-9]+(?: of [0-9]+)? Cards(?: in this Column)?$"
        XCTAssertFalse(container.staticTexts.matching(NSPredicate(format: "label MATCHES[c] %@ OR value MATCHES[c] %@", pattern, pattern)).firstMatch.exists,
                       "Card-count labels must be absent from the native board and Filters popover.", file: file, line: line)
    }

    private func assertRows(_ cardIDs: [String], in board: XCUIElement,
                            file: StaticString = #filePath, line: UInt = #line) {
        // A Form beside the List can rebuild its accessibility subtree while it
        // loads. Count the native row queries instead of re-resolving each index
        // against a different application snapshot to fetch its identifier.
        let list = columnList(in: board)
        let isColumnList = list.exists
        let scope = isColumnList ? list : board
        let rows = scope.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "board.card."))
        let expected = Set(cardIDs.map { "board.card.\($0)" })
        let expectedRows = rows.matching(NSPredicate(format: "identifier IN %@", Array(expected)))
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            rows.count == expected.count && expectedRows.count == expected.count
        }, object: nil)
        let result = XCTWaiter.wait(for: [updated], timeout: 5)
        if result != .completed {
            let diagnostics = XCTAttachment(string:
                "Expected IDs: \(expected.sorted())\nScope: \(isColumnList ? "Column list" : "full board")\n"
                + "Actual row count: \(rows.count); matching expected IDs: \(expectedRows.count)\n\n"
                + scope.debugDescription)
            diagnostics.name = "Card row inventory and native accessibility hierarchy"
            diagnostics.lifetime = .keepAlways
            add(diagnostics)
        }
        XCTAssertEqual(result, .completed,
                       "Expected Card IDs \(expected.sorted()) in \(isColumnList ? "Column list" : "full board"). "
                       + "Actual rows: \(rows.count); matching expected IDs: \(expectedRows.count).",
                       file: file, line: line)
    }

    private func choose(_ value: String, from picker: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(picker.waitForExistence(timeout: 5))
        picker.click()
        let item = app.menuItems[value].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        item.click()
        XCTAssertEqual(picker.value as? String, value)
    }

    private func resizeColumn(_ list: XCUIElement, toWidth width: CGFloat) {
        let delta = width - list.frame.width
        if abs(delta) > 1 {
            let divider = list.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.6))
                .withOffset(CGVector(dx: 0.5, dy: 0))
            divider.click(forDuration: 0.4, thenDragTo: divider.withOffset(CGVector(dx: delta, dy: 0)))
        }
        let resized = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in abs(list.frame.width - width) < 3 }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [resized], timeout: 5), .completed,
                       "The native Column divider must reach \(Int(width))pt; actual: \(list.frame.width).")
    }

    private func resize(_ window: XCUIElement, toWidth width: CGFloat) {
        let difference = width - window.frame.width
        if abs(difference) > 2 {
            let edge = window.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.6)).withOffset(CGVector(dx: -1, dy: 0))
            edge.click(forDuration: 0.4, thenDragTo: edge.withOffset(CGVector(dx: difference, dy: 0)))
        }
        let resized = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in abs(window.frame.width - width) < 12 }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [resized], timeout: 5), .completed)
    }

    private func replace(_ field: XCUIElement, with text: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.click()
        field.typeKey("a", modifierFlags: .command)
        field.typeText(text)
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in field.value as? String == text }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed)
    }

    private func assertCheckbox(_ checkbox: XCUIElement, isChecked checked: Bool,
                                file: StaticString = #filePath, line: UInt = #line) {
        let expected = checked ? 1 : 0
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard checkbox.exists else { return false }
            if let value = checkbox.value as? String { return value == String(expected) }
            if let value = checkbox.value as? NSNumber { return value == NSNumber(value: expected) }
            return false
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed,
                       "Expected native checkbox value \(expected); actual: \(String(describing: checkbox.value)).", file: file, line: line)
    }

    private func assertLabel(_ element: XCUIElement, contains text: String,
                             file: StaticString = #filePath, line: UInt = #line) {
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            element.exists && (element.label.contains(text) || (element.value as? String)?.contains(text) == true)
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed, file: file, line: line)
    }

    private func assertText(_ text: String, in container: XCUIElement,
                            file: StaticString = #filePath, line: UInt = #line) {
        let element = container.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@ OR value == %@", text, text)).firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: 5), "Expected exact native text: \(text)", file: file, line: line)
    }

    private func attach(_ element: XCUIElement, named name: String) {
        let attachment = XCTAttachment(screenshot: element.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
