import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

import { normalizePostgresConnectionString, resolvePostgresSsl } from "./postgres-config";
import type {
  AgentSpec,
  Board,
  BoardDraft,
  BoardTemplate,
  CommentKind,
  CommentStatus,
  Lane,
  PostgresClient,
  PostgresOptions,
  Project,
  StateStore,
  StateStoreOptions,
  Team,
  TeamInvite,
  TeamInviteStatus,
  TeamMember,
  TeamRole,
  WorkItem,
  WorkItemComment,
  WorkspaceState
} from "./types";

export const COMMENT_KINDS = new Set<CommentKind>(["progress", "instruction", "question", "change_request", "note"]);
export const COMMENT_STATUSES = new Set<CommentStatus>(["open", "acknowledged", "resolved"]);
export const DEFAULT_TEAM_ID = "kanban.cards:team";
export const DEFAULT_PROJECT_ID = "kanban.cards:default";

const DEFAULT_WORKSPACE_ID = "default";
const DEFAULT_TABLE_NAME = "kanban_workspaces";
const DEFAULT_TEAM_NAME = "kanban.cards";
const DEFAULT_PROJECT_NAME = "kanban.cards";
const TEAM_ROLES = new Set<TeamRole>(["owner", "admin", "member"]);
const TEAM_INVITE_STATUSES = new Set<TeamInviteStatus>(["pending", "accepted", "revoked"]);
type UnknownRecord = Record<string, any>;
type AliasMap = Map<string, string>;

export function createStateStore(options: StateStoreOptions | string = {}): StateStore {
  if (typeof options === "string") return createFileStateStore(options);

  const connectionString =
    options.connectionString || process.env.KANBAN_CARDS_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (connectionString) {
    return createPostgresStateStore({
      connectionString,
      workspaceId: options.workspaceId,
      tableName: options.tableName,
      pool: options.pool,
      ssl: options.ssl
    });
  }

  return createFileStateStore(options.dataPath || path.join(__dirname, "data", "kanban-cards-state.json"));
}

