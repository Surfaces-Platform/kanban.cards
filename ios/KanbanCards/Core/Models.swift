import Foundation

struct Workspace: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var slug: String
    var name: String
    var url: URL
}

enum CardNextActor: String, Codable, CaseIterable, Identifiable, Sendable {
    case human, agent
    var id: String { rawValue }
    var label: String { self == .human ? "You" : "Agent" }
}

enum CardPriority: String, Codable, CaseIterable, Identifiable, Sendable {
    case high = "High", medium = "Medium", low = "Low"
    var id: String { rawValue }
}

struct Column: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var position: Double
}

struct Comment: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var body: String
    var author: String
    var createdAt: String
}

struct Card: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var externalKey: String?
    var title: String
    var body: String
    var nextActor: CardNextActor?
    var nextAction: String
    var priority: CardPriority?
    var blockedReason: String
    var columnId: String
    var position: Double
    var version: Int
    var archivedAt: String?
    var createdAt: String
    var updatedAt: String
    var comments: [Comment]
}

struct ActivityActor: Codable, Hashable, Sendable {
    // Preserve future server channel values instead of refusing an otherwise readable board.
    var channel: String
    var label: String
    var agentConnectionId: String?
}

struct Activity: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var action: String
    var actor: ActivityActor
    var summary: String
    var projectId: String
    var cardId: String?
    var createdAt: String
}

struct ProjectSummary: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var description: String
    var revision: Int
    var archivedAt: String?
    var createdAt: String
    var updatedAt: String
    var cardCount: Int
}

struct Project: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var description: String
    var columns: [Column]
    var cards: [Card]
    var activity: [Activity]
    var revision: Int
    var archivedAt: String?
    var createdAt: String
    var updatedAt: String
}

struct CardDraft: Codable, Equatable, Sendable {
    var id: String?
    var version: Int?
    var title: String
    var body: String
    var nextActor: CardNextActor?
    var nextAction: String
    var priority: CardPriority?
    var blockedReason: String
    var columnId: String
    var position: Double
    var archivedAt: String?
    var externalKey: String?

    init(columnId: String) {
        id = nil
        version = nil
        title = ""
        body = ""
        nextActor = nil
        nextAction = ""
        priority = nil
        blockedReason = ""
        self.columnId = columnId
        position = 0
        archivedAt = nil
        externalKey = nil
    }

    init(card: Card) {
        id = card.id
        version = card.version
        title = card.title
        body = card.body
        nextActor = card.nextActor
        nextAction = card.nextAction
        priority = card.priority
        blockedReason = card.blockedReason
        columnId = card.columnId
        position = card.position
        archivedAt = card.archivedAt
        externalKey = card.externalKey
    }
}

struct ProjectDraft: Codable, Equatable, Sendable {
    var id: String?
    var revision: Int?
    var name: String
    var description: String
    var columns: [Column]?
    var archivedAt: String?

    init(name: String = "", description: String = "") {
        id = nil
        revision = nil
        self.name = name
        self.description = description
        columns = nil
        archivedAt = nil
    }

    init(project: Project) {
        id = project.id
        revision = project.revision
        name = project.name
        description = project.description
        columns = project.columns
        archivedAt = project.archivedAt
    }
}

struct CommentResult: Decodable, Sendable {
    struct CardReference: Decodable, Sendable {
        var id: String
        var version: Int
    }
    var comment: Comment
    var card: CardReference
    var projectRevision: Int
}

struct NativeOwner: Codable, Hashable, Sendable {
    var id: String
    var displayName: String
    var email: String
}

struct NativeSessionInfo: Codable, Sendable {
    var authenticated: Bool
    var context: String
    var authMode: String?
    var authenticationMethod: String?
    var label: String?
    var email: String?
    var expiresAt: String?
    var rootUrl: URL
    var workspace: Workspace?
    var owner: NativeOwner?
}

struct NativeSignInChallenge: Decodable, Sendable {
    var challengeId: String
    var ceremonyToken: String
    var relyingPartyIdentifier: String
    var challenge: String
    var expiresAt: String
}

