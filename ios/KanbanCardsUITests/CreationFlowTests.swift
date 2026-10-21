import XCTest

/// Creation starts fresh; recovery is an explicit choice that preserves old work.
/// Run in the dedicated iOS Simulator using synthetic demo data only.
@MainActor
final class CreationFlowTests: XCTestCase {
    private var runningApp: XCUIApplication?

    private enum Kind: CaseIterable {
        case project, card

        var noun: String { self == .project ? "Project" : "Card" }
        var titleID: String { self == .project ? "project-name" : "card-title" }
        var bodyID: String { self == .project ? "project-description" : "card-description" }
        var legacyTitle: String { "Older \(noun) idea" }
        var legacyBody: String { "Keep this original \(noun) draft while I start something new." }
    }

    override func setUp() async throws { continueAfterFailure = false }
    override func tearDown() async throws {
        runningApp?.terminate()
        runningApp = nil
    }

    func testFreshFormsPrioritizeWritingAndEmptyCancelDoesNotSaveDraft() {
        for kind in Kind.allCases {
            let app = launch()
            open(kind, in: app)
            assertFresh(kind, in: app)
            XCTAssertTrue(
                bodyField(kind, in: app).isHittable,
                "Description should be available before optional metadata.")
            assertFieldFitsItsRow(kind.bodyID, in: app)
            if kind == .card {
                XCTAssertTrue(app.buttons["More details"].exists)
                XCTAssertFalse(app.staticTexts["Next actor"].isHittable)
            }
            XCTAssertFalse(
                app.buttons["Discard Draft"].exists, "An untouched form has nothing to discard.")
            XCTAssertFalse(app.buttons["creation.saved-drafts"].exists)
            attach(app, named: "Fresh New \(kind.noun) with writing visible")
            cancel(in: app)
            XCTAssertTrue(app.textFields[kind.titleID].waitForNonExistence(timeout: 5))
            open(kind, in: app, alreadyInProject: kind == .card)
            assertFresh(kind, in: app)
            XCTAssertFalse(
                app.buttons["creation.saved-drafts"].exists,
                "Empty Cancel must not produce an empty saved draft.")
            cancel(in: app)
            app.terminate()
        }
    }

    func testCancelOffersContinueKeepAndDiscardThenKeptDraftCanResumeAfterRelaunch() {
        for kind in Kind.allCases {
            let app = launch()
            open(kind, in: app)
            enter(kind, title: "Finish this \(kind.noun)", body: "Writing worth keeping.", in: app)
            cancel(in: app)
            assertCancelChoices(in: app)
            attach(app, named: "New \(kind.noun) clear Cancel choices")
            app.buttons["Continue Editing"].tap()
            assertValue(app.textFields[kind.titleID], equals: "Finish this \(kind.noun)")
            cancel(in: app)
            app.buttons["Keep Draft"].tap()
            XCTAssertTrue(app.textFields[kind.titleID].waitForNonExistence(timeout: 5))

            relaunch(app)
            open(kind, in: app)
            assertFresh(kind, in: app)
            openRecovery(in: app)
            selectDraft(named: "Finish this \(kind.noun)", in: app)
            XCTAssertTrue(app.staticTexts["Writing worth keeping."].firstMatch.exists)
            attach(app, named: "Saved \(kind.noun) preview after relaunch")
            tapRecoveryAction("recovery.resume", in: app)
            assertValue(app.textFields[kind.titleID], equals: "Finish this \(kind.noun)")
            assertValue(bodyField(kind, in: app), equals: "Writing worth keeping.")
            app.buttons["creation.primary"].tap()
            XCTAssertTrue(
                app.staticTexts["Finish this \(kind.noun)"].firstMatch.waitForExistence(timeout: 5))
            app.terminate()
        }
    }

