import {
  DEFAULT_WORKSPACE,
  MCP_PATHS,
  SERVER_VERSION,
  WORKSPACES,
} from "../config.js";
import { textResult } from "../utils/result.js";

function workspaceItems() {
  return Object.entries(WORKSPACES).map(([name, root]) => ({
    name,
    root,
    default: name === DEFAULT_WORKSPACE,
  }));
}

export function registerWorkspaceTools(server) {
  server.registerTool(
    "workspace_server_info",
    {
      title: "Show workspace server info",
      description:
        "Show the MCP server version, endpoints, process information, and permitted workspaces. Use this to verify that the multi-workspace server schema is active.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () =>
      textResult(
        JSON.stringify(
          {
            serverVersion: SERVER_VERSION,
            schemaMode: "multi-workspace",
            processId: process.pid,
            workingDirectory: process.cwd(),
            mcpPaths: MCP_PATHS,
            defaultWorkspace: DEFAULT_WORKSPACE,
            workspaces: workspaceItems(),
          },
          null,
          2
        )
      )
  );

  server.registerTool(
    "workspace_list_available",
    {
      title: "List available workspaces",
      description:
        "List all permitted local workspaces and their identifiers.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => textResult(JSON.stringify(workspaceItems(), null, 2))
  );
}
