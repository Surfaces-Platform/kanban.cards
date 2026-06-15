import type { PostgresOptions } from "./types";

const SSL_MODES_WITH_LEGACY_PG_WARNING = new Set(["prefer", "require", "verify-ca"]);

export function normalizePostgresConnectionString(connectionString: string | undefined): string | undefined {
  if (!connectionString) return connectionString;

  try {
    const url = new URL(connectionString);
    const sslMode = url.searchParams.get("sslmode");
    if (sslMode && SSL_MODES_WITH_LEGACY_PG_WARNING.has(sslMode) && !url.searchParams.has("uselibpqcompat")) {
      url.searchParams.set("sslmode", "verify-full");
      return url.toString();
    }
  } catch (_error) {
    return connectionString;
  }

  return connectionString;
}

export function resolvePostgresSsl(options: Pick<PostgresOptions, "ssl"> = {}): PostgresOptions["ssl"] | undefined {
  if (options.ssl !== undefined) return options.ssl;
  if (process.env.KANBAN_CARDS_POSTGRES_SSL === "disable") return false;
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) return { rejectUnauthorized: false };
  return undefined;
}