    func testDiscardRemovesOnlyCurrentDraftAndNeverCreatesServerWork() {
        for kind in Kind.allCases {
            let app = launch(extra: ["--demo-legacy-creation-drafts"])
            open(kind, in: app)
            enter(kind, title: "Discard this \(kind.noun)", body: "Only a local draft.", in: app)
            cancel(in: app)
            assertCancelChoices(in: app)
            app.buttons["Discard Draft"].tap()
            XCTAssertTrue(app.textFields[kind.titleID].waitForNonExistence(timeout: 5))
            XCTAssertFalse(
                app.staticTexts["Discard this \(kind.noun)"].exists,
                "Discard must not create server work.")
            open(kind, in: app, alreadyInProject: kind == .card)
            assertFresh(kind, in: app)
            openRecovery(in: app)
            XCTAssertFalse(app.staticTexts["Discard this \(kind.noun)"].exists)
            selectDraft(named: kind.legacyTitle, in: app)
            XCTAssertTrue(
                app.staticTexts[kind.legacyBody].firstMatch.exists,
                "Discarding new work must preserve the older record.")
            attach(app, named: "Old \(kind.noun) survives discarding a fresh draft")
            closeRecovery(in: app)
            cancel(in: app)
            app.terminate()
        }
    }

    func testUnknownOriginDraftCanBeCopiedWithoutClaimingItsOriginOrRemovingOriginal() {
        for kind in Kind.allCases {
            let app = launch(extra: ["--demo-legacy-creation-drafts"])
            open(kind, in: app)
            assertFresh(kind, in: app)
            XCTAssertFalse(app.buttons["This is the original Workspace"].exists)
            openRecovery(in: app)
            selectDraft(named: kind.legacyTitle, in: app)
            XCTAssertTrue(app.staticTexts[kind.legacyBody].firstMatch.exists)
            XCTAssertFalse(
                app.buttons["recovery.resume"].exists,
                "Unproven origin must not offer an in-place retry.")
            let copy = app.buttons["recovery.copy"]
            XCTAssertTrue(copy.waitForExistence(timeout: 5))
            reveal(copy, in: app)
            XCTAssertEqual(copy.label, "Copy to New \(kind.noun)")
            attach(app, named: "Unknown-origin \(kind.noun) draft has an explicit copy action")
            copy.tap()
            assertValue(app.textFields[kind.titleID], equals: kind.legacyTitle)
            assertValue(bodyField(kind, in: app), equals: kind.legacyBody)
            replace(app.textFields[kind.titleID], with: "Fresh \(kind.noun) from old text")
            app.buttons["creation.primary"].tap()
            XCTAssertTrue(
                app.staticTexts["Fresh \(kind.noun) from old text"].firstMatch.waitForExistence(
                    timeout: 5))

            relaunch(app)
            open(kind, in: app)
            assertFresh(kind, in: app)
            openRecovery(in: app)
            selectDraft(named: kind.legacyTitle, in: app)
            XCTAssertTrue(
                app.staticTexts[kind.legacyBody].firstMatch.exists,
                "Copying must leave the original record available after relaunch.")
            XCTAssertTrue(app.buttons["recovery.copy"].exists)
            closeRecovery(in: app)
            cancel(in: app)
            app.terminate()
        }
    }

    func testUnreadOldDraftDoesNotBlockSuccessfulFreshCreationAndSurvivesRelaunch() {
        for kind in Kind.allCases {
            let app = launch(extra: ["--demo-unreadable-creation-drafts"])
            open(kind, in: app)
            assertFresh(kind, in: app)
            XCTAssertTrue(app.buttons["creation.saved-drafts"].exists)
            openRecovery(in: app)
            selectDraft(named: "Draft unavailable", in: app)
            XCTAssertTrue(
                app.buttons["recovery.export"].exists,
                "Unread bytes must remain available to export.")
            attach(app, named: "Unread \(kind.noun) recovery is separate from creation")
            closeRecovery(in: app)
            enter(
                kind, title: "New \(kind.noun) despite old record",
                body: "Fresh work remains possible.",
                in: app)
            app.buttons["creation.primary"].tap()
            XCTAssertTrue(
                app.staticTexts["New \(kind.noun) despite old record"].firstMatch.waitForExistence(
                    timeout: 5))

            relaunch(app)
            open(kind, in: app)
            assertFresh(kind, in: app)
            XCTAssertTrue(
                app.buttons["creation.saved-drafts"].exists,
                "Fresh creation must not delete unread old data.")
            openRecovery(in: app)
            selectDraft(named: "Draft unavailable", in: app)
            XCTAssertTrue(app.buttons["recovery.export"].exists)
            attach(app, named: "Unread \(kind.noun) record survives fresh creation and relaunch")
            closeRecovery(in: app)
            cancel(in: app)
            app.terminate()
        }
    }

