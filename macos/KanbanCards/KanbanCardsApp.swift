import AppKit
import SwiftUI

@main
struct KanbanCardsApp: App {
    @State private var model = AppModel()
    @NSApplicationDelegateAdaptor(DraftRecoveryApplicationDelegate.self) private var recoveryDelegate

    init() {
        // Cards are independent document-like windows, never automatically combined into tabs.
        NSWindow.allowsAutomaticWindowTabbing = false
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--appearance-light") { NSApplication.shared.appearance = NSAppearance(named: .aqua) }
        if ProcessInfo.processInfo.arguments.contains("--appearance-dark") { NSApplication.shared.appearance = NSAppearance(named: .darkAqua) }
        #endif
    }

    var body: some Scene {
        WindowGroup("kanban.cards", id: "board", for: BoardWindowID.self) { _ in
            BoardView()
                .environment(model)
                .onAppear { recoveryDelegate.model = model }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Project board")
        } defaultValue: { .main }
        .defaultSize(width: 1320, height: 820)
        .windowResizability(.contentMinSize)
        .commands { KanbanCommands(model: model) }

        WindowGroup("Card", id: "card", for: CardWindowID.self) { $identity in
            if let identity {
                CardWindowView(identity: identity)
                    .environment(model)
                    .onAppear { recoveryDelegate.model = model }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Card details")
            } else {
                ContentUnavailableView("Open a Card from the board", systemImage: "rectangle")
                    .frame(minWidth: 460, minHeight: 480)
            }
        }
        .defaultSize(width: 590, height: 700)
        .windowResizability(.contentMinSize)
        .commandsRemoved()


    }
}

struct KanbanCommands: Commands {
    let model: AppModel
    @Environment(\.openWindow) private var openWindow
    @FocusedValue(\.cardWindowActions) private var cardActions
    @FocusedValue(\.cardDraftActions) private var draftActions
    @FocusedValue(\.boardWindowActions) private var boardActions
    @FocusedValue(\.projectWindowActions) private var projectActions

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Card…") { projectActions?.createCard() }
                .keyboardShortcut("n")
                .disabled(projectActions?.canCreateCard != true)
            Button("New Project…") { boardActions?.createProject() }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .disabled(boardActions?.canCreateProject != true || projectActions?.hasSheet == true)
            Divider()
            Button("Show Board") { openWindow(id: "board", value: BoardWindowID.main) }
                .keyboardShortcut("0")
        }
        CommandGroup(replacing: .saveItem) {
            Button("Save") { draftActions?.save() }
                .keyboardShortcut("s")
                .disabled(draftActions?.canSave != true)
            Button("Revert to Saved…") { draftActions?.revert() }
                .disabled(draftActions?.canRevert != true)
        }
        CommandMenu("Project") {
            Button("Edit Project…") { projectActions?.edit() }.disabled(projectActions?.canEdit != true)
            Button("Activity…") { projectActions?.activity() }.disabled(projectActions?.canShowActivity != true)
            Button(projectActions?.archived == true ? "Restore Project…" : "Archive Project…") { projectActions?.archive() }
                .disabled(projectActions?.canArchive != true)
        }
        CommandMenu("Card") {
            Button("Add Comment") { cardActions?.comment() }
                .keyboardShortcut("m", modifiers: [.command, .shift])
                .disabled(cardActions?.canEdit != true)
            Button("Move Card…") { cardActions?.move() }.disabled(cardActions?.canEdit != true)
            Button("Activity…") { cardActions?.activity() }.disabled(cardActions?.canShowActivity != true)
            Button(cardActions?.archived == true ? "Restore Card…" : "Archive Card…") { cardActions?.archive() }
                .disabled(cardActions?.canArchive != true)
        }
        CommandGroup(after: .toolbar) {
            Button("Refresh") {
                if let cardActions { cardActions.refresh() } else { boardActions?.refresh() }
            }.keyboardShortcut("r")
                .disabled(cardActions.map { !$0.canRefresh } ?? (boardActions?.canRefresh != true || projectActions?.hasSheet == true))
        }
        CommandGroup(after: .appSettings) {
            Button("Sign Out") { Task { await model.signOut() } }
                .disabled(!model.signedIn || model.endingSession)
        }
    }
}

@MainActor
final class DraftRecoveryApplicationDelegate: NSObject, NSApplicationDelegate {
    weak var model: AppModel?

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model else { return .terminateNow }
        try? model.drafts.retryRecoveryWrites()
        guard model.drafts.hasUnpersistedRecovery else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = "Some drafts could not be saved on this Mac"
        alert.informativeText = "Keep the app open to recover your drafts. If you signed out, sign in to the same account again, then copy or export the draft. Quitting now loses text that could not be stored."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Keep App Open")
        alert.addButton(withTitle: "Quit and Lose Unsaved Drafts")
        return alert.runModal() == .alertSecondButtonReturn ? .terminateNow : .terminateCancel
    }
}
