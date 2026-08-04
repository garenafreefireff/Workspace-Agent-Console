import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_VERSION } from "./config.js";
import { registerFileTools } from "./tools/files.js";
import { registerGitTools } from "./tools/git.js";
import { registerPatchTools } from "./tools/patch.js";
import { registerScriptTools } from "./tools/scripts.js";
import { registerWorkspaceTools } from "./tools/workspaces.js";

export function createWorkspaceServer() {
  const server = new McpServer({
    name: "local-workspace-agent",
    version: SERVER_VERSION,
  });

  registerWorkspaceTools(server);
  registerFileTools(server);
  registerGitTools(server);
  registerScriptTools(server);
  registerPatchTools(server);

  return server;
}
