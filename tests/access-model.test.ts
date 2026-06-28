import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Express } from "express";

import { createFileAgentTokenStore, hashAgentToken } from "../src/agent-token-store";
import { createSessionCookie } from "../src/platform-auth";
import { createApp } from "../src/server";
import { DEFAULT_PROJECT_ID, DEFAULT_TEAM_ID, normalizeWorkspace } from "../src/state-store";

test("legacy workspace state normalizes into Team, Project, and board ownership", () => {
  const state = normalizeWorkspace({
    boards: [
      {
        id: "board-legacy",
        name: "Legacy board",
        lanes: [{ id: "todo", title: "To do", description: "", defaultOwnerAgentId: null, defaultReviewerAgentId: null, gate: { title: "To do gate", checks: ["Ready"] } }],
        agentSpecs: [],
        workItems: [{ id: "legacy-card", title: "Legacy card", laneId: "todo", comments: [] }],
        selectedId: null
      }
    ],
    activeBoardId: "board-legacy",
    templates: []
  });

  assert.equal(state.team.id, DEFAULT_TEAM_ID);
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].id, DEFAULT_PROJECT_ID);
  assert.equal(state.activeProjectId, DEFAULT_PROJECT_ID);
  assert.equal(state.boards[0].projectId, DEFAULT_PROJECT_ID);
  assert.equal(state.boards[0].workItems[0].requesterMemberId, null);
  assert.equal(state.boards[0].workItems[0].ownerMemberId, null);
  assert.equal(state.boards[0].workItems[0].reviewerMemberId, null);
  assert.deepEqual(state.members, []);
  assert.deepEqual(state.invites, []);
});

test("legacy lane and agent aliases preserve card placement and defaults", () => {
  const state = normalizeWorkspace({
    boards: [
      {
        id: "board-aliases",
        name: "Alias board",
        lanes: [
          {
            id: "Plan Lane",
            title: "Plan",
            description: "",
            defaultOwnerAgentId: "Owner Agent",
            defaultReviewerAgentId: "Review Agent",
            gate: { title: "Plan gate", checks: ["Ready"] }
          },
          {
            id: "Review Lane",
            title: "Review",
            description: "",
            defaultOwnerAgentId: "Review Agent",
            defaultReviewerAgentId: "Owner Agent",
            gate: { title: "Review gate", checks: ["Checked"] }
          }
        ],
        agentSpecs: [
          { id: "Owner Agent", name: "Owner Agent", role: "Owner", laneIds: ["Plan Lane"], instructions: "", skillNotes: "" },
          { id: "Review Agent", name: "Review Agent", role: "Reviewer", laneIds: ["Review Lane"], instructions: "", skillNotes: "" }
        ],
        workItems: [
          {
            id: "legacy-card",
            title: "Legacy card",
            laneId: "Review Lane",
            ownerAgentId: "Owner Agent",
            reviewerAgentId: "Review Agent",
            comments: []
          }
        ],
        selectedId: null
      }
    ],
    activeBoardId: "board-aliases",
    templates: []
  });

  const board = state.boards[0];
  assert.equal(board.lanes[0].id, "plan-lane");
  assert.equal(board.lanes[0].defaultOwnerAgentId, "owner-agent");
  assert.deepEqual(board.agentSpecs[0].laneIds, ["plan-lane"]);
  assert.equal(board.workItems[0].laneId, "review-lane");
  assert.equal(board.workItems[0].ownerAgentId, "owner-agent");
  assert.equal(board.workItems[0].reviewerAgentId, "review-agent");
});

test("empty agent specs clear stale lane default agent references", () => {
  const state = normalizeWorkspace({
    boards: [
      {
        id: "board-stale-agent-defaults",
        name: "Stale defaults board",
        lanes: [
          {
            id: "todo",
            title: "Todo",
            description: "",
            defaultOwnerAgentId: "missing-owner",
            defaultReviewerAgentId: "missing-reviewer",
            gate: { title: "Todo gate", checks: ["Ready"] }
          }
        ],
        agentSpecs: [],
        workItems: [],
        selectedId: null
      }
    ],
    activeBoardId: "board-stale-agent-defaults",
    templates: []
  });

  assert.equal(state.boards[0].lanes[0].defaultOwnerAgentId, null);
  assert.equal(state.boards[0].lanes[0].defaultReviewerAgentId, null);
});

