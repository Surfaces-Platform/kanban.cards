import Foundation
import XCTest
@testable import KanbanCards

/// Actual production reconciliation/session/transport tests. Execute only in the disposable VM.
@MainActor
final class SharedEditingSessionTests: XCTestCase {
    private var model: AppModel!
    private var store: SliceCredentialStore!
    private var directory: URL!
    private var defaults: UserDefaults!
    private var suite: String!
    private let workspace = Workspace(id: "workspace-a", slug: "test", name: "Synthetic", url: URL(string: "https://test.kanban.cards")!)

    override func setUp() async throws {
        SliceURLProtocol.state.reset()
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        suite = "cards.kanban.SharedSlice.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        store = SliceCredentialStore()
        store.value = NativeSessionCredential(token: "kcn_synthetic_slice_only", expiresAt: ServerTimestamp.string(from: .now.addingTimeInterval(3600)), rootUrl: URL(string: "https://kanban.cards")!, owner: NativeOwner(id: "owner-a", displayName: "Synthetic owner", email: ""))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SliceURLProtocol.self]
        model = AppModel(api: KanbanAPIClient(credentialStore: store, session: URLSession(configuration: configuration)), drafts: DraftStore(directory: directory), defaults: defaults, demo: false)
        SliceURLProtocol.state.enqueue(json: #"{"authenticated":true,"context":"root","authenticationMethod":"native","rootUrl":"https://kanban.cards"}"#)
        SliceURLProtocol.state.enqueue(json: #"{"workspaces":[{"id":"workspace-a","slug":"test","name":"Synthetic","url":"https://test.kanban.cards"}]}"#)
        await model.restore()
        XCTAssertTrue(model.signedIn)
        try enqueueProject(baseline())
        try await model.loadProject(id: "project-a", in: workspace)
    }

    override func tearDown() async throws {
        model = nil
        defaults.removePersistentDomain(forName: suite)
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }

    func testSharedFixtureVectorsSI005SI007SI008SI009SI014UseProductionReconciler() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixtureURL = root.appendingPathComponent("tests/fixtures/shared-editing.json")
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [String: Any])
        let baselineJSON = try XCTUnwrap(fixture["baseline"] as? [String: Any])
        let base = try JSONDecoder().decode(Card.self, from: JSONSerialization.data(withJSONObject: baselineJSON))
        let cases = try XCTUnwrap(fixture["cases"] as? [[String: Any]])
        XCTAssertEqual(cases.count, 8)
        for item in cases {
            let name = try XCTUnwrap(item["id"] as? String)
            var localJSON = try dictionary(CardDraft(card: base))
            for (key, value) in (item["localChanges"] as? [String: Any] ?? [:]) { localJSON[key] = value }
            var latestJSON = baselineJSON
            for (key, value) in (item["latestChanges"] as? [String: Any] ?? [:]) { latestJSON[key] = value }
            let local = try JSONDecoder().decode(CardDraft.self, from: JSONSerialization.data(withJSONObject: localJSON))
            let latest = try JSONDecoder().decode(Card.self, from: JSONSerialization.data(withJSONObject: latestJSON))
            let result = local.reconcile(base: base, latest: latest)
            let merged = try dictionary(result.draft)
            for (key, expected) in (item["expectedDraft"] as? [String: Any] ?? [:]) {
                XCTAssertEqual(String(describing: merged[key] ?? NSNull()), String(describing: expected), "\(name): \(key)")
            }
            XCTAssertEqual(result.conflicts.map(\.rawValue).sorted(), (item["conflicts"] as? [String] ?? []).sorted(), name)
            XCTAssertEqual(result.draft.version, latest.version, name)
        }
    }

    func testSI001SI005DirtyTitleMoveDoneThenSaveNeverReturnsToNext() async throws {
        let base = baseline()
        let session = editing(base)
        session.pending.draft.title = "Revised release notes"
        session.edited()
        XCTAssertEqual(SliceURLProtocol.state.requests.filter { $0.method == "PATCH" }.count, 0)
        var moved = base; moved.columnId = "done"; moved.position = 3; moved.version = 8
        try enqueueProject(base)
        try enqueueCard(moved)
        try enqueueRefresh(moved)
        await session.move(to: "done")
        XCTAssertEqual(session.pending.draft.title, "Revised release notes")
        XCTAssertEqual(session.pending.draft.columnId, "done")
        XCTAssertTrue(session.conflicts.isEmpty)
        var saved = moved; saved.title = session.pending.draft.title; saved.version = 9
        try enqueueProject(moved)
        try enqueueCard(saved)
        try enqueueRefresh(saved)
        await session.save()
        let patches = SliceURLProtocol.state.requests.filter { $0.method == "PATCH" }
        XCTAssertEqual(patches.count, 2)
        let move = try body(patches[0])
        XCTAssertEqual(Set(move.keys), ["columnId"])
        XCTAssertEqual(move["columnId"] as? String, "done")
        let text = try body(patches[1])
        XCTAssertNil(text["columnId"])
        XCTAssertNil(text["position"])
        XCTAssertEqual(text["title"] as? String, "Revised release notes")
        XCTAssertEqual(patches[1].header("X-Kanban-Version"), "8")
        XCTAssertEqual(session.latest.columnId, "done")
        XCTAssertEqual(model.loadedProjects["project-a"]?.cards.first?.columnId, "done")
        XCTAssertFalse(session.dirty)
    }

    func testSI007SI008CommentAndNonoverlapRebaseRetainLocalTitle() async throws {
        let session = editing(baseline())
        session.pending.draft.title = "Local title"; session.edited()
        var remote = baseline(); remote.version = 8; remote.priority = .high
        remote.comments = [Comment(id: "comment-a", body: "Saved Comment", author: "Synthetic", createdAt: remote.updatedAt)]
        try enqueueProject(remote)
        await session.refresh()
        XCTAssertEqual(session.pending.draft.title, "Local title")
        XCTAssertEqual(session.pending.draft.priority, .high)
        XCTAssertEqual(session.pending.draft.version, 8)
        XCTAssertEqual(session.latest.comments.count, 1)
        XCTAssertTrue(session.conflicts.isEmpty)
        var saved = remote; saved.title = "Local title"; saved.version = 9
        try enqueueProject(remote); try enqueueCard(saved); try enqueueRefresh(saved)
        await session.save()
        XCTAssertEqual(session.latest.comments.count, 1)
        XCTAssertEqual(session.latest.priority, .high)
        let patch = try XCTUnwrap(SliceURLProtocol.state.requests.last(where: { $0.method == "PATCH" }))
        XCTAssertEqual(try body(patch)["priority"] as? String, "High")
    }

    func testSI009SameFieldConflictBlocksSaveUntilExplicitChoice() async throws {
        let session = editing(baseline())
        session.pending.draft.title = "Local title"; session.edited()
        var remote = baseline(); remote.title = "Remote title"; remote.version = 8
        session.receive(remote)
        XCTAssertEqual(session.conflicts, [.title])
        try enqueueProject(remote)
        await session.save()
        XCTAssertFalse(SliceURLProtocol.state.requests.contains { $0.method == "PATCH" })
        XCTAssertEqual(session.pending.draft.title, "Local title")
        session.resolve(.title, useSaved: false)
        var saved = remote; saved.title = "Local title"; saved.version = 9
        try enqueueProject(remote); try enqueueCard(saved); try enqueueRefresh(saved)
        await session.save()
        XCTAssertEqual(session.latest.title, "Local title")
        XCTAssertEqual(session.latest.version, 9)
    }

    func testSI006LegacyDestinationRequiresAdoptSavedOrSeparateMove() throws {
        let base = baseline()
        let session = editing(base)
        session.pending.draft.title = "Retained title"
        session.pending.draft.columnId = "doing"
        session.pending.draft.position = 1
        var moved = base; moved.columnId = "done"; moved.position = 3; moved.version = 8
        session.receive(moved)
        XCTAssertEqual(session.conflicts, [.placement])
        session.resolve(.placement, useSaved: false)
        XCTAssertTrue(session.conflicts.contains(.placement), "Text Save cannot enact a legacy destination.")
        session.resolve(.placement, useSaved: true)
        XCTAssertEqual(session.pending.draft.columnId, "done")
        XCTAssertEqual(session.pending.draft.title, "Retained title")
        XCTAssertTrue(session.conflicts.isEmpty)
    }

    func testSI011UnknownPatchReadbackDoesNotReplayMatchingSavedState() async throws {
        let session = editing(baseline())
        session.pending.draft.title = "Requested title"; session.edited()
        try enqueueProject(baseline())
        SliceURLProtocol.state.enqueue(error: URLError(.timedOut))
        await session.save()
        XCTAssertNotNil(session.pending.submitted)
        XCTAssertEqual(SliceURLProtocol.state.requests.filter { $0.method == "PATCH" }.count, 1)
        var saved = baseline(); saved.title = "Requested title"; saved.version = 8
        try enqueueProject(saved)
        await session.save()
        XCTAssertNil(session.pending.submitted)
        XCTAssertEqual(SliceURLProtocol.state.requests.filter { $0.method == "PATCH" }.count, 1)
        XCTAssertTrue(session.message?.contains("does not identify") == true)
        XCTAssertFalse(session.dirty)
    }

    func testSI011UnknownUncommittedPatchRequiresAnotherExplicitSave() async throws {
        let session = editing(baseline())
        session.pending.draft.body = "  Exact local source\n\n"; session.edited()
        try enqueueProject(baseline()); SliceURLProtocol.state.enqueue(error: URLError(.timedOut))
        await session.save()
        try enqueueProject(baseline())
        await session.save()
        XCTAssertNil(session.pending.submitted)
        XCTAssertTrue(session.dirty)
        XCTAssertEqual(SliceURLProtocol.state.requests.filter { $0.method == "PATCH" }.count, 1)
        var saved = baseline(); saved.body = session.pending.draft.body; saved.version = 8
        try enqueueProject(baseline()); try enqueueCard(saved); try enqueueRefresh(saved)
        await session.save()
        XCTAssertEqual(session.latest.body, "  Exact local source\n\n")
        XCTAssertEqual(SliceURLProtocol.state.requests.filter { $0.method == "PATCH" }.count, 2)
    }

    func testSI012ConfirmedSaveFailedRefreshNeverResubmitsDuringCleanup() async throws {
        let session = editing(baseline())
        session.pending.draft.title = "Confirmed title"; session.edited()
        var saved = baseline(); saved.title = "Confirmed title"; saved.version = 8
        try enqueueProject(baseline()); try enqueueCard(saved)
        SliceURLProtocol.state.enqueue(error: URLError(.notConnectedToInternet))
        await session.save()
        XCTAssertEqual(session.latest.title, "Confirmed title")
        XCTAssertTrue(model.errorMessage?.hasPrefix("Card saved.") == true)
        let patches = SliceURLProtocol.state.requests.filter { $0.method == "PATCH" }.count
        try enqueueProject(saved)
        await session.save()
        XCTAssertEqual(SliceURLProtocol.state.requests.filter { $0.method == "PATCH" }.count, patches)
    }

    func testSI003RevertReadsLatestAndReplacesOnlyLocalDraftWithoutPatch() async throws {
        let session = editing(baseline())
        session.pending.draft.title = "Unsaved title"
        session.pending.draft.body = "  Unsaved source\n\n"; session.edited()
        var latest = baseline(); latest.priority = .high; latest.version = 8
        try enqueueProject(latest)
        await session.revert()
        XCTAssertEqual(session.pending.draft, CardDraft(card: latest))
        XCTAssertEqual(session.latest, latest)
        XCTAssertFalse(session.dirty)
        XCTAssertTrue(session.message?.contains("No server write was sent") == true)
        XCTAssertFalse(SliceURLProtocol.state.requests.contains { $0.method == "PATCH" || $0.method == "POST" })
        XCTAssertNil(try model.drafts.loadScoped(ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: "card:project-a:card-a", legacyResourceKey: "card:project-a:card-a", as: PendingCardDraft.self))
    }

    func testSI003SI015LegacyRecoveryRequiresExplicitWorkspaceProofAndPreservesBytes() async throws {
        var legacy = PendingCardDraft(draft: CardDraft(card: baseline()), key: "legacy-key")
        legacy.draft.body = "  Legacy source\n\n"
        legacy.submitted = legacy.draft
        let resource = "card:project-a:card-a"
        try model.drafts.save(legacy, ownerID: "owner-a", resourceKey: resource)
        let ownerFolder = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        let legacyURL = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: ownerFolder, includingPropertiesForKeys: nil).first)
        let originalBytes = try Data(contentsOf: legacyURL)
        let session = editing(baseline())
        XCTAssertTrue(session.legacyNeedsScope)
        XCTAssertTrue(session.readOnly)
        XCTAssertEqual(session.pending, legacy)
        XCTAssertNil(try model.drafts.loadScoped(ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource, as: PendingCardDraft.self))
        let before = SliceURLProtocol.state.requests.count
        await session.save(); await session.revert(); await session.move(to: "done")
        XCTAssertEqual(SliceURLProtocol.state.requests.count, before, "Unknown legacy operation cannot be replayed or dropped before explicit origin confirmation.")
        model.drafts.failWrites = true
        session.recoverLegacy()
        XCTAssertTrue(session.legacyNeedsScope)
        XCTAssertTrue(session.persistenceFailed)
        XCTAssertEqual(try Data(contentsOf: legacyURL), originalBytes)
        model.drafts.failWrites = false
        session.recoverLegacy()
        XCTAssertFalse(session.legacyNeedsScope)
        XCTAssertEqual(session.pending.draft.body, legacy.draft.body)
        XCTAssertEqual(session.pending.submitted, legacy.submitted)
        XCTAssertEqual(session.pending.key, "legacy-key")
        XCTAssertEqual(SliceURLProtocol.state.requests.count, before, "Recovery is local and does not retry the frozen request.")
        XCTAssertEqual(try Data(contentsOf: legacyURL), originalBytes)
        let wrongOrigin = Workspace(id: workspace.id, slug: workspace.slug, name: workspace.name, url: URL(string: "https://other.kanban.cards")!)
        XCTAssertNil(try model.drafts.loadScoped(ownerID: "owner-a", workspace: wrongOrigin, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource, as: PendingCardDraft.self))
        XCTAssertThrowsError(try model.drafts.recoverLegacy(legacy, ownerID: "owner-a", workspace: wrongOrigin, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource))
        XCTAssertNil(try model.drafts.unprovenLegacy(ownerID: "owner-a", legacyResourceKey: resource, as: PendingCardDraft.self))
        XCTAssertNil(try model.drafts.loadScoped(ownerID: "owner-b", workspace: workspace, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource, as: PendingCardDraft.self))
        let relaunched = DraftStore(directory: directory)
        XCTAssertEqual(try relaunched.loadScoped(ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource, as: PendingCardDraft.self)?.draft.body, legacy.draft.body)
        try relaunched.removeScoped(ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource)
        XCTAssertNil(try DraftStore(directory: directory).unprovenLegacy(ownerID: "owner-a", legacyResourceKey: resource, as: PendingCardDraft.self), "Completed cleanup cannot resurrect the old unscoped operation.")
    }

    func testSI010SI015LegacyCommentKeepsFrozenIdentityUntilExplicitOriginRecovery() async throws {
        let legacy = PendingCommentDraft(body: "Retained exact Comment\n", key: "legacy-comment-key", submitted: "Retained exact Comment\n")
        let resource = "comment:project-a:card-a"
        try model.drafts.save(legacy, ownerID: "owner-a", resourceKey: resource)
        let session = model.commentEditingSession(workspace: workspace, projectID: "project-a", cardID: "card-a")
        session.load()
        XCTAssertTrue(session.legacyNeedsScope)
        let before = SliceURLProtocol.state.requests.count
        await session.post(); session.discard()
        XCTAssertEqual(SliceURLProtocol.state.requests.count, before)
        XCTAssertEqual(session.pending, legacy)
        session.recoverLegacy()
        XCTAssertFalse(session.legacyNeedsScope)
        XCTAssertEqual(session.pending, legacy)
        XCTAssertEqual(SliceURLProtocol.state.requests.count, before)
        XCTAssertEqual(try DraftStore(directory: directory).loadScoped(ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource, as: PendingCommentDraft.self), legacy)
    }

    func testSI011HTTP408PatchRetainsSnapshotAndRequiresReadbackInsteadOfReplay() async throws {
        let session = editing(baseline())
        session.pending.draft.title = "Frozen timeout title"; session.edited()
        try enqueueProject(baseline())
        SliceURLProtocol.state.enqueue(status: 408, json: #"{"error":"Synthetic proxy timeout"}"#)
        await session.save()
        XCTAssertEqual(session.pending.submitted?.title, "Frozen timeout title")
        XCTAssertEqual(SliceURLProtocol.state.requests.filter { $0.method == "PATCH" }.count, 1)
        try enqueueProject(baseline())
        await session.save()
        XCTAssertNil(session.pending.submitted)
        XCTAssertTrue(session.dirty)
        XCTAssertEqual(SliceURLProtocol.state.requests.filter { $0.method == "PATCH" }.count, 1, "408 readback cannot replay an unknown PATCH.")
    }

    func testSI005SI011HTTP408MoveRetainsRequestedDestinationWithoutSubmittingText() async throws {
        let session = editing(baseline())
        session.pending.draft.title = "Still local"; session.edited()
        try enqueueProject(baseline())
        SliceURLProtocol.state.enqueue(status: 408, json: #"{"error":"Synthetic proxy timeout"}"#)
        await session.move(to: "done")
        XCTAssertEqual(session.pending.move?.columnId, "done")
        XCTAssertNil(session.pending.submitted)
        await session.move(to: "doing")
        XCTAssertEqual(SliceURLProtocol.state.requests.filter { $0.method == "PATCH" }.count, 1)
        var saved = baseline(); saved.columnId = "done"; saved.position = 3; saved.version = 8
        try enqueueProject(saved)
        await session.save()
        XCTAssertNil(session.pending.move)
        XCTAssertEqual(session.pending.draft.title, "Still local")
        XCTAssertEqual(session.pending.draft.columnId, "done")
        XCTAssertTrue(session.dirty)
        XCTAssertEqual(SliceURLProtocol.state.requests.filter { $0.method == "PATCH" }.count, 1)
    }

    func testSI004FailedDiskWriteRetainsOwnerMemoryWithoutPromisingRelaunch() throws {
        model.drafts.failWrites = true
        let session = editing(baseline())
        session.pending.draft.body = "Only in owner memory\n"; session.edited()
        XCTAssertTrue(session.persistenceFailed)
        XCTAssertTrue(session.recoveryText.contains("Only in owner memory"))
        XCTAssertNotNil(try model.drafts.loadScoped(ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: "card:project-a:card-a", legacyResourceKey: "card:project-a:card-a", as: PendingCardDraft.self))
        XCTAssertNil(try DraftStore(directory: directory).loadScoped(ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: "card:project-a:card-a", legacyResourceKey: "card:project-a:card-a", as: PendingCardDraft.self))
        model.drafts.failWrites = false; session.persist()
        XCTAssertFalse(session.persistenceFailed)
        XCTAssertEqual(try DraftStore(directory: directory).loadScoped(ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: "card:project-a:card-a", legacyResourceKey: "card:project-a:card-a", as: PendingCardDraft.self)?.draft.body, "Only in owner memory\n")
    }

    func testSI010SI018HTTP408SameCardCommentContextsShareFrozenOperationIdentity() async throws {
        let first = model.commentEditingSession(workspace: workspace, projectID: "project-a", cardID: "card-a")
        let second = model.commentEditingSession(workspace: workspace, projectID: "project-a", cardID: "card-a")
        XCTAssertTrue(first === second)
        first.load(); first.pending.body = "One shared Comment"; first.persist()
        XCTAssertEqual(second.pending.body, "One shared Comment")
        let key = first.pending.key
        SliceURLProtocol.state.enqueue(status: 408, json: #"{"error":"Synthetic proxy timeout"}"#)
        await first.post()
        XCTAssertEqual(second.pending.submitted, "One shared Comment")
        second.discard()
        XCTAssertEqual(second.pending.key, key)
        let timestamp = baseline().updatedAt
        SliceURLProtocol.state.enqueue(json: "{\"comment\":{\"id\":\"comment-a\",\"body\":\"One shared Comment\",\"author\":\"Synthetic\",\"createdAt\":\"\(timestamp)\"},\"card\":{\"id\":\"card-a\",\"version\":8},\"projectRevision\":21}")
        var saved = baseline(); saved.version = 8; saved.comments = [Comment(id: "comment-a", body: "One shared Comment", author: "Synthetic", createdAt: timestamp)]
        try enqueueRefresh(saved)
        await second.post()
        let posts = SliceURLProtocol.state.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 2)
        XCTAssertEqual(posts.map { $0.header("Idempotency-Key") }, [key, key])
        XCTAssertEqual(try body(posts[0])["body"] as? String, "One shared Comment")
        XCTAssertEqual(posts[0].body, posts[1].body)
        XCTAssertEqual(model.loadedProjects["project-a"]?.cards.first?.comments.count, 1)
    }

    func testSI014ArchivedAndMissingResourcesBlockOrdinarySave() async throws {
        let session = editing(baseline())
        session.pending.draft.title = "Keep recovery"; session.edited()
        var archived = baseline(); archived.archivedAt = archived.updatedAt; archived.version = 8
        session.receive(archived)
        XCTAssertTrue(session.readOnly)
        await session.save()
        XCTAssertFalse(SliceURLProtocol.state.requests.contains { $0.method == "PATCH" })
        session.missing()
        XCTAssertTrue(session.readOnly)
        XCTAssertEqual(session.pending.draft.title, "Keep recovery")
    }

    func testSI017UnauthorizedReadEndsPrivateSessionWithoutSendingDraft() async throws {
        let session = editing(baseline())
        session.pending.draft.title = "Recover after authentication"; session.edited()
        SliceURLProtocol.state.enqueue(status: 401, json: #"{"error":"Sign in again."}"#)
        await session.save()
        XCTAssertFalse(model.signedIn)
        XCTAssertFalse(session.authorized)
        XCTAssertTrue(model.loadedProjects.isEmpty)
        XCTAssertFalse(SliceURLProtocol.state.requests.contains { $0.method == "PATCH" })
        XCTAssertEqual(session.pending.draft.title, "Recover after authentication")
    }

    func testSI003CorruptCardLoadBlocksEveryWriteAndRetryReadsOriginalRecord() async throws {
        var retained = PendingCardDraft(draft: CardDraft(card: baseline()), key: "retained-card-key", baseline: baseline())
        retained.draft.title = "Retained submitted title"; retained.submitted = retained.draft
        let resource = "card:project-a:card-a"
        let url = try installRetained(retained, resource: resource)
        let corrupt = Data(#"{"key":"retained-card-key","submitted":{"title":"Keep source"},"unfinished":"#.utf8)
        try corrupt.write(to: url)
        model.drafts.prepareToRetryReading(ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource)
        let session = editing(baseline())
        XCTAssertTrue(session.loadFailed); XCTAssertTrue(session.readOnly)
        XCTAssertEqual(session.retainedRecordText, String(data: corrupt, encoding: .utf8))
        let before = SliceURLProtocol.state.requests.count
        session.pending.draft.title = "A placeholder must never replace unread data"
        session.edited(); session.persist(); session.receive(baseline())
        await session.save(); await session.move(to: "done"); await session.revert(); await session.refresh()
        session.retryLoading()
        XCTAssertTrue(session.loadFailed)
        XCTAssertEqual(try Data(contentsOf: url), corrupt)
        XCTAssertEqual(SliceURLProtocol.state.requests.count, before)
        try JSONEncoder().encode(retained).write(to: url)
        session.retryLoading()
        XCTAssertFalse(session.loadFailed)
        XCTAssertEqual(session.pending.key, retained.key)
        XCTAssertEqual(session.pending.submitted, retained.submitted)
        XCTAssertEqual(session.pending.draft.title, retained.draft.title)
        XCTAssertEqual(SliceURLProtocol.state.requests.count, before, "Retry reads local protection; it never replays the submitted PATCH.")
    }

    func testSI003WrongCardIdentityRemainsQuarantinedUntilSuccessfulRead() async throws {
        var other = baseline(); other.id = "another-card"
        let wrong = PendingCardDraft(draft: CardDraft(card: other), key: "other-card-frozen", submitted: CardDraft(card: other), baseline: other)
        let url = try installRetained(wrong, resource: "card:project-a:card-a")
        let original = try Data(contentsOf: url)
        let session = editing(baseline())
        XCTAssertTrue(session.loadFailed)
        let before = SliceURLProtocol.state.requests.count
        session.pending.draft.title = "Unsafe replacement"; session.edited(); session.persist()
        await session.save(); await session.revert(); await session.move(to: "done")
        session.retryLoading()
        XCTAssertTrue(session.loadFailed)
        XCTAssertEqual(try Data(contentsOf: url), original)
        XCTAssertEqual(SliceURLProtocol.state.requests.count, before)
        let correct = PendingCardDraft(draft: CardDraft(card: baseline()), key: "correct-key", baseline: baseline())
        try JSONEncoder().encode(correct).write(to: url)
        session.retryLoading()
        XCTAssertFalse(session.loadFailed)
        XCTAssertEqual(session.pending.draft.id, "card-a")
        XCTAssertEqual(session.pending.key, "correct-key")
    }

    func testSI010CorruptCommentLoadCannotDiscardOrReplaceFrozenPostOnRetry() async throws {
        let retained = PendingCommentDraft(body: "  Frozen Comment\n", key: "original-comment-operation", submitted: "  Frozen Comment\n")
        let resource = "comment:project-a:card-a"
        let url = try installRetained(retained, resource: resource)
        let corrupt = Data(#"{"key":"original-comment-operation","submitted":"  Frozen Comment\n","bad":"#.utf8)
        try corrupt.write(to: url)
        model.drafts.prepareToRetryReading(ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource)
        let session = model.commentEditingSession(workspace: workspace, projectID: "project-a", cardID: "card-a")
        session.load()
        XCTAssertTrue(session.loadFailed); XCTAssertTrue(session.frozen)
        let before = SliceURLProtocol.state.requests.count
        session.pending.body = "Unsafe new body"; session.persist(); session.discard(); await session.post()
        session.retryLoading()
        XCTAssertTrue(session.loadFailed)
        XCTAssertEqual(try Data(contentsOf: url), corrupt)
        XCTAssertEqual(SliceURLProtocol.state.requests.count, before)
        try JSONEncoder().encode(retained).write(to: url)
        session.retryLoading()
        XCTAssertFalse(session.loadFailed)
        XCTAssertEqual(session.pending, retained)
        XCTAssertEqual(SliceURLProtocol.state.requests.count, before)
        try enqueueCommentReply(body: retained.body)
        var saved = baseline(); saved.version = 8
        saved.comments = [Comment(id: "comment-a", body: retained.body, author: "Synthetic", createdAt: saved.updatedAt)]
        try enqueueRefresh(saved)
        await session.post()
        let posts = SliceURLProtocol.state.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 1)
        XCTAssertEqual(posts.first?.header("Idempotency-Key"), retained.key)
        XCTAssertEqual(try body(try XCTUnwrap(posts.first))["body"] as? String, retained.submitted)
    }

    func testSI004UnreadCardFileCannotBeOverwrittenAndRetryRecoversFrozenSnapshot() throws {
        var retained = PendingCardDraft(draft: CardDraft(card: baseline()), key: "unread-card-key", baseline: baseline())
        retained.draft.body = "Original protected body\n"; retained.submitted = retained.draft
        let resource = "card:project-a:card-a"
        let url = try installRetained(retained, resource: resource)
        let backup = try makeUnread(url, resource: resource)
        let original = try Data(contentsOf: backup)
        let session = editing(baseline())
        XCTAssertTrue(session.loadFailed)
        session.persist(); session.edited(); session.retryLoading()
        XCTAssertTrue(session.loadFailed)
        var isDirectory = ObjCBool(false)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)); XCTAssertTrue(isDirectory.boolValue)
        XCTAssertEqual(try Data(contentsOf: backup), original)
        try FileManager.default.removeItem(at: url); try FileManager.default.moveItem(at: backup, to: url)
        session.retryLoading()
        XCTAssertFalse(session.loadFailed)
        XCTAssertEqual(session.pending.submitted, retained.submitted)
        XCTAssertEqual(session.pending.key, retained.key)
    }

    func testSI004UnreadCommentFileCannotBeOverwrittenAndRetryRecoversFrozenPost() async throws {
        let retained = PendingCommentDraft(body: "Protected Comment\n", key: "unread-comment-key", submitted: "Protected Comment\n")
        let resource = "comment:project-a:card-a"
        let url = try installRetained(retained, resource: resource)
        let backup = try makeUnread(url, resource: resource)
        let original = try Data(contentsOf: backup)
        let session = model.commentEditingSession(workspace: workspace, projectID: "project-a", cardID: "card-a")
        session.load()
        XCTAssertTrue(session.loadFailed)
        let before = SliceURLProtocol.state.requests.count
        session.persist(); session.discard(); await session.post(); session.retryLoading()
        XCTAssertTrue(session.loadFailed)
        XCTAssertEqual(SliceURLProtocol.state.requests.count, before)
        XCTAssertEqual(try Data(contentsOf: backup), original)
        try FileManager.default.removeItem(at: url); try FileManager.default.moveItem(at: backup, to: url)
        session.retryLoading()
        XCTAssertFalse(session.loadFailed)
        XCTAssertEqual(session.pending, retained)
    }

    func testSI004RetryReadingDoesNotEvictOwnersFailedWriteMemory() throws {
        model.drafts.failWrites = true
        let session = editing(baseline())
        session.pending.draft.body = "Only the owner's running memory has this source\n"; session.edited()
        XCTAssertTrue(session.persistenceFailed)
        let resource = "card:project-a:card-a"
        model.drafts.prepareToRetryReading(ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource)
        XCTAssertEqual(try model.drafts.loadScoped(ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource, as: PendingCardDraft.self)?.draft.body, session.pending.draft.body)
        XCTAssertNil(try model.drafts.loadScoped(ownerID: "other-owner", workspace: workspace, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource, as: PendingCardDraft.self))
    }

    func testSI003CreationIdentityValidationRejectsSavedResourceAndFrozenWrongIdentity() throws {
        let existing = PendingCardDraft(draft: CardDraft(card: baseline()), key: "wrong-create-card")
        XCTAssertThrowsError(try existing.validateIdentity(cardID: nil))
        var create = PendingCardDraft(draft: CardDraft(columnId: "next"), key: "create-card")
        try create.validateIdentity(cardID: nil)
        create.submitted = CardDraft(card: baseline())
        XCTAssertThrowsError(try create.validateIdentity(cardID: nil))
        var project = PendingProjectDraft(draft: ProjectDraft(name: "Synthetic"), key: "create-project")
        try project.validateIdentity(projectID: nil)
        var otherProject = ProjectDraft(name: "Other"); otherProject.id = "existing-project"
        project.submitted = otherProject
        XCTAssertThrowsError(try project.validateIdentity(projectID: nil))
    }

    func testSI012CardReceiptSurvivesConfirmedPatchThenRefresh401AndOwnerRestore() async throws {
        let session = editing(baseline())
        session.pending.draft.title = "Confirmed before expiry"; session.edited()
        var saved = baseline(); saved.title = session.pending.draft.title; saved.version = 8
        try enqueueProject(baseline()); try enqueueCard(saved)
        SliceURLProtocol.state.enqueue(status: 401, json: #"{"error":"Synthetic expired follow-up read"}"#)
        await session.save()
        XCTAssertFalse(model.signedIn); XCTAssertFalse(session.authorized)
        let resource = "card:project-a:card-a"
        let persisted = try DraftStore(directory: directory).loadScoped(ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource, as: PendingCardDraft.self)
        XCTAssertNotNil(persisted?.confirmed)
        XCTAssertNil(persisted?.submitted)
        XCTAssertEqual(persisted?.draft.title, saved.title)
        let restored = try await authenticatedModel(ownerID: "owner-a", card: saved)
        let resumed = restored.cardEditingSession(workspace: workspace, projectID: "project-a", card: saved)
        resumed.load()
        XCTAssertNotNil(resumed.pending.confirmed)
        let before = SliceURLProtocol.state.requests.count
        await resumed.save()
        XCTAssertEqual(SliceURLProtocol.state.requests.count, before, "A confirmed PATCH needs only local completion, even after reauthentication.")
        XCTAssertNil(resumed.pending.confirmed)
        XCTAssertEqual(SliceURLProtocol.state.requests.filter { $0.method == "PATCH" }.count, 1)
    }

    func testSI010SI012CommentReceiptSurvivesRefresh401WithoutReplayAfterOwnerRestore() async throws {
        let session = model.commentEditingSession(workspace: workspace, projectID: "project-a", cardID: "card-a")
        session.load(); session.pending.body = "Confirmed Comment before expiry"; session.persist()
        let key = session.pending.key
        try enqueueCommentReply(body: session.pending.body)
        SliceURLProtocol.state.enqueue(status: 401, json: #"{"error":"Synthetic expired follow-up read"}"#)
        await session.post()
        XCTAssertFalse(model.signedIn); XCTAssertFalse(session.authorized)
        let resource = "comment:project-a:card-a"
        let persisted = try DraftStore(directory: directory).loadScoped(ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource, as: PendingCommentDraft.self)
        XCTAssertNotNil(persisted?.confirmed)
        XCTAssertEqual(persisted?.key, key)
        let other = try await authenticatedModel(ownerID: "owner-b", card: baseline())
        let isolated = other.commentEditingSession(workspace: workspace, projectID: "project-a", cardID: "card-a")
        isolated.load()
        XCTAssertEqual(isolated.pending.body, ""); XCTAssertNil(isolated.pending.submitted); XCTAssertNil(isolated.pending.confirmed)
        XCTAssertNil(session.retainedRecordText)
        var saved = baseline(); saved.version = 8
        saved.comments = [Comment(id: "comment-a", body: try XCTUnwrap(persisted).body, author: "Synthetic", createdAt: saved.updatedAt)]
        let restored = try await authenticatedModel(ownerID: "owner-a", card: saved)
        let resumed = restored.commentEditingSession(workspace: workspace, projectID: "project-a", cardID: "card-a")
        resumed.load()
        XCTAssertNotNil(resumed.pending.confirmed)
        let before = SliceURLProtocol.state.requests.count
        await resumed.post()
        XCTAssertEqual(SliceURLProtocol.state.requests.count, before, "Completion cannot replay a confirmed POST after sign-in, regardless of server idempotency retention.")
        XCTAssertNil(resumed.pending.confirmed)
        let posts = SliceURLProtocol.state.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 1); XCTAssertEqual(posts.first?.header("Idempotency-Key"), key)
    }

    private func installRetained<T: Encodable>(_ record: T, resource: String) throws -> URL {
        try model.drafts.saveScoped(record, ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource)
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil))
        let files = enumerator.compactMap { $0 as? URL }.filter { $0.pathExtension == "json" }
        XCTAssertEqual(files.count, 1)
        return try XCTUnwrap(files.first)
    }
    private func makeUnread(_ url: URL, resource: String) throws -> URL {
        let backup = url.appendingPathExtension("protected-original")
        try FileManager.default.moveItem(at: url, to: backup)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        model.drafts.prepareToRetryReading(ownerID: "owner-a", workspace: workspace, projectID: "project-a", resourceKey: resource, legacyResourceKey: resource)
        return backup
    }
    private func enqueueCommentReply(body: String) throws {
        struct Reply: Encodable {
            struct CardVersion: Encodable { var id: String; var version: Int }
            var comment: Comment; var card: CardVersion; var projectRevision: Int
        }
        let value = Reply(comment: Comment(id: "comment-a", body: body, author: "Synthetic", createdAt: baseline().updatedAt), card: Reply.CardVersion(id: "card-a", version: 8), projectRevision: 21)
        try SliceURLProtocol.state.enqueue(value)
    }
    private func authenticatedModel(ownerID: String, card: Card) async throws -> AppModel {
        let credential = SliceCredentialStore()
        credential.value = NativeSessionCredential(token: "kcn_synthetic_\(ownerID)", expiresAt: ServerTimestamp.string(from: .now.addingTimeInterval(3600)), rootUrl: URL(string: "https://kanban.cards")!, owner: NativeOwner(id: ownerID, displayName: "Synthetic", email: ""))
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [SliceURLProtocol.self]
        let restored = AppModel(api: KanbanAPIClient(credentialStore: credential, session: URLSession(configuration: configuration)), drafts: DraftStore(directory: directory), defaults: defaults, demo: false)
        SliceURLProtocol.state.enqueue(json: #"{"authenticated":true,"context":"root","authenticationMethod":"native","rootUrl":"https://kanban.cards"}"#)
        SliceURLProtocol.state.enqueue(json: #"{"workspaces":[{"id":"workspace-a","slug":"test","name":"Synthetic","url":"https://test.kanban.cards"}]}"#)
        await restored.restore()
        XCTAssertTrue(restored.signedIn)
        try enqueueProject(card); try await restored.loadProject(id: "project-a", in: workspace)
        return restored
    }

    private func editing(_ card: Card) -> CardEditingSession {
        let session = model.cardEditingSession(workspace: workspace, projectID: "project-a", card: card)
        session.load(); return session
    }
    private func baseline() -> Card {
        Card(id: "card-a", externalKey: "synthetic:card-a", title: "Prepare release notes", body: "Source\n", nextActor: .human, nextAction: "Draft summary", priority: .medium, blockedReason: "", columnId: "next", position: 0, version: 7, createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z", comments: [])
    }
    private func project(_ card: Card) -> Project {
        Project(id: "project-a", name: "Synthetic", description: "", columns: [Column(id: "next", name: "Next", position: 0), Column(id: "doing", name: "Doing", position: 1), Column(id: "done", name: "Done", position: 2)], cards: [card], activity: [], revision: card.version + 13, createdAt: card.createdAt, updatedAt: card.updatedAt)
    }
    private func enqueueProject(_ card: Card) throws {
        struct Reply: Encodable { var project: Project }
        try SliceURLProtocol.state.enqueue(Reply(project: project(card)))
    }
    private func enqueueCard(_ card: Card) throws {
        struct Reply: Encodable { var card: Card; var projectRevision: Int }
        try SliceURLProtocol.state.enqueue(Reply(card: card, projectRevision: card.version + 13))
    }
    private func enqueueRefresh(_ card: Card) throws {
        try enqueueProject(card)
        struct Reply: Encodable { var projects: [ProjectSummary] }
        let p = project(card)
        try SliceURLProtocol.state.enqueue(Reply(projects: [ProjectSummary(id: p.id, name: p.name, description: p.description, revision: p.revision, createdAt: p.createdAt, updatedAt: p.updatedAt, cardCount: p.cards.filter { $0.archivedAt == nil }.count)]))
    }
    private func dictionary<T: Encodable>(_ value: T) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }
    private func body(_ request: SliceTransportState.Request) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
    }
}

@MainActor
private final class SliceCredentialStore: SessionCredentialStore {
    var value: NativeSessionCredential?
    func load() throws -> NativeSessionCredential? { value }
    func save(_ credential: NativeSessionCredential) throws { value = credential }
    func remove() throws { value = nil }
}

private final class SliceTransportState: @unchecked Sendable {
    struct Reply { var status: Int; var data: Data; var error: URLError? }
    struct Request {
        var method: String; var headers: [String: String]; var body: Data
        func header(_ name: String) -> String? { headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value }
    }
    private let lock = NSLock()
    private var replies: [Reply] = []
    private var captured: [Request] = []
    var requests: [Request] { lock.withLock { captured } }
    func reset() { lock.withLock { replies = []; captured = [] } }
    func enqueue(status: Int = 200, json: String) { lock.withLock { replies.append(Reply(status: status, data: Data(json.utf8), error: nil)) } }
    func enqueue<T: Encodable>(_ value: T) throws { enqueue(json: String(decoding: try JSONEncoder().encode(value), as: UTF8.self)) }
    func enqueue(error: URLError) { lock.withLock { replies.append(Reply(status: 0, data: Data(), error: error)) } }
    func consume(_ request: URLRequest) -> Reply {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
            defer { buffer.deallocate() }
            while stream.hasBytesAvailable { let count = stream.read(buffer, maxLength: 4096); if count <= 0 { break }; body.append(buffer, count: count) }
        }
        return lock.withLock {
            captured.append(Request(method: request.httpMethod ?? "GET", headers: request.allHTTPHeaderFields ?? [:], body: body))
            return replies.isEmpty ? Reply(status: 500, data: Data(), error: nil) : replies.removeFirst()
        }
    }
}

private final class SliceURLProtocol: URLProtocol, @unchecked Sendable {
    static let state = SliceTransportState()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let reply = Self.state.consume(request)
        if let error = reply.error { client?.urlProtocol(self, didFailWithError: error); return }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type":"application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
