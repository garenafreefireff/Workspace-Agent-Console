import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectLocalWorkspaceRoot } from "./localWorkspace.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "..", "..");
const configFile = path.join(projectRoot, "data", "workspaces.json");
const exampleFile = path.join(projectRoot, "data", "workspaces.example.json");
const workspaceIdPattern = /^[a-z0-9][a-z0-9_-]{0,49}$/;

const readOnlyPermissions = Object.freeze({
  read: true,
  write: false,
  git: true,
  commit: false,
  execute: false,
});

let mutationQueue = Promise.resolve();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateWorkspaceId(id) {
  if (typeof id !== "string" || !workspaceIdPattern.test(id)) {
    throw new Error(
      "Workspace ID chi duoc gom chu thuong, so, gach ngang va gach duoi; toi da 50 ky tu."
    );
  }

  return id;
}

function normalizePermissions(value, fallback = readOnlyPermissions) {
  const source = value && typeof value === "object" ? value : fallback;

  return {
    read: source.read !== false,
    write: source.write === true,
    git: source.git !== false,
    commit: source.commit === true,
    execute: source.execute === true,
  };
}

function normalizeState(rawState) {
  if (!rawState || typeof rawState !== "object") {
    throw new Error("File cau hinh workspace khong hop le.");
  }

  const source =
    rawState.workspaces && typeof rawState.workspaces === "object"
      ? rawState.workspaces
      : {};
  const workspaces = {};

  for (const [id, value] of Object.entries(source)) {
    validateWorkspaceId(id);

    if (!value || typeof value.root !== "string" || !value.root.trim()) {
      throw new Error(`Workspace ${id} thieu duong dan root.`);
    }

    workspaces[id] = {
      id,
      name:
        typeof value.name === "string" && value.name.trim()
          ? value.name.trim().slice(0, 120)
          : id,
      root: path.resolve(value.root.trim()),
      enabled: value.enabled !== false,
      permissions: normalizePermissions(value.permissions),
    };
  }

  const enabledIds = Object.values(workspaces)
    .filter((workspace) => workspace.enabled)
    .map((workspace) => workspace.id);

  if (enabledIds.length === 0) {
    throw new Error("Can co it nhat mot workspace dang duoc bat.");
  }

  const defaultWorkspace = workspaces[rawState.defaultWorkspace]?.enabled
    ? rawState.defaultWorkspace
    : enabledIds[0];

  return { defaultWorkspace, workspaces };
}

async function ensureConfigFile() {
  try {
    await fs.access(configFile);
  } catch {
    const seed = await fs.readFile(exampleFile, "utf8");
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, seed, "utf8");
  }
}

async function readState() {
  await ensureConfigFile();
  const raw = await fs.readFile(configFile, "utf8");
  return normalizeState(JSON.parse(raw));
}

async function writeState(state) {
  const normalized = normalizeState(state);
  const temporaryFile = `${configFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(
    temporaryFile,
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8"
  );

  try {
    await fs.rename(temporaryFile, configFile);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error.code)) {
      throw error;
    }

    await fs.copyFile(temporaryFile, configFile);
    await fs.unlink(temporaryFile).catch(() => {});
  }

  return normalized;
}

async function mutate(mutator) {
  const operation = mutationQueue.then(async () => {
    const current = await readState();
    const draft = clone(current);
    const result = await mutator(draft);
    const state = await writeState(draft);
    return { result, state };
  });

  mutationQueue = operation.catch(() => {});
  return operation;
}

export function workspaceListFromState(state) {
  return Object.values(state.workspaces)
    .map((workspace) => ({
      ...clone(workspace),
      default: workspace.id === state.defaultWorkspace,
    }))
    .sort((left, right) => {
      if (left.default !== right.default) {
        return left.default ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
}

export async function getLocalWorkspaceSnapshot() {
  const state = await readState();
  return {
    defaultWorkspace: state.defaultWorkspace,
    workspaces: workspaceListFromState(state),
  };
}

export async function addLocalWorkspace({ id, name, root }) {
  return mutate(async (draft) => {
    const workspaceId = validateWorkspaceId(id);

    if (draft.workspaces[workspaceId]) {
      throw new Error(`Workspace da ton tai: ${workspaceId}`);
    }

    const inspection = await inspectLocalWorkspaceRoot(root);
    const workspace = {
      id: workspaceId,
      name:
        typeof name === "string" && name.trim()
          ? name.trim().slice(0, 120)
          : workspaceId,
      root: inspection.root,
      enabled: true,
      permissions: { ...readOnlyPermissions },
    };
    draft.workspaces[workspaceId] = workspace;

    return { workspace, inspection, backendRestartRequired: true };
  });
}

export async function updateLocalWorkspace(id, changes = {}) {
  return mutate(async (draft) => {
    const workspaceId = validateWorkspaceId(id);
    const workspace = draft.workspaces[workspaceId];

    if (!workspace) {
      throw new Error(`Khong tim thay workspace: ${workspaceId}`);
    }

    if (changes.name !== undefined) {
      if (typeof changes.name !== "string" || !changes.name.trim()) {
        throw new Error("Ten workspace khong duoc de trong.");
      }

      workspace.name = changes.name.trim().slice(0, 120);
    }

    let inspection = null;

    if (changes.root !== undefined && changes.root !== workspace.root) {
      inspection = await inspectLocalWorkspaceRoot(changes.root);
      workspace.root = inspection.root;
    }

    return {
      workspace: clone(workspace),
      inspection,
      backendRestartRequired: true,
    };
  });
}

export async function removeLocalWorkspace(id) {
  return mutate(async (draft) => {
    const workspaceId = validateWorkspaceId(id);

    if (!draft.workspaces[workspaceId]) {
      throw new Error(`Khong tim thay workspace: ${workspaceId}`);
    }

    if (Object.keys(draft.workspaces).length <= 1) {
      throw new Error("Khong the xoa workspace cuoi cung.");
    }

    delete draft.workspaces[workspaceId];

    if (draft.defaultWorkspace === workspaceId) {
      draft.defaultWorkspace = Object.keys(draft.workspaces)[0];
    }

    return {
      removed: workspaceId,
      defaultWorkspace: draft.defaultWorkspace,
      backendRestartRequired: true,
    };
  });
}

export async function setLocalDefaultWorkspace(id) {
  return mutate(async (draft) => {
    const workspaceId = validateWorkspaceId(id);

    if (!draft.workspaces[workspaceId]?.enabled) {
      throw new Error(`Khong tim thay workspace: ${workspaceId}`);
    }

    draft.defaultWorkspace = workspaceId;
    return {
      defaultWorkspace: workspaceId,
      backendRestartRequired: true,
    };
  });
}