test("project APIs create, rename, activate, and scope board listing", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-project-api-"));
  const dataPath = path.join(tempDir, "state.json");
  const token = "admin-token";
  const server = await listen(createApp({ dataPath, apiToken: token }));
  const baseUrl = `http://127.0.0.1:${serverPort(server)}`;

  try {
    const initial = await getJson(`${baseUrl}/api/projects`, bearerHeaders(token));
    assert.equal(initial.activeProjectId, DEFAULT_PROJECT_ID);
    assert.equal(initial.projects.length, 1);

    const project = await writeJson(`${baseUrl}/api/projects`, bearerHeaders(token), { name: "Access Model", active: true });
    assert.equal(project.name, "Access Model");
    assert.equal(project.teamId, DEFAULT_TEAM_ID);

    const activeBoard = await writeJson(`${baseUrl}/api/boards`, bearerHeaders(token), { name: "Active project board" });
    assert.equal(activeBoard.projectId, project.id);

    const defaultBoard = await writeJson(`${baseUrl}/api/boards`, bearerHeaders(token), {
      name: "Default project board",
      projectId: DEFAULT_PROJECT_ID
    });
    assert.equal(defaultBoard.projectId, DEFAULT_PROJECT_ID);

    const activeBoards = await getJson(`${baseUrl}/api/boards`, bearerHeaders(token));
    assert.deepEqual(activeBoards.boards.map((board: any) => board.id), [activeBoard.id]);

    const defaultBoards = await getJson(`${baseUrl}/api/boards?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`, bearerHeaders(token));
    assert.ok(defaultBoards.boards.some((board: any) => board.id === defaultBoard.id));
    assert.ok(defaultBoards.boards.every((board: any) => board.projectId === DEFAULT_PROJECT_ID));

    const renamed = await writeJson(`${baseUrl}/api/projects/${project.id}`, bearerHeaders(token), {
      name: "Access Model Runtime",
      active: true
    }, "PATCH");
    assert.equal(renamed.name, "Access Model Runtime");
  } finally {
    await closeServer(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("session users can use project APIs with Auth0 workspace as team seed", async () => {
  await withPlatformAuthEnv(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-session-project-api-"));
    const dataPath = path.join(tempDir, "state.json");
    const server = await listen(createApp({ dataPath, requireAuth: true, apiToken: "admin-token" }));
    const baseUrl = `http://127.0.0.1:${serverPort(server)}`;
    const sessionCookie = await createSessionCookie({
      userId: "auth0|project-user",
      email: "project@example.com",
      name: "Project User",
      workspaceId: "ws_project",
      roles: ["admin"],
      surfaceAccess: ["kanban.cards"]
    }, "test-session-secret-with-enough-entropy", false, 3600);

    try {
      const project = await writeJson(`${baseUrl}/api/projects`, cookieHeaders(sessionCookie), { name: "Session project" });
      assert.equal(project.teamId, "ws_project");

      const session = await getJson(`${baseUrl}/auth/session`, cookieHeaders(sessionCookie));
      assert.equal(session.teamId, "ws_project");
      assert.equal(session.projectId, project.id);
      assert.equal(session.role, "owner");
      assert.equal(session.isTeamMember, true);
      assert.deepEqual(session.projectIds, ["*"]);

      const publicState = await getJson(`${baseUrl}/api/state`, cookieHeaders(sessionCookie));
      assert.equal(publicState.members.length, 1);
      assert.equal(publicState.members[0].email, "project@example.com");
    } finally {
      await closeServer(server);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test("team invite acceptance hashes one-time tokens and grants member-scoped card access", async () => {
  await withPlatformAuthEnv(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-team-invites-"));
    const dataPath = path.join(tempDir, "state.json");
    const server = await listen(createApp({ dataPath, requireAuth: true, apiToken: "admin-token" }));
    const baseUrl = `http://127.0.0.1:${serverPort(server)}`;
    const ownerCookie = await sessionCookie("auth0|owner", "owner@example.com", "Owner User", "ws_team_invites");
    const memberCookie = await sessionCookie("auth0|member", "member@example.com", "Member User", "ws_team_invites");

    try {
      const ownerSession = await getJson(`${baseUrl}/auth/session`, cookieHeaders(ownerCookie));
      assert.equal(ownerSession.role, "owner");
      assert.equal(ownerSession.isTeamMember, true);

      const board = await writeJson(`${baseUrl}/api/boards`, cookieHeaders(ownerCookie), { name: "Member board" });
      await writeJson(`${baseUrl}/api/boards/${board.id}`, cookieHeaders(ownerCookie), {
        lanes: [
          { id: "todo", title: "To do", description: "", defaultOwnerAgentId: null, defaultReviewerAgentId: null, gate: { title: "To do gate", checks: ["Ready"] } }
        ],
        agentSpecs: []
      }, "PATCH");

      const invitePayload = await writeJson(`${baseUrl}/api/team/invites`, cookieHeaders(ownerCookie), {
        email: "member@example.com",
        role: "member",
        projectIds: ["*"]
      });
      assert.equal(invitePayload.invite.email, "member@example.com");
      assert.equal(invitePayload.invite.role, "member");
      assert.equal(invitePayload.invite.tokenHash, undefined);
      assert.match(invitePayload.acceptUrl, /\/invites\/accept\?token=/);
      const inviteToken = new URL(invitePayload.acceptUrl).searchParams.get("token") || "";
      assert.ok(inviteToken.startsWith("kcinv_"));

      const rawState = JSON.parse(await fs.readFile(dataPath, "utf8"));
      assert.equal(rawState.invites.length, 1);
      assert.equal(typeof rawState.invites[0].tokenHash, "string");
      assert.notEqual(rawState.invites[0].tokenHash, inviteToken);

      const nonMemberState = await fetch(`${baseUrl}/api/state`, { headers: cookieHeaders(memberCookie) });
      assert.equal(nonMemberState.status, 403);

      const accepted = await writeJson(`${baseUrl}/api/invites/accept`, cookieHeaders(memberCookie), { token: inviteToken });
      assert.equal(accepted.member.role, "member");
      assert.equal(accepted.invite.status, "accepted");
      assert.equal(accepted.invite.tokenHash, undefined);

      const memberSession = await getJson(`${baseUrl}/auth/session`, cookieHeaders(memberCookie));
      assert.equal(memberSession.role, "member");
      assert.equal(memberSession.isTeamMember, true);

      const ownerStateAfterAccept = await getJson(`${baseUrl}/api/state`, cookieHeaders(ownerCookie));
      assert.equal(ownerStateAfterAccept.members.length, 2);

      const memberStateAfterAccept = await getJson(`${baseUrl}/api/state`, cookieHeaders(memberCookie));
      assert.equal(memberStateAfterAccept.members.length, 1);
      assert.equal(memberStateAfterAccept.members[0].email, "member@example.com");

      const secondAccept = await fetch(`${baseUrl}/api/invites/accept`, {
        method: "POST",
        headers: { ...cookieHeaders(memberCookie), "Content-Type": "application/json" },
        body: JSON.stringify({ token: inviteToken })
      });
      assert.equal(secondAccept.status, 404);

      const memberTeam = await fetch(`${baseUrl}/api/team`, { headers: cookieHeaders(memberCookie) });
      assert.equal(memberTeam.status, 403);

      const memberCreateBoard = await fetch(`${baseUrl}/api/boards`, {
        method: "POST",
        headers: { ...cookieHeaders(memberCookie), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Denied board" })
      });
      assert.equal(memberCreateBoard.status, 403);

      const memberToken = await fetch(`${baseUrl}/api/boards/${board.id}/agent-tokens`, {
        method: "POST",
        headers: { ...cookieHeaders(memberCookie), "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "agent-a" })
      });
      assert.equal(memberToken.status, 403);

      const card = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items`, cookieHeaders(memberCookie), {
        title: "Member card",
        laneId: "todo"
      });
      assert.equal(card.title, "Member card");
    } finally {
      await closeServer(server);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test("card and state writes validate member references against board project access", async () => {
  await withPlatformAuthEnv(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-member-reference-validation-"));
    const dataPath = path.join(tempDir, "state.json");
    const server = await listen(createApp({ dataPath, requireAuth: true, apiToken: "admin-token" }));
    const baseUrl = `http://127.0.0.1:${serverPort(server)}`;
    const ownerCookie = await sessionCookie("auth0|member-ref-owner", "owner-ref@example.com", "Owner Ref", "ws_member_refs");
    const scopedCookie = await sessionCookie("auth0|member-ref-scoped", "scoped-ref@example.com", "Scoped Ref", "ws_member_refs");

    try {
      await getJson(`${baseUrl}/auth/session`, cookieHeaders(ownerCookie));
      const project = await writeJson(`${baseUrl}/api/projects`, cookieHeaders(ownerCookie), { name: "Validated member refs", active: true });
      const otherProject = await writeJson(`${baseUrl}/api/projects`, cookieHeaders(ownerCookie), { name: "Other member refs", active: false });
      const board = await writeJson(`${baseUrl}/api/boards`, cookieHeaders(ownerCookie), {
        name: "Member reference board",
        projectId: project.id,
        lanes: [
          {
            id: "todo",
            title: "To do",
            description: "",
            defaultOwnerAgentId: null,
            defaultReviewerAgentId: null,
            gate: { title: "To do gate", checks: ["Ready"] }
          }
        ],
        agentSpecs: []
      });

      const ownerTeam = await getJson(`${baseUrl}/api/team`, cookieHeaders(ownerCookie));
      const ownerMember = ownerTeam.currentMember;
      assert.ok(ownerMember);

      const invitePayload = await writeJson(`${baseUrl}/api/team/invites`, cookieHeaders(ownerCookie), {
        email: "scoped-ref@example.com",
        role: "member",
        projectIds: [otherProject.id]
      });
      const inviteToken = new URL(invitePayload.acceptUrl).searchParams.get("token") || "";
      await writeJson(`${baseUrl}/api/invites/accept`, cookieHeaders(scopedCookie), { token: inviteToken });
      const teamAfterInvite = await getJson(`${baseUrl}/api/team`, cookieHeaders(ownerCookie));
      const scopedMember = teamAfterInvite.members.find((member: any) => member.email === "scoped-ref@example.com");
      assert.ok(scopedMember);

      const invalidCreate = await fetch(`${baseUrl}/api/boards/${board.id}/work-items`, {
        method: "POST",
        headers: { ...cookieHeaders(ownerCookie), "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Invalid requester",
          laneId: "todo",
          requesterMemberId: "missing-member"
        })
      });
      assert.equal(invalidCreate.status, 400);

      const card = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items`, cookieHeaders(ownerCookie), {
        title: "Valid member references",
        laneId: "todo",
        requesterMemberId: ownerMember.id,
        ownerMemberId: ownerMember.id,
        reviewerMemberId: null
      });
      assert.equal(card.requesterMemberId, ownerMember.id);
      assert.equal(card.ownerMemberId, ownerMember.id);
      assert.equal(card.reviewerMemberId, null);

      const invalidPatch = await fetch(`${baseUrl}/api/boards/${board.id}/work-items/${card.id}`, {
        method: "PATCH",
        headers: { ...cookieHeaders(ownerCookie), "Content-Type": "application/json" },
        body: JSON.stringify({ reviewerMemberId: scopedMember.id })
      });
      assert.equal(invalidPatch.status, 400);

      const cleared = await writeJson(`${baseUrl}/api/boards/${board.id}/work-items/${card.id}`, cookieHeaders(ownerCookie), {
        ownerMemberId: ""
      }, "PATCH");
      assert.equal(cleared.ownerMemberId, null);

      const state = await getJson(`${baseUrl}/api/state`, cookieHeaders(ownerCookie));
      const stateBoard = state.boards.find((candidate: any) => candidate.id === board.id);
      const stateCard = stateBoard.workItems.find((candidate: any) => candidate.id === card.id);
      stateCard.reviewerMemberId = "missing-member";
      const invalidStateWrite = await fetch(`${baseUrl}/api/state`, {
        method: "PUT",
        headers: { ...cookieHeaders(ownerCookie), "Content-Type": "application/json" },
        body: JSON.stringify(state)
      });
      assert.equal(invalidStateWrite.status, 400);
    } finally {
      await closeServer(server);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test("admins can invite admins and members but cannot manage owners", async () => {
  await withPlatformAuthEnv(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-team-admins-"));
    const dataPath = path.join(tempDir, "state.json");
    const server = await listen(createApp({ dataPath, requireAuth: true, apiToken: "admin-token" }));
    const baseUrl = `http://127.0.0.1:${serverPort(server)}`;
    const ownerCookie = await sessionCookie("auth0|owner", "owner@example.com", "Owner User", "ws_team_admins");
    const adminCookie = await sessionCookie("auth0|admin", "admin@example.com", "Admin User", "ws_team_admins");

    try {
      await getJson(`${baseUrl}/auth/session`, cookieHeaders(ownerCookie));
      const adminInvite = await writeJson(`${baseUrl}/api/team/invites`, cookieHeaders(ownerCookie), {
        email: "admin@example.com",
        role: "admin",
        projectIds: ["*"]
      });
      const adminToken = new URL(adminInvite.acceptUrl).searchParams.get("token") || "";
      await writeJson(`${baseUrl}/api/invites/accept`, cookieHeaders(adminCookie), { token: adminToken });

      const ownerTeam = await getJson(`${baseUrl}/api/team`, cookieHeaders(ownerCookie));
      const owner = ownerTeam.members.find((member: any) => member.email === "owner@example.com");
      assert.ok(owner);

      const ownerInviteDenied = await fetch(`${baseUrl}/api/team/invites`, {
        method: "POST",
        headers: { ...cookieHeaders(adminCookie), "Content-Type": "application/json" },
        body: JSON.stringify({ email: "new-owner@example.com", role: "owner", projectIds: ["*"] })
      });
      assert.equal(ownerInviteDenied.status, 403);

      const ownerPatchDenied = await fetch(`${baseUrl}/api/team/members/${owner.id}`, {
        method: "PATCH",
        headers: { ...cookieHeaders(adminCookie), "Content-Type": "application/json" },
        body: JSON.stringify({ role: "member", projectIds: ["*"] })
      });
      assert.equal(ownerPatchDenied.status, 403);

      const memberInvite = await writeJson(`${baseUrl}/api/team/invites`, cookieHeaders(adminCookie), {
        email: "new-member@example.com",
        role: "member",
        projectIds: ["*"]
      });
      assert.equal(memberInvite.invite.role, "member");
      assert.equal(memberInvite.invite.tokenHash, undefined);
    } finally {
      await closeServer(server);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test("agent tokens normalize legacy sessions and reject expired sessions", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-agent-session-store-"));
  const tokenPath = path.join(tempDir, "tokens.json");
  const legacyToken = "kcagt_legacy_token";
  const corruptCapabilitiesToken = "kcagt_corrupt_caps";
  const store = createFileAgentTokenStore(tokenPath);

  try {
    await fs.writeFile(tokenPath, JSON.stringify({
      tokens: [
        {
          id: "agtok_legacy",
          boardId: "board-1",
          agentId: "agent-a",
          label: "Legacy token",
          tokenHash: hashAgentToken(legacyToken),
          last4: legacyToken.slice(-4),
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          revokedAt: null
        },
        {
          id: "agtok_corrupt_caps",
          boardId: "board-1",
          agentId: "agent-a",
          label: "Corrupt capabilities",
          tokenHash: hashAgentToken(corruptCapabilitiesToken),
          last4: corruptCapabilitiesToken.slice(-4),
          capabilities: ["view", "delete-everything"],
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          revokedAt: null
        }
      ]
    }));

    const legacy = await store.verify(legacyToken);
    assert.equal(legacy?.sessionId, "legacy:agtok_legacy");
    assert.deepEqual(legacy?.capabilities, ["view", "create", "update", "comment", "move"]);

    const corruptCapabilities = await store.verify(corruptCapabilitiesToken);
    assert.deepEqual(corruptCapabilities?.capabilities, ["view"]);

    const expired = await store.create({
      boardId: "board-1",
      agentId: "agent-a",
      expiresAt: "2000-01-01T00:00:00.000Z"
    });
    assert.equal(await store.verify(expired.token), null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function bearerHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`
  };
}

function cookieHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie.split(";")[0]
  };
}

async function listen(app: Express): Promise<Server> {
  return new Promise<Server>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function serverPort(server: Server): number {
  return (server.address() as AddressInfo).port;
}

async function getJson<T = any>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function writeJson<T = any>(url: string, headers: Record<string, string>, body: unknown, method = "POST"): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      ...headers,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function withPlatformAuthEnv(run: () => Promise<void>): Promise<void> {
  const restore = setEnv({
    OIDC_ISSUER: "https://auth.example.com/",
    OIDC_CLIENT_ID: "test-client",
    OIDC_REDIRECT_URI: "http://127.0.0.1:4317/auth/callback",
    SESSION_SECRET: "test-session-secret-with-enough-entropy",
    PLATFORM_SURFACE_ID: "kanban.cards"
  });
  try {
    await run();
  } finally {
    restore();
  }
}

async function sessionCookie(userId: string, email: string, name: string, workspaceId: string): Promise<string> {
  return createSessionCookie({
    userId,
    email,
    name,
    workspaceId,
    roles: ["admin"],
    surfaceAccess: ["kanban.cards"]
  }, "test-session-secret-with-enough-entropy", false, 3600);
}

function setEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