export function createFileStateStore(dataPath: string): StateStore {
  const resolvedPath = path.resolve(dataPath);
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<WorkspaceState> {
    try {
      const raw = await fs.readFile(resolvedPath, "utf8");
      return normalizeWorkspace(JSON.parse(raw));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const state = freshWorkspaceState();
      await write(state);
      return state;
    }
  }

  async function write(nextState: unknown): Promise<WorkspaceState> {
    const normalized = normalizeWorkspace(nextState);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    const tempPath = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`);
    await fs.rename(tempPath, resolvedPath);
    return normalized;
  }

  async function update<T>(mutator: (state: WorkspaceState) => T): Promise<{ state: WorkspaceState; result: T }> {
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

  return { kind: "file", path: resolvedPath, read, write, update };
}

export function createPostgresStateStore(options: StateStoreOptions = {}): StateStore {
  const tableName = options.tableName || DEFAULT_TABLE_NAME;
  const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
  const pool =
    options.pool ||
    new Pool({
      connectionString: normalizePostgresConnectionString(options.connectionString),
      ssl: resolvePostgresSsl(options)
    });
  let readyPromise: Promise<unknown> | null = null;

  async function ensureReady(client: PostgresClient = pool): Promise<void> {
    if (!readyPromise || client !== pool) {
      const ready = client.query(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id text PRIMARY KEY,
          state jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      if (client === pool) readyPromise = ready;
      await ready;
      return;
    }

    await readyPromise;
  }

  async function read(): Promise<WorkspaceState> {
    await ensureReady();
    const result = await pool.query<{ state: unknown }>(`SELECT state FROM ${tableName} WHERE id = $1`, [workspaceId]);
    if (!result.rows.length) return write(freshWorkspaceState());
    return normalizeWorkspace(result.rows[0].state);
  }

  async function write(nextState: unknown): Promise<WorkspaceState> {
    const normalized = normalizeWorkspace(nextState);
    await ensureReady();
    await pool.query(
      `INSERT INTO ${tableName} (id, state, created_at, updated_at)
       VALUES ($1, $2::jsonb, now(), now())
       ON CONFLICT (id)
       DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [workspaceId, JSON.stringify(normalized)]
    );
    return normalized;
  }

  async function update<T>(mutator: (state: WorkspaceState) => T): Promise<{ state: WorkspaceState; result: T }> {
    const client = await pool.connect();
    try {
      await ensureReady(client);
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${tableName} (id, state, created_at, updated_at)
         VALUES ($1, $2::jsonb, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [workspaceId, JSON.stringify(freshWorkspaceState())]
      );
      const result = await client.query<{ state: unknown }>(`SELECT state FROM ${tableName} WHERE id = $1 FOR UPDATE`, [workspaceId]);
      const state = normalizeWorkspace(result.rows[0]?.state);
      const mutationResult = mutator(state);
      const normalized = normalizeWorkspace(state);
      await client.query(`UPDATE ${tableName} SET state = $2::jsonb, updated_at = now() WHERE id = $1`, [
        workspaceId,
        JSON.stringify(normalized)
      ]);
      await client.query("COMMIT");
      return { state: normalized, result: mutationResult };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return { kind: "postgres", path: `${tableName}:${workspaceId}`, read, write, update };
}

export function freshWorkspaceState(): WorkspaceState {
  const now = new Date().toISOString();
  const team = createTeam({ id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME, createdAt: now, updatedAt: now });
  const project = createProject({ id: DEFAULT_PROJECT_ID, teamId: team.id, name: DEFAULT_PROJECT_NAME, createdAt: now, updatedAt: now });
  const board = createBoard({ name: "Untitled board", projectId: project.id });
  return {
    team,
    projects: [project],
    activeProjectId: project.id,
    members: [],
    invites: [],
    boards: [board],
    activeBoardId: board.id,
    templates: []
  };
}

export function createBoard(input: Partial<Board> = {}): Board {
  const now = new Date().toISOString();
  const projectId = input.projectId || DEFAULT_PROJECT_ID;
  const board = normalizeBoard({
    id: input.id || makeId("board"),
    projectId,
    name: input.name || "Untitled board",
    lanes: input.lanes || [],
    agentSpecs: input.agentSpecs || [],
    workItems: input.workItems || [],
    selectedId: input.selectedId || null,
    flowPrompt: input.flowPrompt || "",
    configDraft: input.configDraft || null,
    isEditingFlow: Boolean(input.isEditingFlow),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now
  }, projectId, new Set([projectId]));
  if (!board) throw new Error("Unable to create board.");
  return board;
}

export function createTeam(input: Partial<Team> = {}): Team {
  const now = new Date().toISOString();
  const team = normalizeTeam({
    id: input.id || DEFAULT_TEAM_ID,
    name: input.name || DEFAULT_TEAM_NAME,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now
  });
  if (!team) throw new Error("Unable to create team.");
  return team;
}

export function createProject(input: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  const project = normalizeProject({
    id: input.id || makeId("project"),
    teamId: input.teamId || DEFAULT_TEAM_ID,
    name: input.name || "Untitled project",
    description: input.description || "",
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now
  }, input.teamId || DEFAULT_TEAM_ID);
  if (!project) throw new Error("Unable to create project.");
  return project;
}

export function createTeamMember(input: Partial<TeamMember> = {}): TeamMember {
  const now = new Date().toISOString();
  const member = normalizeTeamMember({
    id: input.id || makeId("member"),
    teamId: input.teamId || DEFAULT_TEAM_ID,
    userId: input.userId || "",
    email: input.email || "",
    name: input.name || "",
    role: input.role || "member",
    projectIds: input.projectIds || ["*"],
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
    lastSeenAt: input.lastSeenAt || now
  }, input.teamId || DEFAULT_TEAM_ID, new Set([...(input.projectIds || []), DEFAULT_PROJECT_ID]));
  if (!member) throw new Error("Unable to create team member.");
  return member;
}

export function createTeamInvite(input: Partial<TeamInvite> = {}): TeamInvite {
  const now = new Date().toISOString();
  const invite = normalizeTeamInvite({
    id: input.id || makeId("invite"),
    teamId: input.teamId || DEFAULT_TEAM_ID,
    email: input.email || "",
    role: input.role || "member",
    projectIds: input.projectIds || ["*"],
    tokenHash: input.tokenHash || "",
    invitedBy: input.invitedBy || "",
    acceptedBy: input.acceptedBy || null,
    status: input.status || "pending",
    expiresAt: input.expiresAt || new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString(),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
    acceptedAt: input.acceptedAt || null,
    revokedAt: input.revokedAt || null
  }, input.teamId || DEFAULT_TEAM_ID, new Set([...(input.projectIds || []), DEFAULT_PROJECT_ID]));
  if (!invite) throw new Error("Unable to create team invite.");
  return invite;
}

export function normalizeWorkspace(rawState: unknown): WorkspaceState {
  const state = isRecord(rawState) ? rawState : {};
  const team = normalizeTeam(state.team) || createTeam({ id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME });
  const projects = Array.isArray(state.projects)
    ? withUniqueProjectIds(state.projects.map((project) => normalizeProject(project, team.id)).filter(isNonNull), team.id)
    : [];

  if (!projects.length) {
    projects.push(createProject({ id: DEFAULT_PROJECT_ID, teamId: team.id, name: DEFAULT_PROJECT_NAME }));
  }

  const projectIds = new Set(projects.map((project) => project.id));
  const fallbackProjectId = projects.some((project) => project.id === DEFAULT_PROJECT_ID) ? DEFAULT_PROJECT_ID : projects[0].id;
  const boards = Array.isArray(state.boards)
    ? state.boards.map((board) => normalizeBoard(board, fallbackProjectId, projectIds)).filter(isNonNull)
    : [];

  if (!boards.length) boards.push(createBoard({ name: "Untitled board", projectId: fallbackProjectId }));

  const activeProjectId = projectIds.has(String(state.activeProjectId)) ? String(state.activeProjectId) : fallbackProjectId;
  const activeProjectBoards = boards.filter((board) => board.projectId === activeProjectId);
  const activeBoardId = boards.some((board) => board.id === state.activeBoardId)
    ? String(state.activeBoardId)
    : (activeProjectBoards[0] || boards[0]).id;
  const members = Array.isArray(state.members)
    ? withUniqueTeamMembers(state.members.map((member) => normalizeTeamMember(member, team.id, projectIds)).filter(isNonNull))
    : [];
  const invites = Array.isArray(state.invites)
    ? withUniqueInviteIds(state.invites.map((invite) => normalizeTeamInvite(invite, team.id, projectIds)).filter(isNonNull))
    : [];
  const templates = Array.isArray(state.templates) ? state.templates.map(normalizeTemplate).filter(isNonNull) : [];

  return { team, projects, activeProjectId, members, invites, boards, activeBoardId, templates };
}

function normalizeTeam(rawTeam: unknown): Team | null {
  if (!isRecord(rawTeam)) return null;
  const id = String(rawTeam.id || "").trim();
  const name = String(rawTeam.name || DEFAULT_TEAM_NAME).trim() || DEFAULT_TEAM_NAME;
  if (!id) return null;
  const now = new Date().toISOString();
  return {
    id,
    name,
    createdAt: String(rawTeam.createdAt || now),
    updatedAt: String(rawTeam.updatedAt || now)
  };
}

function normalizeProject(rawProject: unknown, fallbackTeamId: string = DEFAULT_TEAM_ID): Project | null {
  if (!isRecord(rawProject)) return null;
  const id = String(rawProject.id || "").trim();
  const name = String(rawProject.name || "").trim();
  if (!id || !name) return null;
  const now = new Date().toISOString();
  return {
    id,
    teamId: String(rawProject.teamId || fallbackTeamId).trim() || fallbackTeamId,
    name,
    description: String(rawProject.description || "").trim(),
    createdAt: String(rawProject.createdAt || now),
    updatedAt: String(rawProject.updatedAt || now)
  };
}

function normalizeTeamMember(rawMember: unknown, fallbackTeamId: string = DEFAULT_TEAM_ID, projectIds: Set<string> = new Set([DEFAULT_PROJECT_ID])): TeamMember | null {
  if (!isRecord(rawMember)) return null;
  const id = String(rawMember.id || "").trim();
  const userId = String(rawMember.userId || "").trim();
  const email = normalizeEmail(rawMember.email);
  if (!id || !userId || !email) return null;
  const now = new Date().toISOString();
  return {
    id,
    teamId: String(rawMember.teamId || fallbackTeamId).trim() || fallbackTeamId,
    userId,
    email,
    name: String(rawMember.name || email).trim() || email,
    role: TEAM_ROLES.has(rawMember.role as TeamRole) ? rawMember.role as TeamRole : "member",
    projectIds: normalizeProjectIds(rawMember.projectIds, projectIds),
    createdAt: String(rawMember.createdAt || now),
    updatedAt: String(rawMember.updatedAt || now),
    lastSeenAt: String(rawMember.lastSeenAt || rawMember.updatedAt || now)
  };
}

function normalizeTeamInvite(rawInvite: unknown, fallbackTeamId: string = DEFAULT_TEAM_ID, projectIds: Set<string> = new Set([DEFAULT_PROJECT_ID])): TeamInvite | null {
  if (!isRecord(rawInvite)) return null;
  const id = String(rawInvite.id || "").trim();
  const email = normalizeEmail(rawInvite.email);
  const tokenHash = String(rawInvite.tokenHash || "").trim();
  if (!id || !email || !tokenHash) return null;
  const now = new Date().toISOString();
  return {
    id,
    teamId: String(rawInvite.teamId || fallbackTeamId).trim() || fallbackTeamId,
    email,
    role: TEAM_ROLES.has(rawInvite.role as TeamRole) ? rawInvite.role as TeamRole : "member",
    projectIds: normalizeProjectIds(rawInvite.projectIds, projectIds),
    tokenHash,
    invitedBy: String(rawInvite.invitedBy || "").trim(),
    acceptedBy: nullableString(rawInvite.acceptedBy),
    status: TEAM_INVITE_STATUSES.has(rawInvite.status as TeamInviteStatus) ? rawInvite.status as TeamInviteStatus : "pending",
    expiresAt: String(rawInvite.expiresAt || new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString()),
    createdAt: String(rawInvite.createdAt || now),
    updatedAt: String(rawInvite.updatedAt || now),
    acceptedAt: nullableString(rawInvite.acceptedAt),
    revokedAt: nullableString(rawInvite.revokedAt)
  };
}

function normalizeBoard(rawBoard: unknown, fallbackProjectId: string = DEFAULT_PROJECT_ID, projectIds: Set<string> = new Set([DEFAULT_PROJECT_ID])): Board | null {
  if (!isRecord(rawBoard)) return null;

  const rawLaneRecords = Array.isArray(rawBoard.lanes) ? rawBoard.lanes.filter(isRecord) : [];
  const normalizedLanePairs = rawLaneRecords
    .map((rawLane) => ({ raw: rawLane, lane: normalizeLane(rawLane) }))
    .filter((pair): pair is { raw: UnknownRecord; lane: Lane } => Boolean(pair.lane));
  const lanes = withUniqueLaneIds(normalizedLanePairs.map((pair) => pair.lane));
  const laneAliases = buildAliasMap(normalizedLanePairs.map((pair) => pair.raw), lanes, ["id", "title"]);
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const rawAgentRecords = Array.isArray(rawBoard.agentSpecs) ? rawBoard.agentSpecs.filter(isRecord) : [];
  const normalizedAgentPairs = rawAgentRecords
    .map((rawAgent) => ({ raw: rawAgent, agent: normalizeAgentSpec(rawAgent, laneIds, laneAliases) }))
    .filter((pair): pair is { raw: UnknownRecord; agent: AgentSpec } => Boolean(pair.agent));
  const agentSpecs = withUniqueAgentIds(normalizedAgentPairs.map((pair) => pair.agent));
  const agentAliases = buildAliasMap(normalizedAgentPairs.map((pair) => pair.raw), agentSpecs, ["id", "name"]);
  const agentIds = new Set(agentSpecs.map((agent) => agent.id));
  const normalizedLanes = lanes.map((lane) => normalizeLaneAgentDefaults(lane, agentIds, agentAliases));
  const workItems = Array.isArray(rawBoard.workItems)
    ? rawBoard.workItems.map((item) => normalizeWorkItem(item, normalizedLanes, laneAliases, agentIds, agentAliases)).filter(isNonNull)
    : [];
  const selectedId = workItems.some((item) => item.id === rawBoard.selectedId) ? String(rawBoard.selectedId) : null;
  const configDraft = normalizeDraft(rawBoard.configDraft);
  const name = String(rawBoard.name || "Untitled board").trim() || "Untitled board";
  const requestedProjectId = String(rawBoard.projectId || "").trim();
  const projectId = requestedProjectId && projectIds.has(requestedProjectId) ? requestedProjectId : fallbackProjectId;
  const now = new Date().toISOString();

  return {
    id: String(rawBoard.id || makeId("board")),
    projectId,
    name,
    lanes: normalizedLanes,
    agentSpecs,
    workItems,
    selectedId,
    flowPrompt: typeof rawBoard.flowPrompt === "string" ? rawBoard.flowPrompt : "",
    configDraft,
    isEditingFlow: Boolean(rawBoard.isEditingFlow && configDraft),
    createdAt: String(rawBoard.createdAt || now),
    updatedAt: String(rawBoard.updatedAt || now)
  };
}

function normalizeTemplate(rawTemplate: unknown): BoardTemplate | null {
  if (!isRecord(rawTemplate)) return null;

  const rawLaneRecords = Array.isArray(rawTemplate.lanes) ? rawTemplate.lanes.filter(isRecord) : [];
  const normalizedLanePairs = rawLaneRecords
    .map((rawLane) => ({ raw: rawLane, lane: normalizeLane(rawLane) }))
    .filter((pair): pair is { raw: UnknownRecord; lane: Lane } => Boolean(pair.lane));
  const lanes = withUniqueLaneIds(normalizedLanePairs.map((pair) => pair.lane));
  const laneAliases = buildAliasMap(normalizedLanePairs.map((pair) => pair.raw), lanes, ["id", "title"]);
  const name = String(rawTemplate.name || "").trim();
  if (!name || !lanes.length) return null;
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const rawAgentRecords = Array.isArray(rawTemplate.agentSpecs) ? rawTemplate.agentSpecs.filter(isRecord) : [];
  const normalizedAgentPairs = rawAgentRecords
    .map((rawAgent) => ({ raw: rawAgent, agent: normalizeAgentSpec(rawAgent, laneIds, laneAliases) }))
    .filter((pair): pair is { raw: UnknownRecord; agent: AgentSpec } => Boolean(pair.agent));
  const agentSpecs = withUniqueAgentIds(normalizedAgentPairs.map((pair) => pair.agent));
  const agentAliases = buildAliasMap(normalizedAgentPairs.map((pair) => pair.raw), agentSpecs, ["id", "name"]);
  const agentIds = new Set(agentSpecs.map((agent) => agent.id));

  return {
    id: String(rawTemplate.id || makeId("template")),
    name,
    description: String(rawTemplate.description || "").trim(),
    builtIn: false,
    lanes: lanes.map((lane) => normalizeLaneAgentDefaults(lane, agentIds, agentAliases)),
    agentSpecs,
    createdAt: String(rawTemplate.createdAt || new Date().toISOString())
  };
}

function withUniqueProjectIds(projects: Project[], fallbackTeamId: string): Project[] {
  const used = new Map<string, number>();
  return projects.map((project) => {
    const preferredId = String(project.id || "").trim();
    const baseId = preferredId || makeId("project");
    const nextCount = (used.get(baseId) || 0) + 1;
    used.set(baseId, nextCount);
    return {
      ...project,
      id: nextCount === 1 ? baseId : `${baseId}-${nextCount}`,
      teamId: project.teamId || fallbackTeamId
    };
  });
}

function withUniqueTeamMembers(members: TeamMember[]): TeamMember[] {
  const used = new Set<string>();
  const result: TeamMember[] = [];
  for (const member of members) {
    const userKey = `user:${member.userId}`;
    const emailKey = `email:${member.email}`;
    if (used.has(userKey) || used.has(emailKey)) continue;
    used.add(userKey);
    used.add(emailKey);
    result.push(member);
  }
  return result;
}

function withUniqueInviteIds(invites: TeamInvite[]): TeamInvite[] {
  const used = new Map<string, number>();
  return invites.map((invite) => {
    const baseId = String(invite.id || "").trim() || makeId("invite");
    const nextCount = (used.get(baseId) || 0) + 1;
    used.set(baseId, nextCount);
    return {
      ...invite,
      id: nextCount === 1 ? baseId : `${baseId}-${nextCount}`
    };
  });
}

function normalizeProjectIds(value: unknown, projectIds: Set<string>): string[] {
  if (Array.isArray(value)) {
    if (value.some((projectId) => String(projectId || "").trim() === "*")) return ["*"];
    const normalized = Array.from(new Set(value.map((projectId) => String(projectId || "").trim()).filter((projectId) => projectIds.has(projectId))));
    return normalized.length ? normalized : ["*"];
  }
  return ["*"];
}

export function normalizeDraft(draft: unknown): BoardDraft | null {
  if (!isRecord(draft) || !Array.isArray(draft.lanes)) return null;
  const rawLaneRecords = draft.lanes.filter(isRecord);
  const normalizedLanePairs = rawLaneRecords
    .map((rawLane) => ({ raw: rawLane, lane: normalizeLane(rawLane) }))
    .filter((pair): pair is { raw: UnknownRecord; lane: Lane } => Boolean(pair.lane));
  const lanes = withUniqueLaneIds(normalizedLanePairs.map((pair) => pair.lane));
  const laneAliases = buildAliasMap(normalizedLanePairs.map((pair) => pair.raw), lanes, ["id", "title"]);
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const rawAgentRecords = Array.isArray(draft.agentSpecs) ? draft.agentSpecs.filter(isRecord) : [];
  const normalizedAgentPairs = rawAgentRecords
    .map((rawAgent) => ({ raw: rawAgent, agent: normalizeAgentSpec(rawAgent, laneIds, laneAliases) }))
    .filter((pair): pair is { raw: UnknownRecord; agent: AgentSpec } => Boolean(pair.agent));
  const agentSpecs = withUniqueAgentIds(normalizedAgentPairs.map((pair) => pair.agent));
  const agentAliases = buildAliasMap(normalizedAgentPairs.map((pair) => pair.raw), agentSpecs, ["id", "name"]);
  const agentIds = new Set(agentSpecs.map((agent) => agent.id));
  return {
    lanes: lanes.map((lane) => normalizeLaneAgentDefaults(lane, agentIds, agentAliases)),
    agentSpecs
  };
}

function normalizeLane(lane: unknown): Lane | null {
  if (!isRecord(lane)) return null;
  const title = String(lane.title || "").trim();
  if (!title) return null;

  const gate = isRecord(lane.gate) ? lane.gate : {};
  const checks = Array.isArray(gate.checks)
    ? gate.checks.map((check: unknown) => String(check || "").trim()).filter(Boolean)
    : defaultGateChecks(title);

  return {
    id: slugify(lane.id || title) || slugify(title),
    title,
    description: String(lane.description || "").trim(),
    defaultOwnerAgentId: nullableString(lane.defaultOwnerAgentId),
    defaultReviewerAgentId: nullableString(lane.defaultReviewerAgentId),
    gate: {
      title: String(gate.title || `${title} gate`).trim(),
      checks: checks.length ? checks : defaultGateChecks(title)
    }
  };
}

function normalizeAgentSpec(rawAgent: unknown, laneIds: Set<string> = new Set(), laneAliases: AliasMap = new Map()): AgentSpec | null {
  if (!isRecord(rawAgent)) return null;
  const name = String(rawAgent.name || "").trim();
  const id = slugify(rawAgent.id || name) || slugify(name);
  if (!id || !name) return null;

  return {
    id,
    name,
    role: String(rawAgent.role || "").trim(),
    laneIds: Array.isArray(rawAgent.laneIds)
      ? rawAgent.laneIds.map((laneId: unknown) => resolveAlias(laneId, laneAliases) || slugify(laneId)).filter((laneId: string) => laneIds.has(laneId))
      : [],
    instructions: String(rawAgent.instructions || "").trim(),
    skillNotes: String(rawAgent.skillNotes || "").trim()
  };
}

function normalizeLaneAgentDefaults(lane: Lane, agentIds: Set<string> = new Set(), agentAliases: AliasMap = new Map()): Lane {
  const ownerAgentId = normalizeLinkedAgentId(lane.defaultOwnerAgentId, agentIds, agentAliases, true);
  const reviewerAgentId = normalizeLinkedAgentId(lane.defaultReviewerAgentId, agentIds, agentAliases, true);
  return {
    ...lane,
    defaultOwnerAgentId: ownerAgentId,
    defaultReviewerAgentId: reviewerAgentId
  };
}

function withUniqueAgentIds(agentSpecs: AgentSpec[]): AgentSpec[] {
  const used = new Map<string, number>();
  return agentSpecs.map((agent) => {
    const baseId = slugify(agent.id) || "agent";
    const nextCount = (used.get(baseId) || 0) + 1;
    used.set(baseId, nextCount);
    return {
      ...agent,
      id: nextCount === 1 ? baseId : `${baseId}-${nextCount}`
    };
  });
}

function normalizeWorkItem(
  rawItem: unknown,
  lanes: Lane[] = [],
  laneAliases: AliasMap = new Map(),
  agentIds: Set<string> = new Set(),
  agentAliases: AliasMap = new Map()
): WorkItem | null {
  if (!isRecord(rawItem)) return null;
  const title = String(rawItem.title || "").trim();
  if (!title) return null;

  const laneIds = new Set(lanes.map((lane) => lane.id));
  const fallbackLaneId = lanes[0]?.id || "";
  const requestedLaneId = String(rawItem.laneId || "").trim();
  const resolvedLaneId = resolveAlias(requestedLaneId, laneAliases) || requestedLaneId;
  const laneId = laneIds.has(resolvedLaneId) ? resolvedLaneId : fallbackLaneId;
  const now = new Date().toISOString();

  return {
    id: String(rawItem.id || makeId("item")),
    title,
    summary: String(rawItem.summary || "").trim(),
    laneId,
    requesterMemberId: nullableString(rawItem.requesterMemberId),
    ownerMemberId: nullableString(rawItem.ownerMemberId),
    reviewerMemberId: nullableString(rawItem.reviewerMemberId),
    ownerAgentId: normalizeLinkedAgentId(rawItem.ownerAgentId, agentIds, agentAliases),
    reviewerAgentId: normalizeLinkedAgentId(rawItem.reviewerAgentId, agentIds, agentAliases),
    blockers: Array.isArray(rawItem.blockers) ? rawItem.blockers : [],
    approvals: Array.isArray(rawItem.approvals) ? rawItem.approvals : [],
    completed: Boolean(rawItem.completed),
    delivered: Boolean(rawItem.delivered),
    comments: Array.isArray(rawItem.comments) ? rawItem.comments.map(normalizeComment).filter(isNonNull) : [],
    createdAt: String(rawItem.createdAt || now),
    updatedAt: String(rawItem.updatedAt || now)
  };
}

export function createWorkItem(input: UnknownRecord, board: Board): WorkItem | null {
  return normalizeWorkItem(
    {
      ...input,
      id: input.id || makeId("item"),
      laneId: input.laneId || board.lanes[0]?.id || "",
      comments: input.comments || []
    },
    board.lanes
  );
}

function buildAliasMap<T extends { id: string }>(rawRecords: UnknownRecord[], normalizedRecords: T[], fields: string[]): AliasMap {
  const aliases: AliasMap = new Map();
  rawRecords.forEach((rawRecord, index) => {
    const normalizedId = normalizedRecords[index]?.id;
    if (!normalizedId) return;
    addAlias(aliases, normalizedId, normalizedId);
    for (const field of fields) {
      addAlias(aliases, rawRecord[field], normalizedId);
    }
  });
  return aliases;
}

function addAlias(aliases: AliasMap, value: unknown, normalizedId: string): void {
  const raw = String(value || "").trim();
  if (!raw) return;
  if (!aliases.has(raw)) aliases.set(raw, normalizedId);
  const slug = slugify(raw);
  if (slug && !aliases.has(slug)) aliases.set(slug, normalizedId);
}

function resolveAlias(value: unknown, aliases: AliasMap): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return aliases.get(raw) || aliases.get(slugify(raw)) || null;
}

