import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import express, { type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from "express";

import { createStateStore } from "./state-store";
import type {
  Activity,
  ActivityActor,
  Card,
  Column,
  Comment,
  IdempotencyRecord,
  JsonValue,
  Project,
  StateStore,
  StateStoreOptions,
  WorkspaceState
} from "./types";

type AuthMethod = "bearer" | "cookie";

interface OwnerAuth {
  method: AuthMethod;
  actor: ActivityActor;
}

declare global {
  namespace Express {
    interface Request {
      ownerAuth?: OwnerAuth;
    }
  }
}

export interface CreateAppOptions extends StateStoreOptions {
  staticDir?: string;
  dataPath?: string;
  requireDatabase?: boolean;
  apiToken?: string;
  ownerLabel?: string;
  sessionTtlSeconds?: number;
  store?: StateStore;
  host?: string;
  port?: string | number;
}

interface HttpError extends Error {
  status?: number;
}

interface MutationResult {
  statusCode: number;
  response: JsonValue;
  replayed: boolean;
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>;
type UnknownRecord = Record<string, unknown>;

const PRODUCT_NAME = "kanban.cards";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const SESSION_COOKIE = "kanban_cards_session";
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_ACTIVITY = 1_000;
const MAX_IDEMPOTENCY_RECORDS = 1_000;
const DEFAULT_COLUMNS = ["Inbox", "Next", "Doing", "Done"];
const FALLBACK_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>kanban.cards</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="app"><main class="centered-view"><strong>kanban.cards</strong><p>Opening your projects…</p></main></div>
  <div class="toast-region" id="toast-region" aria-live="polite"></div>
  <script src="app.js"></script>
</body>
</html>`;

export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();
  const staticDir = options.staticDir || process.cwd();
  const configuredHost = options.host || process.env.HOST || DEFAULT_HOST;
  const production = Boolean(process.env.VERCEL || process.env.NODE_ENV === "production" || !isLoopbackHost(configuredHost));
  const apiToken = String(options.apiToken ?? process.env.KANBAN_CARDS_API_TOKEN ?? "").trim();
  const ownerLabel = cleanLabel(options.ownerLabel ?? process.env.KANBAN_CARDS_OWNER_LABEL ?? "Owner", "Owner");
  const databaseRequired = options.requireDatabase ?? production;
  const connectionString = options.connectionString || process.env.KANBAN_CARDS_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  const sessionTtlSeconds = positiveInteger(
    options.sessionTtlSeconds ?? process.env.KANBAN_CARDS_SESSION_TTL_SECONDS,
    DEFAULT_SESSION_TTL_SECONDS
  );
  const missingConfiguration = [
    ...(!apiToken ? ["KANBAN_CARDS_API_TOKEN"] : []),
    ...(databaseRequired && !connectionString ? ["KANBAN_CARDS_DATABASE_URL or POSTGRES_URL or DATABASE_URL"] : [])
  ];
  const store = options.store || createStateStore({
    dataPath: options.dataPath,
    connectionString,
    tableName: options.tableName,
    workspaceId: options.workspaceId,
    pool: options.pool,
    ssl: options.ssl
  });

  app.disable("x-powered-by");
  app.use(securityHeaders());
  app.use(express.json({ limit: "256kb", type: "application/json" }));

  app.get("/api/health", (_req, res) => {
    res.status(missingConfiguration.length ? 503 : 200).json({
      ok: missingConfiguration.length === 0,
      product: PRODUCT_NAME,
      schemaVersion: 2,
      store: store.kind,
      authentication: "owner-key",
      missingConfiguration
    });
  });

  app.get("/api/session", (req, res) => {
    noStore(res);
    const auth = authenticate(req, { apiToken, ownerLabel });
    if (!auth) {
      res.json({ authenticated: false });
      return;
    }
    res.json({ authenticated: true, label: auth.actor.label });
  });

  app.post("/api/session", asyncHandler(async (req, res) => {
    noStore(res);
    assertRequestOrigin(req, false);
    if (!apiToken) throw httpError(503, "Owner authentication is not configured.");
    const suppliedToken = requiredString(asRecord(req.body).token, "Access key");
    if (!safeEqual(suppliedToken, apiToken)) throw httpError(401, "Invalid access key.");
    const expiresAt = Math.floor(Date.now() / 1_000) + sessionTtlSeconds;
    res.cookie(SESSION_COOKIE, createSessionValue(expiresAt, apiToken), {
      httpOnly: true,
      secure: production,
      sameSite: "lax",
      path: "/",
      maxAge: sessionTtlSeconds * 1_000
    });
    res.json({ authenticated: true, label: ownerLabel });
  }));

  app.delete("/api/session", (req, res) => {
    noStore(res);
    assertRequestOrigin(req, false);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: production, sameSite: "lax", path: "/" });
    res.status(204).end();
  });

  app.get("/", serveIndex(staticDir));
  app.get("/index.html", serveIndex(staticDir));
  app.get("/app.js", sendStaticFile(staticDir, "public/app.js", "application/javascript; charset=utf-8"));
  app.get("/styles.css", sendStaticFile(staticDir, "public/styles.css", "text/css; charset=utf-8"));
  app.get("/robots.txt", sendStaticFile(staticDir, "public/robots.txt", "text/plain; charset=utf-8"));
  app.get("/favicon.ico", (_req, res) => res.status(204).end());

  app.use("/api/projects", (req, _res, next) => {
    if (missingConfiguration.length) throw httpError(503, `Missing required configuration: ${missingConfiguration.join(", ")}.`);
    const auth = authenticate(req, { apiToken, ownerLabel });
    if (!auth) throw httpError(401, "Authentication required.");
    req.ownerAuth = auth;
    if (req.method !== "GET" && req.method !== "HEAD" && auth.method === "cookie") assertRequestOrigin(req, true);
    next();
  });

  app.get("/api/projects", asyncHandler(async (req, res) => {
    noStore(res);
    const includeArchived = req.query.includeArchived === "true";
    const state = await store.read();
    res.json({ projects: state.projects.filter((project) => includeArchived || !project.archivedAt).map(projectSummary) });
  }));

  app.post("/api/projects", asyncHandler(async (req, res) => {
    const body = asRecord(req.body);
    const actor = requireActor(req);
    const outcome = (await store.update((state) => idempotentMutation(req, state, () => {
      const now = new Date().toISOString();
      const project: Project = {
        id: makeId("project"),
        name: requiredString(body.name, "Project name"),
        description: optionalText(body.description),
        columns: normalizeColumns(body.columns, undefined),
        cards: [],
        activity: [],
        revision: 1,
        archivedAt: null,
        createdAt: now,
        updatedAt: now
      };
      addActivity(project, actor, "project.created", `Created project ${project.name}.`);
      state.projects.push(project);
      return { statusCode: 201, response: jsonValue({ project }) };
    }))).result;
    sendMutation(res, outcome);
  }));

  app.get("/api/projects/:projectId", asyncHandler(async (req, res) => {
    noStore(res);
    const project = findProject(await store.read(), routeParam(req, "projectId"));
    res.setHeader("ETag", quoteVersion(project.revision));
    res.json({ project });
  }));

  app.patch("/api/projects/:projectId", asyncHandler(async (req, res) => {
    const projectId = routeParam(req, "projectId");
    const actor = requireActor(req);
    const body = asRecord(req.body);
    const expectedRevision = requiredMatch(req, "Project revision");
    const { result } = await store.update((state) => {
      const project = findProject(state, projectId);
      assertVersion(project.revision, expectedRevision, "Project");
      let changed = false;
      if (hasOwn(body, "name")) {
        project.name = requiredString(body.name, "Project name");
        changed = true;
      }
      if (hasOwn(body, "description")) {
        project.description = optionalText(body.description);
        changed = true;
      }
      if (hasOwn(body, "columns")) {
        const columns = normalizeColumns(body.columns, project.columns);
        const columnIds = new Set(columns.map((column) => column.id));
        const strandedCard = project.cards.find((card) => !columnIds.has(card.columnId));
        if (strandedCard) throw httpError(409, `Column ${strandedCard.columnId} still contains card ${strandedCard.id}.`);
        project.columns = columns;
        changed = true;
      }
      if (hasOwn(body, "archivedAt")) {
        project.archivedAt = nullableTimestamp(body.archivedAt, "Project archivedAt");
        changed = true;
      }
      if (!changed) throw httpError(400, "No supported project changes were provided.");
      touchProject(project);
      addActivity(project, actor, project.archivedAt ? "project.archived" : "project.updated", `Updated project ${project.name}.`);
      return { project };
    });
    res.setHeader("ETag", quoteVersion(result.project.revision));
    res.json(result);
  }));

  app.post("/api/projects/:projectId/cards", asyncHandler(async (req, res) => {
    const projectId = routeParam(req, "projectId");
    const actor = requireActor(req);
    const body = asRecord(req.body);
    const outcome = (await store.update((state) => idempotentMutation(req, state, () => {
      const project = findProject(state, projectId);
      assertProjectWritable(project);
      const externalKey = optionalString(body.externalKey);
      if (externalKey) {
        const existing = project.cards.find((card) => card.externalKey === externalKey);
        if (existing) {
          return {
            statusCode: 200,
            response: jsonValue({ card: existing, projectRevision: project.revision, deduplicated: true })
          };
        }
      }
      const columnId = optionalString(body.columnId) || project.columns[0]?.id;
      if (!columnId || !project.columns.some((column) => column.id === columnId)) throw httpError(400, "A valid columnId is required.");
      const now = new Date().toISOString();
      const card: Card = {
        id: makeId("card"),
        ...(externalKey ? { externalKey } : {}),
        title: requiredString(body.title, "Card title"),
        body: optionalText(body.body),
        columnId,
        position: optionalPosition(body.position, nextCardPosition(project, columnId)),
        version: 1,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        comments: []
      };
      project.cards.push(card);
      touchProject(project);
      addActivity(project, actor, "card.created", `Created card ${card.title}.`, card.id);
      return { statusCode: 201, response: jsonValue({ card, projectRevision: project.revision }) };
    }))).result;
    sendMutation(res, outcome);
  }));

  app.patch("/api/projects/:projectId/cards/:cardId", asyncHandler(async (req, res) => {
    const projectId = routeParam(req, "projectId");
    const cardId = routeParam(req, "cardId");
    const actor = requireActor(req);
    const body = asRecord(req.body);
    const expectedVersion = requiredMatch(req, "Card version");
    const { result } = await store.update((state) => {
      const project = findProject(state, projectId);
      assertProjectWritable(project);
      const card = findCard(project, cardId);
      assertVersion(card.version, expectedVersion, "Card");
      let changed = false;
      let moved = false;
      if (hasOwn(body, "title")) {
        card.title = requiredString(body.title, "Card title");
        changed = true;
      }
      if (hasOwn(body, "body")) {
        card.body = optionalText(body.body);
        changed = true;
      }
      if (hasOwn(body, "columnId")) {
        const columnId = requiredString(body.columnId, "Card columnId");
        if (!project.columns.some((column) => column.id === columnId)) throw httpError(400, "Card columnId does not exist in this project.");
        moved = columnId !== card.columnId;
        card.columnId = columnId;
        if (!hasOwn(body, "position") && moved) card.position = nextCardPosition(project, columnId, card.id);
        changed = true;
      }
      if (hasOwn(body, "position")) {
        card.position = optionalPosition(body.position, card.position);
        changed = true;
      }
      if (hasOwn(body, "archivedAt")) {
        card.archivedAt = nullableTimestamp(body.archivedAt, "Card archivedAt");
        changed = true;
      }
      if (!changed) throw httpError(400, "No supported card changes were provided.");
      touchCard(card);
      touchProject(project);
      const action = card.archivedAt ? "card.archived" : moved ? "card.moved" : "card.updated";
      addActivity(project, actor, action, `${formatAction(action)} ${card.title}.`, card.id);
      return { card, projectRevision: project.revision };
    });
    res.setHeader("ETag", quoteVersion(result.card.version));
    res.json(result);
  }));

  app.post("/api/projects/:projectId/cards/:cardId/comments", asyncHandler(async (req, res) => {
    const projectId = routeParam(req, "projectId");
    const cardId = routeParam(req, "cardId");
    const actor = requireActor(req);
    const body = asRecord(req.body);
    const outcome = (await store.update((state) => idempotentMutation(req, state, () => {
      const project = findProject(state, projectId);
      assertProjectWritable(project);
      const card = findCard(project, cardId);
      const comment: Comment = {
        id: makeId("comment"),
        body: requiredString(body.body, "Comment body"),
        author: actor.label,
        createdAt: new Date().toISOString()
      };
      card.comments.push(comment);
      touchCard(card);
      touchProject(project);
      addActivity(project, actor, "comment.created", `${actor.label} commented on ${card.title}.`, card.id);
      return {
        statusCode: 201,
        response: jsonValue({
          comment,
          card: { id: card.id, version: card.version },
          projectRevision: project.revision
        })
      };
    }))).result;
    sendMutation(res, outcome);
  }));

  app.get("/api/projects/:projectId/activity", asyncHandler(async (req, res) => {
    noStore(res);
    const project = findProject(await store.read(), routeParam(req, "projectId"));
    const limit = boundedInteger(req.query.limit, 50, 1, 200);
    res.json({ activity: project.activity.slice(-limit), projectRevision: project.revision });
  }));

  app.use("/api", (_req, _res, next) => next(httpError(404, "API route not found.")));
  app.use((req, res) => {
    res.status(404).type("text/plain").send(`Not found: ${req.path}`);
  });
  app.use(errorHandler());

  return app;
}

function securityHeaders(): RequestHandler {
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'"
    );
    if (req.path.startsWith("/api/")) noStore(res);
    next();
  };
}

function authenticate(
  req: Request,
  config: { apiToken: string; ownerLabel: string }
): OwnerAuth | null {
  const authorization = req.get("authorization") || "";
  if (authorization) {
    if (!authorization.startsWith("Bearer ") || !config.apiToken) return null;
    const supplied = authorization.slice("Bearer ".length).trim();
    if (!safeEqual(supplied, config.apiToken)) return null;
    return {
      method: "bearer",
      actor: { channel: "api", label: cleanLabel(req.get("x-kanban-actor"), config.ownerLabel) }
    };
  }
  const cookie = parseCookies(req.get("cookie") || "")[SESSION_COOKIE];
  if (cookie && config.apiToken && verifySessionValue(cookie, config.apiToken)) {
    return { method: "cookie", actor: { channel: "web", label: config.ownerLabel } };
  }
  return null;
}

function idempotentMutation(
  req: Request,
  state: WorkspaceState,
  mutate: () => { statusCode: number; response: JsonValue }
): MutationResult {
  const key = optionalString(req.get("idempotency-key"));
  const requestPath = req.originalUrl.split("?", 1)[0];
  const requestHash = crypto.createHash("sha256").update(stableJson(req.body ?? {})).digest("hex");
  if (key) {
    const existing = state.idempotencyRecords.find((record) => record.method === "POST" && record.path === requestPath && record.key === key);
    if (existing) {
      if (existing.requestHash !== requestHash) throw httpError(409, "Idempotency key was already used with a different request.");
      return { statusCode: existing.statusCode, response: existing.response, replayed: true };
    }
  }

  const result = mutate();
  if (key) {
    const record: IdempotencyRecord = {
      key,
      method: "POST",
      path: requestPath,
      requestHash,
      statusCode: result.statusCode,
      response: result.response,
      createdAt: new Date().toISOString()
    };
    state.idempotencyRecords.push(record);
    if (state.idempotencyRecords.length > MAX_IDEMPOTENCY_RECORDS) {
      state.idempotencyRecords.splice(0, state.idempotencyRecords.length - MAX_IDEMPOTENCY_RECORDS);
    }
  }
  return { ...result, replayed: false };
}

function sendMutation(res: Response, outcome: MutationResult): void {
  if (outcome.replayed) res.setHeader("Idempotency-Replayed", "true");
  res.status(outcome.statusCode).json(outcome.response);
}

function addActivity(project: Project, actor: ActivityActor, action: string, summary: string, cardId?: string): Activity {
  const activity: Activity = {
    id: makeId("activity"),
    action,
    actor: { ...actor },
    summary,
    projectId: project.id,
    ...(cardId ? { cardId } : {}),
    createdAt: new Date().toISOString()
  };
  project.activity.push(activity);
  if (project.activity.length > MAX_ACTIVITY) project.activity.splice(0, project.activity.length - MAX_ACTIVITY);
  return activity;
}

function normalizeColumns(value: unknown, existing: Column[] | undefined): Column[] {
  const source = value === undefined
    ? DEFAULT_COLUMNS.map((name, position) => ({ id: slugId(name, position), name, position }))
    : requireArray(value, "Project columns").map((candidate, position) => {
        const input = typeof candidate === "string" ? { name: candidate } : asRecord(candidate);
        const name = requiredString(input.name, `Column ${position + 1} name`);
        return {
          id: optionalString(input.id) || existing?.[position]?.id || slugId(name, position),
          name,
          position: optionalPosition(input.position, position)
        };
      });
  if (!source.length) throw httpError(400, "A project requires at least one column.");
  const ids = source.map((column) => column.id);
  if (new Set(ids).size !== ids.length) throw httpError(400, "Column IDs must be unique.");
  return source.sort((left, right) => left.position - right.position);
}

function projectSummary(project: Project): UnknownRecord {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    revision: project.revision,
    archivedAt: project.archivedAt,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    cardCount: project.cards.filter((card) => !card.archivedAt).length
  };
}

function findProject(state: WorkspaceState, projectId: string): Project {
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw httpError(404, "Project not found.");
  return project;
}

function findCard(project: Project, cardId: string): Card {
  const card = project.cards.find((candidate) => candidate.id === cardId);
  if (!card) throw httpError(404, "Card not found.");
  return card;
}

function assertProjectWritable(project: Project): void {
  if (project.archivedAt) throw httpError(409, "Archived projects are read-only.");
}

function touchProject(project: Project): void {
  project.revision += 1;
  project.updatedAt = new Date().toISOString();
}

function touchCard(card: Card): void {
  card.version += 1;
  card.updatedAt = new Date().toISOString();
}

function nextCardPosition(project: Project, columnId: string, exceptCardId?: string): number {
  const positions = project.cards
    .filter((card) => card.id !== exceptCardId && card.columnId === columnId && !card.archivedAt)
    .map((card) => card.position);
  return positions.length ? Math.max(...positions) + 1 : 0;
}

function requiredMatch(req: Request, label: string): number {
  const value = req.get("if-match");
  if (!value) throw httpError(428, `${label} is required in If-Match.`);
  const normalized = value.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const result = Number(normalized);
  if (!Number.isSafeInteger(result) || result < 1) throw httpError(400, `Invalid ${label.toLowerCase()}.`);
  return result;
}

function assertVersion(actual: number, expected: number, resource: string): void {
  if (actual !== expected) throw httpError(409, `${resource} changed since it was read. Refresh and reconcile before retrying.`);
}

function quoteVersion(value: number): string {
  return `"${value}"`;
}

function createSessionValue(expiresAt: number, secret: string): string {
  const payload = `v1.${expiresAt}`;
  return `${payload}.${sign(payload, secret)}`;
}

function verifySessionValue(value: string, secret: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1_000)) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  return safeEqual(parts[2], sign(payload, secret));
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = crypto.createHash("sha256").update(left).digest();
  const rightDigest = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function assertRequestOrigin(req: Request, requireOrigin: boolean): void {
  const origin = req.get("origin");
  if (!origin) {
    if (requireOrigin) throw httpError(403, "A same-origin browser request is required.");
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw httpError(403, "Invalid request origin.");
  }
  const expectedHost = (req.get("x-forwarded-host") || req.get("host") || "").split(",", 1)[0].trim();
  const expectedProtocol = (req.get("x-forwarded-proto") || req.protocol || "http").split(",", 1)[0].trim();
  if (parsed.host !== expectedHost || parsed.protocol !== `${expectedProtocol}:`) throw httpError(403, "Cross-origin request rejected.");
}

function requireActor(req: Request): ActivityActor {
  if (!req.ownerAuth) throw httpError(401, "Authentication required.");
  return req.ownerAuth.actor;
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `Missing route parameter ${name}.`);
  return value.trim();
}

function requiredString(value: unknown, label: string): string {
  const text = optionalString(value);
  if (!text) throw httpError(400, `${label} is required.`);
  return text;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function optionalText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function cleanLabel(value: unknown, fallback: string): string {
  const text = optionalString(value)?.replace(/[\r\n\0]/g, " ").slice(0, 80);
  return text || fallback;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === null || value === "") return null;
  const text = requiredString(value, label);
  if (!Number.isFinite(Date.parse(text))) throw httpError(400, `${label} must be an ISO timestamp or null.`);
  return new Date(text).toISOString();
}

function optionalPosition(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw httpError(400, "Position must be a non-negative integer.");
  return result;
}

function positiveInteger(value: unknown, fallback: number): number {
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : fallback;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw httpError(400, `Value must be an integer from ${minimum} to ${maximum}.`);
  }
  return result;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw httpError(400, `${label} must be an array.`);
  return value;
}

function asRecord(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as UnknownRecord;
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function slugId(name: string, position: number): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || `column-${position + 1}`;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function formatAction(action: string): string {
  if (action === "card.moved") return "Moved";
  if (action === "card.archived") return "Archived";
  return "Updated";
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as UnknownRecord).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
}

function serveIndex(staticDir: string): RequestHandler {
  return asyncHandler(async (_req, res) => {
    try {
      res.type("html").send(await fs.readFile(path.join(staticDir, "index.html"), "utf8"));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      res.type("html").send(FALLBACK_INDEX_HTML);
    }
  });
}

function sendStaticFile(staticDir: string, relativePath: string, contentType: string): RequestHandler {
  return asyncHandler(async (_req, res) => {
    try {
      const content = await fs.readFile(path.join(staticDir, relativePath));
      res.type(contentType).send(content);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      throw httpError(404, "Static asset not found.");
    }
  });
}

function asyncHandler(handler: AsyncHandler): RequestHandler {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function errorHandler(): ErrorRequestHandler {
  return (error: unknown, _req, res, _next) => {
    const status = isHttpError(error) ? error.status || 500 : 500;
    const message = error instanceof Error && status < 500 ? error.message : "Internal server error.";
    if (status >= 500) console.error(error instanceof Error ? error.message : String(error));
    noStore(res);
    res.status(status).json({ error: message });
  };
}

function httpError(status: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}

function isHttpError(error: unknown): error is HttpError {
  return error instanceof Error && typeof (error as HttpError).status === "number";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

if (require.main === module) {
  const host = process.env.HOST || DEFAULT_HOST;
  const port = positiveInteger(process.env.PORT, DEFAULT_PORT);
  const server = createServer(createApp());
  server.once("error", (error) => {
    console.error(`Unable to start ${PRODUCT_NAME}: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`${PRODUCT_NAME} server listening at http://${host}:${port}`);
  });
}
