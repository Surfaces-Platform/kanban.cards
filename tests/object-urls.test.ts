import assert from "node:assert/strict";
import test from "node:test";
import { objectPath, parseObjectRoute, safeObjectReturnPath } from "../src/object-urls";

test("Workspace, Project, Card and Comment addresses round-trip using immutable IDs", () => {
  for (const route of [{}, { projectId: "project-one" }, { projectId: "project-one", cardId: "card-one" },
    { projectId: "project-one", cardId: "card-one", commentId: "comment-one" }]) {
    const address = new URL(objectPath(route), "https://mike.kanban.cards");
    assert.deepEqual(parseObjectRoute(address.pathname, address.hash), route);
    assert.equal(safeObjectReturnPath(address.pathname + address.hash), objectPath(route));
  }
  assert.equal(objectPath({ projectId: "p", cardId: "c", commentId: "m" }), "/projects/p/cards/c#m");
});

test("return addresses reject external destinations, traversal, queries and malformed IDs", () => {
  for (const value of [null, {}, "https://other.kanban.cards/projects/p", "//evil.test/", "/api/projects", "/sign-in",
    "/projects/../p", "/projects/%2e%2e", "/projects/p%2fc/cards/c", "/projects/p?workspaceId=other",
    "/projects/p/cards/c#comment#extra", "/projects/p#comment-one", "/projects/p/cards/c#<script>", "/\\evil.test", " /", "/projects/_p"]) {
    assert.equal(safeObjectReturnPath(value), null, String(value));
  }
  assert.throws(() => objectPath({ cardId: "card" }));
  assert.throws(() => objectPath({ projectId: "project", commentId: "comment" }));
  assert.throws(() => objectPath({ projectId: "../other" }));
  assert.equal(safeObjectReturnPath("/projects/p/"), "/projects/p");
});
