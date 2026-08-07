import { NextResponse } from "next/server";
import {
  callBackendTool,
  extractText,
  getBackendHealth,
} from "../../../lib/backend.js";
import { inspectLocalWorkspaceRoot } from "../../../lib/localWorkspace.js";
import {
  addLocalWorkspace,
  getLocalWorkspaceSnapshot,
  removeLocalWorkspace,
  setLocalDefaultWorkspace,
  updateLocalWorkspace,
} from "../../../lib/localWorkspaceStore.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function localToolResult(tool, payload) {
  const text = JSON.stringify(payload, null, 2);

  return NextResponse.json(
    {
      ok: true,
      tool,
      source: "local-workspace-config",
      result: {
        content: [{ type: "text", text }],
      },
      text,
    },
    { headers: { "cache-control": "no-store" } }
  );
}

async function runLocalWorkspaceTool(tool, args = {}) {
  if (tool === "workspace_list_available") {
    const snapshot = await getLocalWorkspaceSnapshot();
    return snapshot.workspaces;
  }

  if (tool === "workspace_server_info") {
    const [health, snapshot] = await Promise.all([
      getBackendHealth(),
      getLocalWorkspaceSnapshot(),
    ]);

    return {
      ...health,
      defaultWorkspace: snapshot.defaultWorkspace,
      workspaces: snapshot.workspaces,
      workspaceConfigSource: "local-config",
    };
  }

  if (tool === "workspace_validate_path") {
    return inspectLocalWorkspaceRoot(args.root);
  }

  if (tool === "workspace_add") {
    const operation = await addLocalWorkspace(args);
    return operation.result;
  }

  if (tool === "workspace_update") {
    const operation = await updateLocalWorkspace(args.id, {
      name: args.name,
      root: args.root,
    });
    return operation.result;
  }

  if (tool === "workspace_remove") {
    if (args.confirm !== true) {
      throw new Error("Can truyen confirm=true de xoa workspace.");
    }

    const operation = await removeLocalWorkspace(args.id);
    return operation.result;
  }

  if (tool === "workspace_set_default") {
    const operation = await setLocalDefaultWorkspace(args.id);
    return operation.result;
  }

  return null;
}

const LOCAL_WORKSPACE_TOOLS = new Set([
  "workspace_list_available",
  "workspace_server_info",
  "workspace_validate_path",
  "workspace_add",
  "workspace_update",
  "workspace_remove",
  "workspace_set_default",
]);

export async function POST(request) {
  const body = await request.json().catch(() => null);

  if (!body || typeof body.tool !== "string") {
    return NextResponse.json(
      { ok: false, error: "Invalid request body." },
      { status: 400 }
    );
  }

  try {
    if (LOCAL_WORKSPACE_TOOLS.has(body.tool)) {
      const payload = await runLocalWorkspaceTool(
        body.tool,
        body.args ?? {}
      );
      return localToolResult(body.tool, payload);
    }

    const result = await callBackendTool(body.tool, body.args ?? {});

    return NextResponse.json(
      {
        ok: true,
        tool: body.tool,
        result,
        text: extractText(result),
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      {
        status: 502,
        headers: { "cache-control": "no-store" },
      }
    );
  }
}
