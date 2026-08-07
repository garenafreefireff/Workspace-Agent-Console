import { NextResponse } from "next/server";
import { callBackendRest } from "../../../../lib/backend.js";
import {
  removeLocalWorkspace,
  updateLocalWorkspace,
} from "../../../../lib/localWorkspaceStore.js";

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

export async function PATCH(request, context) {
  const { id } = await context.params;

  if (!id || id === "undefined" || id === "null") {
    return errorResponse(new Error("Workspace ID khong hop le."));
  }

  const body = await request.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return errorResponse(new Error("Request body khong hop le."));
  }

  const changes = {};

  if (body.name !== undefined) {
    changes.name = body.name;
  }

  if (body.root !== undefined) {
    changes.root = body.root;
  }

  try {
    const data = await callBackendRest(
      `/api/workspaces/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(changes),
      }
    );

    return NextResponse.json(
      data,
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error.code === "WORKSPACE_REST_UNAVAILABLE") {
      try {
        const { result } = await updateLocalWorkspace(id, changes);
        return NextResponse.json(
          { ok: true, result, source: "local-config" },
          { headers: { "cache-control": "no-store" } }
        );
      } catch (fallbackError) {
        return errorResponse(fallbackError);
      }
    }

    return errorResponse(error);
  }
}

export async function DELETE(_request, context) {
  const { id } = await context.params;

  if (!id || id === "undefined" || id === "null") {
    return errorResponse(new Error("Workspace ID khong hop le."));
  }

  try {
    const data = await callBackendRest(
      `/api/workspaces/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );

    return NextResponse.json(
      data,
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error.code === "WORKSPACE_REST_UNAVAILABLE") {
      try {
        const { result } = await removeLocalWorkspace(id);
        return NextResponse.json(
          { ok: true, result, source: "local-config" },
          { headers: { "cache-control": "no-store" } }
        );
      } catch (fallbackError) {
        return errorResponse(fallbackError);
      }
    }

    return errorResponse(error);
  }
}