    func testBoundLegacyBackupRemainsUsableWhenScopedCopyIsDamagedAfterRelaunch() {
        for kind in Kind.allCases {
            let app = launch(extra: ["--demo-bound-corrupt-creation-drafts"])
            let title = "Bound \(kind.noun) backup"
            let body = "Recover this original \(kind.noun) backup after the newer scoped record is damaged."
            open(kind, in: app)
            assertFresh(kind, in: app)
            openRecovery(in: app)
            XCTAssertTrue(
                app.staticTexts["Draft unavailable"].firstMatch.exists,
                "The damaged scoped copy should remain visible alongside its usable backup.")
            selectDraft(named: title, in: app)
            XCTAssertTrue(app.staticTexts[body].firstMatch.exists)
            XCTAssertTrue(app.buttons["recovery.resume"].exists)
            XCTAssertFalse(
                app.buttons["recovery.copy"].exists,
                "A valid existing Workspace binding permits continuing the original request.")
            attach(app, named: "Bound \(kind.noun) backup remains available beside damaged copy")
            closeRecovery(in: app)
            cancel(in: app)

            relaunch(app)
            open(kind, in: app)
            assertFresh(kind, in: app)
            openRecovery(in: app)
            selectDraft(named: title, in: app)
            XCTAssertTrue(app.staticTexts[body].firstMatch.exists)
            tapRecoveryAction("recovery.resume", in: app)
            assertValue(app.textFields[kind.titleID], equals: title)
            assertValue(bodyField(kind, in: app), equals: body)
            attach(app, named: "Bound \(kind.noun) backup resumes full text after relaunch")
            app.terminate()
        }
    }

    func testTypedDraftSurvivesTerminationWithoutCancelAndReopensOnlyByChoice() {
        for kind in Kind.allCases {
            let app = launch()
            open(kind, in: app)
            enter(
                kind, title: "Interrupted \(kind.noun)", body: "Recovered after the app closes.",
                in: app)
            relaunch(app)
            open(kind, in: app)
            assertFresh(kind, in: app)
            openRecovery(in: app)
            selectDraft(named: "Interrupted \(kind.noun)", in: app)
            tapRecoveryAction("recovery.resume", in: app)
            assertValue(app.textFields[kind.titleID], equals: "Interrupted \(kind.noun)")
            assertValue(bodyField(kind, in: app), equals: "Recovered after the app closes.")
            attach(app, named: "Interrupted \(kind.noun) resumes intact by choice")
            app.terminate()
        }
    }

    func testErasingAllTextRestoresEmptyCancelWithoutLeavingSavedDraft() {
        for kind in Kind.allCases {
            let app = launch()
            open(kind, in: app)
            enter(
                kind, title: "Temporary \(kind.noun)", body: "Erase this before closing.", in: app)
            replace(app.textFields[kind.titleID], with: "")
            assertEditableValue(app.textFields[kind.titleID], equals: "", phase: "Erased title")
            replace(bodyField(kind, in: app), with: "")
            assertEditableValue(bodyField(kind, in: app), equals: "", phase: "Erased description")
            assertFresh(kind, in: app)
            cancel(in: app)
            XCTAssertTrue(
                app.textFields[kind.titleID].waitForNonExistence(timeout: 5),
                "Erasing all work must restore immediate Cancel.")
            XCTAssertFalse(app.buttons["Keep Draft"].exists)
            open(kind, in: app, alreadyInProject: kind == .card)
            assertFresh(kind, in: app)
            XCTAssertFalse(
                app.buttons["creation.saved-drafts"].exists,
                "Erased text must not leave an empty recovery item.")
            attach(app, named: "Erased New \(kind.noun) returns to a fresh form")
            cancel(in: app)
            app.terminate()
        }
    }

