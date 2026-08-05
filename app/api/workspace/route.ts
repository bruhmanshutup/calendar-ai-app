import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { workspaceStates } from "@/db/schema";
import { parsePersistedWorkspace } from "@/lib/domain/workspace-state";

const WORKSPACE_ID = "owner";
const MAX_STATE_BYTES = 2_000_000;

export async function GET() {
  const db = getDb();
  const [record] = await db
    .select({ stateJson: workspaceStates.stateJson })
    .from(workspaceStates)
    .where(eq(workspaceStates.id, WORKSPACE_ID))
    .limit(1);

  if (!record) {
    return NextResponse.json(
      { state: null },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    return NextResponse.json(
      { state: parsePersistedWorkspace(JSON.parse(record.stateJson)) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: { message: "Saved workspace data is invalid." } },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  const bodyText = await request.text();
  if (bodyText.length > MAX_STATE_BYTES) {
    return NextResponse.json(
      { error: { message: "Workspace data is too large." } },
      { status: 413 },
    );
  }

  try {
    const body = JSON.parse(bodyText) as { state?: unknown };
    const state = parsePersistedWorkspace(body.state);
    const db = getDb();
    await db
      .insert(workspaceStates)
      .values({
        id: WORKSPACE_ID,
        stateJson: JSON.stringify(state),
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: workspaceStates.id,
        set: {
          stateJson: JSON.stringify(state),
          updatedAt: new Date().toISOString(),
        },
      });

    return NextResponse.json({ saved: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          message:
            error instanceof Error
              ? error.message
              : "Workspace data could not be saved.",
        },
      },
      { status: 400 },
    );
  }
}

export async function DELETE() {
  const db = getDb();
  await db.delete(workspaceStates).where(eq(workspaceStates.id, WORKSPACE_ID));
  return NextResponse.json({ cleared: true });
}