function normalizeLinkedAgentId(value: unknown, agentIds: Set<string>, agentAliases: AliasMap, requireKnownAgent = false): string | null {
  const raw = nullableString(value);
  if (!raw) return null;
  const resolved = resolveAlias(raw, agentAliases) || raw;
  if (!agentIds.size) return requireKnownAgent ? null : resolved;
  return agentIds.has(resolved) ? resolved : null;
}

function normalizeComment(rawComment: unknown): WorkItemComment | null {
  if (!isRecord(rawComment)) return null;
  const text = String(rawComment.text || "").trim();
  if (!text) return null;

  const now = new Date().toISOString();
  const kind = COMMENT_KINDS.has(rawComment.kind as CommentKind) ? (rawComment.kind as CommentKind) : "note";
  const status = COMMENT_STATUSES.has(rawComment.status as CommentStatus) ? (rawComment.status as CommentStatus) : "open";

  return {
    id: String(rawComment.id || makeId("comment")),
    kind,
    status,
    text,
    author: String(rawComment.author || "agent").trim() || "agent",
    createdAt: String(rawComment.createdAt || now),
    updatedAt: String(rawComment.updatedAt || now)
  };
}

export function createComment(input: UnknownRecord): WorkItemComment | null {
  return normalizeComment({
    ...input,
    id: input.id || makeId("comment")
  });
}