    func testActiveCreationShowsProgressUntilSuccessfulCompletion() {
        for kind in Kind.allCases {
            let app = launch(extra: ["--demo-creation-save-delay"])
            open(kind, in: app)
            let title = "Visible saving \(kind.noun)"
            enter(
                kind, title: title, body: "Keep progress visible while the request runs.", in: app)
            app.buttons["creation.primary"].tap()
            assertProgress("Creating \(kind.noun.lowercased())…", in: app)
            attach(app, named: "Creating \(kind.noun) shows active progress")
            XCTAssertTrue(
                app.textFields[kind.titleID].waitForNonExistence(timeout: 45),
                "The confirmed request should finish and close the editor.")
            XCTAssertTrue(app.staticTexts[title].firstMatch.waitForExistence(timeout: 5))
            app.terminate()
        }
    }

    func testCheckingUncertainSaveShowsProgressUntilItIsConfirmed() {
        for kind in Kind.allCases {
            let app = launch(extra: [
                "--demo-creation-save-delay", "--demo-creation-save-uncertain",
            ])
            open(kind, in: app)
            let title = "Check the saved \(kind.noun)"
            enter(
                kind, title: title, body: "Preserve this request across an uncertain response.",
                in: app)
            app.buttons["creation.primary"].tap()
            assertProgress("Creating \(kind.noun.lowercased())…", in: app)
            let unresolved = app.staticTexts[
                "The save hasn’t been confirmed yet. Check its result before making changes."]
            XCTAssertTrue(unresolved.waitForExistence(timeout: 45), app.debugDescription)
            XCTAssertEqual(app.buttons["creation.primary"].label, "Check Save")
            XCTAssertFalse(app.textFields[kind.titleID].isEnabled)
            attach(app, named: "Unconfirmed \(kind.noun) gives a clear Check Save action")
            app.buttons["creation.primary"].tap()
            assertProgress("Checking save…", in: app)
            attach(app, named: "Checking \(kind.noun) save shows active progress")
            XCTAssertTrue(app.textFields[kind.titleID].waitForNonExistence(timeout: 45))
            XCTAssertTrue(app.staticTexts[title].firstMatch.waitForExistence(timeout: 5))
            app.terminate()
        }
    }

    func testArchivedProjectKeepsSavedCardDraftAvailableForPreviewAndExport() {
        let app = launch(extra: ["--demo-archived-projects", "--demo-archived-creation-draft"])
        openArchivedProject(in: app)
        assertArchivedDraftRecovery(in: app)
        attach(app, named: "Archived Project keeps its saved Card accessible for export")
        relaunch(app, extra: ["--demo-archived-projects"])
        openArchivedProject(in: app)
        assertArchivedDraftRecovery(in: app)
        attach(app, named: "Archived Card draft remains available after relaunch")
    }

    func testCardRecoveryPreviewDisclosesEveryDetailTheCopyRetains() {
        let app = launch(extra: ["--demo-creation-recovery-metadata"])
        open(.card, in: app)
        openRecovery(in: app)
        selectDraft(named: "Card with saved details", in: app)
        XCTAssertTrue(app.staticTexts["Review every saved detail before copying."].exists)
        let expectedDetails = [
            ("column", "Doing"), ("next-actor", "Agent"), ("priority", "High"),
            ("next-action", "Review the saved plan"), ("blocker", "Waiting for approval"),
        ]
        for (detail, value) in expectedDetails {
            let row = app.descendants(matching: .any)
                .matching(identifier: "recovery.detail.\(detail)").firstMatch
            reveal(row, in: app)
            XCTAssertTrue(
                row.label.contains(value), "Preview must show retained \(detail): \(row.label)")
        }
        attach(app, named: "Saved Card preview discloses all copied details")
        let copy = app.buttons["recovery.copy"]
        reveal(copy, in: app)
        XCTAssertEqual(copy.label, "Copy to New Card")
        copy.tap()
        assertValue(app.textFields["card-title"], equals: "Card with saved details")
        assertValue(bodyField(.card, in: app), equals: "Review every saved detail before copying.")
        let more = app.buttons["More details"]
        reveal(more, in: app)
        more.tap()
        let actor = app.staticTexts["Agent"].firstMatch
        reveal(actor, in: app)
        XCTAssertTrue(actor.exists)
        let priority = app.staticTexts["High"].firstMatch
        reveal(priority, in: app)
        XCTAssertTrue(priority.exists)
        let nextAction = inputField("card-next-action", in: app)
        reveal(nextAction, in: app)
        assertValue(nextAction, equals: "Review the saved plan")
        let blocker = inputField("card-blocker", in: app)
        reveal(blocker, in: app)
        assertValue(blocker, equals: "Waiting for approval")
        attach(app, named: "Copied Card retains the details shown in its preview")
    }

