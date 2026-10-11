#!/usr/bin/env node

// src/cli/kanban-cards-client.ts
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
var DEFAULT_BASE_URL = "http://127.0.0.1:4317/api";
var USER_CONFIG_PATH = path.join(os.homedir(), ".kanban-cards", "config.json");
var REPO_CONFIG_NAME = ".kanban-cards.json";
try {
  const [command, ...args] = process.argv.slice(2);
  const options = parseArgs(args);
  const skipsConfig = !command || command === "setup" || command === "help" || command === "--help";
  const userConfig = skipsConfig ? {} : await loadUserConfig();
  const runtime = resolveRuntime(userConfig);
  const result = await run(command, options, runtime);
  if (result !== void 0) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 1;
}
async function run(action, opts, context) {
  if (!action || action === "help" || action === "--help") return usage();
  if (action === "setup") return setup(opts);
  requireToken(context);
  if (action === "session") return request("/session", {}, context);
  if (action === "projects") return request("/projects", {}, context);
  if (action === "create-project") {
    requireOption(opts, "name");
    const body = { name: stringOption(opts, "name") };
    copyTextOption(opts, body, "description");
    if (opts.columns !== void 0) body.columns = columnsOption(opts.columns);
    return request("/projects", {
      method: "POST",
      body,
      idempotencyKey: createIdempotencyKey(opts, "project")
    }, context);
  }
  if (action === "bind") {
    const projectId2 = stringOption(opts, "project");
    await request(`/projects/${encodeURIComponent(projectId2)}`, {}, context);
    const repoRoot = await findRepositoryRoot(repoStart(opts));
    const configPath = path.join(repoRoot, REPO_CONFIG_NAME);
    await assertSafeExistingRepoConfig(configPath);
    await writeJsonAtomic(configPath, { projectId: projectId2 }, 420);
    return { configPath, projectId: projectId2 };
  }
  const projectId = await resolveProjectId(opts);
  const projectPath = `/projects/${encodeURIComponent(projectId)}`;
  if (action === "project") return request(projectPath, {}, context);
  if (action === "update-project") {
    const body = {};
    copyStringOption(opts, body, "name");
    copyTextOption(opts, body, "description");
    if (opts.columns !== void 0) body.columns = columnsOption(opts.columns);
    requireNonEmptyBody(body, action);
    return request(projectPath, {
      method: "PATCH",
      body,
      expectedVersion: stringOption(opts, "version")
    }, context);
  }
  if (action === "cards") {
    assertKnownOptions(opts, ["project", "repo", "next-actor", "priority", "blocked", "include-archived"]);
    const query = new URLSearchParams();
    if (opts["next-actor"] !== void 0) query.set("nextActor", enumOption(opts, "next-actor", ["human", "agent", "unassigned"]));
    if (opts.priority !== void 0) query.set("priority", enumOption(opts, "priority", ["High", "Medium", "Low", "unset"]));
    if (opts.blocked !== void 0) query.set("blocked", enumOption(opts, "blocked", ["true", "false"]));
    if (opts["include-archived"] !== void 0) query.set("includeArchived", enumOption(opts, "include-archived", ["true", "false"]));
    return request(`${projectPath}/cards${query.size ? `?${query}` : ""}`, {}, context);
  }
  if (action === "create-card") {
    assertKnownOptions(opts, ["project", "repo", "title", "body", "column", "position", "external-key", "idempotency-key", "next-actor", "next-action", "priority", "blocked-reason"]);
    requireOption(opts, "title");
    const body = { title: stringOption(opts, "title") };
    copyTextOption(opts, body, "body");
    copyStringOption(opts, body, "column", "columnId");
    copyStringOption(opts, body, "external-key", "externalKey");
    copyCardMetadataOptions(opts, body);
    if (opts.position !== void 0) body.position = numberOption(opts, "position");
    const externalKey = optionalStringOption(opts, "external-key");
    return request(`${projectPath}/cards`, {
      method: "POST",
      body,
      idempotencyKey: createIdempotencyKey(opts, "card", externalKey ? `${projectId}:${externalKey}` : void 0)
    }, context);
  }
  if (action === "update-card") {
    assertKnownOptions(opts, ["project", "repo", "card", "title", "body", "version", "next-actor", "next-action", "priority", "blocked-reason"]);
    const cardId = stringOption(opts, "card");
    const body = {};
    copyStringOption(opts, body, "title");
    copyTextOption(opts, body, "body");
    copyCardMetadataOptions(opts, body);
    requireNonEmptyBody(body, action);
    return request(`${projectPath}/cards/${encodeURIComponent(cardId)}`, {
      method: "PATCH",
      body,
      expectedVersion: stringOption(opts, "version")
    }, context);
  }
  if (action === "move-card") {
    const cardId = stringOption(opts, "card");
    const body = { columnId: stringOption(opts, "column") };
    if (opts.position !== void 0) body.position = numberOption(opts, "position");
    return request(`${projectPath}/cards/${encodeURIComponent(cardId)}`, {
      method: "PATCH",
      body,
      expectedVersion: stringOption(opts, "version")
    }, context);
  }
  if (action === "archive-card") {
    const cardId = stringOption(opts, "card");
    return request(`${projectPath}/cards/${encodeURIComponent(cardId)}`, {
      method: "PATCH",
      body: { archivedAt: (/* @__PURE__ */ new Date()).toISOString() },
      expectedVersion: stringOption(opts, "version")
    }, context);
  }
  if (action === "comment") {
    const cardId = stringOption(opts, "card");
    const body = { body: stringOption(opts, "text") };
    return request(`${projectPath}/cards/${encodeURIComponent(cardId)}/comments`, {
      method: "POST",
      body,
      idempotencyKey: createIdempotencyKey(opts, "comment")
    }, context);
  }
  if (action === "activity") {
    const query = opts.limit === void 0 ? "" : `?limit=${encodeURIComponent(String(positiveIntegerOption(opts, "limit")))}`;
    return request(`${projectPath}/activity${query}`, {}, context);
  }
  throw new Error(`Unknown command: ${action}`);
}
async function setup(opts) {
  if (opts.token !== void 0) {
    throw new Error("Do not pass tokens on the command line. Pipe the token to setup with --token-stdin.");
  }
  if (opts["token-stdin"] !== true) {
    throw new Error("Missing --token-stdin. Pipe the AgentConnection credential to standard input.");
  }
  const token = (await readStdin()).trim();
  if (!token) throw new Error("No token was received on standard input.");
  const apiBaseUrl = normalizeBaseUrl(optionalStringOption(opts, "url") || DEFAULT_BASE_URL);
  const actor = optionalStringOption(opts, "actor") || "codex";
  const session = await request("/session", {}, { baseUrl: apiBaseUrl, token, actor });
  if (!isRecord(session) || session.authenticated !== true || session.context !== "workspace" && session.context !== "local") {
    throw new Error("The credential must authenticate an exact Workspace tenant API.");
  }
  const nextConfig = { apiBaseUrl, token, actor };
  await writeJsonAtomic(USER_CONFIG_PATH, nextConfig, 384);
  return {
    configPath: USER_CONFIG_PATH,
    apiBaseUrl,
    actor,
    tokenConfigured: true
  };
}
async function request(pathname, options, context) {
  const headers = {
    Authorization: `Bearer ${context.token}`,
    "X-Kanban-Actor": context.actor
  };
  if (options.body) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  if (options.expectedVersion) headers["X-Kanban-Version"] = options.expectedVersion;
  const endpoint = `${context.baseUrl}${pathname}`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : void 0
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to reach the kanban.cards API at ${context.baseUrl}: ${detail}`);
  }
  const responseText = await response.text();
  const data = parseResponse(responseText);
  if (!response.ok) {
    const message = isRecord(data) && typeof data.error === "string" ? data.error : `Request failed with ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    throw new Error(message);
  }
  return data;
}
async function loadUserConfig() {
  const parsed = await readJsonIfPresent(USER_CONFIG_PATH);
  if (parsed === void 0) return {};
  if (!isRecord(parsed)) throw new Error(`Invalid user config: ${USER_CONFIG_PATH}`);
  const allowed = /* @__PURE__ */ new Set(["apiBaseUrl", "token", "actor"]);
  const unexpected = Object.keys(parsed).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`Unsupported user config field(s): ${unexpected.join(", ")}`);
  return parsed;
}
function resolveRuntime(config) {
  return {
    baseUrl: normalizeBaseUrl(config.apiBaseUrl || DEFAULT_BASE_URL),
    token: typeof config.token === "string" ? config.token : "",
    actor: typeof config.actor === "string" && config.actor.trim() ? config.actor.trim() : "codex"
  };
}
async function resolveProjectId(opts) {
  const explicit = optionalStringOption(opts, "project");
  if (explicit) return explicit;
  const repoRoot = await findRepositoryRoot(repoStart(opts));
  const configPath = path.join(repoRoot, REPO_CONFIG_NAME);
  const parsed = await readJsonIfPresent(configPath);
  if (parsed === void 0) {
    throw new Error(`No project selected. Pass --project or run bind in ${repoRoot}.`);
  }
  return validateRepoConfig(parsed, configPath).projectId;
}
async function assertSafeExistingRepoConfig(configPath) {
  const parsed = await readJsonIfPresent(configPath);
  if (parsed !== void 0) validateRepoConfig(parsed, configPath);
}
function validateRepoConfig(value, configPath) {
  if (!isRecord(value)) throw new Error(`Invalid repository config: ${configPath}`);
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "projectId") {
    throw new Error(`${configPath} may contain only projectId. Never store a token or API URL in a repository config.`);
  }
  if (typeof value.projectId !== "string" || !value.projectId.trim()) {
    throw new Error(`Invalid projectId in ${configPath}`);
  }
  return { projectId: value.projectId.trim() };
}
async function findRepositoryRoot(start) {
  let current = path.resolve(start);
  const stat = await fs.stat(current).catch(() => void 0);
  if (!stat?.isDirectory()) throw new Error(`Repository path is not a directory: ${current}`);
  while (true) {
    if (await pathExists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No Git repository found from ${start}. Pass --repo with a path inside the repository.`);
    }
    current = parent;
  }
}
function repoStart(opts) {
  return optionalStringOption(opts, "repo") || process.cwd();
}
async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return void 0;
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${filePath}`);
    throw error;
  }
}
async function writeJsonAtomic(filePath, data, mode) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 448 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}
`, { mode });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, mode).catch(() => void 0);
}
function createIdempotencyKey(opts, namespace, stableSeed) {
  const explicit = optionalStringOption(opts, "idempotency-key");
  if (explicit) return explicit;
  if (stableSeed) {
    const digest = createHash("sha256").update(`${namespace}\0${stableSeed}`).digest("hex").slice(0, 32);
    return `kanban-cards-${namespace}-${digest}`;
  }
  return `kanban-cards-${namespace}-${randomUUID()}`;
}
function columnsOption(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing --columns");
  const text = value.trim();
  if (text.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("--columns must be a comma-separated list or a JSON array.");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("--columns must contain at least one column.");
    return parsed.map((column, index) => normalizeColumn(column, index));
  }
  const columns = text.split(",").map((column) => column.trim()).filter(Boolean);
  if (!columns.length) throw new Error("--columns must contain at least one column.");
  return columns.map((name, position) => ({ name, position }));
}
function normalizeColumn(value, index) {
  if (typeof value === "string" && value.trim()) return { name: value.trim(), position: index };
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) {
    throw new Error(`Column ${index + 1} must be a name or an object with a name.`);
  }
  const column = { name: value.name.trim() };
  if (value.id !== void 0) {
    if (typeof value.id !== "string" || !value.id.trim()) throw new Error(`Column ${index + 1} has an invalid id.`);
    column.id = value.id.trim();
  }
  if (value.position !== void 0) {
    if (typeof value.position !== "number" || !Number.isFinite(value.position) || value.position < 0) {
      throw new Error(`Column ${index + 1} has an invalid position.`);
    }
    column.position = value.position;
  }
  return column;
}
function copyStringOption(opts, body, option, field = option) {
  if (opts[option] !== void 0) body[field] = stringOption(opts, option);
}
function copyTextOption(opts, body, option, field = option) {
  if (opts[option] === void 0) return;
  if (typeof opts[option] !== "string") throw new Error(`Missing --${option}`);
  body[field] = opts[option];
}
function copyCardMetadataOptions(opts, body) {
  if (opts["next-actor"] !== void 0) {
    const value = enumOption(opts, "next-actor", ["human", "agent", "unassigned"]);
    body.nextActor = value === "unassigned" ? null : value;
  }
  copyTextOption(opts, body, "next-action", "nextAction");
  if (opts.priority !== void 0) {
    const value = enumOption(opts, "priority", ["High", "Medium", "Low", "unset"]);
    body.priority = value === "unset" ? null : value;
  }
  copyTextOption(opts, body, "blocked-reason", "blockedReason");
}
function enumOption(opts, key, allowed) {
  const value = stringOption(opts, key);
  if (!allowed.includes(value)) throw new Error(`--${key} must be one of: ${allowed.join(", ")}.`);
  return value;
}
function assertKnownOptions(opts, allowed) {
  const unexpected = Object.keys(opts).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`Unsupported option(s): ${unexpected.map((key) => `--${key}`).join(", ")}`);
}
function optionalStringOption(opts, key) {
  const value = opts[key];
  if (value === void 0) return void 0;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing --${key}`);
  return value.trim();
}
function stringOption(opts, key) {
  const value = optionalStringOption(opts, key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}
function numberOption(opts, key) {
  const value = Number(stringOption(opts, key));
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${key} must be a non-negative number.`);
  return value;
}
function positiveIntegerOption(opts, key) {
  const value = numberOption(opts, key);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${key} must be a positive integer.`);
  return value;
}
function requireOption(opts, key) {
  stringOption(opts, key);
}
function requireNonEmptyBody(body, command) {
  if (!Object.keys(body).length) throw new Error(`${command} requires at least one field to update.`);
}
function requireToken(context) {
  if (!context.token) throw new Error("Run setup with --token-stdin before using the API.");
}
function normalizeBaseUrl(value) {
  const normalized = value.trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("The API URL must be an absolute http:// or https:// URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The API URL must use http:// or https://.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("The API URL must not contain credentials, a query, or a fragment.");
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("A non-loopback kanban.cards API requires https:// so the AgentConnection credential is encrypted in transit.");
  }
  return normalized;
}
function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized.startsWith("127.") || normalized === "[::1]" || normalized === "::1";
}
function parseResponse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const equalsIndex = value.indexOf("=");
    const key = equalsIndex > 2 ? value.slice(2, equalsIndex) : value.slice(2);
    if (Object.hasOwn(parsed, key)) throw new Error(`Repeated option: --${key}. Supply each option once.`);
    if (equalsIndex > 2) {
      parsed[key] = value.slice(equalsIndex + 1);
      continue;
    }
    const next = values[index + 1];
    if (next === void 0 || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
function usage() {
  return {
    userConfig: USER_CONFIG_PATH,
    repositoryConfig: REPO_CONFIG_NAME,
    commands: [
      "setup [--url <api-url>] [--actor <label>] --token-stdin",
      "session",
      "projects",
      "create-project --name <name> [--description <text>] [--columns <comma-list-or-json>] [--idempotency-key <key>]",
      "bind --project <project-id> [--repo <path>]",
      "project [--project <project-id>] [--repo <path>]",
      "update-project [--project <project-id>] [--name <name>] [--description <text>] [--columns <comma-list-or-json>] --version <version>",
      "cards [--project <project-id>] [--next-actor human|agent|unassigned] [--priority High|Medium|Low|unset] [--blocked true|false] [--include-archived true|false]",
      "create-card [--project <project-id>] --title <title> [--body <text>] [--column <column-id>] [--position <number>] [--external-key <key>] [--idempotency-key <key>] [--next-actor human|agent|unassigned] [--next-action <text>] [--priority High|Medium|Low|unset] [--blocked-reason <text>]",
      "update-card [--project <project-id>] --card <card-id> [--title <title>] [--body <text>] [--next-actor human|agent|unassigned] [--next-action <text>] [--priority High|Medium|Low|unset] [--blocked-reason <text>] --version <version>",
      "move-card [--project <project-id>] --card <card-id> --column <column-id> [--position <number>] --version <version>",
      "archive-card [--project <project-id>] --card <card-id> --version <version>",
      "comment [--project <project-id>] --card <card-id> --text <text> [--idempotency-key <key>]",
      "activity [--project <project-id>] [--limit <count>]"
    ]
  };
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
async function pathExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isNodeError(error) {
  return error instanceof Error;
}
