import { NextResponse } from "next/server";
import { callBackendRest } from "../../../../../lib/backend.js";
import { setLocalDefaultWorkspace } from "../../../../../lib/localWorkspaceStore.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request, context) {
  const { id } = await context.params;

  if (!id || id === "undefined" || id === "null") {
    return NextResponse.json(
      { ok: false, error: "Workspace ID khong hop le." },
      { status: 400 }
    );
  }

  try {
    const data = await callBackendRest(
      `/api/workspaces/${encodeURIComponent(id)}/default`,
      { method: "POST", body: "{}" }
    );

    return NextResponse.json(
      data,
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error.code === "WORKSPACE_REST_UNAVAILABLE") {
      try {
        const { result } = await setLocalDefaultWorkspace(id);
        return NextResponse.json(
          { ok: true, result, source: "local-config" },
          { headers: { "cache-control": "no-store" } }
        );
      } catch (fallbackError) {
        return NextResponse.json(
          { ok: false, error: fallbackError.message },
          {
            status: 400,
            headers: { "cache-control": "no-store" },
          }
        );
      }
    }

    return NextResponse.json(
      { ok: false, error: error.message },
      {
        status: 400,
        headers: { "cache-control": "no-store" },
      }
    );
  }
}