    func testOpeningAnotherDraftClearsThePreviousDraftsServerError() {
        for kind in Kind.allCases {
            let app = launch(extra: [
                "--demo-legacy-creation-drafts", "--demo-creation-save-error",
            ])
            open(kind, in: app)
            let rejectedTitle = "Rejected \(kind.noun) draft"
            enter(kind, title: rejectedTitle, body: "Keep this rejected draft for later.", in: app)
            app.buttons["creation.primary"].tap()
            let previousError = app.staticTexts["Demo creation request was rejected."]
            XCTAssertTrue(previousError.waitForExistence(timeout: 10), app.debugDescription)
            openRecovery(in: app)
            selectDraft(named: kind.legacyTitle, in: app)
            closeRecovery(in: app)
            assertValue(app.textFields[kind.titleID], equals: rejectedTitle)
            XCTAssertTrue(
                previousError.exists, "Closing recovery must leave the current draft unchanged.")
            openRecovery(in: app)
            selectDraft(named: kind.legacyTitle, in: app)
            tapRecoveryActionKeepingCurrentDraft("recovery.copy", in: app)
            assertValue(app.textFields[kind.titleID], equals: kind.legacyTitle)
            XCTAssertFalse(
                previousError.exists, "The previous draft’s error must not appear on this draft.")
            XCTAssertTrue(app.buttons["creation.primary"].isEnabled)
            attach(app, named: "Opening a saved \(kind.noun) clears the previous request error")
            openRecovery(in: app)
            XCTAssertTrue(
                app.staticTexts[rejectedTitle].firstMatch.exists,
                "Switching after a rejected request must retain the previous draft.")
            closeRecovery(in: app)
            app.terminate()
        }
    }

    func testCreationFieldLabelsRemainVisibleAfterTyping() {
        for kind in Kind.allCases {
            let app = launch()
            open(kind, in: app)
            enter(
                kind, title: "Labeled \(kind.noun)",
                body: "A description with its own persistent label.", in: app, pacedTyping: true)
            let titleLabel = app.staticTexts["\(kind.titleID)-label"]
            let bodyLabel = app.staticTexts["\(kind.bodyID)-label"]
            XCTAssertTrue(titleLabel.exists, "A filled field still needs its visible label.")
            XCTAssertTrue(bodyLabel.exists, "Description must remain labeled after typing.")
            assertFieldFitsItsRow(kind.bodyID, in: app)
            attach(app, named: "Filled \(kind.noun) fields keep visible labels")
            if kind == .card {
                let more = app.buttons["More details"]
                reveal(more, in: app)
                more.tap()
                for (identifier, value) in [
                    ("card-next-action", "Review the result"),
                    ("card-blocker", "Waiting for confirmation"),
                ] {
                    let field = inputField(identifier, in: app)
                    reveal(field, in: app)
                    replace(field, with: value, pacedTyping: true)
                    let label = app.staticTexts["\(identifier)-label"]
                    XCTAssertTrue(label.exists, "\(identifier) must keep its label after typing.")
                    assertValue(field, equals: value)
                    assertFieldFitsItsRow(identifier, in: app)
                }
                attach(app, named: "Filled optional Card details keep visible labels")
            }
            app.terminate()
        }
    }

