import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  COMMAND_TIMEOUT_MS,
  SAFE_COMMAND_PREFIXES,
  SAFE_RUNNERS,
  getWorkspace,
} from "../config.js";
import {
  resolveExistingPath,
  toWorkspaceRelative,
} from "./paths.js";
import { limitOutput } from "./result.js";

export const execFile = promisify(execFileCallback);

function normalizeCommandName(command) {
  const basename = path.basename(command).toLowerCase();

  if (process.platform === "win32" && basename.endsWith(".cmd")) {
    return basename.slice(0, -4);
  }

  return basename;
}

function argsStartWith(args, prefix) {
  if (args.length < prefix.length) {
    return false;
  }

  return prefix.every((value, index) => args[index] === value);
}

function samePath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);

  if (process.platform === "win32") {
    return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  }

  return resolvedLeft === resolvedRight;
}

async function findMatchingCommandPrefix(
  workspace,
  cwd,
  command,
  args
) {
  const selected = getWorkspace(workspace);
  const workingDirectory = await resolveExistingPath(
    selected.root,
    cwd
  );
  const normalizedCommand = normalizeCommandName(command);

  for (const rule of SAFE_COMMAND_PREFIXES) {
    if (rule.workspace !== selected.name) {
      continue;
    }

    if (
      normalizeCommandName(rule.command) !== normalizedCommand ||
      !argsStartWith(args, rule.argsPrefix)
    ) {
      continue;
    }

    for (const allowedCwd of rule.cwdChoices) {
      let allowedDirectory;

      try {
        allowedDirectory = await resolveExistingPath(
          selected.root,
          allowedCwd
        );
      } catch {
        continue;
      }

      if (samePath(workingDirectory, allowedDirectory)) {
        return {
          selected,
          workingDirectory,
          rule,
        };
      }
    }
  }

  throw new Error(
    "Command khong khop allowlist prefix. Hay them rule vao SAFE_COMMAND_PREFIXES neu can."
  );
}

export async function runAllowedCommand(runnerName) {
  const runner = SAFE_RUNNERS[runnerName];

  if (!runner) {
    throw new Error(`Runner khong hop le: ${runnerName}`);
  }

  const selected = getWorkspace(runner.workspace);
  const workingDirectory = await resolveExistingPath(
    selected.root,
    runner.cwd
  );
  const stat = await fs.stat(workingDirectory);

  if (!stat.isDirectory()) {
    throw new Error(
      `Thu muc chay khong ton tai: ${runner.cwd}`
    );
  }

  console.log("[COMMAND] Starting", {
    runner: runnerName,
    workspace: selected.name,
    cwd: toWorkspaceRelative(
      selected.root,
      workingDirectory
    ),
    command: runner.command,
    args: runner.args,
  });

  try {
    const { stdout = "", stderr = "" } =
      await execFile(runner.command, runner.args, {
        cwd: workingDirectory,
        windowsHide: true,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 2_000_000,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
      });

    console.log("[COMMAND] Completed", {
      runner: runnerName,
      workspace: selected.name,
    });

    return {
      success: true,
      workspace: selected.name,
      stdout: limitOutput(stdout),
      stderr: limitOutput(stderr),
    };
  } catch (error) {
    console.error("[COMMAND] Failed", {
      runner: runnerName,
      workspace: selected.name,
      code: error.code,
      signal: error.signal,
      message: error.message,
    });

    return {
      success: false,
      workspace: selected.name,
      code: error.code ?? null,
      signal: error.signal ?? null,
      stdout: limitOutput(error.stdout ?? ""),
      stderr: limitOutput(
        error.stderr ?? error.message ?? ""
      ),
    };
  }
}

export async function runAllowedPrefixCommand({
  workspace,
  cwd = ".",
  command,
  args = [],
}) {
  const { selected, workingDirectory, rule } =
    await findMatchingCommandPrefix(
      workspace,
      cwd,
      command,
      args
    );

  const stat = await fs.stat(workingDirectory);

  if (!stat.isDirectory()) {
    throw new Error(`Thu muc chay khong ton tai: ${cwd}`);
  }

  console.log("[COMMAND] Starting prefix command", {
    workspace: selected.name,
    cwd: toWorkspaceRelative(selected.root, workingDirectory),
    rule: rule.title,
    command,
    args,
  });

  try {
    const { stdout = "", stderr = "" } =
      await execFile(rule.command, args, {
        cwd: workingDirectory,
        windowsHide: true,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 2_000_000,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
      });

    console.log("[COMMAND] Completed prefix command", {
      workspace: selected.name,
      rule: rule.title,
    });

    return {
      success: true,
      workspace: selected.name,
      cwd: toWorkspaceRelative(selected.root, workingDirectory),
      rule: rule.title,
      stdout: limitOutput(stdout),
      stderr: limitOutput(stderr),
    };
  } catch (error) {
    console.error("[COMMAND] Prefix command failed", {
      workspace: selected.name,
      rule: rule.title,
      code: error.code,
      signal: error.signal,
      message: error.message,
    });

    return {
      success: false,
      workspace: selected.name,
      cwd: toWorkspaceRelative(selected.root, workingDirectory),
      rule: rule.title,
      code: error.code ?? null,
      signal: error.signal ?? null,
      stdout: limitOutput(error.stdout ?? ""),
      stderr: limitOutput(
        error.stderr ?? error.message ?? ""
      ),
    };
  }
}
