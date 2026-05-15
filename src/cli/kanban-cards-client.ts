import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_BASE_URL = "http://127.0.0.1:4317/api";

type CliOptions = Record<string, string | boolean | undefined>;
interface CliConfig {
  apiBaseUrl?: string;
  token?: string;
  boardId?: string;
  agentId?: string;
}
interface RuntimeContext {
  baseUrl: string;
  token: string;
  boardId: string;
  agentId: string;
}
interface RequestOptions {
  method?: string;
  body?: Record<string, unknown>;
}

const [command, ...args] = process.argv.slice(2);
const options = parseArgs(args);
const config = await loadConfig(options.config);
const runtime = resolveRuntime(config);

try {
  const result = await run(command, options, runtime);
  if (result !== undefined) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

async function run(action: string | undefined, opts: CliOptions, context: RuntimeContext): Promise<unknown> {
  if (!action || action === "help" || action === "--help") return usage();

  if (action === "setup") return setup(opts);
  if (action === "config") return effectiveConfig(context);
  if (action === "health") return request("/health", {}, context);
  if (action === "state") return request("/state", {}, context);
  if (action === "boards") return request("/boards", {}, context);
  if (action === "session") return request("/agent/session", {}, context);

  if (action === "board") {
    const boardId = opts.board || context.boardId;
    requireValue(boardId, "board");
    return request(`/boards/${encodeURIComponent(boardId)}`, {}, context);
  }

  if (action === "instructions") {
    const agentId = opts.agent || context.agentId;
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
    return request(`/agent/instructions${query}`, {}, context);
  }

  if (action === "create-card" || action === "create-item") {
    requireToken(context);
    const boardId = opts.board || context.boardId;
    requireValue(boardId, "board");
    requireOption(opts, "title");
    return request(`/boards/${encodeURIComponent(boardId)}/work-items`, {
      method: "POST",
      body: {
        title: opts.title,
        summary: opts.summary || "",
        laneId: opts.lane,
        ownerAgentId: opts.owner || context.agentId,
        reviewerAgentId: opts.reviewer
      }
    }, context);
  }

  if (action === "move-card" || action === "move-item") {
    requireToken(context);
    const boardId = opts.board || context.boardId;
    requireValue(boardId, "board");
    requireOption(opts, "item");
    requireOption(opts, "lane");
    const itemId = String(opts.item);
    return request(`/boards/${encodeURIComponent(boardId)}/work-items/${encodeURIComponent(itemId)}`, {
      method: "PATCH",
      body: { laneId: opts.lane }
    }, context);
  }

  if (action === "update-card" || action === "update-item") {
    requireToken(context);
    const boardId = opts.board || context.boardId;
    requireValue(boardId, "board");
    requireOption(opts, "item");
    const itemId = String(opts.item);
    const body: Record<string, unknown> = {};
    for (const key of ["title", "summary", "owner", "reviewer", "lane"]) {
      if (opts[key] === undefined) continue;
      if (key === "owner") body.ownerAgentId = opts[key];
      else if (key === "reviewer") body.reviewerAgentId = opts[key];
      else if (key === "lane") body.laneId = opts[key];
      else body[key] = opts[key];
    }
    for (const key of ["completed", "delivered"]) {
      if (opts[key] === undefined) continue;
      body[key] = booleanOption(opts[key], key);
    }
    return request(`/boards/${encodeURIComponent(boardId)}/work-items/${encodeURIComponent(itemId)}`, {
      method: "PATCH",
      body
    }, context);
  }

  if (action === "approve-card" || action === "approve-item") {
    requireToken(context);
    const boardId = opts.board || context.boardId;
    requireValue(boardId, "board");
    requireOption(opts, "item");
    const itemId = String(opts.item);
    const board = await request(`/boards/${encodeURIComponent(boardId)}`, {}, context) as { workItems?: Array<{ id?: string; approvals?: unknown[] }> };
    const item = board.workItems?.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error("Card not found.");
    const approvals = Array.isArray(item.approvals) ? item.approvals : [];
    return request(`/boards/${encodeURIComponent(boardId)}/work-items/${encodeURIComponent(itemId)}`, {
      method: "PATCH",
      body: {
        approvals: [
          ...approvals,
          {
            author: opts.author || opts.agent || context.agentId || "agent",
            text: opts.text || "Approved.",
            createdAt: new Date().toISOString()
          }
        ]
      }
    }, context);
  }

  if (action === "comment") {
    requireToken(context);
    const boardId = opts.board || context.boardId;
    requireValue(boardId, "board");
    requireOption(opts, "item");
    requireOption(opts, "text");
    const itemId = String(opts.item);
    return request(`/boards/${encodeURIComponent(boardId)}/work-items/${encodeURIComponent(itemId)}/comments`, {
      method: "POST",
      body: {
        kind: opts.kind || "progress",
        status: opts.status || "open",
        author: opts.author || opts.agent || context.agentId || "agent",
        text: opts.text
      }
    }, context);
  }

  if (action === "resolve-comment" || action === "ack-comment") {
    requireToken(context);
    const boardId = opts.board || context.boardId;
    requireValue(boardId, "board");
    requireOption(opts, "item");
    requireOption(opts, "comment");
    const itemId = String(opts.item);
    const commentId = String(opts.comment);
    const status = action === "ack-comment" ? "acknowledged" : "resolved";
    return request(`/boards/${encodeURIComponent(boardId)}/work-items/${encodeURIComponent(itemId)}/comments/${encodeURIComponent(commentId)}`, {
      method: "PATCH",
      body: { status }
    }, context);
  }

  throw new Error(`Unknown command: ${action}`);
}

async function setup(opts: CliOptions): Promise<Record<string, unknown>> {
  requireOption(opts, "url");
  requireOption(opts, "token");
  requireOption(opts, "board");
  requireOption(opts, "agent");

  const configPath = resolveConfigPath(opts.config);
  const nextConfig = {
    apiBaseUrl: String(opts.url).replace(/\/$/, ""),
    token: String(opts.token),
    boardId: String(opts.board),
    agentId: String(opts.agent)
  };

  await writeConfig(configPath, nextConfig);
  return {
    configPath,
    apiBaseUrl: nextConfig.apiBaseUrl,
    boardId: nextConfig.boardId,
    agentId: nextConfig.agentId,
    tokenConfigured: true
  };
}

async function request(pathname: string, options: RequestOptions = {}, context: RuntimeContext): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (options.body) headers["Content-Type"] = "application/json";
  if (context.token) headers.Authorization = `Bearer ${context.token}`;

  const response = await fetch(`${context.baseUrl}${pathname}`, {
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

async function loadConfig(customPath: string | boolean | undefined): Promise<CliConfig> {
  const configPath = resolveConfigPath(customPath);
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeConfig(configPath: string, data: CliConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, configPath);
  await fs.chmod(configPath, 0o600).catch(() => undefined);
}

function resolveRuntime(config: CliConfig): RuntimeContext {
  return {
    baseUrl: (process.env.KANBAN_CARDS_API_BASE_URL || process.env.INSTRUCT_API_BASE_URL || config.apiBaseUrl || DEFAULT_BASE_URL).replace(/\/$/, ""),
    token: process.env.KANBAN_CARDS_API_TOKEN || process.env.INSTRUCT_API_TOKEN || config.token || "",
    boardId: process.env.KANBAN_CARDS_BOARD_ID || config.boardId || "",
    agentId: process.env.KANBAN_CARDS_AGENT_ID || config.agentId || ""
  };
}

function effectiveConfig(context: RuntimeContext): Record<string, unknown> {
  return {
    apiBaseUrl: context.baseUrl,
    boardId: context.boardId || null,
    agentId: context.agentId || null,
    tokenConfigured: Boolean(context.token)
  };
}

function resolveConfigPath(customPath: string | boolean | undefined): string {
  if (customPath && typeof customPath === "string") return path.resolve(expandHome(customPath));
  return path.join(os.homedir(), ".kanban-cards", "config.json");
}

function expandHome(value: string): string {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function parseArgs(values: string[]): CliOptions {
  const parsed: CliOptions = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const equalsIndex = value.indexOf("=");
    if (equalsIndex > 2) {
      parsed[value.slice(2, equalsIndex)] = value.slice(equalsIndex + 1);
      continue;
    }
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

function requireOption(opts: CliOptions, key: string): void {
  requireValue(opts[key], key);
}

function requireValue(value: unknown, key: string): asserts value {
  if (!value) throw new Error(`Missing --${key}`);
}

function requireToken(context: RuntimeContext): void {
  if (!context.token) throw new Error("Run setup or set KANBAN_CARDS_API_TOKEN for write operations.");
}

function usage(): Record<string, unknown> {
  return {
    configFile: "~/.kanban-cards/config.json",
    envPrecedence: [
      "KANBAN_CARDS_API_BASE_URL",
      "KANBAN_CARDS_API_TOKEN",
      "KANBAN_CARDS_BOARD_ID",
      "KANBAN_CARDS_AGENT_ID"
    ],
    commands: [
      "setup --url <api-url> --token <token> --board <board-id> --agent <agent-id>",
      "config",
      "health",
      "session",
      "state",
      "boards",
      "board [--board <board-id>]",
      "instructions [--agent <agent-id>]",
      "create-card [--board <board-id>] --title <title> [--lane <lane-id>] [--owner <agent-id>] [--reviewer <agent-id>]",
      "move-card [--board <board-id>] --item <card-id> --lane <lane-id>",
      "update-card [--board <board-id>] --item <card-id> [--title <title>] [--summary <summary>] [--lane <lane-id>] [--owner <agent-id>] [--reviewer <agent-id>] [--completed true|false] [--delivered true|false]",
      "approve-card [--board <board-id>] --item <card-id> [--text <text>] [--author <name>]",
      "comment [--board <board-id>] --item <card-id> --text <text> [--kind progress|instruction|question|change_request|note] [--status open|acknowledged|resolved] [--author <name>]",
      "ack-comment [--board <board-id>] --item <card-id> --comment <comment-id>",
      "resolve-comment [--board <board-id>] --item <card-id> --comment <comment-id>"
    ]
  };
}

function booleanOption(value: string | boolean | undefined, key: string): boolean {
  if (value === true) return true;
  if (value === false) return false;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`--${key} must be true or false.`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
