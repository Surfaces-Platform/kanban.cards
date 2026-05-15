const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApp } = require("../server");

test("private beta auth protects the UI without exposing the agent token", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kanban-cards-auth-"));
  const dataPath = path.join(tempDir, "state.json");
  const server = await listen(createApp({
    dataPath,
    requireAuth: true,
    apiToken: "agent-token",
    basicUser: "mike",
    basicPassword: "secret"
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const denied = await fetch(`${baseUrl}/`);
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("www-authenticate") || "", /kanban\.cards/);

    const html = await text(`${baseUrl}/`, basicHeaders("mike", "secret"));
    assert.match(html, /kanban\.cards/);
    assert.doesNotMatch(html, /KANBAN_CARDS_API_TOKEN|INSTRUCT_API_TOKEN|agent-token/);

    const state = await getJson(`${baseUrl}/api/state`, basicHeaders("mike", "secret"));
    assert.equal(state.boards[0].name, "Untitled board");

    const saved = await writeJson(`${baseUrl}/api/state`, basicHeaders("mike", "secret"), state, "PUT");
    assert.equal(saved.boards[0].name, "Untitled board");

    const board = await writeJson(`${baseUrl}/api/boards`, bearerHeaders("agent-token"), { name: "Agent board" });
    assert.equal(board.name, "Agent board");
  } finally {
    await closeServer(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("production-like auth reports missing required secrets", async () => {
  const server = await listen(createApp({ requireAuth: true, apiToken: "", basicUser: "", basicPassword: "" }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 500);
    const body = await health.json();
    assert.deepEqual(body.missingConfig, [
      "KANBAN_CARDS_API_TOKEN",
      "KANBAN_CARDS_BASIC_USER",
      "KANBAN_CARDS_BASIC_PASSWORD"
    ]);
  } finally {
    await closeServer(server);
  }
});

function basicHeaders(user, password) {
  return {
    Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
  };
}

function bearerHeaders(token) {
  return {
    Authorization: `Bearer ${token}`
  };
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function text(url, headers = {}) {
  const response = await fetch(url, { headers });
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return response.text();
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return response.json();
}

async function writeJson(url, headers, body, method = "POST") {
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
  return response.json();
}
