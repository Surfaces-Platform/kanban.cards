import SwiftUI

/// Standard native menu actions target the Card under the pointer, independently
/// of the Card currently selected in the board.
struct CardContextMenu: View {
    let archived: Bool
    let canOpen: Bool
    let canEdit: Bool
    let canArchive: Bool
    let open: () -> Void
    let move: () -> Void
    let activity: () -> Void
    let archive: () -> Void

    var body: some View {
        Button("Open in New Window", systemImage: "macwindow") { open() }.disabled(!canOpen)
        Divider()
        Button("Move…", systemImage: "arrow.right") { move() }.disabled(!canEdit)
        Button("Activity…", systemImage: "clock") { activity() }.disabled(!canOpen)
        Divider()
        Button(archived ? "Restore Card…" : "Archive Card…", role: archived ? nil : .destructive) { archive() }
            .disabled(!canArchive)
    }
}
