import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

import { normalizePostgresConnectionString, resolvePostgresSsl } from "./postgres-config";
import type { PostgresOptions } from "./types";

export const ACCESS_REGISTRY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_ACCESS_TABLE_NAME = "kanban_v3_access_registry";
export const DEFAULT_ACCESS_DATA_PATH = path.join(process.cwd(), "data", "kanban-cards-v3-access.json");
export const LEGACY_WORKSPACE_STORAGE_ID = "default";

const ACCESS_REGISTRY_ROW_ID = "registry";
const DEFAULT_HANDOFF_TTL_SECONDS = 5 * 60;
const MAX_HANDOFF_TTL_SECONDS = 15 * 60;
const MAX_WORKSPACES_PER_OWNER = 10;
const MAX_ACTIVE_AGENT_CONNECTIONS_PER_WORKSPACE = 50;
const FRESH_OWNER_VERIFICATION_MS = 5 * 60 * 1000;
const MAX_AGENT_CONNECTIONS_PER_HOUR = 100;
const AGENT_CONNECTION_RATE_WINDOW_MS = 60 * 60 * 1000;

export interface AccessOwner {
  id: string;
  providerSubject: string;
  email: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccessWorkspace {
  id: string;
  slug: string;
  name: string;
  storageId: string;
  ownerIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AccessHandoff {
  id: string;
  tokenHash: string;
  ownerId: string;
  workspaceId: string;
  sessionId: string;
  destinationHost: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface RevokedAccessSession {
  providerSubject: string;
  sessionId: string;
  revokedAt: string;
}

export type AgentConnectionScope = "read" | "write";

export interface AgentConnection {
  id: string;
  credentialHash: string;
  ownerId: string;
  workspaceId: string;
  label: string;
  scopes: AgentConnectionScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface AccessPasskey {
  id: string;
  ownerId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AuthChallenge {
  id: string;
  challenge: string;
  browserHash: string;
  purpose: string;
  ownerId: string | null;
  rootOrigin: string;
  expiresAt: string;
  data: Record<string, unknown>;
}

export interface AuthSession {
  id: string;
  ownerId: string;
  rootOrigin: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  verifiedAt: string;
}

export interface RecoveryCode {
  ownerId: string;
  codeHash: string;
  createdAt: string;
  consumedAt: string | null;
}

export interface AuthHandoff {
  id: string;
  tokenHash: string;
  browserHash: string;
  ownerId: string;
  sessionId: string;
  destinationOrigin: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface AuthRateLimit {
  id: string;
  count: number;
  resetAt: string;
}

export interface AccessRegistryState {
  schemaVersion: 1;
  owners: AccessOwner[];
  workspaces: AccessWorkspace[];
  handoffs: AccessHandoff[];
  revokedSessions: RevokedAccessSession[];
  agentConnections: AgentConnection[];
  passkeys: AccessPasskey[];
  authChallenges: AuthChallenge[];
  authSessions: AuthSession[];
  recoveryCodes: RecoveryCode[];
  authHandoffs: AuthHandoff[];
  authRateLimits: AuthRateLimit[];
  setupConsumed: boolean;
}

export interface AccessStoreOptions extends PostgresOptions {
  dataPath?: string;
  now?: () => Date;
}

export interface CreateWorkspaceInput {
  providerSubject: string;
  email: string;
  displayName: string;
  slug: string;
  name: string;
}

export interface BindLegacyWorkspaceInput extends CreateWorkspaceInput {}

export interface CreateHandoffInput {
  providerSubject: string;
  workspaceId: string;
  sessionId: string;
  destinationHost: string;
  ttlSeconds?: number;
  expiresAt?: string;
}

export interface IssuedAccessHandoff {
  id: string;
  token: string;
  ownerId: string;
  owner: AccessOwner;
  workspaceId: string;
  sessionId: string;
  destinationHost: string;
  createdAt: string;
  expiresAt: string;
}

export interface ConsumeHandoffInput {
  token: string;
  destinationHost: string;
}

export interface CreateAgentConnectionInput {
  providerSubject: string;
  workspaceId: string;
  label: string;
  scopes: AgentConnectionScope[];
  expiresAt?: string | null;
  authSessionId?: string;
}

export interface IssuedAgentConnection {
  connection: AgentConnection;
  credential: string;
}

export interface VerifiedAgentConnection {
  connection: AgentConnection;
  owner: AccessOwner;
  workspace: AccessWorkspace;
}

export interface AuthorizeAgentConnectionInput {
  credential: string;
  workspaceId: string;
  requiredScope: AgentConnectionScope;
}

export interface ConsumedAccessHandoff {
  handoffId: string;
  owner: AccessOwner;
  workspace: AccessWorkspace;
  sessionId: string;
  consumedAt: string;
}

export interface ResolvedAccessOwner {
  owner: AccessOwner;
  workspaces: AccessWorkspace[];
}

export type AccessStoreErrorCode =
  | "ACCESS_CONFLICT"
  | "ACCESS_FORBIDDEN"
  | "ACCESS_RATE_LIMITED"
  | "ACCESS_HANDOFF_CONSUMED"
  | "ACCESS_HANDOFF_DESTINATION_MISMATCH"
  | "ACCESS_HANDOFF_EXPIRED"
  | "ACCESS_HANDOFF_INVALID"
  | "ACCESS_OWNER_NOT_FOUND"
  | "ACCESS_AGENT_CREDENTIAL_INVALID"
  | "ACCESS_AGENT_EXPIRED"
  | "ACCESS_AGENT_REVOKED"
  | "ACCESS_AGENT_SCOPE_MISSING"
  | "ACCESS_AGENT_WORKSPACE_MISMATCH"
  | "ACCESS_SESSION_REVOKED"
  | "ACCESS_WORKSPACE_NOT_FOUND";

export class AccessStoreError extends Error {
  constructor(readonly code: AccessStoreErrorCode, message: string) {
    super(message);
    this.name = "AccessStoreError";
  }
}

export interface AccessStore {
  kind: "file" | "postgres";
  path: string;
  read(): Promise<AccessRegistryState>;
  authTransaction<T>(mutator: (state: AccessRegistryState) => T): Promise<T>;
  resolveOwner(providerSubject: string): Promise<ResolvedAccessOwner | null>;
  getOwnerByProviderSubject(providerSubject: string): Promise<AccessOwner | null>;
  getWorkspaceById(workspaceId: string): Promise<AccessWorkspace | null>;
  getWorkspaceBySlug(slug: string): Promise<AccessWorkspace | null>;
  listWorkspacesForOwner(providerSubject: string): Promise<AccessWorkspace[]>;
  createWorkspace(input: CreateWorkspaceInput): Promise<AccessWorkspace>;
  bindLegacyWorkspace(input: BindLegacyWorkspaceInput): Promise<AccessWorkspace>;
  isSessionRevoked(providerSubject: string, sessionId: string): Promise<boolean>;
  revokeSession(providerSubject: string, sessionId: string): Promise<RevokedAccessSession>;
  createHandoff(input: CreateHandoffInput): Promise<IssuedAccessHandoff>;
  consumeHandoff(input: ConsumeHandoffInput): Promise<ConsumedAccessHandoff>;
  listAgentConnections(providerSubject: string, workspaceId: string): Promise<AgentConnection[]>;
  createAgentConnection(input: CreateAgentConnectionInput): Promise<IssuedAgentConnection>;
  revokeAgentConnection(providerSubject: string, workspaceId: string, connectionId: string): Promise<AgentConnection>;
  verifyAgentCredential(credential: string): Promise<VerifiedAgentConnection>;
  authorizeAgentCredential(input: AuthorizeAgentConnectionInput): Promise<VerifiedAgentConnection>;
}

interface AccessRegistryAdapter {
  kind: "file" | "postgres";
  path: string;
  read(): Promise<AccessRegistryState>;
  update<T>(mutator: (state: AccessRegistryState) => T): Promise<{ state: AccessRegistryState; result: T }>;
}

export function createAccessStore(options: AccessStoreOptions = {}): AccessStore {
  const connectionString =
    options.connectionString || process.env.KANBAN_CARDS_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (connectionString || options.pool) {
    return createPostgresAccessStore({ ...options, connectionString });
  }
  return createFileAccessStore(options.dataPath || DEFAULT_ACCESS_DATA_PATH, options);
}

export function createFileAccessStore(dataPath: string, options: Pick<AccessStoreOptions, "now"> = {}): AccessStore {
  const resolvedPath = path.resolve(dataPath);
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function write(nextState: unknown): Promise<AccessRegistryState> {
    const normalized = normalizeAccessRegistry(nextState);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    const temporaryPath = `${resolvedPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, resolvedPath);
    return normalized;
  }

  async function read(): Promise<AccessRegistryState> {
    try {
      return normalizeAccessRegistry(JSON.parse(await fs.readFile(resolvedPath, "utf8")));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      return write(freshAccessRegistryState());
    }
  }

  async function update<T>(mutator: (state: AccessRegistryState) => T): Promise<{ state: AccessRegistryState; result: T }> {
    const nextWrite = writeQueue
      .catch(() => undefined)
      .then(async () => {
        const state = await read();
        const result = mutator(state);
        const saved = await write(state);
        return { state: saved, result };
      });
    writeQueue = nextWrite;
    return nextWrite;
  }

  return accessStoreFromAdapter({ kind: "file", path: resolvedPath, read, update }, options.now);
}

export function createPostgresAccessStore(options: AccessStoreOptions = {}): AccessStore {
  const tableName = validateTableName(options.tableName || DEFAULT_ACCESS_TABLE_NAME);
  const pool =
    options.pool ||
    new Pool({
      connectionString: normalizePostgresConnectionString(options.connectionString),
      ssl: resolvePostgresSsl(options)
    });
  let readyPromise: Promise<void> | null = null;

  function ensureReady(): Promise<void> {
    if (!readyPromise) {
      readyPromise = pool.query(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id text PRIMARY KEY,
          state jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `).then(() => undefined).catch((error: unknown) => {
        readyPromise = null;
        throw error;
      });
    }
    return readyPromise;
  }

  async function initialize(): Promise<void> {
    await ensureReady();
    await pool.query(
      `INSERT INTO ${tableName} (id, state, created_at, updated_at)
       VALUES ($1, $2::jsonb, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [ACCESS_REGISTRY_ROW_ID, JSON.stringify(freshAccessRegistryState())]
    );
  }

  async function read(): Promise<AccessRegistryState> {
    await initialize();
    const result = await pool.query<{ state: unknown }>(`SELECT state FROM ${tableName} WHERE id = $1`, [ACCESS_REGISTRY_ROW_ID]);
    if (!result.rows.length) throw new Error("Access registry was not initialized.");
    return normalizeAccessRegistry(result.rows[0].state);
  }

  async function update<T>(mutator: (state: AccessRegistryState) => T): Promise<{ state: AccessRegistryState; result: T }> {
    await ensureReady();
    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(
        `INSERT INTO ${tableName} (id, state, created_at, updated_at)
         VALUES ($1, $2::jsonb, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [ACCESS_REGISTRY_ROW_ID, JSON.stringify(freshAccessRegistryState())]
      );
      const selected = await client.query<{ state: unknown }>(
        `SELECT state FROM ${tableName} WHERE id = $1 FOR UPDATE`,
        [ACCESS_REGISTRY_ROW_ID]
      );
      const state = normalizeAccessRegistry(selected.rows[0]?.state);
      const mutationResult = mutator(state);
      const normalized = normalizeAccessRegistry(state);
      await client.query(`UPDATE ${tableName} SET state = $2::jsonb, updated_at = now() WHERE id = $1`, [
        ACCESS_REGISTRY_ROW_ID,
        JSON.stringify(normalized)
      ]);
      await client.query("COMMIT");
      return { state: normalized, result: mutationResult };
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return accessStoreFromAdapter(
    { kind: "postgres", path: `${tableName}:${ACCESS_REGISTRY_ROW_ID}`, read, update },
    options.now
  );
}

export function freshAccessRegistryState(): AccessRegistryState {
  return {
    schemaVersion: ACCESS_REGISTRY_SCHEMA_VERSION,
    owners: [],
    workspaces: [],
    handoffs: [],
    revokedSessions: [],
    agentConnections: [],
    passkeys: [],
    authChallenges: [],
    authSessions: [],
    recoveryCodes: [],
    authHandoffs: [],
    authRateLimits: [],
    setupConsumed: false
  };
}

export function normalizeAccessRegistry(rawState: unknown): AccessRegistryState {
  const state = requireRecord(rawState, "Access registry");
  if (state.schemaVersion !== ACCESS_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported access registry schema. Expected version ${ACCESS_REGISTRY_SCHEMA_VERSION}.`);
  }
  const owners = requireArray(state.owners, "Access registry owners").map(normalizeOwner);
  const workspaces = requireArray(state.workspaces, "Access registry workspaces").map(normalizeWorkspace);
  const handoffs = requireArray(state.handoffs, "Access registry handoffs").map(normalizeHandoff);
  const revokedSessions = state.revokedSessions === undefined
    ? []
    : requireArray(state.revokedSessions, "Access registry revokedSessions").map(normalizeRevokedSession);
  const agentConnections = state.agentConnections === undefined
    ? []
    : requireArray(state.agentConnections, "Access registry agentConnections").map(normalizeAgentConnection);
  const passkeys = optionalArray(state.passkeys, "Access registry passkeys").map(normalizePasskey);
  const authChallenges = optionalArray(state.authChallenges, "Access registry authChallenges").map(normalizeAuthChallenge);
  const authSessions = optionalArray(state.authSessions, "Access registry authSessions").map(normalizeAuthSession);
  const recoveryCodes = optionalArray(state.recoveryCodes, "Access registry recoveryCodes").map(normalizeRecoveryCode);
  const authHandoffs = optionalArray(state.authHandoffs, "Access registry authHandoffs").map(normalizeAuthHandoff);
  const authRateLimits = optionalArray(state.authRateLimits, "Access registry authRateLimits").map(normalizeAuthRateLimit);
  if (state.setupConsumed !== undefined && typeof state.setupConsumed !== "boolean") {
    throw new Error("Access registry setupConsumed must be a boolean.");
  }
  const setupConsumed = state.setupConsumed === true;

  assertUnique(owners.map((owner) => owner.id), "owner id");
  assertUnique(owners.map((owner) => owner.providerSubject), "provider subject");
  assertUnique(workspaces.map((workspace) => workspace.id), "workspace id");
  assertUnique(workspaces.map((workspace) => workspace.slug), "workspace slug");
  assertUnique(workspaces.map((workspace) => workspace.storageId), "workspace storage id");
  assertUnique(handoffs.map((handoff) => handoff.id), "handoff id");
  assertUnique(handoffs.map((handoff) => handoff.tokenHash), "handoff token hash");
  assertUnique(agentConnections.map((connection) => connection.id), "agent connection id");
  assertUnique(agentConnections.map((connection) => connection.credentialHash), "agent credential hash");
  assertUnique(passkeys.map((passkey) => passkey.id), "passkey credential id");
  assertUnique(authChallenges.map((challenge) => challenge.id), "auth challenge id");
  assertUnique(authSessions.map((session) => session.id), "auth session id");
  assertUnique(recoveryCodes.map((code) => code.codeHash), "recovery code hash");
  assertUnique(authHandoffs.map((handoff) => handoff.id), "auth handoff id");
  assertUnique(authHandoffs.map((handoff) => handoff.tokenHash), "auth handoff token hash");
  assertUnique(authRateLimits.map((limit) => limit.id), "auth rate limit id");
  assertUnique(
    revokedSessions.map((session) => revokedSessionKey(session.providerSubject, session.sessionId)),
    "revoked session"
  );

  const ownerIds = new Set(owners.map((owner) => owner.id));
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  for (const owner of owners) {
    if (Date.parse(owner.updatedAt) < Date.parse(owner.createdAt)) {
      throw new Error(`Owner ${owner.id} cannot be updated before it is created.`);
    }
  }
  for (const workspace of workspaces) {
    if (Date.parse(workspace.updatedAt) < Date.parse(workspace.createdAt)) {
      throw new Error(`Workspace ${workspace.id} cannot be updated before it is created.`);
    }
    assertUnique(workspace.ownerIds, `owner membership in workspace ${workspace.id}`);
    for (const ownerId of workspace.ownerIds) {
      if (!ownerIds.has(ownerId)) throw new Error(`Workspace ${workspace.id} refers to missing owner ${ownerId}.`);
    }
  }
  for (const handoff of handoffs) {
    const workspace = workspacesById.get(handoff.workspaceId);
    if (!ownerIds.has(handoff.ownerId)) throw new Error(`Handoff ${handoff.id} refers to missing owner ${handoff.ownerId}.`);
    if (!workspace) throw new Error(`Handoff ${handoff.id} refers to missing workspace ${handoff.workspaceId}.`);
    if (!workspace.ownerIds.includes(handoff.ownerId)) {
      throw new Error(`Handoff ${handoff.id} owner does not own workspace ${handoff.workspaceId}.`);
    }
    if (Date.parse(handoff.expiresAt) <= Date.parse(handoff.createdAt)) {
      throw new Error(`Handoff ${handoff.id} must expire after it is created.`);
    }
    if (handoff.consumedAt && Date.parse(handoff.consumedAt) < Date.parse(handoff.createdAt)) {
      throw new Error(`Handoff ${handoff.id} cannot be consumed before it is created.`);
    }
  }
  for (const connection of agentConnections) {
    const workspace = workspacesById.get(connection.workspaceId);
    if (!ownerIds.has(connection.ownerId)) throw new Error(`Agent connection ${connection.id} refers to a missing owner.`);
    if (!workspace || !workspace.ownerIds.includes(connection.ownerId)) throw new Error(`Agent connection ${connection.id} is not bound to its owner's Workspace.`);
  }
  for (const passkey of passkeys) {
    if (!ownerIds.has(passkey.ownerId)) throw new Error(`Passkey ${passkey.id} refers to a missing owner.`);
    assertNotBefore(passkey.lastUsedAt, passkey.createdAt, "Passkey lastUsedAt");
    assertNotBefore(passkey.revokedAt, passkey.createdAt, "Passkey revokedAt");
  }
  for (const challenge of authChallenges) {
    if (challenge.ownerId !== null && !ownerIds.has(challenge.ownerId)) {
      throw new Error(`Auth challenge ${challenge.id} refers to a missing owner.`);
    }
  }
  const sessionsById = new Map(authSessions.map((session) => [session.id, session]));
  for (const session of authSessions) {
    if (!ownerIds.has(session.ownerId)) throw new Error(`Auth session ${session.id} refers to a missing owner.`);
    if (Date.parse(session.expiresAt) <= Date.parse(session.createdAt)) {
      throw new Error(`Auth session ${session.id} must expire after it is created.`);
    }
    assertNotBefore(session.verifiedAt, session.createdAt, "Auth session verifiedAt");
    assertNotBefore(session.revokedAt, session.createdAt, "Auth session revokedAt");
  }
  for (const code of recoveryCodes) {
    if (!ownerIds.has(code.ownerId)) throw new Error("Recovery code refers to a missing owner.");
    assertNotBefore(code.consumedAt, code.createdAt, "Recovery code consumedAt");
  }
  for (const handoff of authHandoffs) {
    const session = sessionsById.get(handoff.sessionId);
    if (!ownerIds.has(handoff.ownerId)) throw new Error(`Auth handoff ${handoff.id} refers to a missing owner.`);
    if (!session || session.ownerId !== handoff.ownerId) {
      throw new Error(`Auth handoff ${handoff.id} is not bound to its owner's session.`);
    }
  }
  return {
    schemaVersion: ACCESS_REGISTRY_SCHEMA_VERSION, owners, workspaces, handoffs, revokedSessions, agentConnections,
    passkeys, authChallenges, authSessions, recoveryCodes, authHandoffs, authRateLimits, setupConsumed
  };
}

function accessStoreFromAdapter(adapter: AccessRegistryAdapter, nowOption?: () => Date): AccessStore {
  const now = nowOption || (() => new Date());

  async function authTransaction<T>(mutator: (state: AccessRegistryState) => T): Promise<T> {
    return (await adapter.update((state) => {
      const result = mutator(state);
      if (result && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function") {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error("Access registry transaction callbacks must be synchronous.");
      }
      return result;
    })).result;
  }

  async function getOwnerByProviderSubject(providerSubject: string): Promise<AccessOwner | null> {
    const subject = normalizeProviderSubject(providerSubject);
    return findOwner(await adapter.read(), subject) || null;
  }

  async function resolveOwner(providerSubject: string): Promise<ResolvedAccessOwner | null> {
    const subject = normalizeProviderSubject(providerSubject);
    const state = await adapter.read();
    const owner = findOwner(state, subject);
    if (!owner) return null;
    const workspaces = state.workspaces
      .filter((workspace) => workspace.ownerIds.includes(owner.id))
      .sort((left, right) => left.slug.localeCompare(right.slug));
    return { owner, workspaces };
  }

  async function getWorkspaceBySlug(slug: string): Promise<AccessWorkspace | null> {
    const canonicalSlug = normalizeWorkspaceSlug(slug);
    return (await adapter.read()).workspaces.find((workspace) => workspace.slug === canonicalSlug) || null;
  }

  async function getWorkspaceById(workspaceId: string): Promise<AccessWorkspace | null> {
    const id = requiredIdentifier(workspaceId, "Workspace id");
    return (await adapter.read()).workspaces.find((workspace) => workspace.id === id) || null;
  }

  async function listWorkspacesForOwner(providerSubject: string): Promise<AccessWorkspace[]> {
    const subject = normalizeProviderSubject(providerSubject);
    const state = await adapter.read();
    const owner = findOwner(state, subject);
    if (!owner) return [];
    return state.workspaces.filter((workspace) => workspace.ownerIds.includes(owner.id)).sort((left, right) => left.slug.localeCompare(right.slug));
  }

  async function createWorkspace(input: CreateWorkspaceInput): Promise<AccessWorkspace> {
    return (await adapter.update((state) => createWorkspaceInRegistry(state, input, validNow(now)))).result;
  }

  async function bindLegacyWorkspace(input: BindLegacyWorkspaceInput): Promise<AccessWorkspace> {
    const providerSubject = normalizeProviderSubject(input.providerSubject);
    const email = normalizeOwnerEmail(input.email);
    const displayName = normalizeOwnerDisplayName(input.displayName);
    const slug = normalizeWorkspaceSlug(input.slug);
    const name = normalizeWorkspaceName(input.name);
    return (await adapter.update((state) => {
      const timestamp = validNow(now);
      const owner = ensureOwner(state, { providerSubject, email, displayName }, timestamp);
      const byStorage = state.workspaces.find((workspace) => workspace.storageId === LEGACY_WORKSPACE_STORAGE_ID);
      const bySlug = state.workspaces.find((workspace) => workspace.slug === slug);
      const existing = byStorage || bySlug;
      if (existing) {
        if (
          byStorage !== bySlug ||
          existing.storageId !== LEGACY_WORKSPACE_STORAGE_ID ||
          existing.slug !== slug ||
          existing.name !== name ||
          !existing.ownerIds.includes(owner.id)
        ) {
          throw new AccessStoreError("ACCESS_CONFLICT", "Legacy Workspace binding conflicts with the stored mapping.");
        }
        return existing;
      }
      const workspace: AccessWorkspace = {
        id: uniqueId("workspace", new Set(state.workspaces.map((candidate) => candidate.id))),
        slug,
        name,
        storageId: LEGACY_WORKSPACE_STORAGE_ID,
        ownerIds: [owner.id],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.workspaces.push(workspace);
      return workspace;
    })).result;
  }

  async function isSessionRevoked(providerSubject: string, sessionId: string): Promise<boolean> {
    const subject = normalizeProviderSubject(providerSubject);
    const familyId = normalizeSessionId(sessionId);
    return hasRevokedSession(await adapter.read(), subject, familyId);
  }

  async function revokeSession(providerSubject: string, sessionId: string): Promise<RevokedAccessSession> {
    const subject = normalizeProviderSubject(providerSubject);
    const familyId = normalizeSessionId(sessionId);
    return (await adapter.update((state) => {
      const canonicalSubject = findOwner(state, subject)?.providerSubject || subject;
      const existing = state.revokedSessions.find(
        (candidate) => candidate.providerSubject === canonicalSubject && candidate.sessionId === familyId
      );
      if (existing) return existing;
      const revokedSession: RevokedAccessSession = {
        providerSubject: canonicalSubject,
        sessionId: familyId,
        revokedAt: validNow(now)
      };
      state.revokedSessions.push(revokedSession);
      return revokedSession;
    })).result;
  }

  async function createHandoff(input: CreateHandoffInput): Promise<IssuedAccessHandoff> {
    const providerSubject = normalizeProviderSubject(input.providerSubject);
    const workspaceId = requiredIdentifier(input.workspaceId, "Workspace id");
    const sessionId = normalizeSessionId(input.sessionId);
    const destinationHost = normalizeDestinationHost(input.destinationHost);
    const issuedAt = validNow(now);
    const expiresAt = resolveHandoffExpiry(input, issuedAt);
    const token = `kch_${crypto.randomBytes(32).toString("base64url")}`;
    const tokenHash = hashHandoffToken(token);
    return (await adapter.update((state) => {
      if (hasRevokedSession(state, providerSubject, sessionId)) {
        throw new AccessStoreError("ACCESS_SESSION_REVOKED", "Session has been revoked.");
      }
      const owner = findOwner(state, providerSubject);
      if (!owner) throw new AccessStoreError("ACCESS_OWNER_NOT_FOUND", "Owner is not registered.");
      const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
      if (!workspace) throw new AccessStoreError("ACCESS_WORKSPACE_NOT_FOUND", "Workspace is not registered.");
      if (!workspace.ownerIds.includes(owner.id)) {
        throw new AccessStoreError("ACCESS_FORBIDDEN", "Owner does not have access to this Workspace.");
      }
      const handoff: AccessHandoff = {
        id: uniqueId("handoff", new Set(state.handoffs.map((candidate) => candidate.id))),
        tokenHash,
        ownerId: owner.id,
        workspaceId: workspace.id,
        sessionId,
        destinationHost,
        createdAt: issuedAt,
        expiresAt,
        consumedAt: null
      };
      state.handoffs.push(handoff);
      return {
        id: handoff.id,
        token,
        ownerId: owner.id,
        owner: { ...owner },
        workspaceId: workspace.id,
        sessionId,
        destinationHost,
        createdAt: issuedAt,
        expiresAt
      };
    })).result;
  }

  async function consumeHandoff(input: ConsumeHandoffInput): Promise<ConsumedAccessHandoff> {
    const tokenHash = hashHandoffToken(normalizeHandoffToken(input.token));
    const destinationHost = normalizeDestinationHost(input.destinationHost);
    return (await adapter.update((state) => {
      const handoff = state.handoffs.find((candidate) => safeHashEqual(candidate.tokenHash, tokenHash));
      if (!handoff) throw new AccessStoreError("ACCESS_HANDOFF_INVALID", "Handoff is invalid.");
      if (handoff.destinationHost !== destinationHost) {
        throw new AccessStoreError("ACCESS_HANDOFF_DESTINATION_MISMATCH", "Handoff destination does not match this host.");
      }
      if (handoff.consumedAt) throw new AccessStoreError("ACCESS_HANDOFF_CONSUMED", "Handoff was already consumed.");
      const consumedAt = validNow(now);
      if (Date.parse(handoff.expiresAt) <= Date.parse(consumedAt)) {
        throw new AccessStoreError("ACCESS_HANDOFF_EXPIRED", "Handoff has expired.");
      }
      const owner = state.owners.find((candidate) => candidate.id === handoff.ownerId);
      if (!owner) throw new AccessStoreError("ACCESS_HANDOFF_INVALID", "Handoff no longer grants Workspace access.");
      if (hasRevokedSession(state, owner.providerSubject, handoff.sessionId)) {
        throw new AccessStoreError("ACCESS_SESSION_REVOKED", "Session has been revoked.");
      }
      const workspace = state.workspaces.find((candidate) => candidate.id === handoff.workspaceId);
      if (!workspace || !workspace.ownerIds.includes(owner.id)) {
        throw new AccessStoreError("ACCESS_HANDOFF_INVALID", "Handoff no longer grants Workspace access.");
      }
      handoff.consumedAt = consumedAt;
      return { handoffId: handoff.id, owner, workspace, sessionId: handoff.sessionId, consumedAt };
    })).result;
  }

  async function listAgentConnections(providerSubject: string, workspaceId: string): Promise<AgentConnection[]> {
    const subject = normalizeProviderSubject(providerSubject);
    const id = requiredIdentifier(workspaceId, "Workspace id");
    const state = await adapter.read();
    const owner = findOwner(state, subject);
    const workspace = state.workspaces.find((candidate) => candidate.id === id);
    if (!owner || !workspace?.ownerIds.includes(owner.id)) throw new AccessStoreError("ACCESS_FORBIDDEN", "Workspace access is unavailable.");
    return state.agentConnections.filter((connection) => connection.ownerId === owner.id && connection.workspaceId === id);
  }

  async function createAgentConnection(input: CreateAgentConnectionInput): Promise<IssuedAgentConnection> {
    const subject = normalizeProviderSubject(input.providerSubject);
    const workspaceId = requiredIdentifier(input.workspaceId, "Workspace id");
    const label = normalizeAgentLabel(input.label);
    const scopes = normalizeAgentScopes(input.scopes);
    const expiresAt = input.expiresAt == null ? null : timestamp(input.expiresAt, "Agent connection expiresAt");
    const authSessionId = input.authSessionId === undefined ? null : normalizeSessionId(input.authSessionId);
    const secret = crypto.randomBytes(32).toString("base64url");
    return (await adapter.update((state) => {
      const issuedAt = validNow(now);
      if (expiresAt && Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new Error("Agent connection expiry must be in the future.");
      const owner = findOwner(state, subject);
      const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
      if (!owner || !workspace?.ownerIds.includes(owner.id)) throw new AccessStoreError("ACCESS_FORBIDDEN", "Workspace access is unavailable.");
      if (authSessionId) {
        const session = state.authSessions.find((candidate) => candidate.id === authSessionId && candidate.ownerId === owner.id);
        const currentTime = Date.parse(issuedAt);
        if (!session || session.revokedAt || hasRevokedSession(state, owner.id, authSessionId) || Date.parse(session.expiresAt) <= currentTime || Date.parse(session.verifiedAt) > currentTime || currentTime - Date.parse(session.verifiedAt) > FRESH_OWNER_VERIFICATION_MS) {
          throw new AccessStoreError("ACCESS_FORBIDDEN", "Verify your passkey in an active session before creating an API key.");
        }
      }
      if (state.agentConnections.filter((connection) => connection.ownerId === owner.id && connection.workspaceId === workspaceId && !connection.revokedAt).length >= MAX_ACTIVE_AGENT_CONNECTIONS_PER_WORKSPACE) {
        throw new AccessStoreError("ACCESS_FORBIDDEN", "A Workspace can have up to 50 unrevoked API keys. Revoke an existing key before creating another.");
      }
      const currentTime = Date.parse(issuedAt);
      state.authRateLimits = state.authRateLimits.filter((limit) => Date.parse(limit.resetAt) > currentTime);
      const rateLimitId = `agent-key-issuance:${crypto.createHash("sha256").update(owner.id).digest("hex")}`;
      let rateLimit = state.authRateLimits.find((limit) => limit.id === rateLimitId);
      if (rateLimit && rateLimit.count >= MAX_AGENT_CONNECTIONS_PER_HOUR) {
        throw new AccessStoreError("ACCESS_RATE_LIMITED", `API-key creation limit reached. Try again after ${rateLimit.resetAt}.`);
      }
      const id = uniqueId("agent", new Set(state.agentConnections.map((candidate) => candidate.id)));
      const credential = `kac_${id}_${secret}`;
      const connection: AgentConnection = { id, credentialHash: hashAgentCredential(credential), ownerId: owner.id, workspaceId, label, scopes, createdAt: issuedAt, lastUsedAt: null, expiresAt, revokedAt: null };
      state.agentConnections.push(connection);
      if (!rateLimit) {
        rateLimit = { id: rateLimitId, count: 0, resetAt: new Date(currentTime + AGENT_CONNECTION_RATE_WINDOW_MS).toISOString() };
        state.authRateLimits.push(rateLimit);
      }
      rateLimit.count += 1;
      return { connection, credential };
    })).result;
  }

  async function revokeAgentConnection(providerSubject: string, workspaceId: string, connectionId: string): Promise<AgentConnection> {
    const subject = normalizeProviderSubject(providerSubject);
    const workspace = requiredIdentifier(workspaceId, "Workspace id");
    const id = requiredIdentifier(connectionId, "Agent connection id");
    return (await adapter.update((state) => {
      const owner = findOwner(state, subject);
      const connection = state.agentConnections.find((candidate) => candidate.id === id && candidate.workspaceId === workspace);
      if (!owner || !connection || connection.ownerId !== owner.id) throw new AccessStoreError("ACCESS_FORBIDDEN", "Agent connection is unavailable.");
      if (!connection.revokedAt) connection.revokedAt = validNow(now);
      return connection;
    })).result;
  }

  async function verifyAgentCredential(credentialValue: string): Promise<VerifiedAgentConnection> {
    const credential = normalizeAgentCredential(credentialValue);
    const hash = hashAgentCredential(credential);
    return resolveAgentCredential(await adapter.read(), hash, validNow(now));
  }

  async function authorizeAgentCredential(input: AuthorizeAgentConnectionInput): Promise<VerifiedAgentConnection> {
    const credential = normalizeAgentCredential(input.credential);
    const workspaceId = requiredIdentifier(input.workspaceId, "Workspace id");
    const requiredScope = normalizeAgentScope(input.requiredScope);
    const hash = hashAgentCredential(credential);
    return (await adapter.update((state) => {
      const usedAt = validNow(now);
      const verified = resolveAgentCredential(state, hash, usedAt);
      if (verified.workspace.id !== workspaceId) throw new AccessStoreError("ACCESS_AGENT_WORKSPACE_MISMATCH", "Agent connection does not authorize this Workspace.");
      if (!verified.connection.scopes.includes(requiredScope)) throw new AccessStoreError("ACCESS_AGENT_SCOPE_MISSING", `Agent connection requires ${requiredScope} scope.`);
      verified.connection.lastUsedAt = usedAt;
      return verified;
    })).result;
  }

  return {
    kind: adapter.kind,
    path: adapter.path,
    read: adapter.read,
    authTransaction,
    resolveOwner,
    getOwnerByProviderSubject,
    getWorkspaceById,
    getWorkspaceBySlug,
    listWorkspacesForOwner,
    createWorkspace,
    bindLegacyWorkspace,
    isSessionRevoked,
    revokeSession,
    createHandoff,
    consumeHandoff,
    listAgentConnections,
    createAgentConnection,
    revokeAgentConnection,
    verifyAgentCredential,
    authorizeAgentCredential
  };
}

export function createWorkspaceInRegistry(
  state: AccessRegistryState,
  input: CreateWorkspaceInput,
  createdAt: string = new Date().toISOString()
): AccessWorkspace {
  const providerSubject = normalizeProviderSubject(input.providerSubject);
  const email = normalizeOwnerEmail(input.email);
  const displayName = normalizeOwnerDisplayName(input.displayName);
  const slug = normalizeWorkspaceSlug(input.slug);
  const name = normalizeWorkspaceName(input.name);
  const timestampValue = timestamp(createdAt, "Workspace createdAt");
  if (state.workspaces.some((workspace) => workspace.slug === slug)) {
    throw new AccessStoreError("ACCESS_CONFLICT", `Workspace slug ${slug} is already registered.`);
  }
  const existingOwner = findOwner(state, providerSubject);
  if (existingOwner && state.workspaces.filter((workspace) => workspace.ownerIds.includes(existingOwner.id)).length >= MAX_WORKSPACES_PER_OWNER) {
    throw new AccessStoreError("ACCESS_FORBIDDEN", "An owner can have up to 10 Workspaces.");
  }
  const owner = ensureOwner(state, { providerSubject, email, displayName }, timestampValue);
  const workspace: AccessWorkspace = {
    id: uniqueId("workspace", new Set(state.workspaces.map((candidate) => candidate.id))),
    slug,
    name,
    storageId: uniqueId("state", new Set(state.workspaces.map((candidate) => candidate.storageId))),
    ownerIds: [owner.id],
    createdAt: timestampValue,
    updatedAt: timestampValue
  };
  state.workspaces.push(workspace);
  return workspace;
}

function findOwner(state: AccessRegistryState, identifier: string): AccessOwner | undefined {
  return state.owners.find((owner) => owner.id === identifier)
    || state.owners.find((owner) => owner.providerSubject === identifier);
}

function ensureOwner(
  state: AccessRegistryState,
  identity: { providerSubject: string; email: string; displayName: string },
  timestamp: string
): AccessOwner {
  const existing = findOwner(state, identity.providerSubject);
  if (existing) {
    const email = identity.email || existing.email;
    if (existing.email !== email || existing.displayName !== identity.displayName) {
      existing.email = email;
      existing.displayName = identity.displayName;
      existing.updatedAt = timestamp;
    }
    return existing;
  }
  const owner: AccessOwner = {
    id: uniqueId("owner", new Set(state.owners.map((candidate) => candidate.id))),
    providerSubject: identity.providerSubject,
    email: identity.email,
    displayName: identity.displayName,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  state.owners.push(owner);
  return owner;
}

function normalizeOwner(value: unknown): AccessOwner {
  const owner = requireRecord(value, "Access owner");
  return {
    id: requiredIdentifier(owner.id, "Owner id"),
    providerSubject: normalizeProviderSubject(owner.providerSubject),
    email: normalizeOwnerEmail(owner.email),
    displayName: normalizeOwnerDisplayName(owner.displayName),
    createdAt: timestamp(owner.createdAt, "Owner createdAt"),
    updatedAt: timestamp(owner.updatedAt, "Owner updatedAt")
  };
}

function normalizeWorkspace(value: unknown): AccessWorkspace {
  const workspace = requireRecord(value, "Access workspace");
  return {
    id: requiredIdentifier(workspace.id, "Workspace id"),
    slug: normalizeWorkspaceSlug(workspace.slug),
    name: normalizeWorkspaceName(workspace.name),
    storageId: requiredIdentifier(workspace.storageId, "Workspace storage id"),
    ownerIds: requireArray(workspace.ownerIds, "Workspace ownerIds").map((ownerId) => requiredIdentifier(ownerId, "Workspace owner id")),
    createdAt: timestamp(workspace.createdAt, "Workspace createdAt"),
    updatedAt: timestamp(workspace.updatedAt, "Workspace updatedAt")
  };
}

function normalizeHandoff(value: unknown): AccessHandoff {
  const handoff = requireRecord(value, "Access handoff");
  const tokenHash = requiredString(handoff.tokenHash, "Handoff tokenHash");
  if (!/^sha256:[a-f0-9]{64}$/.test(tokenHash)) throw new Error("Handoff tokenHash is invalid.");
  return {
    id: requiredIdentifier(handoff.id, "Handoff id"),
    tokenHash,
    ownerId: requiredIdentifier(handoff.ownerId, "Handoff owner id"),
    workspaceId: requiredIdentifier(handoff.workspaceId, "Handoff workspace id"),
    sessionId: normalizeSessionId(handoff.sessionId),
    destinationHost: normalizeDestinationHost(handoff.destinationHost),
    createdAt: timestamp(handoff.createdAt, "Handoff createdAt"),
    expiresAt: timestamp(handoff.expiresAt, "Handoff expiresAt"),
    consumedAt: handoff.consumedAt == null ? null : timestamp(handoff.consumedAt, "Handoff consumedAt")
  };
}

function normalizeRevokedSession(value: unknown): RevokedAccessSession {
  const session = requireRecord(value, "Revoked access session");
  return {
    providerSubject: normalizeProviderSubject(session.providerSubject),
    sessionId: normalizeSessionId(session.sessionId),
    revokedAt: timestamp(session.revokedAt, "Revoked session revokedAt")
  };
}

function normalizeAgentConnection(value: unknown): AgentConnection {
  const connection = requireRecord(value, "Agent connection");
  const credentialHash = requiredString(connection.credentialHash, "Agent credentialHash");
  if (!/^sha256:[a-f0-9]{64}$/.test(credentialHash)) throw new Error("Agent credentialHash is invalid.");
  return {
    id: requiredIdentifier(connection.id, "Agent connection id"), credentialHash,
    ownerId: requiredIdentifier(connection.ownerId, "Agent owner id"), workspaceId: requiredIdentifier(connection.workspaceId, "Agent Workspace id"),
    label: normalizeAgentLabel(connection.label), scopes: normalizeAgentScopes(connection.scopes),
    createdAt: timestamp(connection.createdAt, "Agent createdAt"),
    lastUsedAt: connection.lastUsedAt == null ? null : timestamp(connection.lastUsedAt, "Agent lastUsedAt"),
    expiresAt: connection.expiresAt == null ? null : timestamp(connection.expiresAt, "Agent expiresAt"),
    revokedAt: connection.revokedAt == null ? null : timestamp(connection.revokedAt, "Agent revokedAt")
  };
}

function normalizePasskey(value: unknown): AccessPasskey {
  const passkey = requireRecord(value, "Passkey");
  return {
    id: base64urlString(passkey.id, "Passkey credential id"),
    ownerId: requiredIdentifier(passkey.ownerId, "Passkey owner id"),
    publicKey: base64urlString(passkey.publicKey, "Passkey public key"),
    counter: nonnegativeInteger(passkey.counter, "Passkey counter"),
    transports: requireArray(passkey.transports, "Passkey transports").map((transport) => requiredIdentifier(transport, "Passkey transport")),
    createdAt: timestamp(passkey.createdAt, "Passkey createdAt"),
    lastUsedAt: passkey.lastUsedAt == null ? null : timestamp(passkey.lastUsedAt, "Passkey lastUsedAt"),
    revokedAt: passkey.revokedAt == null ? null : timestamp(passkey.revokedAt, "Passkey revokedAt")
  };
}

function normalizeAuthChallenge(value: unknown): AuthChallenge {
  const challenge = requireRecord(value, "Auth challenge");
  return {
    id: requiredIdentifier(challenge.id, "Auth challenge id"),
    challenge: requiredIdentifier(challenge.challenge, "Auth challenge value"),
    browserHash: storedHash(challenge.browserHash, "Auth challenge browserHash"),
    purpose: requiredIdentifier(challenge.purpose, "Auth challenge purpose"),
    ownerId: challenge.ownerId == null ? null : requiredIdentifier(challenge.ownerId, "Auth challenge owner id"),
    rootOrigin: normalizeAuthOrigin(challenge.rootOrigin, "Auth challenge rootOrigin"),
    expiresAt: timestamp(challenge.expiresAt, "Auth challenge expiresAt"),
    data: normalizeJsonRecord(challenge.data, "Auth challenge data")
  };
}

function normalizeAuthSession(value: unknown): AuthSession {
  const session = requireRecord(value, "Auth session");
  return {
    id: normalizeSessionId(session.id),
    ownerId: requiredIdentifier(session.ownerId, "Auth session owner id"),
    rootOrigin: normalizeAuthOrigin(session.rootOrigin, "Auth session rootOrigin"),
    createdAt: timestamp(session.createdAt, "Auth session createdAt"),
    expiresAt: timestamp(session.expiresAt, "Auth session expiresAt"),
    revokedAt: session.revokedAt == null ? null : timestamp(session.revokedAt, "Auth session revokedAt"),
    verifiedAt: timestamp(session.verifiedAt, "Auth session verifiedAt")
  };
}

function normalizeRecoveryCode(value: unknown): RecoveryCode {
  const code = requireRecord(value, "Recovery code");
  return {
    ownerId: requiredIdentifier(code.ownerId, "Recovery code owner id"),
    codeHash: storedHash(code.codeHash, "Recovery code hash"),
    createdAt: timestamp(code.createdAt, "Recovery code createdAt"),
    consumedAt: code.consumedAt == null ? null : timestamp(code.consumedAt, "Recovery code consumedAt")
  };
}

function normalizeAuthHandoff(value: unknown): AuthHandoff {
  const handoff = requireRecord(value, "Auth handoff");
  return {
    id: requiredIdentifier(handoff.id, "Auth handoff id"),
    tokenHash: storedHash(handoff.tokenHash, "Auth handoff tokenHash"),
    browserHash: storedHash(handoff.browserHash, "Auth handoff browserHash"),
    ownerId: requiredIdentifier(handoff.ownerId, "Auth handoff owner id"),
    sessionId: normalizeSessionId(handoff.sessionId),
    destinationOrigin: normalizeAuthOrigin(handoff.destinationOrigin, "Auth handoff destinationOrigin"),
    expiresAt: timestamp(handoff.expiresAt, "Auth handoff expiresAt"),
    consumedAt: handoff.consumedAt == null ? null : timestamp(handoff.consumedAt, "Auth handoff consumedAt")
  };
}

function normalizeAuthRateLimit(value: unknown): AuthRateLimit {
  const limit = requireRecord(value, "Auth rate limit");
  return {
    id: requiredIdentifier(limit.id, "Auth rate limit id"),
    count: nonnegativeInteger(limit.count, "Auth rate limit count"),
    resetAt: timestamp(limit.resetAt, "Auth rate limit resetAt")
  };
}

function normalizeAuthOrigin(value: unknown, label: string): string {
  const origin = requiredString(value, label);
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error(`${label} is invalid.`); }
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.hostname.endsWith(".localhost");
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localHost))
    || parsed.username || parsed.password || parsed.origin !== origin
  ) throw new Error(`${label} must be an exact secure origin or local HTTP origin.`);
  return parsed.origin;
}

function normalizeJsonRecord(value: unknown, label: string): Record<string, unknown> {
  const record = requireRecord(value, label);
  function validateJson(item: unknown, ancestors: Set<object>): void {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || !item || ancestors.has(item)) throw new Error(`${label} must contain JSON values.`);
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error(`${label} must contain JSON values.`);
    }
    const nextAncestors = new Set(ancestors).add(item);
    for (const child of Object.values(item)) validateJson(child, nextAncestors);
  }
  validateJson(record, new Set());
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function base64urlString(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (result.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(result)) throw new Error(`${label} must be base64url.`);
  return result;
}

function storedHash(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) throw new Error(`${label} is invalid.`);
  return result;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer.`);
  return value;
}

function assertNotBefore(value: string | null, minimum: string, label: string): void {
  if (value && Date.parse(value) < Date.parse(minimum)) throw new Error(`${label} cannot be before createdAt.`);
}

function normalizeAgentLabel(value: unknown): string {
  const label = requiredString(value, "Agent label");
  if (label.length > 120 || /[\r\n\0]/.test(label)) throw new Error("Agent label is invalid.");
  return label;
}

function normalizeAgentScopes(value: unknown): AgentConnectionScope[] {
  const scopes = [...new Set(requireArray(value, "Agent scopes").map((scope) => requiredString(scope, "Agent scope")))];
  if (!scopes.length || scopes.some((scope) => scope !== "read" && scope !== "write")) throw new Error("Agent scopes must contain read and/or write.");
  return scopes as AgentConnectionScope[];
}

function normalizeAgentScope(value: unknown): AgentConnectionScope {
  if (value !== "read" && value !== "write") throw new Error("Agent scope is invalid.");
  return value;
}

function resolveAgentCredential(state: AccessRegistryState, hash: string, usedAt: string): VerifiedAgentConnection {
  const connection = state.agentConnections.find((candidate) => safeHashEqual(candidate.credentialHash, hash));
  if (!connection) throw new AccessStoreError("ACCESS_AGENT_CREDENTIAL_INVALID", "Agent credential is invalid.");
  if (connection.revokedAt) throw new AccessStoreError("ACCESS_AGENT_REVOKED", "Agent connection has been revoked.");
  if (connection.expiresAt && Date.parse(connection.expiresAt) <= Date.parse(usedAt)) throw new AccessStoreError("ACCESS_AGENT_EXPIRED", "Agent connection has expired.");
  const owner = state.owners.find((candidate) => candidate.id === connection.ownerId);
  const workspace = state.workspaces.find((candidate) => candidate.id === connection.workspaceId);
  if (!owner || !workspace?.ownerIds.includes(owner.id)) throw new AccessStoreError("ACCESS_AGENT_CREDENTIAL_INVALID", "Agent connection is unavailable.");
  return { connection, owner, workspace };
}

function normalizeAgentCredential(value: unknown): string {
  const credential = requiredString(value, "Agent credential");
  if (!/^kac_agent-[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/.test(credential)) throw new AccessStoreError("ACCESS_AGENT_CREDENTIAL_INVALID", "Agent credential is invalid.");
  return credential;
}

function hashAgentCredential(credential: string): string {
  return `sha256:${crypto.createHash("sha256").update(credential).digest("hex")}`;
}

function normalizeProviderSubject(value: unknown): string {
  const subject = requiredString(value, "Provider subject");
  if (subject.length > 512 || /[\r\n\0]/.test(subject)) throw new Error("Provider subject is invalid.");
  return subject;
}

function normalizeSessionId(value: unknown): string {
  const sessionId = requiredString(value, "Session id");
  if (sessionId.length > 512 || /[\r\n\0]/.test(sessionId)) throw new Error("Session id is invalid.");
  return sessionId;
}

function revokedSessionKey(providerSubject: string, sessionId: string): string {
  return `${providerSubject}\0${sessionId}`;
}

function hasRevokedSession(state: AccessRegistryState, providerSubject: string, sessionId: string): boolean {
  const owner = findOwner(state, providerSubject);
  return state.revokedSessions.some(
    (candidate) => candidate.sessionId === sessionId && (
      candidate.providerSubject === providerSubject
      || candidate.providerSubject === owner?.providerSubject
      || candidate.providerSubject === owner?.id
    )
  );
}

function normalizeOwnerEmail(value: unknown): string {
  if (typeof value !== "string") throw new Error("Owner email must be a string.");
  const email = value.trim().toLowerCase();
  if (!email) return "";
  if (email.length > 320 || /[\s\r\n\0]/.test(email) || !/^[^@]+@[^@]+$/.test(email)) {
    throw new Error("Owner email is invalid.");
  }
  return email;
}

function normalizeOwnerDisplayName(value: unknown): string {
  const displayName = requiredString(value, "Owner display name");
  if (displayName.length > 120 || /[\r\n\0]/.test(displayName)) throw new Error("Owner display name is invalid.");
  return displayName;
}

function normalizeWorkspaceSlug(value: unknown): string {
  const slug = requiredString(value, "Workspace slug").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new Error("Workspace slug must be a valid lowercase hostname label.");
  }
  return slug;
}

function normalizeWorkspaceName(value: unknown): string {
  const name = requiredString(value, "Workspace name");
  if (name.length > 120 || /[\r\n\0]/.test(name)) throw new Error("Workspace name is invalid.");
  return name;
}

function normalizeDestinationHost(value: unknown): string {
  const host = requiredString(value, "Handoff destination host").toLowerCase();
  if (host.length > 253 || /[\s/@?#\\]/.test(host)) throw new Error("Handoff destination host is invalid.");
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    throw new Error("Handoff destination host is invalid.");
  }
  if (!parsed.hostname || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error("Handoff destination host is invalid.");
  }
  return parsed.host.toLowerCase();
}

function normalizeHandoffToken(value: unknown): string {
  const token = requiredString(value, "Handoff token");
  if (!/^kch_[A-Za-z0-9_-]{43}$/.test(token)) throw new AccessStoreError("ACCESS_HANDOFF_INVALID", "Handoff is invalid.");
  return token;
}

function hashHandoffToken(token: string): string {
  return `sha256:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function resolveHandoffExpiry(input: CreateHandoffInput, issuedAt: string): string {
  if (input.expiresAt !== undefined && input.ttlSeconds !== undefined) {
    throw new Error("Provide either expiresAt or ttlSeconds for a handoff, not both.");
  }
  if (input.expiresAt !== undefined) {
    const expiresAt = timestamp(input.expiresAt, "Handoff expiresAt");
    if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new Error("Handoff expiresAt must be in the future.");
    if (Date.parse(expiresAt) - Date.parse(issuedAt) > MAX_HANDOFF_TTL_SECONDS * 1_000) {
      throw new Error(`Handoff lifetime cannot exceed ${MAX_HANDOFF_TTL_SECONDS} seconds.`);
    }
    return expiresAt;
  }
  const ttlSeconds = input.ttlSeconds === undefined ? DEFAULT_HANDOFF_TTL_SECONDS : Number(input.ttlSeconds);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_HANDOFF_TTL_SECONDS) {
    throw new Error(`Handoff ttlSeconds must be an integer from 1 to ${MAX_HANDOFF_TTL_SECONDS}.`);
  }
  return new Date(Date.parse(issuedAt) + ttlSeconds * 1_000).toISOString();
}

function validNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw new Error("Access-store clock returned an invalid date.");
  return value.toISOString();
}

function uniqueId(prefix: string, existing: Set<string>): string {
  let id = "";
  do id = `${prefix}-${crypto.randomUUID()}`;
  while (existing.has(id));
  return id;
}

function validateTableName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("Invalid PostgreSQL table name.");
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function optionalArray(value: unknown, label: string): unknown[] {
  return value === undefined ? [] : requireArray(value, label);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function requiredIdentifier(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (result.length > 512 || /[\r\n\0]/.test(result)) throw new Error(`${label} is invalid.`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(result).toISOString();
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}.`);
    seen.add(value);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
