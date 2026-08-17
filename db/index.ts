import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

const WORKSPACE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS workspace_states (
  id TEXT PRIMARY KEY NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

const initializedDatabases = new WeakMap<object, Promise<unknown>>();

async function ensureWorkspaceSchema(database: D1Database): Promise<void> {
  let initialization = initializedDatabases.get(database as object);
  if (!initialization) {
    initialization = database.prepare(WORKSPACE_SCHEMA_SQL).run();
    initializedDatabases.set(database as object, initialization);
  }
  try {
    await initialization;
  } catch (error) {
    initializedDatabases.delete(database as object);
    throw error;
  }
}

export async function getDb() {
  const bindings = env as unknown as { DB?: D1Database };
  if (!bindings.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  await ensureWorkspaceSchema(bindings.DB);

  return drizzle(bindings.DB, { schema });
}
