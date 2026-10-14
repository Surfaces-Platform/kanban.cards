import AppKit
import CryptoKit
import SwiftUI

/// Nonvisual integration labels the native hosting container and keeps windows
/// visible after display changes. Window frames use standard AppKit geometry and owner-scoped UserDefaults.
struct NativeCardWindowGeometry: NSViewRepresentable {
    let identity: CardWindowID
    let resetDemoLayout: Bool
    func makeNSView(context: Context) -> CardWindowGeometryView { CardWindowGeometryView(identity: identity, resetDemoLayout: resetDemoLayout) }
    func updateNSView(_ view: CardWindowGeometryView, context: Context) { }
}

@MainActor
final class CardWindowGeometryView: NSView {
    private static var nextPlacement = 0
    private let identity: CardWindowID
    private let resetDemoLayout: Bool
    private var frameObservers: [NSObjectProtocol] = []
    private weak var configuredWindow: NSWindow?
    private var readyObserver: NSObjectProtocol?
    private var screenObserver: NSObjectProtocol?

    init(identity: CardWindowID, resetDemoLayout: Bool) {
        self.identity = identity; self.resetDemoLayout = resetDemoLayout
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { nil }
    isolated deinit {
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        if let readyObserver { NotificationCenter.default.removeObserver(readyObserver) }
        for observer in frameObservers { NotificationCenter.default.removeObserver(observer) }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window, configuredWindow !== window else { return }
        if let readyObserver { NotificationCenter.default.removeObserver(readyObserver) }
        readyObserver = NotificationCenter.default.addObserver(forName: NSWindow.didUpdateNotification, object: window, queue: .main) { [weak self, weak window] _ in
            MainActor.assumeIsolated {
                guard let self, let window, window.isVisible else { return }
                self.schedule(window)
            }
        }
        schedule(window)
    }

    private func schedule(_ window: NSWindow) {
        DispatchQueue.main.async { [weak self, weak window] in
            guard let self, let window, self.window === window, window.isVisible, self.configuredWindow !== window else { return }
            self.configure(window)
        }
    }

    private func configure(_ window: NSWindow) {
        configuredWindow = window
        if let readyObserver { NotificationCenter.default.removeObserver(readyObserver); self.readyObserver = nil }
        window.contentView?.setAccessibilityLabel("Card details")
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        let digest = SHA256.hash(data: (try? encoder.encode(identity)) ?? Data()).map { String(format: "%02x", $0) }.joined()
        let key = "macOS.CardWindowFrame." + digest
        #if DEBUG
        if resetDemoLayout && identity.ownerID == "demo-owner" { UserDefaults.standard.removeObject(forKey: key) }
        #endif
        let restoredFrame = UserDefaults.standard.string(forKey: key).flatMap { saved -> NSRect? in
            let frame = NSRectFromString(saved)
            guard [frame.origin.x, frame.origin.y, frame.width, frame.height, frame.maxX, frame.maxY].allSatisfy({ $0.isFinite }),
                  frame.width >= 460, frame.height >= 480 else { return nil }
            return clampedFrame(frame)
        }
        if let restoredFrame {
            // Restore only validated geometry, already constrained to a visible display.
            window.setFrame(restoredFrame, display: true)
        } else if let initialFrame = initialFrame(for: window) {
            window.setFrame(initialFrame, display: true)
        }
        keepWindowVisible()
        UserDefaults.standard.set(NSStringFromRect(window.frame), forKey: key)
        for notification in [NSWindow.didMoveNotification, NSWindow.didResizeNotification] {
            frameObservers.append(NotificationCenter.default.addObserver(forName: notification, object: window, queue: .main) { [weak window] _ in
                MainActor.assumeIsolated {
                    guard let window, window.isVisible, !window.styleMask.contains(.fullScreen) else { return }
                    UserDefaults.standard.set(NSStringFromRect(window.frame), forKey: key)
                }
            })
        }
        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.keepWindowVisible() }
        }
    }

    private func initialFrame(for window: NSWindow) -> NSRect? {
        // The app has one main board. Its existing nonvisual bridge labels this
        // native content view, so placement does not depend on restoration IDs.
        let board = NSApplication.shared.orderedWindows.first { candidate in
            candidate !== window && candidate.isVisible && !candidate.isMiniaturized
                && candidate.sheetParent == nil && !candidate.styleMask.contains(.fullScreen)
                && candidate.contentView?.accessibilityLabel() == "Project board"
        }
        guard let screen = board?.screen ?? window.screen ?? NSScreen.main else { return nil }
        let visible = screen.visibleFrame
        let index = Self.nextPlacement
        Self.nextPlacement += 1
        let gap: CGFloat = 42
        let margin: CGFloat = 16
        let pairWidth = min(590, max(460, (visible.width - gap - 2 * margin) / 2))
        let fitsPair = visible.width >= 2 * pairWidth + gap + 2 * margin
        let width = fitsPair ? pairWidth : min(590, max(460, visible.width - 2 * margin))
        let groupWidth = fitsPair ? 2 * width + gap : width
        let preferredLeft = board.map { $0.frame.minX + 32 }
            ?? (fitsPair ? visible.midX - groupWidth / 2 : visible.minX + margin)
        let left = min(max(preferredLeft, visible.minX + margin),
                       max(visible.minX + margin, visible.maxX - groupWidth - margin))
        let cascade = CGFloat((fitsPair ? index / 2 : index) % 4) * 24
        let centeredHeight = min(700, max(480, visible.height - 2 * margin))
        let top = (board.map { $0.frame.maxY - 200 } ?? (visible.midY + centeredHeight / 2)) - cascade
        // Keep the board title and filters above new viewers. On shorter displays
        // the native scrolling Card contents fit in a shorter independent window.
        let height = min(700, max(480, top - visible.minY - margin))
        let x = left + (fitsPair ? CGFloat(index % 2) * (width + gap) : cascade)
        return clampedFrame(CGRect(x: x, y: top - height, width: width, height: height))
    }

    private func keepWindowVisible() {
        guard let window = configuredWindow, !window.styleMask.contains(.fullScreen),
              let adjusted = clampedFrame(window.frame) else { return }
        if window.frame != adjusted { window.setFrame(adjusted, display: true) }
    }

    private func clampedFrame(_ frame: NSRect) -> NSRect? {
        guard [frame.origin.x, frame.origin.y, frame.width, frame.height, frame.maxX, frame.maxY].allSatisfy({ $0.isFinite }),
              frame.width > 0, frame.height > 0,
              let fallback = NSScreen.main ?? NSScreen.screens.first else { return nil }
        let screen = NSScreen.screens.max { left, right in
            let a = left.visibleFrame.intersection(frame)
            let b = right.visibleFrame.intersection(frame)
            return (a.isNull ? 0 : a.width * a.height) < (b.isNull ? 0 : b.width * b.height)
        } ?? fallback
        let visible = screen.visibleFrame
        let width = min(frame.width, visible.width)
        let height = min(frame.height, visible.height)
        return CGRect(x: min(max(frame.minX, visible.minX), visible.maxX - width),
            y: min(max(frame.minY, visible.minY), visible.maxY - height), width: width, height: height)
    }
}

struct NativeWindowAccessibility: NSViewRepresentable {
    let label: String
    func makeNSView(context: Context) -> WindowAccessibilityView { WindowAccessibilityView(label: label) }
    func updateNSView(_ view: WindowAccessibilityView, context: Context) {
        view.contextLabel = label
        view.window?.contentView?.setAccessibilityLabel(label)
    }
}

final class WindowAccessibilityView: NSView {
    var contextLabel: String
    init(label: String) { contextLabel = label; super.init(frame: .zero) }
    required init?(coder: NSCoder) { nil }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.contentView?.setAccessibilityLabel(contextLabel)
    }
}
