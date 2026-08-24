import type { Pool, PoolClient } from "pg";

export type ActivityChannel = "web" | "api";

export interface ActivityActor {
  channel: ActivityChannel;
  label: string;
  agentConnectionId?: string;
}

export interface Column {
  id: string;
  name: string;
  position: number;
}

export interface Comment {
  id: string;
  body: string;
  author: string;
  createdAt: string;
}

export interface Card {
  id: string;
  externalKey?: string;
  title: string;
  body: string;
  columnId: string;
  position: number;
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Activity {
  id: string;
  action: string;
  actor: ActivityActor;
  summary: string;
  projectId: string;
  cardId?: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  columns: Column[];
  cards: Card[];
  activity: Activity[];
  revision: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface IdempotencyRecord {
  key: string;
  method: "POST";
  path: string;
  requestHash: string;
  statusCode: number;
  response: JsonValue;
  createdAt: string;
}

export interface WorkspaceState {
  schemaVersion: 2;
  projects: Project[];
  idempotencyRecords: IdempotencyRecord[];
}

export interface StateStore {
  kind: "file" | "postgres";
  path: string;
  readExisting(): Promise<WorkspaceState | null>;
  read(): Promise<WorkspaceState>;
  write(nextState: unknown): Promise<WorkspaceState>;
  update<T>(mutator: (state: WorkspaceState) => T): Promise<{ state: WorkspaceState; result: T }>;
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
  workspaceDirectory?: string;
}

export interface WorkspaceStoreResolver {
  kind: "file" | "postgres";
  resolve(storageId: string): StateStore;
}

export type PostgresClient = Pool | PoolClient;
