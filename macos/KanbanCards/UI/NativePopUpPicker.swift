import AppKit
import SwiftUI

struct NativePopUpOption<Value: Hashable>: Equatable {
    let title: String
    let value: Value
}

struct NativeMenuAction {
    let title: String
    var systemImage: String? = nil
    var isEnabled = true
    var beginsGroup = false
    let perform: () -> Void
}

/// A standard AppKit pull-down button with the system's menu accessibility action.
struct NativePullDownMenu: NSViewRepresentable {
    let title: String
    let systemImage: String
    let label: String
    let identifier: String
    let actions: [NativeMenuAction]

    func makeNSView(context: Context) -> NSPopUpButton {
        let button = NSPopUpButton(title: title,
            image: NSImage(systemSymbolName: systemImage, accessibilityDescription: nil),
            pullDownMenu: NSMenu(title: title))
        button.autoenablesItems = false
        button.imagePosition = .imageOnly
        return button
    }

    func updateNSView(_ button: NSPopUpButton, context: Context) {
        context.coordinator.parent = self
        let menu = NSMenu(title: title)
        menu.autoenablesItems = false
        for (index, action) in actions.enumerated() {
            if action.beginsGroup && index > 0 { menu.addItem(.separator()) }
            let item = NSMenuItem(title: action.title,
                action: #selector(Coordinator.performAction(_:)), keyEquivalent: "")
            item.target = context.coordinator
            item.tag = index
            item.isEnabled = action.isEnabled
            item.setAccessibilityIdentifier("\(identifier).action.\(index)")
            if let systemImage = action.systemImage {
                item.image = NSImage(systemSymbolName: systemImage, accessibilityDescription: nil)
            }
            menu.addItem(item)
        }
        button.menu = menu
        button.title = title
        button.image = NSImage(systemSymbolName: systemImage, accessibilityDescription: nil)
        menu.item(at: 0)?.isHidden = false
        switch context.environment.controlSize {
        case .mini: button.controlSize = .mini
        case .small: button.controlSize = .small
        case .large: button.controlSize = .large
        default: button.controlSize = .regular
        }
        button.isEnabled = context.environment.isEnabled && actions.contains { $0.isEnabled }
        button.toolTip = label
        button.setAccessibilityLabel(label)
        button.setAccessibilityIdentifier(identifier)
        button.invalidateIntrinsicContentSize()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSPopUpButton, context: Context) -> CGSize? {
        nsView.intrinsicContentSize
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    @MainActor
    final class Coordinator: NSObject {
        var parent: NativePullDownMenu
        init(_ parent: NativePullDownMenu) { self.parent = parent }
        @objc func performAction(_ item: NSMenuItem) {
            guard parent.actions.indices.contains(item.tag), parent.actions[item.tag].isEnabled else { return }
            parent.actions[item.tag].perform()
        }
    }
}

/// A standard AppKit selection control, retaining its native accessibility actions.
struct NativePopUpPicker<Value: Hashable>: NSViewRepresentable {
    let label: String
    @Binding var selection: Value
    let options: [NativePopUpOption<Value>]
    let identifier: String

    func makeNSView(context: Context) -> NSPopUpButton {
        let button = NSPopUpButton(frame: .zero, pullsDown: false)
        button.menu = NSMenu()
        button.autoenablesItems = false
        button.target = context.coordinator
        button.action = #selector(Coordinator.selectionChanged(_:))
        return button
    }

    func updateNSView(_ button: NSPopUpButton, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.options != options {
            button.removeAllItems()
            for option in options {
                button.menu?.addItem(NSMenuItem(title: option.title, action: nil, keyEquivalent: ""))
            }
            context.coordinator.options = options
        }
        if let index = options.firstIndex(where: { $0.value == selection }) {
            button.selectItem(at: index)
        } else {
            button.select(nil)
        }
        switch context.environment.controlSize {
        case .mini: button.controlSize = .mini
        case .small: button.controlSize = .small
        case .large: button.controlSize = .large
        default: button.controlSize = .regular
        }
        button.isEnabled = context.environment.isEnabled && !options.isEmpty
        button.setAccessibilityLabel(label)
        button.setAccessibilityIdentifier(identifier)
        button.invalidateIntrinsicContentSize()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSPopUpButton, context: Context) -> CGSize? {
        let intrinsic = nsView.intrinsicContentSize
        let proposedWidth = proposal.width.flatMap { $0.isFinite ? max(0, $0) : nil } ?? intrinsic.width
        return CGSize(width: min(intrinsic.width, proposedWidth), height: intrinsic.height)
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    @MainActor
    final class Coordinator: NSObject {
        var parent: NativePopUpPicker
        var options: [NativePopUpOption<Value>] = []
        init(_ parent: NativePopUpPicker) { self.parent = parent }
        @objc func selectionChanged(_ button: NSPopUpButton) {
            guard options.indices.contains(button.indexOfSelectedItem) else { return }
            parent.selection = options[button.indexOfSelectedItem].value
        }
    }
}
