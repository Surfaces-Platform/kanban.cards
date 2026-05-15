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

export interface Board {
  id: string;
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
  createdAt: string;
  lastUsedAt: Nullable<string>;
  revokedAt: Nullable<string>;
}

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

export type PostgresClient = Pool | PoolClient;
