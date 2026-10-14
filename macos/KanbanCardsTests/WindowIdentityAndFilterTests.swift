import Foundation
import XCTest
@testable import KanbanCards

final class WindowIdentityAndFilterTests: XCTestCase {
    func testWindowIdentityReusesSameCardAndSeparatesEveryResourceScope() throws {
        let identity = CardWindowID(ownerID: "owner-a", workspaceID: "workspace-a",
            projectID: "project-a", cardID: "card-a")
        let roundTrip = try JSONDecoder().decode(CardWindowID.self, from: JSONEncoder().encode(identity))
        XCTAssertEqual(roundTrip, identity)
        var variants = [identity]
        var owner = identity; owner.ownerID = "owner-b"; variants.append(owner)
        var workspace = identity; workspace.workspaceID = "workspace-b"; variants.append(workspace)
        var project = identity; project.projectID = "project-b"; variants.append(project)
        var card = identity; card.cardID = "card-b"; variants.append(card)
        XCTAssertEqual(Set(variants + [roundTrip]).count, 5)
    }

    func testFiltersCombineActorPriorityBlockerAndSearchUsingAnd() {
        let card = makeCard()
        var filter = CardFilter()
        filter.actor = "human"
        filter.priority = "High"
        filter.blocked = "false"
        filter.search = "homepage"
        XCTAssertTrue(filter.includes(card))
        filter.blocked = "true"
        XCTAssertFalse(filter.includes(card))
        filter.blocked = "false"
        filter.actor = "agent"
        XCTAssertFalse(filter.includes(card))
        filter.actor = "human"
        filter.priority = "Low"
        XCTAssertFalse(filter.includes(card))
        filter.priority = "High"
        filter.search = "unrelated"
        XCTAssertFalse(filter.includes(card))
    }

    func testArchivedCardsAreHiddenByDefaultAndCanBeIncluded() {
        var card = makeCard()
        card.archivedAt = ServerTimestamp.string()
        var filter = CardFilter()
        XCTAssertFalse(filter.includes(card))
        filter.includesArchived = true
        XCTAssertTrue(filter.includes(card))
    }

    private func makeCard() -> Card {
        Card(id: "card-a", title: "Review homepage", body: "Preserve Markdown source",
            nextActor: .human, nextAction: "Review the layout", priority: .high,
            blockedReason: "", columnId: "next", position: 0, version: 1,
            createdAt: "2026-10-13T12:00:00Z", updatedAt: "2026-10-13T12:00:00Z", comments: [])
    }
}