function withUniqueLaneIds(lanes: Lane[]): Lane[] {
  const used = new Map<string, number>();
  return lanes.map((lane) => {
    const baseId = slugify(lane.id) || slugify(lane.title) || "lane";
    const nextCount = (used.get(baseId) || 0) + 1;
    used.set(baseId, nextCount);
    const id = nextCount === 1 ? baseId : `${baseId}-${nextCount}`;
    return {
      ...lane,
      id,
      defaultOwnerAgentId: nullableString(lane.defaultOwnerAgentId),
      defaultReviewerAgentId: nullableString(lane.defaultReviewerAgentId),
      gate: {
        title: lane.gate?.title || `${lane.title} gate`,
        checks: Array.isArray(lane.gate?.checks) ? [...lane.gate.checks] : defaultGateChecks(lane.title)
      }
    };
  });
}

function defaultGateChecks(title: string): string[] {
  return ["Output is reviewable.", "Blockers and open questions are captured.", `${title} handoff is clear.`];
}

export function findBoard(state: WorkspaceState, boardId: string | null | undefined): Board | null {
  return state.boards.find((board) => board.id === boardId) || null;
}

export function findProject(state: WorkspaceState, projectId: string | null | undefined): Project | null {
  return state.projects.find((project) => project.id === projectId) || null;
}

