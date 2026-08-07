import { NextResponse } from "next/server";
import { inspectLocalWorkspaceRoot } from "../../../../lib/localWorkspace.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const body = await request.json().catch(() => null);

  if (!body || typeof body.root !== "string") {
    return NextResponse.json(
      { ok: false, error: "Can cung cap root." },
      { status: 400 }
    );
  }

  try {
    const inspection = await inspectLocalWorkspaceRoot(body.root);

    return NextResponse.json(
      { ok: true, inspection },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      {
        status: 400,
        headers: { "cache-control": "no-store" },
      }
    );
  }
}
