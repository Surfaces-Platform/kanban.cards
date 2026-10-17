import Foundation
import SwiftUI

enum BoardWindowID: String, Codable, Hashable, Sendable { case main }

/// A local presentation preference; every mode reads and edits the same Cards.
enum CardInteractionMode: String, CaseIterable, Identifiable {
    case windows, inspector, columnList
    static var current: Self {
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("--demo"), let index = arguments.firstIndex(of: "--card-view"),
           arguments.indices.contains(index + 1), let mode = Self(rawValue: arguments[index + 1]) {
            return mode
        }
        #endif
        return .columnList
    }

    var id: String { rawValue }
    var label: String {
        switch self {
        case .windows: "A: Card windows"
        case .inspector: "B: Right inspector"
        case .columnList: "C: Column list + detail"
        }
    }
}


/// Codable values let SwiftUI restore viewers and reuse an existing window for a Card.
/// Owner and Workspace are part of the identity because server resource IDs are scoped.
struct CardWindowID: Codable, Hashable, Sendable {
    var ownerID: String
    var workspaceID: String
    var projectID: String
    var cardID: String
}

struct CardFilter: Equatable {
    var actor = "all"
    var priority = "all"
    var blocked = "all"
    var search = ""
    var includesArchived = false
    var refinementCount: Int {
        (actor == "all" ? 0 : 1) + (priority == "all" ? 0 : 1)
        + (blocked == "all" ? 0 : 1) + (includesArchived ? 1 : 0)
    }
    var active: Bool { refinementCount > 0 || !search.isEmpty }

    mutating func clearRefinements() {
        actor = "all"
        priority = "all"
        blocked = "all"
        includesArchived = false
    }

    func includes(_ card: Card) -> Bool {
        (includesArchived || card.archivedAt == nil)
        && (actor == "all" || (card.nextActor?.rawValue ?? "unassigned") == actor)
        && (priority == "all" || (card.priority?.rawValue ?? "unset") == priority)
        && (blocked == "all" || (card.blockedReason.isEmpty ? "false" : "true") == blocked)
        && (search.isEmpty || card.title.localizedStandardContains(search)
            || card.body.localizedStandardContains(search) || card.nextAction.localizedStandardContains(search))
    }
}

struct CardWindowActions {
    var canEdit: Bool
    var canRefresh: Bool
    var canShowActivity: Bool
    var canArchive: Bool
    var archived: Bool
    var comment: () -> Void
    var move: () -> Void
    var activity: () -> Void
    var archive: () -> Void
    var refresh: () -> Void
}

struct BoardWindowActions {
    var canCreateWorkspace: Bool
    var canCreateProject: Bool
    var canRefresh: Bool
    var createWorkspace: () -> Void
    var createProject: () -> Void
    var refresh: () -> Void
}

struct ProjectWindowActions {
    var hasSheet: Bool
    var canEdit: Bool
    var canCreateCard: Bool
    var canShowActivity: Bool
    var canArchive: Bool
    var archived: Bool
    var edit: () -> Void
    var createCard: () -> Void
    var activity: () -> Void
    var archive: () -> Void
}

struct CardWindowActionsKey: FocusedValueKey { typealias Value = CardWindowActions }
struct BoardWindowActionsKey: FocusedValueKey { typealias Value = BoardWindowActions }
struct ProjectWindowActionsKey: FocusedValueKey { typealias Value = ProjectWindowActions }

extension FocusedValues {
    var cardWindowActions: CardWindowActions? {
        get { self[CardWindowActionsKey.self] }
        set { self[CardWindowActionsKey.self] = newValue }
    }
    var boardWindowActions: BoardWindowActions? {
        get { self[BoardWindowActionsKey.self] }
        set { self[BoardWindowActionsKey.self] = newValue }
    }
    var projectWindowActions: ProjectWindowActions? {
        get { self[ProjectWindowActionsKey.self] }
        set { self[ProjectWindowActionsKey.self] = newValue }
    }
}
