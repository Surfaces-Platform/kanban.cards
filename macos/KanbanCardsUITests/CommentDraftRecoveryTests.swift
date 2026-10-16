import AppKit
import CryptoKit
import Foundation
import XCTest

/// Fault injection is restricted to demo-owner drafts inside the dedicated pilot VM.
/// Card and Comment contents are created through the native interface.
@MainActor
final class CommentDraftRecoveryTests: XCTestCase {
    private let homepage = "demo-card-homepage"
    private let licenses = "demo-card-licenses"
    private var runningApp: XCUIApplication?

    override func setUp() async throws { continueAfterFailure = false }
    override func tearDown() async throws { runningApp?.terminate(); runningApp = nil }

    func testCommentWriteFailureKeepsRecoveryUsableWhileCardAndNavigationAreLocked() throws {
        let fileManager = FileManager.default
        let pilotSource = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("kanban-ui-pilot/source", isDirectory: true)
        try XCTSkipUnless(fileManager.fileExists(atPath: pilotSource.path),
                          "This filesystem fault injection runs only in the dedicated pilot VM.")

        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--reset-demo-drafts", "--reset-demo-window-layout",
                               "-ApplePersistenceIgnoreState", "YES"]
        app.launch()
        runningApp = app
        app.typeKey("0", modifierFlags: .command)
        let board = app.windows.containing(.button, identifier: "session.sign-out").firstMatch
        XCTAssertTrue(board.waitForExistence(timeout: 10))
        board.buttons["board.card.\(homepage)"].click()
        let card = board.descendants(matching: .any).matching(identifier: "card.viewer.\(homepage)").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        let title = card.textFields["editor.title"]
        let cardDraft = "Keep this Card draft while recovering its Comment"
        replace(title, with: cardDraft)
        let save = card.buttons["editor.save"]
        XCTAssertTrue(save.isEnabled, "The Card must have a savable draft before Comment recovery locks it.")

        app.typeKey("m", modifierFlags: [.command, .shift])
        let composer = card.descendants(matching: .any)
            .matching(identifier: "card.comment-composer.\(homepage)").firstMatch
        let comment = composer.textViews["comment.body"]
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        XCTAssertTrue(comment.isHittable)
        XCTAssertEqual(app.sheets.count, 0)

