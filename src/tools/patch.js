import { z } from "zod";
import {
  DEFAULT_WORKSPACE,
  WORKSPACE_NAMES,
  getWorkspace,
} from "../config.js";
import { execFile } from "../utils/command.js";
import { applyUnifiedDiff } from "../utils/diff.js";
import { limitOutput, textResult } from "../utils/result.js";
import { assertWriteEnabled } from "../utils/writeGuard.js";

const workspaceSchema = z
  .enum(WORKSPACE_NAMES)
  .default(DEFAULT_WORKSPACE);

export function registerPatchTools(server) {
  server.registerTool(
    "workspace_apply_patch",
    {
      title: "Apply source code patch",
      description:
        "Apply a Git unified diff in the selected workspace. Deleting, renaming, binary patches, symlinks, absolute paths, parent-directory paths, and .git changes are forbidden.",
      inputSchema: {
        workspace: workspaceSchema,
        patch: z.string().min(1).max(300000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async ({
      workspace = DEFAULT_WORKSPACE,
      patch,
    }) => {
      console.log("[TOOL] workspace_apply_patch", {
        workspace,
        patchCharacters: patch.length,
      });

      try {
        assertWriteEnabled();

        const selected = getWorkspace(workspace);
        await applyUnifiedDiff(selected.root, patch);

        let status =
          "Khong the doc Git status hoac workspace khong phai Git repository.";

        try {
          const { stdout } = await execFile(
            "git",
            [
              "-C",
              selected.root,
              "status",
              "--short",
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

          status = stdout || "Khong co thay doi.";
        } catch {
          // Patch co the duoc ap dung ngoai Git repository.
        }

        console.log(
          "[TOOL] workspace_apply_patch completed",
          { workspace: selected.name }
        );

        return textResult(
          [
            `Workspace: ${selected.name}`,
            "Patch da duoc ap dung thanh cong.",
            "",
            "Git status:",
            status,
          ].join("\n")
        );
      } catch (error) {
        console.error(
          "[TOOL] workspace_apply_patch failed:",
          error
        );

        const details = [
          error.message,
          error.stderr,
          error.stdout,
        ]
          .filter(Boolean)
          .join("\n");

        return textResult(
          `Khong the ap dung patch:\n${limitOutput(details)}`
        );
      }
    }
  );
}
