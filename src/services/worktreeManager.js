import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "../utils/command.js";
import { getWorkspace } from "./workspaceRegistry.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "..", "..");

export const LOOP_WORKTREE_DIR = path.resolve(
  process.env.LOOP_WORKTREE_DIR ?? path.join(projectRoot, "data", "loop-worktrees")
);

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

function assertRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new Error("Loop runId khong hop le cho worktree.");
  }
}

function normalizeForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSafeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath) {
    return false;
  }

  const normalized = relativePath.replaceAll("\\", "/");
  return (
    !path.isAbsolute(relativePath) &&
    !normalized.startsWith("../") &&
    !normalized.includes("/../") &&
    normalized !== ".." &&
    !normalized.startsWith(".git/") &&
    normalized !== ".git"
  );
}

async function exists(value) {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function git(root, args, options = {}) {
  return execFile("git", ["-C", root, ...args], {
    cwd: root,
    windowsHide: true,
    timeout: options.timeout ?? 60000,
    maxBuffer: options.maxBuffer ?? 4_000_000,
    encoding: "utf8",
  });
}

async function assertWorkspaceIsGitRoot(workspace) {
  const { stdout } = await git(workspace.root, ["rev-parse", "--show-toplevel"]);
  const gitRoot = stdout.trim();

  if (normalizeForCompare(gitRoot) !== normalizeForCompare(workspace.root)) {
    throw new Error(
      `Worktree isolation hien yeu cau workspace root la Git root. Git root: ${gitRoot}`
    );
  }
}

async function copyUntrackedFiles(sourceRoot, targetRoot) {
  const { stdout = "" } = await git(sourceRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const files = stdout.split("\0").filter(Boolean);
  const copied = [];

  for (const relativeFile of files) {
    const normalizedRelative = relativeFile.replaceAll("\\", "/");

    if (
      normalizedRelative.startsWith(".loop-evidence/") ||
      normalizedRelative.startsWith("test-results/")
    ) {
      continue;
    }

    if (!isSafeRelativePath(relativeFile)) {
      throw new Error(`Untracked path khong an toan: ${relativeFile}`);
    }

    const source = path.resolve(sourceRoot, relativeFile);
    const target = path.resolve(targetRoot, relativeFile);
    const stat = await fs.lstat(source);

    if (!stat.isFile()) {
      continue;
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    copied.push(relativeFile.replaceAll("\\", "/"));
  }

  return copied;
}

async function applyWorkspaceDiff(sourceRoot, targetRoot) {
  const { stdout: patch = "" } = await git(
    sourceRoot,
    ["diff", "--binary", "HEAD", "--"],
    { maxBuffer: 12_000_000 }
  );

  if (!patch.trim()) {
    return { applied: false, bytes: 0 };
  }

  const temporaryPatch = path.join(
    os.tmpdir(),
    `loop-worktree-${randomUUID()}.patch`
  );
  await fs.writeFile(temporaryPatch, patch, "utf8");

  try {
    await git(
      targetRoot,
      ["apply", "--whitespace=nowarn", temporaryPatch],
      { timeout: 120000, maxBuffer: 12_000_000 }
    );
  } finally {
    await fs.unlink(temporaryPatch).catch(() => {});
  }

  return {
    applied: true,
    bytes: Buffer.byteLength(patch, "utf8"),
  };
}

async function linkDependencyDirectory(sourceRoot, targetRoot, relativeDirectory) {
  const source = path.resolve(sourceRoot, relativeDirectory);
  const target = path.resolve(targetRoot, relativeDirectory);

  if (!(await exists(source)) || (await exists(target))) {
    return null;
  }

  const stat = await fs.stat(source);

  if (!stat.isDirectory()) {
    return null;
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.symlink(
    source,
    target,
    process.platform === "win32" ? "junction" : "dir"
  );

  return relativeDirectory.replaceAll("\\", "/");
}

async function linkDependencies(sourceRoot, targetRoot) {
  const linked = [];
  const warnings = [];

  for (const relativeDirectory of ["node_modules", "web/node_modules"]) {
    try {
      const result = await linkDependencyDirectory(
        sourceRoot,
        targetRoot,
        relativeDirectory
      );

      if (result) {
        linked.push(result);
      }
    } catch (error) {
      warnings.push(`${relativeDirectory}: ${error.message}`);
    }
  }

  return { linked, warnings };
}

export function verificationWorktreePath(runId) {
  assertRunId(runId);
  return path.join(LOOP_WORKTREE_DIR, runId);
}

export async function prepareVerificationWorktree({ runId, workspaceId }) {
  assertRunId(runId);
  const workspace = getWorkspace(workspaceId);
  await assertWorkspaceIsGitRoot(workspace);
  await fs.mkdir(LOOP_WORKTREE_DIR, { recursive: true });

  const worktreeRoot = verificationWorktreePath(runId);

  if (!(await exists(worktreeRoot))) {
    await git(workspace.root, [
      "worktree",
      "add",
      "--detach",
      "--force",
      worktreeRoot,
      "HEAD",
    ], { timeout: 120000 });
  }

  await git(worktreeRoot, ["reset", "--hard", "HEAD"]);
  await git(worktreeRoot, ["clean", "-fd"]);

  const diff = await applyWorkspaceDiff(workspace.root, worktreeRoot);
  const untrackedFiles = await copyUntrackedFiles(workspace.root, worktreeRoot);
  const dependencies = await linkDependencies(workspace.root, worktreeRoot);
  const { stdout: head = "" } = await git(worktreeRoot, ["rev-parse", "HEAD"]);

  return {
    mode: "worktree",
    workspace: workspace.id,
    sourceRoot: workspace.root,
    root: worktreeRoot,
    head: head.trim(),
    diff,
    untrackedFiles,
    linkedDependencies: dependencies.linked,
    warnings: dependencies.warnings,
  };
}

export async function removeVerificationWorktree({ runId, workspaceId }) {
  assertRunId(runId);
  const workspace = getWorkspace(workspaceId);
  const worktreeRoot = verificationWorktreePath(runId);

  if (!(await exists(worktreeRoot))) {
    return { removed: false, root: worktreeRoot };
  }

  try {
    await git(
      workspace.root,
      ["worktree", "remove", "--force", worktreeRoot],
      { timeout: 120000 }
    );
  } catch {
    await fs.rm(worktreeRoot, { recursive: true, force: true });
  }

  await git(workspace.root, ["worktree", "prune"]).catch(() => {});
  return { removed: true, root: worktreeRoot };
}
