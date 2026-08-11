import { NextResponse } from "next/server";
import { callBackendRest } from "../../../lib/backend.js";
import {
  addLocalWorkspace,
  getLocalWorkspaceSnapshot,
} from "../../../lib/localWorkspaceStore.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error, status = 400) {
  return NextResponse.json(
    { ok: false, error: error.message },
    {
      status,
      headers: { "cache-control": "no-store" },
    }
  );
}

export async function GET() {
  try {
    const data = await callBackendRest("/api/workspaces");

    return NextResponse.json(
      data,
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error.code === "WORKSPACE_REST_UNAVAILABLE") {
      try {
        const snapshot = await getLocalWorkspaceSnapshot();
        return NextResponse.json(
          { ok: true, ...snapshot, source: "local-config" },
          { headers: { "cache-control": "no-store" } }
        );
      } catch (fallbackError) {
        return errorResponse(fallbackError, 502);
      }
    }

    return errorResponse(error, 502);
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => null);

  if (
    !body ||
    typeof body.id !== "string" ||
    typeof body.name !== "string" ||
    typeof body.root !== "string"
  ) {
    return errorResponse(
      new Error("Can cung cap id, name va root.")
    );
  }

  try {
    const data = await callBackendRest("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({
        id: body.id,
        name: body.name,
        root: body.root,
        permissions: body.permissions,
      }),
    });

    return NextResponse.json(
      data,
      {
        status: 201,
        headers: { "cache-control": "no-store" },
      }
    );
  } catch (error) {
    if (error.code === "WORKSPACE_REST_UNAVAILABLE") {
      try {
        const { result } = await addLocalWorkspace({
          id: body.id,
          name: body.name,
          root: body.root,
          permissions: body.permissions,
        });
        return NextResponse.json(
          { ok: true, result, source: "local-config" },
          {
            status: 201,
            headers: { "cache-control": "no-store" },
          }
        );
      } catch (fallbackError) {
        return errorResponse(fallbackError);
      }
    }

    return errorResponse(error);
  }
}
