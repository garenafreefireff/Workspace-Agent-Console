import { promises as fs } from "node:fs";
import path from "node:path";
import { IGNORED_NAMES, TEXT_EXTENSIONS } from "../config.js";

export function normalizeRelativePath(relativePath = ".") {
  const cleanPath = relativePath.trim() || ".";

  if (path.isAbsolute(cleanPath)) {
    throw new Error("Chi duoc su dung duong dan tuong doi.");
  }

  return cleanPath;
}

export function assertInsideWorkspace(root, targetPath) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetPath);

  const rootComparison =
    process.platform === "win32"
      ? resolvedRoot.toLowerCase()
      : resolvedRoot;

  const targetComparison =
    process.platform === "win32"
      ? resolvedTarget.toLowerCase()
      : resolvedTarget;

  const rootWithSeparator = rootComparison.endsWith(path.sep)
    ? rootComparison
    : rootComparison + path.sep;

  if (
    targetComparison !== rootComparison &&
    !targetComparison.startsWith(rootWithSeparator)
  ) {
    throw new Error("Duong dan nam ngoai workspace duoc phep.");
  }

  return resolvedTarget;
}

export function resolveWorkspacePath(
  root,
  relativePath = "."
) {
  const normalized = normalizeRelativePath(relativePath);
  return assertInsideWorkspace(
    root,
    path.resolve(root, normalized)
  );
}

export async function resolveExistingPath(
  root,
  relativePath = "."
) {
  const lexicalPath = resolveWorkspacePath(
    root,
    relativePath
  );
  const realPath = await fs.realpath(lexicalPath);

  return assertInsideWorkspace(root, realPath);
}

export async function resolveWritableFile(root, relativePath) {
  const lexicalPath = resolveWorkspacePath(
    root,
    relativePath
  );
  const parentPath = path.dirname(lexicalPath);

  const realParentPath = await fs.realpath(parentPath);
  assertInsideWorkspace(root, realParentPath);

  return assertInsideWorkspace(
    root,
    path.join(realParentPath, path.basename(lexicalPath))
  );
}

export function toWorkspaceRelative(root, absolutePath) {
  const relative = path.relative(root, absolutePath);
  return relative.replaceAll("\\", "/") || ".";
}

export async function walkDirectory(
  root,
  directory,
  currentDepth,
  maxDepth,
  output,
  maxEntries
) {
  if (output.length >= maxEntries) {
    return;
  }

  const entries = await fs.readdir(directory, {
    withFileTypes: true,
  });

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (output.length >= maxEntries) {
      return;
    }

    if (IGNORED_NAMES.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      output.push(
        `${toWorkspaceRelative(root, absolutePath)} [symlink skipped]`
      );
      continue;
    }

    if (entry.isDirectory()) {
      output.push(
        `${toWorkspaceRelative(root, absolutePath)}/`
      );

      if (currentDepth < maxDepth) {
        await walkDirectory(
          root,
          absolutePath,
          currentDepth + 1,
          maxDepth,
          output,
          maxEntries
        );
      }

      continue;
    }

    if (entry.isFile()) {
      output.push(toWorkspaceRelative(root, absolutePath));
    }
  }
}

export async function collectTextFiles(
  directory,
  output,
  maxFiles
) {
  if (output.length >= maxFiles) {
    return;
  }

  const entries = await fs.readdir(directory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (output.length >= maxFiles) {
      return;
    }

    if (IGNORED_NAMES.has(entry.name) || entry.isSymbolicLink()) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await collectTextFiles(absolutePath, output, maxFiles);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();

    if (
      TEXT_EXTENSIONS.has(extension) ||
      entry.name === "Dockerfile" ||
      entry.name === "Makefile"
    ) {
      output.push(absolutePath);
    }
  }
}
