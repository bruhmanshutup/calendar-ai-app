import { NextResponse } from "next/server";
import {
  deleteWorkspaceState,
  readWorkspaceState,
  writeWorkspaceState,
} from "@/db";
import { parsePersistedWorkspace } from "@/lib/domain/workspace-state";

const WORKSPACE_ID = "owner";
const MAX_STATE_BYTES = 2_000_000;

export async function GET() {
  const stateJson = await readWorkspaceState(WORKSPACE_ID);

  if (!stateJson) {
    return NextResponse.json(
      { state: null },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    return NextResponse.json(
      { state: parsePersistedWorkspace(JSON.parse(stateJson)) },
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
    await writeWorkspaceState(WORKSPACE_ID, JSON.stringify(state));

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
  await deleteWorkspaceState(WORKSPACE_ID);
  return NextResponse.json({ cleared: true });
}