struct NativePasskeyAssertion: Encodable, Sendable {
    struct Response: Encodable, Sendable {
        var authenticatorData: String
        var clientDataJSON: String
        var signature: String
        var userHandle: String
    }
    var id: String
    var rawId: String
    let type = "public-key"
    var response: Response
    let clientExtensionResults: [String: String] = [:]
}

enum ServerTimestamp {
    static func string(from date: Date = .now) -> String {
        date.ISO8601Format(.iso8601.year().month().day().dateSeparator(.dash)
            .time(includingFractionalSeconds: true).timeZone(separator: .omitted))
    }

    static func date(from string: String) -> Date? {
        try? Date(string, strategy: .iso8601.year().month().day().dateSeparator(.dash)
            .time(includingFractionalSeconds: true).timeZone(separator: .omitted))
    }
}

// Shared SI-005/SI-007/SI-008/SI-009 domain reconciliation. Platform UI stays separate.
enum CardDraftField: String, Codable, CaseIterable, Hashable, Sendable {
    case title, body, nextActor, nextAction, priority, blockedReason, placement

    var label: String {
        switch self {
        case .title: "Title"
        case .body: "Description"
        case .nextActor: "Next actor"
        case .nextAction: "Next action"
        case .priority: "Priority"
        case .blockedReason: "Blocker"
        case .placement: "Column"
        }
    }
}

struct CardDraftReconciliation: Sendable {
    var draft: CardDraft
    var conflicts: Set<CardDraftField>
    var localChanged: Set<CardDraftField>
    var serverChanged: Set<CardDraftField>
}

extension CardDraft {
    func matches(_ other: CardDraft, field: CardDraftField) -> Bool {
        switch field {
        case .title: title == other.title
        case .body: body == other.body
        case .nextActor: nextActor == other.nextActor
        case .nextAction: nextAction == other.nextAction
        case .priority: priority == other.priority
        case .blockedReason: blockedReason == other.blockedReason
        case .placement: columnId == other.columnId && position == other.position
        }
    }

    mutating func adopt(_ other: CardDraft, field: CardDraftField) {
        switch field {
        case .title: title = other.title
        case .body: body = other.body
        case .nextActor: nextActor = other.nextActor
        case .nextAction: nextAction = other.nextAction
        case .priority: priority = other.priority
        case .blockedReason: blockedReason = other.blockedReason
        case .placement: columnId = other.columnId; position = other.position
        }
    }

    func value(for field: CardDraftField) -> String {
        switch field {
        case .title: title
        case .body: body
        case .nextActor: nextActor?.label ?? "Unassigned"
        case .nextAction: nextAction
        case .priority: priority?.rawValue ?? "Unset"
        case .blockedReason: blockedReason
        case .placement: columnId
        }
    }

    func reconcile(base: Card, latest: Card) -> CardDraftReconciliation {
        let original = CardDraft(card: base)
        let saved = CardDraft(card: latest)
        var merged = self
        var conflicts = Set<CardDraftField>()
        var localChanged = Set<CardDraftField>()
        var serverChanged = Set<CardDraftField>()
        for field in CardDraftField.allCases {
            let local = !matches(original, field: field)
            let remote = !saved.matches(original, field: field)
            if local { localChanged.insert(field) }
            if remote { serverChanged.insert(field) }
            if field == .placement {
                // Older drafts may contain an unsaved destination. Text Save cannot enact it.
                if local && !matches(saved, field: field) { conflicts.insert(field) }
                else { merged.adopt(saved, field: field) }
            } else if !local {
                merged.adopt(saved, field: field)
            } else if remote && !matches(saved, field: field) {
                conflicts.insert(field)
            }
        }
        merged.id = latest.id
        merged.version = latest.version
        merged.archivedAt = latest.archivedAt
        merged.externalKey = latest.externalKey
        return CardDraftReconciliation(draft: merged, conflicts: conflicts,
            localChanged: localChanged, serverChanged: serverChanged)
    }

    var editableFields: [CardDraftField] {
        [.title, .body, .nextActor, .nextAction, .priority, .blockedReason]
    }

    func matchesEditableFields(of other: CardDraft) -> Bool {
        editableFields.allSatisfy { matches(other, field: $0) }
    }
}
