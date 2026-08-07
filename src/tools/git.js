import { z } from "zod";
import {
  assertWorkspacePermission,
  getWorkspace,
} from "../services/workspaceRegistry.js";
import { execFile } from "../utils/command.js";
import {
  resolveWorkspacePath,
  toWorkspaceRelative,
} from "../utils/paths.js";
import { limitOutput, textResult } from "../utils/result.js";
import { assertWriteEnabled } from "../utils/writeGuard.js";

const workspaceSchema = z.string().min(1).optional();

function selectWorkspace(workspaceName, permission) {
  const selected = getWorkspace(workspaceName);
  assertWorkspacePermission(selected, permission);
  return selected;
}

function validateGitRef(ref) {
  if (!/^[A-Za-z0-9._/@:^~+-]+$/.test(ref) || ref.startsWith("-")) {
    throw new Error("Git ref khong hop le.");
  }
}

export function registerGitTools(server) {
  server.registerTool(
    "workspace_git_diff",
    {
      title: "Show Git diff",
      description:
        "Inspect uncommitted Git changes in the selected workspace.",
      inputSchema: {
        workspace: workspaceSchema,
        file: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspace, file }) => {
      try {
        const selected = selectWorkspace(workspace, "git");
        const args = ["-C", selected.root, "diff", "--"];

        if (file) {
          const absoluteFile = resolveWorkspacePath(
            selected.root,
            file
          );
          args.push(
            toWorkspaceRelative(selected.root, absoluteFile)
          );
        }

        const { stdout, stderr } = await execFile(
          "git",
          args,
          {
            cwd: selected.root,
            windowsHide: true,
            maxBuffer: 2_000_000,
          }
        );

        const output =
          stdout || stderr || "Khong co thay doi Git.";

        return textResult(
          `Workspace: ${selected.name}\n\n${output.slice(
            0,
            150000
          )}`
        );
      } catch (error) {
        return textResult(`Loi Git: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_git_status",
    {
      title: "Show Git status",
      description:
        "Inspect the branch and modified, staged, deleted, and untracked files in the selected workspace.",
      inputSchema: {
        workspace: workspaceSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspace }) => {
      console.log("[TOOL] workspace_git_status", {
        workspace,
      });

      try {
        const selected = selectWorkspace(workspace, "git");
        const { stdout, stderr } = await execFile(
          "git",
          [
            "-C",
            selected.root,
            "status",
            "--short",
            "--branch",
            "--untracked-files=all",
          ],
          {
            cwd: selected.root,
            windowsHide: true,
            timeout: 30000,
            maxBuffer: 2_000_000,
            encoding: "utf8",
          }
        );

        return textResult(
          [
            `Workspace: ${selected.name}`,
            `Root: ${selected.root}`,
            "",
            limitOutput(
              stdout ||
                stderr ||
                "Workspace khong co thay doi Git."
            ),
          ].join("\n")
        );
      } catch (error) {
        console.error(
          "[TOOL] workspace_git_status failed:",
          error
        );

        return textResult(`Loi Git: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_git_log",
    {
      title: "Show Git log",
      description:
        "Inspect recent Git commits in the selected workspace.",
      inputSchema: {
        workspace: workspaceSchema,
        maxCount: z.number().int().min(1).max(100).default(20),
        file: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      workspace,
      maxCount = 20,
      file,
    }) => {
      try {
        const selected = selectWorkspace(workspace, "git");
        const args = [
          "-C",
          selected.root,
          "log",
          `--max-count=${maxCount}`,
          "--date=short",
          "--pretty=format:%h %ad %an %s",
          "--",
        ];

        if (file) {
          const absoluteFile = resolveWorkspacePath(
            selected.root,
            file
          );
          args.push(
            toWorkspaceRelative(selected.root, absoluteFile)
          );
        }

        const { stdout, stderr } = await execFile("git", args, {
          cwd: selected.root,
          windowsHide: true,
          timeout: 30000,
          maxBuffer: 2_000_000,
          encoding: "utf8",
        });

        return textResult(
          [
            `Workspace: ${selected.name}`,
            "",
            limitOutput(stdout || stderr || "Khong co commit."),
          ].join("\n")
        );
      } catch (error) {
        return textResult(`Loi Git: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_git_show",
    {
      title: "Show Git revision",
      description:
        "Show one Git revision with stats and patch in the selected workspace.",
      inputSchema: {
        workspace: workspaceSchema,
        ref: z.string().min(1).max(120).default("HEAD"),
        maxCharacters: z
          .number()
          .int()
          .min(1000)
          .max(200000)
          .default(80000),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      workspace,
      ref = "HEAD",
      maxCharacters = 80000,
    }) => {
      try {
        validateGitRef(ref);

        const selected = selectWorkspace(workspace, "git");
        const { stdout, stderr } = await execFile(
          "git",
          [
            "-C",
            selected.root,
            "show",
            "--stat",
            "--patch",
            "--no-ext-diff",
            "--no-renames",
            ref,
          ],
          {
            cwd: selected.root,
            windowsHide: true,
            timeout: 30000,
            maxBuffer: 2_000_000,
            encoding: "utf8",
          }
        );

        const output = stdout || stderr || "Khong co output.";
        const truncated = output.length > maxCharacters;

        return textResult(
          [
            `Workspace: ${selected.name}`,
            `Ref: ${ref}`,
            "",
            output.slice(0, maxCharacters),
            truncated
              ? "\n\n[Output da bi rut gon vi vuot gioi han.]"
              : "",
          ].join("\n")
        );
      } catch (error) {
        return textResult(`Loi Git: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_git_commit",
    {
      title: "Create Git commit",
      description:
        "Stage selected files or all changes and create one Git commit in the selected workspace.",
      inputSchema: {
        workspace: workspaceSchema,
        message: z.string().min(1).max(500),
        files: z.array(z.string().min(1)).max(100).default([]),
        all: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async ({
      workspace,
      message,
      files = [],
      all = false,
    }) => {
      try {
        assertWriteEnabled();

        if (!all && files.length === 0) {
          throw new Error(
            "Can truyen files hoac all=true de commit."
          );
        }

        const selected = selectWorkspace(workspace, "commit");

        if (all) {
          await execFile(
            "git",
            ["-C", selected.root, "add", "-A"],
            {
              cwd: selected.root,
              windowsHide: true,
              timeout: 30000,
              maxBuffer: 2_000_000,
              encoding: "utf8",
            }
          );
        } else {
          const relativeFiles = files.map((file) => {
            const absoluteFile = resolveWorkspacePath(
              selected.root,
              file
            );
            return toWorkspaceRelative(
              selected.root,
              absoluteFile
            );
          });

          await execFile(
            "git",
            ["-C", selected.root, "add", "--", ...relativeFiles],
            {
              cwd: selected.root,
              windowsHide: true,
              timeout: 30000,
              maxBuffer: 2_000_000,
              encoding: "utf8",
            }
          );
        }

        const { stdout, stderr } = await execFile(
          "git",
          ["-C", selected.root, "commit", "-m", message],
          {
            cwd: selected.root,
            windowsHide: true,
            timeout: 30000,
            maxBuffer: 2_000_000,
            encoding: "utf8",
          }
        );

        return textResult(
          [
            `Workspace: ${selected.name}`,
            "Commit da duoc tao.",
            "",
            limitOutput(stdout || stderr),
          ].join("\n")
        );
      } catch (error) {
        return textResult(
          `Loi Git: ${limitOutput(
            [error.message, error.stdout, error.stderr]
              .filter(Boolean)
              .join("\n")
          )}`
        );
      }
    }
  );
}
