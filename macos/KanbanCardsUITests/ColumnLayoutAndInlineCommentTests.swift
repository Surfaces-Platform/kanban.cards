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

    func testFullBoardInlineFiltersRetainCriteriaAcrossColumnNavigation() throws {
        let app = launch()
        let board = board(in: app)
        let surface = board.descendants(matching: .any).matching(identifier: "board.surface").firstMatch
        let fullHeader = board.descendants(matching: .any).matching(identifier: "board.control-strip").firstMatch
        let search = board.searchFields.firstMatch
        XCTAssertTrue(surface.waitForExistence(timeout: 5))
        for width in [CGFloat(1320), CGFloat(1024)] {
            resize(board, toWidth: width)
            replace(search, with: "")
            XCTAssertTrue(fullHeader.waitForExistence(timeout: 5))
            let headerFrame = fullHeader.frame
            attachHeaderGeometry("initial inline board at \(Int(width))pt", in: board, app: app)
            XCTAssertFalse(surface.staticTexts["Atlas website"].exists,
                           "The native title bar already names this Project.")
            XCTAssertFalse(surface.staticTexts["Prepare a clear, accessible launch experience."].exists,
                           "Board descriptions must not occupy the board surface.")
            XCTAssertFalse(board.buttons["board.info"].exists)
            XCTAssertFalse(board.descendants(matching: .any).matching(identifier: "board.info-popover").firstMatch.exists)
            assertInlineFiltersFit(in: board)
            XCTAssertFalse(fullHeader.buttons["board.clear-filters"].isEnabled)

            replace(search, with: "Review")
            attachHeaderGeometry("searched inline board at \(Int(width))pt", in: board, app: app)
            XCTAssertEqual(fullHeader.frame.minY, headerFrame.minY, accuracy: 1,
                           "Searching must preserve the board's top control position.")
            XCTAssertEqual(fullHeader.frame.height, headerFrame.height, accuracy: 1)
            choose("You", from: board.popUpButtons["board.filter.actor"], in: app)
            attachHeaderGeometry("actor selected at \(Int(width))pt", in: board, app: app)
            XCTAssertEqual(fullHeader.frame.minY, headerFrame.minY, accuracy: 1)
            choose("High", from: board.popUpButtons["board.filter.priority"], in: app)
            attachHeaderGeometry("priority selected at \(Int(width))pt", in: board, app: app)
            assertRows([homepage], in: board)
            assertLabel(board.staticTexts["board.filter-summary"], contains: "You")
            assertLabel(board.staticTexts["board.filter-summary"], contains: "High")
            assertLabel(board.staticTexts["board.filter-summary"], contains: "Review")
            XCTAssertTrue(fullHeader.buttons["board.clear-filters"].isEnabled)
            assertInlineFiltersFit(in: board)
            XCTAssertEqual(fullHeader.frame.minY, headerFrame.minY, accuracy: 1,
                           "Active criteria must not expand the board above the native toolbar boundary.")
            XCTAssertEqual(fullHeader.frame.height, headerFrame.height, accuracy: 1,
                           "Active criteria belong below the control strip.")

            board.buttons["board.card.\(homepage)"].click()
            let list = columnList(in: board)
            XCTAssertTrue(list.waitForExistence(timeout: 5))
            XCTAssertTrue(board.descendants(matching: .any).matching(identifier: "card.control-strip.\(homepage)")
                .firstMatch.waitForExistence(timeout: 5))
            attachHeaderGeometry("filtered Column at \(Int(width))pt", in: board, app: app)
            assertHeaderRow(in: board, list: list, matching: headerFrame)
            assertRows([homepage], in: board)
            XCTAssertEqual(search.value as? String, "Review")
            XCTAssertFalse(board.popUpButtons["board.filter.actor"].exists,
                           "The compact Column keeps its filter choices in a popover.")
            openFilters(in: board, app: app)
            XCTAssertEqual(app.popUpButtons["board.filter.actor"].value as? String, "You")
            XCTAssertEqual(app.popUpButtons["board.filter.priority"].value as? String, "High")
            closeFilters(in: app)
            board.buttons["board.return-to-board"].click()
            XCTAssertTrue(fullHeader.waitForExistence(timeout: 5))
            attachHeaderGeometry("returned inline board at \(Int(width))pt", in: board, app: app)
            XCTAssertEqual(fullHeader.frame.minY, headerFrame.minY, accuracy: 1)
            XCTAssertEqual(fullHeader.frame.height, headerFrame.height, accuracy: 1)
            assertInlineFiltersFit(in: board)
            assertRows([homepage], in: board)
            assertLabel(board.staticTexts["board.filter-summary"], contains: "Review")
            XCTAssertEqual(board.popUpButtons["board.filter.actor"].value as? String, "You")
            XCTAssertEqual(board.popUpButtons["board.filter.priority"].value as? String, "High")
            fullHeader.buttons["board.clear-filters"].click()
            XCTAssertFalse(fullHeader.buttons["board.clear-filters"].isEnabled)
            XCTAssertEqual(search.value as? String, "Review")
            assertRows(["demo-card-footer", homepage], in: board)
            XCTAssertEqual(fullHeader.frame.minY, headerFrame.minY, accuracy: 1)
            assertNoCardCounts(in: board)
            XCTAssertEqual(app.windows.count, 1)
        }
    }

    func testColumnHeaderStaysInOneReachableRowAndPreservesWidthAtBothPaneLimits() throws {
        let app = launch()
        let board = board(in: app)
        resize(board, toWidth: 1320)
        let fullHeader = board.descendants(matching: .any).matching(identifier: "board.control-strip").firstMatch
        XCTAssertTrue(fullHeader.waitForExistence(timeout: 5))
        let headerFrame = fullHeader.frame
        board.buttons["board.card.\(homepage)"].click()
        let list = columnList(in: board)
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        for width in [CGFloat(440), CGFloat(230)] {
            resizeColumn(list, toWidth: width)
            let chosenWidth = list.frame.width
            assertHeaderRow(in: board, list: list, matching: headerFrame)
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
            assertHeaderRow(in: board, list: list, matching: headerFrame)
            board.buttons["board.card.\(licenses)"].click()
            XCTAssertTrue(viewer(licenses, in: board).waitForExistence(timeout: 5))
            XCTAssertEqual(list.frame.width, chosenWidth, accuracy: 1)

            choose("Next", from: board.popUpButtons["board.focused-column"], in: app)
            assertRows([pricing], in: board)
            XCTAssertTrue(viewer(pricing, in: board).waitForExistence(timeout: 5))
            XCTAssertEqual(list.frame.width, chosenWidth, accuracy: 1,
                           "Choosing a Column must not resize the list or wrap its navigation controls.")
            assertHeaderRow(in: board, list: list, matching: headerFrame)
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
            assertHeaderRow(in: board, list: list, matching: headerFrame)
            assertNoCardCounts(in: board)
            attach(board, named: "Single native Column header row at \(Int(width))pt list width")
        }
        board.buttons["board.return-to-board"].click()
        XCTAssertTrue(fullHeader.waitForExistence(timeout: 5))
        resize(board, toWidth: 1024)
        let narrowHeaderFrame = fullHeader.frame
        board.buttons["board.card.\(homepage)"].click()
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        XCTAssertTrue(board.descendants(matching: .any).matching(identifier: "card.control-strip.\(homepage)")
            .firstMatch.waitForExistence(timeout: 5))
        for width in [CGFloat(440), CGFloat(230)] {
            resizeColumn(list, toWidth: width)
            assertHeaderRow(in: board, list: list, matching: narrowHeaderFrame)
        }
        board.buttons["board.return-to-board"].click()
        XCTAssertTrue(fullHeader.waitForExistence(timeout: 5))
        XCTAssertEqual(fullHeader.frame.minY, narrowHeaderFrame.minY, accuracy: 1)
        XCTAssertEqual(fullHeader.frame.height, narrowHeaderFrame.height, accuracy: 1)
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
        XCTAssertTrue(board.popUpButtons["board.filter.actor"].isHittable)
        XCTAssertFalse(board.buttons["board.filters"].exists)
        assertLabel(board.staticTexts["board.filter-summary"], contains: "You")
        openFilters(in: board, app: app)
        XCTAssertEqual(app.popUpButtons["board.filter.actor"].value as? String, "You")
        closeFilters(in: app)
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
        if board.popUpButtons["board.filter.actor"].exists {
            XCTAssertFalse(board.buttons["board.filters"].exists)
            XCTAssertTrue(board.popUpButtons["board.filter.actor"].isHittable)
            return
        }
        board.buttons["board.filters"].click()
        XCTAssertTrue(popover(in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(app.popUpButtons["board.filter.actor"].isHittable)
    }

    private func closeFilters(in app: XCUIApplication) {
        guard popover(in: app).exists else {
            XCTAssertTrue(board(in: app).popUpButtons["board.filter.actor"].isHittable)
            return
        }
        app.buttons["board.filters.done"].click()
        XCTAssertTrue(popover(in: app).waitForNonExistence(timeout: 5))
    }

    private func assertInlineFiltersFit(in board: XCUIElement,
                                        file: StaticString = #filePath, line: UInt = #line) {
        let header = board.descendants(matching: .any).matching(identifier: "board.control-strip").firstMatch
        XCTAssertTrue(header.exists, file: file, line: line)
        XCTAssertFalse(board.buttons["board.filters"].exists,
                       "Full-board filters must be directly available.", file: file, line: line)
        let controls = [header.popUpButtons["board.filter.actor"],
                        header.popUpButtons["board.filter.priority"],
                        header.popUpButtons["board.filter.blocked"],
                        header.checkBoxes["board.filter.archived"], header.buttons["board.clear-filters"]]
        for control in controls {
            XCTAssertTrue(control.exists, file: file, line: line)
            XCTAssertTrue(control.isHittable, "Every inline filter must remain reachable.", file: file, line: line)
            XCTAssertGreaterThan(control.frame.width, 20, file: file, line: line)
            XCTAssertGreaterThanOrEqual(control.frame.minX, header.frame.minX - 1, file: file, line: line)
            XCTAssertLessThanOrEqual(control.frame.maxX, header.frame.maxX + 1, file: file, line: line)
            XCTAssertGreaterThanOrEqual(control.frame.minY, header.frame.minY - 1, file: file, line: line)
            XCTAssertLessThanOrEqual(control.frame.maxY, header.frame.maxY + 1, file: file, line: line)
            XCTAssertGreaterThanOrEqual(control.frame.minX, board.frame.minX - 1, file: file, line: line)
            XCTAssertLessThanOrEqual(control.frame.maxX, board.frame.maxX + 1, file: file, line: line)
        }
        for (left, right) in zip(controls, controls.dropFirst()) {
            XCTAssertLessThanOrEqual(left.frame.maxX, right.frame.minX + 1,
                                     "Inline filters must remain in one row without overlap.", file: file, line: line)
            XCTAssertEqual(left.frame.midY, right.frame.midY, accuracy: 4, file: file, line: line)
        }
    }

    private func attachHeaderGeometry(_ stage: String, in board: XCUIElement, app: XCUIApplication) {
        let windowFrame = board.frame
        let elements: [(String, XCUIElement)] = [
            ("window", board),
            ("toolbar", board.toolbars.firstMatch),
            ("boardRoot", board.descendants(matching: .any).matching(identifier: "board.window").firstMatch),
            ("surface", board.descendants(matching: .any).matching(identifier: "board.surface").firstMatch),
            ("fullHeader", board.descendants(matching: .any).matching(identifier: "board.control-strip").firstMatch),
            ("columnList", columnList(in: board)),
            ("columnHeader", board.descendants(matching: .any).matching(identifier: "board.column-header").firstMatch),
            ("cardHeader", board.descendants(matching: .any).matching(identifier: "card.control-strip.\(homepage)").firstMatch),
            ("filters", board.buttons["board.filters"]),
            ("actorFilter", board.popUpButtons["board.filter.actor"]),
            ("priorityFilter", board.popUpButtons["board.filter.priority"]),
            ("blockedFilter", board.popUpButtons["board.filter.blocked"]),
            ("archivedFilter", board.checkBoxes["board.filter.archived"]),
            ("filterPopover", popover(in: app)),
            ("criteria", board.staticTexts["board.filter-summary"]),
            ("doingColumn", board.descendants(matching: .any).matching(identifier: "board.column.doing").firstMatch)
        ]
        func values(_ frame: CGRect) -> [String: Any] {
            ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
                .mapValues { $0.isFinite ? Double($0) as Any : NSNull() }
        }
        let frames: [[String: Any]] = elements.map { name, element in
            guard element.exists else { return ["name": name, "exists": false] }
            let frame = element.frame
            return ["name": name, "exists": true, "absolute": values(frame),
                    "windowRelative": values(frame.offsetBy(dx: -windowFrame.minX, dy: -windowFrame.minY))]
        }
        let payload: [String: Any] = ["stage": stage, "frames": frames]
        let json = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "Unable to encode header geometry."
        print("HEADER_GEOMETRY \(json)")
        let geometry = XCTAttachment(string: json)
        geometry.name = "Header geometry: \(stage)"
        geometry.lifetime = .keepAlways
        add(geometry)
        let hierarchy = XCTAttachment(string: board.debugDescription
            + (popover(in: app).exists ? "\n\nFilters popover:\n" + popover(in: app).debugDescription : ""))
        hierarchy.name = "Native hierarchy: \(stage)"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        attach(board, named: "Header screenshot: \(stage)")
        if popover(in: app).exists { attach(popover(in: app), named: "Filters screenshot: \(stage)") }
    }

    private func assertHeaderRow(in board: XCUIElement, list: XCUIElement, matching fullHeader: CGRect,
                                 file: StaticString = #filePath, line: UInt = #line) {
        let row = board.descendants(matching: .any).matching(identifier: "board.column-header").firstMatch
        let back = board.buttons["board.return-to-board"]
        let column = board.popUpButtons["board.focused-column"]
        let filters = board.buttons["board.filters"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), file: file, line: line)
        XCTAssertEqual(row.frame.minY, fullHeader.minY, accuracy: 1, file: file, line: line)
        XCTAssertEqual(row.frame.height, fullHeader.height, accuracy: 1, file: file, line: line)
        let cardStrip = board.descendants(matching: .any).matching(NSPredicate(
            format: "identifier BEGINSWITH %@", "card.control-strip.")).firstMatch
        if cardStrip.exists {
            XCTAssertEqual(cardStrip.frame.minY, row.frame.minY, accuracy: 1, file: file, line: line)
            XCTAssertEqual(cardStrip.frame.height, row.frame.height, accuracy: 1, file: file, line: line)
        }
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
        if text.isEmpty {
            field.typeKey(XCUIKeyboardKey.delete.rawValue, modifierFlags: [])
        } else {
            field.typeText(text)
        }
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