    func testArchivingWhileCreatingKeepsTheCurrentCardAvailableForRecovery() {
        let app = launch(extra: ["--demo-archive-project-on-save"])
        open(.card, in: app)
        enter(
            .card, title: "Card interrupted by archive", body: "Preserve this in-progress Card.",
            in: app)
        app.buttons["creation.primary"].tap()
        XCTAssertTrue(app.staticTexts["recovery.archived-notice"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["creation.primary"].exists)
        selectDraft(named: "Card interrupted by archive", in: app)
        XCTAssertTrue(
            app.staticTexts["Preserve this in-progress Card."].waitForExistence(timeout: 5))
        let export = app.buttons["recovery.export"]
        reveal(export, in: app)
        XCTAssertTrue(export.isEnabled)
        XCTAssertFalse(app.buttons["recovery.resume"].exists)
        XCTAssertFalse(app.buttons["recovery.copy"].exists)
        attach(app, named: "Archiving during creation preserves the current Card in recovery")
        closeRecovery(in: app)
        XCTAssertTrue(app.buttons["archive.saved-card-drafts"].waitForExistence(timeout: 5))
    }

    private func launch(extra: [String] = []) -> XCUIApplication {
        runningApp?.terminate()
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--reset-demo-drafts"] + extra
        runningApp = app
        app.launch()
        XCTAssertTrue(
            app.staticTexts["iPhone app"].firstMatch.waitForExistence(timeout: 15),
            app.debugDescription)
        return app
    }

    private func relaunch(_ app: XCUIApplication, extra: [String] = []) {
        app.terminate()
        app.launchArguments = ["--demo"] + extra
        app.launch()
        XCTAssertTrue(
            app.staticTexts["iPhone app"].firstMatch.waitForExistence(timeout: 15),
            app.debugDescription)
    }

    private func open(_ kind: Kind, in app: XCUIApplication, alreadyInProject: Bool = false) {
        if kind == .card && !alreadyInProject { app.staticTexts["iPhone app"].firstMatch.tap() }
        let action = app.buttons["New \(kind.noun)"]
        XCTAssertTrue(action.waitForExistence(timeout: 5), app.debugDescription)
        action.tap()
        XCTAssertTrue(
            app.textFields[kind.titleID].waitForExistence(timeout: 5), app.debugDescription)
    }

    private func assertFresh(_ kind: Kind, in app: XCUIApplication) {
        let title = app.textFields[kind.titleID]
        XCTAssertTrue(title.isEnabled, "New \(kind.noun) must always allow fresh work.")
        let value = title.value as? String ?? ""
        XCTAssertTrue(
            value.isEmpty || value == title.placeholderValue,
            "Fresh form unexpectedly contains: \(value)")
        XCTAssertFalse(app.buttons["creation.primary"].isEnabled)
        XCTAssertFalse(app.buttons["This is the original Workspace"].exists)
    }

    private func enter(
        _ kind: Kind, title: String, body: String, in app: XCUIApplication,
        pacedTyping: Bool = false
    ) {
        replace(app.textFields[kind.titleID], with: title, pacedTyping: pacedTyping)
        let description = bodyField(kind, in: app)
        XCTAssertTrue(description.waitForExistence(timeout: 5), app.debugDescription)
        replace(description, with: body, pacedTyping: pacedTyping)
        XCTAssertTrue(app.buttons["creation.primary"].isEnabled)
    }

    private func bodyField(_ kind: Kind, in app: XCUIApplication) -> XCUIElement {
        let textView = app.textViews[kind.bodyID]
        return textView.exists ? textView : app.textFields[kind.bodyID]
    }

    private func cancel(in app: XCUIApplication) {
        let cancel = app.buttons["creation.cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 5), app.debugDescription)
        cancel.tap()
    }

    private func assertCancelChoices(in app: XCUIApplication) {
        XCTAssertTrue(app.buttons["Keep Draft"].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(app.buttons["Discard Draft"].exists)
        XCTAssertTrue(app.buttons["Continue Editing"].exists)
    }

    private func openRecovery(in app: XCUIApplication) {
        let saved = app.buttons["creation.saved-drafts"]
        XCTAssertTrue(saved.waitForExistence(timeout: 5), app.debugDescription)
        saved.tap()
        XCTAssertTrue(
            app.navigationBars["Saved drafts"].waitForExistence(timeout: 5), app.debugDescription)
    }

    private func selectDraft(named title: String, in app: XCUIApplication) {
        let row = app.buttons.matching(
            NSPredicate(format: "label == %@ OR label BEGINSWITH %@", title, title + ",")
        ).firstMatch
        if row.waitForExistence(timeout: 5) {
            row.tap()
        } else {
            let text = app.staticTexts[title].firstMatch
            XCTAssertTrue(text.waitForExistence(timeout: 5), app.debugDescription)
            text.tap()
        }
    }

    private func closeRecovery(in app: XCUIApplication) {
        let close = app.buttons["recovery.close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), app.debugDescription)
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))
    }

    private func tapRecoveryAction(_ identifier: String, in app: XCUIApplication) {
        let action = app.buttons[identifier]
        reveal(action, in: app)
        action.tap()
        XCTAssertTrue(app.buttons["recovery.close"].waitForNonExistence(timeout: 5))
    }

    private func assertProgress(_ label: String, in app: XCUIApplication) {
        let progress = app.descendants(matching: .any)
            .matching(identifier: "creation.progress").firstMatch
        XCTAssertTrue(progress.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertTrue(
            progress.label.contains(label),
            "Expected active status \(label); found \(progress.label).")
        XCTAssertFalse(app.buttons["creation.primary"].isEnabled)
        XCTAssertFalse(app.buttons["creation.cancel"].isEnabled)
        XCTAssertFalse(
            app.staticTexts[
                "The save hasn’t been confirmed yet. Check its result before making changes."
            ].exists,
            "Unresolved-save messaging belongs after a request ends, not while it is active.")
    }

    private func openArchivedProject(in app: XCUIApplication) {
        let archivedProjects = app.buttons["project.archived"]
        XCTAssertTrue(archivedProjects.waitForExistence(timeout: 5), app.debugDescription)
        archivedProjects.tap()
        let project = app.buttons["archive.project.demo-archived-project"]
        XCTAssertTrue(project.waitForExistence(timeout: 5), app.debugDescription)
        project.tap()
        XCTAssertFalse(app.buttons["New Card"].exists)
    }

    private func assertArchivedDraftRecovery(in app: XCUIApplication) {
        let saved = app.buttons["archive.saved-card-drafts"]
        reveal(saved, in: app)
        saved.tap()
        XCTAssertTrue(app.staticTexts["recovery.archived-notice"].waitForExistence(timeout: 5))
        selectDraft(named: "Card saved before archiving", in: app)
        XCTAssertTrue(
            app.staticTexts[
                "Keep this draft available after the Project is archived."
            ].waitForExistence(timeout: 5))
        let export = app.buttons["recovery.export"]
        reveal(export, in: app)
        XCTAssertTrue(export.isEnabled)
        XCTAssertFalse(app.buttons["recovery.resume"].exists)
        XCTAssertFalse(app.buttons["recovery.copy"].exists)
        XCTAssertFalse(app.buttons["creation.primary"].exists)
        XCTAssertFalse(app.buttons["Remove Saved Draft"].exists)
    }

    private func tapRecoveryActionKeepingCurrentDraft(
        _ identifier: String, in app: XCUIApplication
    ) {
        let action = app.buttons[identifier]
        reveal(action, in: app)
        XCTAssertEqual(action.label, "Keep Current and Copy Draft")
        XCTAssertTrue(app.staticTexts["Your current draft will stay in Saved drafts."].exists)
        attach(app, named: "Opening a saved draft clearly preserves current work")
        action.tap()
        XCTAssertTrue(app.buttons["recovery.close"].waitForNonExistence(timeout: 5))
    }

    private func inputField(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        let textView = app.textViews[identifier]
        return textView.exists ? textView : app.textFields[identifier]
    }

    private func assertFieldFitsItsRow(_ identifier: String, in app: XCUIApplication) {
        let field = inputField(identifier, in: app)
        let row = app.cells.containing(.any, identifier: identifier).firstMatch
        XCTAssertTrue(row.exists, "The field should be contained by a native form row.")
        XCTAssertLessThanOrEqual(
            field.frame.maxY, row.frame.maxY + 1,
            "The multiline input must not extend below the row and clip its text.")
        XCTAssertGreaterThanOrEqual(field.frame.minY, row.frame.minY - 1)
    }

    private func reveal(_ element: XCUIElement, in app: XCUIApplication, towardTop: Bool = false) {
        for _ in 0..<10 {
            if element.exists && element.isHittable { return }
            if towardTop || (element.exists && element.frame.minY < 0) {
                app.swipeDown()
            } else {
                app.swipeUp()
            }
        }
        XCTAssertTrue(element.exists && element.isHittable, app.debugDescription)
    }

    private func replace(
        _ field: XCUIElement, with value: String, pacedTyping: Bool = false
    ) {
        field.tap()
        let existing = field.value as? String ?? ""
        if !existing.isEmpty && existing != field.placeholderValue {
            // Use the visible native edit menu. Simulator keyboard shortcuts
            // are not reliably delivered to iOS text fields.
            guard let app = runningApp else {
                XCTFail("Replacing text requires the running application.")
                return
            }
            field.press(forDuration: 1.2)
            let menuItem = app.menuItems["Select All"].firstMatch
            let button = app.buttons["Select All"].firstMatch
            let labeledElement = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label == %@", "Select All")).firstMatch
            let selectAll: XCUIElement
            if menuItem.waitForExistence(timeout: 2), menuItem.isHittable {
                selectAll = menuItem
            } else if button.waitForExistence(timeout: 2), button.isHittable {
                selectAll = button
            } else {
                selectAll = labeledElement
            }
            guard selectAll.waitForExistence(timeout: 2), selectAll.isHittable else {
                attach(app, named: "Select All menu missing for \(field.identifier)")
                XCTFail(
                    "The native edit menu did not offer a hittable Select All action for \(field.identifier)."
                )
                return
            }
            selectAll.tap()
            field.typeText(XCUIKeyboardKey.delete.rawValue)
            assertEditableValue(field, equals: "", phase: "Select All and Delete")
        }
        if pacedTyping {
            // Keep the label/layout test deterministic on loaded hosted simulators.
            // Every input still passes through the native keyboard; never repair a mismatch.
            for character in value { field.typeText(String(character)) }
        } else if !value.isEmpty {
            field.typeText(value)
        }
        assertEditableValue(field, equals: value, phase: "Replacement")
    }

    private func assertEditableValue(_ field: XCUIElement, equals expected: String, phase: String) {
        let matchesValue = NSPredicate { _, _ in
            let value = field.value as? String ?? ""
            return value == expected || (expected.isEmpty && value == field.placeholderValue)
        }
        let matches = XCTWaiter.wait(
            for: [XCTNSPredicateExpectation(predicate: matchesValue, object: nil)], timeout: 5
        ) == .completed
        let actual = field.value as? String ?? ""
        if !matches, let app = runningApp {
            attach(app, named: "\(phase) failed for \(field.identifier)")
        }
        XCTAssertTrue(
            matches,
            "\(phase) for \(field.identifier): expected \(String(reflecting: expected)); found \(String(reflecting: actual))."
        )
    }

    private func assertValue(_ field: XCUIElement, equals value: String) {
        let predicate = NSPredicate(format: "value == %@", value)
        expectation(for: predicate, evaluatedWith: field)
        waitForExpectations(timeout: 5)
    }

    private func attach(_ app: XCUIApplication, named name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name
        image.lifetime = .keepAlways
        add(image)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + " accessibility tree"
        tree.lifetime = .keepAlways
        add(tree)
    }
}