export function findTeamMember(state: WorkspaceState, memberId: string | null | undefined): TeamMember | null {
  return state.members.find((member) => member.id === memberId) || null;
}

export function findTeamMemberByIdentity(state: WorkspaceState, identity: { userId?: string | null; email?: string | null }): TeamMember | null {
  const userId = String(identity.userId || "").trim();
  const email = normalizeEmail(identity.email);
  return state.members.find((member) => {
    if (userId && member.userId === userId) return true;
    return Boolean(email && member.email === email);
  }) || null;
}

export function findTeamInvite(state: WorkspaceState, inviteId: string | null | undefined): TeamInvite | null {
  return state.invites.find((invite) => invite.id === inviteId) || null;
}

export function findWorkItem(board: Board | null | undefined, itemId: string | null | undefined): WorkItem | null {
  return board?.workItems.find((item) => item.id === itemId) || null;
}

export function findComment(item: WorkItem | null | undefined, commentId: string | null | undefined): WorkItemComment | null {
  return item?.comments.find((comment) => comment.id === commentId) || null;
}

export function touchBoard(board: Board): void {
  board.updatedAt = new Date().toISOString();
}

export function touchProject(project: Project): void {
  project.updatedAt = new Date().toISOString();
}

export function touchWorkItem(item: WorkItem): void {
  item.updatedAt = new Date().toISOString();
}

export function touchTeamMember(member: TeamMember): void {
  member.updatedAt = new Date().toISOString();
}

export function touchTeamInvite(invite: TeamInvite): void {
  invite.updatedAt = new Date().toISOString();
}

function slugify(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeEmail(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
