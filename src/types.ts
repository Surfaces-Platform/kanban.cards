import type { Pool, PoolClient } from "pg";

export type Nullable<T> = T | null;
export type JsonObject = Record<string, unknown>;

export interface Gate {
  title: string;
  checks: string[];
}

export interface Lane {
  id: string;
  title: string;
  description: string;
  defaultOwnerAgentId: Nullable<string>;
  defaultReviewerAgentId: Nullable<string>;
  gate: Gate;
}

export interface AgentSpec {
  id: string;
  name: string;
  role: string;
  laneIds: string[];
  instructions: string;
  skillNotes: string;
}

export type CommentKind = "progress" | "instruction" | "question" | "change_request" | "note";
export type CommentStatus = "open" | "acknowledged" | "resolved";

export interface WorkItemComment {
  id: string;
  kind: CommentKind;
  status: CommentStatus;
  text: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItem {
  id: string;
  title: string;
  summary: string;
  laneId: string;
  ownerAgentId: Nullable<string>;
  reviewerAgentId: Nullable<string>;
  blockers: unknown[];
  approvals: unknown[];
  completed: boolean;
  delivered: boolean;
  comments: WorkItemComment[];
  createdAt: string;
  updatedAt: string;
}

export interface BoardDraft {
  lanes: Lane[];
  agentSpecs: AgentSpec[];
}

export interface Team {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  teamId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export type TeamRole = "owner" | "admin" | "member";
export type TeamInviteStatus = "pending" | "accepted" | "revoked";

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  email: string;
  name: string;
  role: TeamRole;
  projectIds: string[];
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface TeamInvite {
  id: string;
  teamId: string;
  email: string;
  role: TeamRole;
  projectIds: string[];
  tokenHash: string;
  invitedBy: string;
  acceptedBy: Nullable<string>;
  status: TeamInviteStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  acceptedAt: Nullable<string>;
  revokedAt: Nullable<string>;
}

export type PublicTeamMember = TeamMember;
export type PublicTeamInvite = Omit<TeamInvite, "tokenHash">;

export interface Board {
  id: string;
  projectId: string;
  name: string;
  lanes: Lane[];
  agentSpecs: AgentSpec[];
  workItems: WorkItem[];
  selectedId: Nullable<string>;
  flowPrompt: string;
  configDraft: Nullable<BoardDraft>;
  isEditingFlow: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BoardTemplate {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  lanes: Lane[];
  agentSpecs: AgentSpec[];
  createdAt: string;
}

export interface WorkspaceState {
  team: Team;
  projects: Project[];
  activeProjectId: string;
  members: TeamMember[];
  invites: TeamInvite[];
  boards: Board[];
  activeBoardId: string;
  templates: BoardTemplate[];
}

export interface AgentInstruction {
  boardId: string;
  boardName: string;
  workItemId: string;
  workItemTitle: string;
  laneId: string;
  ownerAgentId: Nullable<string>;
  reviewerAgentId: Nullable<string>;
  comment: WorkItemComment;
}

export interface TokenRecord {
  id: string;
  boardId: string;
  agentId: string;
  label: string;
  tokenHash: string;
  last4: string;
  teamId: Nullable<string>;
  projectId: Nullable<string>;
  sessionId: string;
  delegatedBy: Nullable<string>;
  capabilities: string[];
  expiresAt: Nullable<string>;
  reason: string;
  createdAt: string;
  lastUsedAt: Nullable<string>;
  revokedAt: Nullable<string>;
}

export type AgentCapability = "view" | "create" | "update" | "comment" | "move";

export type PublicTokenRecord = Omit<TokenRecord, "tokenHash">;

export interface CreatedAgentToken {
  token: string;
  tokenRecord: PublicTokenRecord;
}

export interface AgentTokenCreateInput {
  id?: string;
  boardId: string;
  agentId: string;
  label?: unknown;
  teamId?: Nullable<string>;
  projectId?: Nullable<string>;
  sessionId?: unknown;
  delegatedBy?: Nullable<string>;
  capabilities?: unknown;
  expiresAt?: Nullable<string>;
  reason?: unknown;
}

export type WorkspaceEventType = "workspace_changed";
export type WorkspaceEventActorType = "anonymous" | "agent" | "user" | "service";

export interface WorkspaceEventActorProvenance extends JsonObject {
  type: WorkspaceEventActorType;
  userId?: string;
  email?: string;
  name?: string;
  agentId?: string;
  tokenId?: string;
  sessionId?: string;
  boardId?: string;
  teamId?: Nullable<string>;
  projectId?: Nullable<string>;
  method?: string;
}

export interface WorkspaceEventDelegationProvenance extends JsonObject {
  sessionId: string;
  delegatedBy: Nullable<string>;
  capabilities: string[];
  expiresAt: Nullable<string>;
  reason: string;
}

export interface WorkspaceEventResourcePayload extends JsonObject {
  type: string;
  id?: Nullable<string>;
  cardId?: Nullable<string>;
}

export interface WorkspaceEventPayload extends JsonObject {
  reason?: string;
  action?: string;
  resource?: WorkspaceEventResourcePayload;
  actor?: WorkspaceEventActorProvenance;
  delegation?: Nullable<WorkspaceEventDelegationProvenance>;
  timestamp?: string;
  updatedAt?: string;
  projectId?: string;
  activeProjectId?: string;
  agentId?: string;
  tokenId?: string;
}

export interface WorkspaceEvent {
  id: string;
  type: WorkspaceEventType;
  boardId: Nullable<string>;
  payload: WorkspaceEventPayload;
  createdAt: string;
}

export interface WorkspaceEventCreateInput {
  type: WorkspaceEventType;
  boardId?: Nullable<string>;
  payload?: WorkspaceEventPayload;
}

export interface WorkspaceEventListRecentOptions {
  boardId?: Nullable<string>;
  cardId?: Nullable<string>;
  limit?: number;
}

export interface StateStore {
  kind: "file" | "postgres";
  path: string;
  read(): Promise<WorkspaceState>;
  write(nextState: unknown): Promise<WorkspaceState>;
  update<T>(mutator: (state: WorkspaceState) => T): Promise<{ state: WorkspaceState; result: T }>;
}

export interface AgentTokenStore {
  kind: "file" | "postgres";
  path: string;
  ensureReady(): Promise<void>;
  list(boardId: string): Promise<PublicTokenRecord[]>;
  create(input: AgentTokenCreateInput): Promise<CreatedAgentToken>;
  verify(rawToken: string): Promise<PublicTokenRecord | null>;
  revoke(boardId: string, tokenId: string): Promise<PublicTokenRecord | null>;
}

export interface EventStore {
  kind: "file" | "postgres";
  path: string;
  ensureReady(): Promise<void>;
  append(input: WorkspaceEventCreateInput): Promise<WorkspaceEvent>;
  listSince(sinceId: string | null, limit?: number): Promise<WorkspaceEvent[]>;
  listRecent(options?: WorkspaceEventListRecentOptions): Promise<WorkspaceEvent[]>;
  latestId(): Promise<string | null>;
}

export interface PostgresOptions {
  connectionString?: string;
  tableName?: string;
  pool?: Pool;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

export interface StateStoreOptions extends PostgresOptions {
  dataPath?: string;
  workspaceId?: string;
}

export interface AgentTokenStoreOptions extends PostgresOptions {
  dataPath?: string;
}

export interface EventStoreOptions extends PostgresOptions {
  dataPath?: string;
}

export type PostgresClient = Pool | PoolClient;