        // Block only the synthetic owner's directory. Keep its existing draft files
        // intact in a sibling directory, and restore them even when an assertion fails.
        let fault = try DemoOwnerDraftWriteFault(fileManager: fileManager)
        defer {
            do { try fault.restore() }
            catch { XCTFail("Could not restore the demo draft directory: \(error)") }
        }
        let text = "This complete inline Comment survives a failed local write, then posts once."
        replace(comment, with: text)
        let retry = composer.buttons["Retry Saving Local Draft"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        XCTAssertTrue(comment.isEnabled, "Recovery must leave the Comment text available.")
        XCTAssertTrue(composer.buttons["Copy Draft"].isEnabled)
        XCTAssertTrue(composer.buttons["Export Draft…"].isEnabled)
        XCTAssertTrue(retry.isEnabled)
        waitUntil { !title.isEnabled && !save.isEnabled }
        XCTAssertFalse(card.buttons["editor.revert"].isEnabled)
        XCTAssertFalse(board.buttons["board.card.\(licenses)"].isEnabled,
                       "Card navigation must wait until its Comment is retained locally.")
        XCTAssertFalse(board.buttons["board.return-to-board"].isEnabled)

        reveal(composer.buttons["Copy Draft"], in: card)
        composer.buttons["Copy Draft"].click()
        XCTAssertTrue(composer.buttons["Copied"].waitForExistence(timeout: 5))
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), text,
                       "Copy must recover the entire Comment, including text typed after the failed write.")
        composer.buttons["Export Draft…"].click()
        let export = app.sheets.firstMatch
        XCTAssertTrue(export.waitForExistence(timeout: 5), "Export must open the native save panel during recovery.")
        let cancelExport = export.buttons["Cancel"].firstMatch
        XCTAssertTrue(cancelExport.waitForExistence(timeout: 5))
        cancelExport.click()
        XCTAssertTrue(export.waitForNonExistence(timeout: 5))
        XCTAssertFalse(title.isEnabled)
        XCTAssertFalse(save.isEnabled)

        try fault.restore()
        reveal(retry, in: card)
        retry.click()
        XCTAssertTrue(retry.waitForNonExistence(timeout: 5))
        assertValue(text, of: comment)
        waitUntil { title.isEnabled && save.isEnabled }
        XCTAssertTrue(card.buttons["editor.revert"].isEnabled)
        XCTAssertTrue(board.buttons["board.card.\(licenses)"].isEnabled)
        assertValue(cardDraft, of: title)
        comment.click()
        app.typeKey(XCUIKeyboardKey.return.rawValue, modifierFlags: .command)
        XCTAssertTrue(comment.waitForNonExistence(timeout: 5))
        assertText(text, in: card)
        assertText("Comments (3)", in: card)
        XCTAssertFalse(card.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@ OR value == %@", "Comments (4)", "Comments (4)")).firstMatch.exists,
                       "Recovery and one submission must add exactly one Comment to the two demo Comments.")
        assertValue(cardDraft, of: title)
        XCTAssertEqual(app.sheets.count, 0)
        XCTAssertEqual(app.windows.count, 1)
        let attachment = XCTAttachment(screenshot: board.screenshot())
        attachment.name = "Comment recovery keeps Copy, Export and Retry usable without losing the Card draft"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func reveal(_ element: XCUIElement, in card: XCUIElement) {
        let scroll = card.scrollViews["card.contents-scroll.\(homepage)"]
        for _ in 0..<8 where !element.isHittable {
            let deltaY: CGFloat = element.frame.midY < scroll.frame.midY ? 180 : -180
            scroll.scroll(byDeltaX: 0, deltaY: deltaY)
        }
        XCTAssertTrue(element.isHittable)
    }

    private func replace(_ field: XCUIElement, with text: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.click()
        field.typeKey("a", modifierFlags: .command)
        field.typeKey(XCUIKeyboardKey.delete.rawValue, modifierFlags: [])
        if !text.isEmpty { field.typeText(text) }
        assertValue(text, of: field)
    }

    private func assertValue(_ expected: String, of field: XCUIElement) {
        waitUntil { field.exists && field.value as? String == expected }
    }

    private func assertText(_ text: String, in element: XCUIElement) {
        XCTAssertTrue(element.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@ OR value == %@", text, text)).firstMatch.waitForExistence(timeout: 5))
    }

    private func waitUntil(_ condition: @escaping () -> Bool) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 5), .completed)
    }
}

/// A regular file at the owner's directory path makes DraftStore's atomic writes
/// fail without changing permissions or touching another owner's recovery data.
private final class DemoOwnerDraftWriteFault {
    private let fileManager: FileManager
    private let directory: URL
    private let backup: URL
    private let marker = Data("Native UI test demo-owner draft write blocker".utf8)
    private var installed = false

    init(fileManager: FileManager) throws {
        self.fileManager = fileManager
        let digest = SHA256.hash(data: Data("demo-owner".utf8)).map { String(format: "%02x", $0) }.joined()
        let root = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("cards.kanban.macOS/Drafts", isDirectory: true)
        directory = root.appendingPathComponent(digest, isDirectory: true)
        backup = root.appendingPathComponent(".comment-recovery-\(UUID().uuidString)", isDirectory: true)
        let attributes = try fileManager.attributesOfItem(atPath: directory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory else {
            throw NSError(domain: "CommentDraftRecoveryTests", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Expected the native UI-created demo draft directory."])
        }
        try fileManager.moveItem(at: directory, to: backup)
        do {
            try marker.write(to: directory, options: .atomic)
            installed = true
        } catch {
            try fileManager.moveItem(at: backup, to: directory)
            throw error
        }
    }

    func restore() throws {
        guard installed else { return }
        guard try Data(contentsOf: directory) == marker else {
            throw NSError(domain: "CommentDraftRecoveryTests", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "The draft blocker changed; refusing to remove unexpected content."])
        }
        try fileManager.removeItem(at: directory)
        try fileManager.moveItem(at: backup, to: directory)
        installed = false
    }
}
