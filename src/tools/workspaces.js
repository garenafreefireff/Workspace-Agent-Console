import { z } from "zod";
import { MCP_PATHS, SERVER_VERSION } from "../config.js";
import {
  getDefaultWorkspaceName,
  listWorkspaces,
  workspaceRegistry,
} from "../services/workspaceRegistry.js";
import { textResult } from "../utils/result.js";

function jsonResult(value) {
  return textResult(JSON.stringify(value, null, 2));
}

function mutationAnnotations() {
  return {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: false,
  };
}

const permissionsSchema = z
  .object({
    read: z.boolean().optional(),
    write: z.boolean().optional(),
    git: z.boolean().optional(),
    commit: z.boolean().optional(),
    execute: z.boolean().optional(),
  })
  .optional();

export function registerWorkspaceTools(server) {
  server.registerTool(
    "workspace_server_info",
    {
      title: "Show workspace server info",
      description:
        "Show the MCP server version, endpoints, process information, and dynamically registered workspaces.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () =>
      jsonResult({
        serverVersion: SERVER_VERSION,
        schemaMode: "dynamic-multi-workspace",
        processId: process.pid,
        workingDirectory: process.cwd(),
        mcpPaths: MCP_PATHS,
        defaultWorkspace: getDefaultWorkspaceName(),
        workspaces: listWorkspaces(),
      })
  );

  server.registerTool(
    "workspace_list_available",
    {
      title: "List available workspaces",
      description:
        "List all dynamically registered local workspaces, permissions, and the current default workspace.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => jsonResult(listWorkspaces())
  );

  server.registerTool(
    "workspace_validate_path",
    {
      title: "Validate workspace path",
      description:
        "Validate an absolute local directory before registering it and inspect common project markers.",
      inputSchema: {
        root: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ root }) => {
      try {
        return jsonResult(await workspaceRegistry.validateRoot(root));
      } catch (error) {
        return textResult(`Loi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_add",
    {
      title: "Add workspace",
      description:
        "Register a local directory as a new workspace. Optional permissions control read, write, Git inspection, commit, and command execution access.",
      inputSchema: {
        id: z.string().min(1).max(50),
        name: z.string().min(1).max(120),
        root: z.string().min(1),
        permissions: permissionsSchema,
      },
      annotations: mutationAnnotations(),
    },
    async (input) => {
      try {
        return jsonResult(await workspaceRegistry.add(input));
      } catch (error) {
        return textResult(`Loi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_update",
    {
      title: "Update workspace",
      description:
        "Update the display name, root directory, or permissions of an existing workspace without restarting the MCP server.",
      inputSchema: {
        id: z.string().min(1).max(50),
        name: z.string().min(1).max(120).optional(),
        root: z.string().min(1).optional(),
        permissions: permissionsSchema,
      },
      annotations: mutationAnnotations(),
    },
    async ({ id, name, root, permissions }) => {
      try {
        return jsonResult(
          await workspaceRegistry.update(id, {
            name,
            root,
            permissions,
          })
        );
      } catch (error) {
        return textResult(`Loi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_remove",
    {
      title: "Remove workspace",
      description:
        "Remove a workspace from the registry. Files in the workspace are not deleted.",
      inputSchema: {
        id: z.string().min(1).max(50),
        confirm: z.literal(true),
      },
      annotations: mutationAnnotations(),
    },
    async ({ id }) => {
      try {
        return jsonResult(await workspaceRegistry.remove(id));
      } catch (error) {
        return textResult(`Loi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_set_default",
    {
      title: "Set default workspace",
      description:
        "Set the workspace used when a tool call omits the workspace argument.",
      inputSchema: {
        id: z.string().min(1).max(50),
      },
      annotations: mutationAnnotations(),
    },
    async ({ id }) => {
      try {
        return jsonResult(await workspaceRegistry.setDefault(id));
      } catch (error) {
        return textResult(`Loi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_pick_directory",
    {
      title: "Open Windows folder picker",
      description:
        "Open the native Windows folder picker on the machine running the MCP server and return the selected directory.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return jsonResult(await workspaceRegistry.pickDirectory());
      } catch (error) {
        return textResult(`Loi: ${error.message}`);
      }
    }
  );
}
