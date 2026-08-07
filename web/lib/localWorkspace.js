import { promises as fs } from "node:fs";
import path from "node:path";

const PROJECT_MARKERS = Object.freeze([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "README.md",
  "Cargo.toml",
  "go.mod",
]);

async function exists(absolutePath) {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export async function inspectLocalWorkspaceRoot(root) {
  if (typeof root !== "string" || !root.trim()) {
    throw new Error("Can cung cap duong dan workspace.");
  }

  const requestedRoot = root.trim();

  if (!path.isAbsolute(requestedRoot)) {
    throw new Error("Duong dan workspace phai la duong dan tuyet doi.");
  }

  let realRoot;

  try {
    realRoot = await fs.realpath(path.resolve(requestedRoot));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Thu muc workspace khong ton tai.");
    }

    if (error?.code === "EACCES" || error?.code === "EPERM") {
      throw new Error("Khong co quyen truy cap thu muc workspace.");
    }

    throw error;
  }

  const stat = await fs.stat(realRoot);

  if (!stat.isDirectory()) {
    throw new Error("Duong dan workspace khong phai thu muc.");
  }

  const markers = [];

  for (const marker of PROJECT_MARKERS) {
    if (await exists(path.join(realRoot, marker))) {
      markers.push(marker);
    }
  }

  return {
    root: realRoot,
    exists: true,
    isDirectory: true,
    isGitRepository: await exists(path.join(realRoot, ".git")),
    markers,
  };
}
