import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import { workspaceStates } from "./schema";

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
  // Imported lazily so a Node build (Vercel) never loads the Workers-only
  // module unless the D1 path is actually used.
  const { env } = await import("cloudflare:workers");
  const bindings = env as unknown as { DB?: D1Database };
  if (!bindings.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  await ensureWorkspaceSchema(bindings.DB);

  return drizzle(bindings.DB, { schema });
}

// Vercel's Upstash Redis integration sets KV_REST_API_*; a direct Upstash
// database uses UPSTASH_REDIS_REST_*. Either one switches storage to Redis.
function redisConfig(): { url: string; token: string } | undefined {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : undefined;
}

async function redis(
  config: { url: string; token: string },
  command: string[],
): Promise<unknown> {
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  const body = (await response.json()) as { result?: unknown; error?: string };
  if (!response.ok || body.error) {
    throw new Error(`Workspace storage request failed: ${body.error ?? response.status}`);
  }
  return body.result;
}

const redisKey = (id: string) => `planpilot:workspace:${id}`;

export async function readWorkspaceState(id: string): Promise<string | null> {
  const config = redisConfig();
  if (config) {
    const result = await redis(config, ["GET", redisKey(id)]);
    return typeof result === "string" ? result : null;
  }
  const db = await getDb();
  const [record] = await db
    .select({ stateJson: workspaceStates.stateJson })
    .from(workspaceStates)
    .where(eq(workspaceStates.id, id))
    .limit(1);
  return record?.stateJson ?? null;
}

export async function writeWorkspaceState(
  id: string,
  stateJson: string,
): Promise<void> {
  const config = redisConfig();
  if (config) {
    await redis(config, ["SET", redisKey(id), stateJson]);
    return;
  }
  const db = await getDb();
  const updatedAt = new Date().toISOString();
  await db
    .insert(workspaceStates)
    .values({ id, stateJson, updatedAt })
    .onConflictDoUpdate({
      target: workspaceStates.id,
      set: { stateJson, updatedAt },
    });
}

export async function deleteWorkspaceState(id: string): Promise<void> {
  const config = redisConfig();
  if (config) {
    await redis(config, ["DEL", redisKey(id)]);
    return;
  }
  const db = await getDb();
  await db.delete(workspaceStates).where(eq(workspaceStates.id, id));
}
