import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  COMMAND_TIMEOUT_MS,
  SAFE_COMMAND_PREFIXES,
  SAFE_RUNNERS,
} from "../config.js";
import {
  assertWorkspacePermission,
  getWorkspace,
} from "../services/workspaceRegistry.js";
import {
  resolveExistingPath,
  toWorkspaceRelative,
} from "./paths.js";
import { limitOutput } from "./result.js";

export const execFile = promisify(execFileCallback);

const WINDOWS_BATCH_EXTENSION = /\.(?:cmd|bat)$/i;
const SAFE_WINDOWS_BATCH_TOKEN = /^[A-Za-z0-9_./:@=,+\-\\]+$/;

function buildWindowsBatchCommand(command, args) {
  const tokens = [command, ...args];

  for (const token of tokens) {
    if (
      typeof token !== "string" ||
      !token ||
      !SAFE_WINDOWS_BATCH_TOKEN.test(token)
    ) {
      throw new Error(
        `Windows batch argument khong an toan hoac khong duoc ho tro: ${String(token)}`
      );
    }
  }

  return tokens.join(" ");
}

/**
 * Node cannot execute .cmd/.bat files directly with execFile on Windows.
 * Keep normal executables on execFile, and route only allowlisted batch
 * commands through cmd.exe with a deliberately restricted token grammar.
 */
export function resolvePortableInvocation(
  command,
  args = [],
  {
    platform = process.platform,
    commandProcessor =
      process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
  } = {}
) {
  if (
    platform === "win32" &&
    WINDOWS_BATCH_EXTENSION.test(path.basename(command))
  ) {
    return {
      command: commandProcessor,
      args: ["/d", "/s", "/c", buildWindowsBatchCommand(command, args)],
    };
  }

  return { command, args };
}

export async function execPortableFile(command, args = [], options = {}) {
  const invocation = resolvePortableInvocation(command, args);
  return execFile(invocation.command, invocation.args, options);
}

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
  assertWorkspacePermission(selected, "execute");
  const workingDirectory = await resolveExistingPath(
    selected.root,
    cwd
  );
  const normalizedCommand = normalizeCommandName(command);

  for (const rule of SAFE_COMMAND_PREFIXES) {
    if (
      rule.workspace !== "*" &&
      rule.workspace !== selected.id
    ) {
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

export async function runConfiguredRunner(
  runnerName,
  {
    workspaceRoot,
    workspaceName,
  } = {}
) {
  const runner = SAFE_RUNNERS[runnerName];

  if (!runner) {
    throw new Error(`Runner khong hop le: ${runnerName}`);
  }

  const selected = getWorkspace(runner.workspace);
  assertWorkspacePermission(selected, "execute");
  const effectiveRoot = workspaceRoot
    ? path.resolve(workspaceRoot)
    : selected.root;
  const workingDirectory = await resolveExistingPath(
    effectiveRoot,
    runner.cwd
  );
  const stat = await fs.stat(workingDirectory);
  const effectiveWorkspaceName = workspaceName ?? selected.name;

  if (!stat.isDirectory()) {
    throw new Error(
      `Thu muc chay khong ton tai: ${runner.cwd}`
    );
  }

  console.log("[COMMAND] Starting", {
    runner: runnerName,
    workspace: effectiveWorkspaceName,
    cwd: toWorkspaceRelative(
      effectiveRoot,
      workingDirectory
    ),
    command: runner.command,
    args: runner.args,
    isolatedRoot: workspaceRoot ? effectiveRoot : null,
  });

  try {
    const { stdout = "", stderr = "" } =
      await execPortableFile(runner.command, runner.args, {
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
      workspace: effectiveWorkspaceName,
    });

    return {
      success: true,
      workspace: effectiveWorkspaceName,
      stdout: limitOutput(stdout),
      stderr: limitOutput(stderr),
    };
  } catch (error) {
    console.error("[COMMAND] Failed", {
      runner: runnerName,
      workspace: effectiveWorkspaceName,
      code: error.code,
      signal: error.signal,
      message: error.message,
    });

    return {
      success: false,
      workspace: effectiveWorkspaceName,
      code: error.code ?? null,
      signal: error.signal ?? null,
      stdout: limitOutput(error.stdout ?? ""),
      stderr: limitOutput(
        error.stderr ?? error.message ?? ""
      ),
    };
  }
}

export async function runAllowedCommand(runnerName) {
  return runConfiguredRunner(runnerName);
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
      await execPortableFile(rule.command, args, {
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
