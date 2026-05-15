#!/usr/bin/env node

const baseUrl = (process.env.KANBAN_CARDS_API_BASE_URL || process.env.INSTRUCT_API_BASE_URL || "http://127.0.0.1:4317/api").replace(/\/$/, "");
const token = process.env.KANBAN_CARDS_API_TOKEN || process.env.INSTRUCT_API_TOKEN || "";

const [command, ...args] = process.argv.slice(2);
const options = parseArgs(args);

try {
  const result = await run(command, options);
  if (result !== undefined) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

async function run(action, opts) {
  if (!action || action === "help" || action === "--help") return usage();

  if (action === "health") return request("/health");
  if (action === "state") return request("/state");
  if (action === "boards") return request("/boards");

  if (action === "board") {
    requireOption(opts, "board");
    return request(`/boards/${encodeURIComponent(opts.board)}`);
  }

  if (action === "instructions") {
    const query = opts.agent ? `?agentId=${encodeURIComponent(opts.agent)}` : "";
    return request(`/agent/instructions${query}`);
  }

  if (action === "create-card" || action === "create-item") {
    requireToken();
    requireOption(opts, "board");
    requireOption(opts, "title");
    return request(`/boards/${encodeURIComponent(opts.board)}/work-items`, {
      method: "POST",
      body: {
        title: opts.title,
        summary: opts.summary || "",
        laneId: opts.lane,
        ownerAgentId: opts.owner,
        reviewerAgentId: opts.reviewer
      }
    });
  }

  if (action === "move-card" || action === "move-item") {
    requireToken();
    requireOption(opts, "board");
    requireOption(opts, "item");
    requireOption(opts, "lane");
    return request(`/boards/${encodeURIComponent(opts.board)}/work-items/${encodeURIComponent(opts.item)}`, {
      method: "PATCH",
      body: { laneId: opts.lane }
    });
  }

  if (action === "update-card" || action === "update-item") {
    requireToken();
    requireOption(opts, "board");
    requireOption(opts, "item");
    const body = {};
    for (const key of ["title", "summary", "owner", "reviewer", "lane"]) {
      if (!opts[key]) continue;
      if (key === "owner") body.ownerAgentId = opts[key];
      else if (key === "reviewer") body.reviewerAgentId = opts[key];
      else if (key === "lane") body.laneId = opts[key];
      else body[key] = opts[key];
    }
    return request(`/boards/${encodeURIComponent(opts.board)}/work-items/${encodeURIComponent(opts.item)}`, {
      method: "PATCH",
      body
    });
  }

  if (action === "comment") {
    requireToken();
    requireOption(opts, "board");
    requireOption(opts, "item");
    requireOption(opts, "text");
    return request(`/boards/${encodeURIComponent(opts.board)}/work-items/${encodeURIComponent(opts.item)}/comments`, {
      method: "POST",
      body: {
        kind: opts.kind || "progress",
        status: opts.status || "open",
        author: opts.author || opts.agent || "agent",
        text: opts.text
      }
    });
  }

  if (action === "resolve-comment" || action === "ack-comment") {
    requireToken();
    requireOption(opts, "board");
    requireOption(opts, "item");
    requireOption(opts, "comment");
    const status = action === "ack-comment" ? "acknowledged" : "resolved";
    return request(`/boards/${encodeURIComponent(opts.board)}/work-items/${encodeURIComponent(opts.item)}/comments/${encodeURIComponent(opts.comment)}`, {
      method: "PATCH",
      body: { status }
    });
  }

  throw new Error(`Unknown command: ${action}`);
}

async function request(path, options = {}) {
  const headers = {};
  if (options.body) headers["Content-Type"] = "application/json";
  if (options.method && options.method !== "GET") {
    requireToken();
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.error || `Request failed with ${response.status}`);
  }
  return data;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function requireOption(opts, key) {
  if (!opts[key]) throw new Error(`Missing --${key}`);
}

function requireToken() {
  if (!token) throw new Error("Set KANBAN_CARDS_API_TOKEN for write operations.");
}

function usage() {
  return {
    commands: [
      "health",
      "state",
      "boards",
      "board --board <board-id>",
      "instructions --agent <agent-id>",
      "create-card --board <board-id> --title <title> [--lane <lane-id>] [--owner <agent-id>] [--reviewer <agent-id>]",
      "move-card --board <board-id> --item <card-id> --lane <lane-id>",
      "update-card --board <board-id> --item <card-id> [--title <title>] [--summary <summary>] [--lane <lane-id>] [--owner <agent-id>] [--reviewer <agent-id>]",
      "comment --board <board-id> --item <card-id> --text <text> [--kind progress|instruction|question|change_request|note] [--status open|acknowledged|resolved] [--author <name>]",
      "ack-comment --board <board-id> --item <card-id> --comment <comment-id>",
      "resolve-comment --board <board-id> --item <card-id> --comment <comment-id>"
    ]
  };
}
