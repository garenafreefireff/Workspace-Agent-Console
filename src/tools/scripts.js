import { z } from "zod";
import {
  DEFAULT_WORKSPACE,
  SAFE_COMMAND_PREFIXES,
  SAFE_RUNNERS,
  WORKSPACE_NAMES,
} from "../config.js";
import {
  runAllowedCommand,
  runAllowedPrefixCommand,
} from "../utils/command.js";
import { textResult } from "../utils/result.js";
import { assertWriteEnabled } from "../utils/writeGuard.js";

export const RUNNER_NAMES = Object.freeze(
  Object.keys(SAFE_RUNNERS)
);

const workspaceSchema = z
  .enum(WORKSPACE_NAMES)
  .default(DEFAULT_WORKSPACE);

export function registerScriptTools(server) {
  server.registerTool(
    "workspace_list_command_prefixes",
    {
      title: "List approved command prefixes",
      description:
        "List command prefixes that workspace_run_command may execute.",
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
          SAFE_COMMAND_PREFIXES.map((rule) => ({
            title: rule.title,
            workspace: rule.workspace,
            cwdChoices: rule.cwdChoices,
            command: rule.command,
            argsPrefix: rule.argsPrefix,
          })),
          null,
          2
        )
      )
  );

  server.registerTool(
    "workspace_run_script",
    {
      title: "Run approved project script",
      description:
        "Run one predefined BESS or EMS lint, typecheck, test, compile, or build command. Each runner is permanently bound to one workspace.",
      inputSchema: {
        runner: z.enum(RUNNER_NAMES),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async ({ runner }) => {
      console.log("[TOOL] workspace_run_script", {
        runner,
      });

      try {
        assertWriteEnabled();

        const result = await runAllowedCommand(runner);

        const sections = [
          `Workspace: ${result.workspace}`,
          `Runner: ${runner}`,
          `Success: ${result.success}`,
        ];

        if (result.code !== undefined) {
          sections.push(
            `Exit code: ${result.code ?? "unknown"}`
          );
        }

        if (result.signal) {
          sections.push(`Signal: ${result.signal}`);
        }

        if (result.stdout) {
          sections.push(`\nSTDOUT:\n${result.stdout}`);
        }

        if (result.stderr) {
          sections.push(`\nSTDERR:\n${result.stderr}`);
        }

        return textResult(sections.join("\n"));
      } catch (error) {
        console.error(
          "[TOOL] workspace_run_script failed:",
          error
        );

        return textResult(`Loi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_run_command",
    {
      title: "Run approved prefix command",
      description:
        "Run a command only when it matches one configured SAFE_COMMAND_PREFIXES rule for the selected workspace and cwd.",
      inputSchema: {
        workspace: workspaceSchema,
        cwd: z.string().default("."),
        command: z.string().min(1),
        args: z.array(z.string()).max(30).default([]),
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
      cwd = ".",
      command,
      args = [],
    }) => {
      console.log("[TOOL] workspace_run_command", {
        workspace,
        cwd,
        command,
        args,
      });

      try {
        assertWriteEnabled();

        const result = await runAllowedPrefixCommand({
          workspace,
          cwd,
          command,
          args,
        });

        const sections = [
          `Workspace: ${result.workspace}`,
          `CWD: ${result.cwd}`,
          `Rule: ${result.rule}`,
          `Success: ${result.success}`,
        ];

        if (result.code !== undefined) {
          sections.push(
            `Exit code: ${result.code ?? "unknown"}`
          );
        }

        if (result.signal) {
          sections.push(`Signal: ${result.signal}`);
        }

        if (result.stdout) {
          sections.push(`\nSTDOUT:\n${result.stdout}`);
        }

        if (result.stderr) {
          sections.push(`\nSTDERR:\n${result.stderr}`);
        }

        return textResult(sections.join("\n"));
      } catch (error) {
        console.error(
          "[TOOL] workspace_run_command failed:",
          error
        );

        return textResult(`Loi: ${error.message}`);
      }
    }
  );
}
