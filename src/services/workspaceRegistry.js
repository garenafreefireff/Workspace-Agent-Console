import { execFile as execFileCallback } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "..", "..");

export const WORKSPACE_CONFIG_FILE = path.resolve(
  process.env.WORKSPACE_CONFIG_FILE ??
    path.join(projectRoot, "data", "workspaces.json")
);

export const READ_ONLY_PERMISSIONS = Object.freeze({
  read: true,
  write: false,
  git: true,
  commit: false,
  execute: false,
});

const LEGACY_PERMISSIONS = Object.freeze({
  read: true,
  write: true,
  git: true,
  commit: true,
  execute: true,
});

const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,49}$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateWorkspaceId(id) {
  if (typeof id !== "string" || !WORKSPACE_ID_PATTERN.test(id)) {
    throw new Error(
      "Workspace ID chi duoc gom chu thuong, so, dau gach ngang va gach duoi; toi da 50 ky tu."
    );
  }

  return id;
}

function normalizePermissions(value, fallback = READ_ONLY_PERMISSIONS) {
  const source = value && typeof value === "object" ? value : fallback;

  return {
    read: source.read !== false,
    write: source.write === true,
    git: source.git !== false,
    commit: source.commit === true,
    execute: source.execute === true,
  };
}

function normalizeWorkspace(id, value, fallbackPermissions) {
  validateWorkspaceId(id);

  if (!value || typeof value !== "object") {
    throw new Error(`Cau hinh workspace ${id} khong hop le.`);
  }

  if (typeof value.root !== "string" || !value.root.trim()) {
    throw new Error(`Workspace ${id} thieu duong dan root.`);
  }

  return {
    id,
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name.trim().slice(0, 120)
        : id,
    root: path.resolve(value.root.trim()),
    enabled: value.enabled !== false,
    permissions: normalizePermissions(
      value.permissions,
      fallbackPermissions
    ),
  };
}

function normalizeState(rawState, fallbackPermissions = READ_ONLY_PERMISSIONS) {
  if (!rawState || typeof rawState !== "object") {
    throw new Error("File cau hinh workspace khong hop le.");
  }

  const rawWorkspaces =
    rawState.workspaces && typeof rawState.workspaces === "object"
      ? rawState.workspaces
      : {};
  const workspaces = {};

  for (const [id, value] of Object.entries(rawWorkspaces)) {
    workspaces[id] = normalizeWorkspace(
      id,
      value,
      fallbackPermissions
    );
  }

  const enabledIds = Object.values(workspaces)
    .filter((workspace) => workspace.enabled)
    .map((workspace) => workspace.id);

  if (enabledIds.length === 0) {
    throw new Error("Can co it nhat mot workspace dang duoc bat.");
  }

  const requestedDefault = rawState.defaultWorkspace;
  const defaultWorkspace =
    typeof requestedDefault === "string" &&
    workspaces[requestedDefault]?.enabled
      ? requestedDefault
      : enabledIds[0];

  return { defaultWorkspace, workspaces };
}

function stateForDisk(state) {
  return {
    defaultWorkspace: state.defaultWorkspace,
    workspaces: Object.fromEntries(
      Object.entries(state.workspaces).map(([id, workspace]) => [
        id,
        {
          id,
          name: workspace.name,
          root: workspace.root,
          enabled: workspace.enabled,
          permissions: workspace.permissions,
        },
      ])
    ),
  };
}

function createLegacySeed() {
  const defaultWorkspace = process.env.DEFAULT_WORKSPACE ?? "ems";
  const workspaces = {
    bess: {
      id: "bess",
      name: "BESS Planner",
      root: path.resolve(
        process.env.WORKSPACE_BESS ?? "E:\\bessplaner"
      ),
      enabled: true,
      permissions: { ...LEGACY_PERMISSIONS },
    },
    ems: {
      id: "ems",
      name: "EMS DRL",
      root: path.resolve(
        process.env.WORKSPACE_EMS ??
          "E:\\img\\bess2\\EMS_DRL_Package_2026-07-11\\EMS_DRL_Package"
      ),
      enabled: true,
      permissions: { ...LEGACY_PERMISSIONS },
    },
  };

  return {
    defaultWorkspace: workspaces[defaultWorkspace]
      ? defaultWorkspace
      : "ems",
    workspaces,
  };
}

function ensureInitialState(configFile) {
  if (existsSync(configFile)) {
    const parsed = JSON.parse(readFileSync(configFile, "utf8"));
    return normalizeState(parsed);
  }

  const seeded = normalizeState(createLegacySeed(), LEGACY_PERMISSIONS);
  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(
    configFile,
    `${JSON.stringify(stateForDisk(seeded), null, 2)}\n`,
    "utf8"
  );
  return seeded;
}

async function exists(absolutePath) {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function inspectWorkspaceRoot(root) {
  if (typeof root !== "string" || !root.trim()) {
    throw new Error("Can cung cap duong dan workspace.");
  }

  if (!path.isAbsolute(root.trim())) {
    throw new Error("Duong dan workspace phai la duong dan tuyet doi.");
  }

  const realRoot = await fs.realpath(path.resolve(root.trim()));
  const stat = await fs.stat(realRoot);

  if (!stat.isDirectory()) {
    throw new Error("Duong dan workspace khong phai thu muc.");
  }

  const markerCandidates = [
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "README.md",
    "Cargo.toml",
    "go.mod",
  ];
  const markers = [];

  for (const marker of markerCandidates) {
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

export class WorkspaceRegistry {
  constructor({ configFile = WORKSPACE_CONFIG_FILE } = {}) {
    this.configFile = path.resolve(configFile);
    this.state = ensureInitialState(this.configFile);
    this.mutationQueue = Promise.resolve();
  }

  list() {
    this.#refreshFromDisk();

    return Object.values(this.state.workspaces)
      .map((workspace) => ({
        ...clone(workspace),
        default: workspace.id === this.state.defaultWorkspace,
      }))
      .sort((left, right) => {
        if (left.default !== right.default) {
          return left.default ? -1 : 1;
        }

        return left.name.localeCompare(right.name);
      });
  }

  getDefaultWorkspaceName() {
    this.#refreshFromDisk();
    return this.state.defaultWorkspace;
  }

  get(workspaceName) {
    this.#refreshFromDisk();
    const requested = workspaceName || this.state.defaultWorkspace;
    const workspace = this.state.workspaces[requested];

    if (!workspace || !workspace.enabled) {
      throw new Error(
        `Workspace khong hop le: ${requested}. Cac workspace duoc phep: ${this.list()
          .filter((item) => item.enabled)
          .map((item) => item.id)
          .join(", ")}`
      );
    }

    return clone(workspace);
  }

  async validateRoot(root) {
    return inspectWorkspaceRoot(root);
  }

  async add({ id, name, root }) {
    return this.#mutate(async (draft) => {
      const workspaceId = validateWorkspaceId(id);

      if (draft.workspaces[workspaceId]) {
        throw new Error(`Workspace da ton tai: ${workspaceId}`);
      }

      const inspection = await inspectWorkspaceRoot(root);
      draft.workspaces[workspaceId] = {
        id: workspaceId,
        name:
          typeof name === "string" && name.trim()
            ? name.trim().slice(0, 120)
            : workspaceId,
        root: inspection.root,
        enabled: true,
        permissions: { ...READ_ONLY_PERMISSIONS },
      };

      return {
        workspace: clone(draft.workspaces[workspaceId]),
        inspection,
      };
    });
  }

  async update(id, changes = {}) {
    return this.#mutate(async (draft) => {
      const workspaceId = validateWorkspaceId(id);
      const current = draft.workspaces[workspaceId];

      if (!current) {
        throw new Error(`Khong tim thay workspace: ${workspaceId}`);
      }

      if (changes.name !== undefined) {
        if (typeof changes.name !== "string" || !changes.name.trim()) {
          throw new Error("Ten workspace khong duoc de trong.");
        }

        current.name = changes.name.trim().slice(0, 120);
      }

      let inspection = null;

      if (changes.root !== undefined && changes.root !== current.root) {
        inspection = await inspectWorkspaceRoot(changes.root);
        current.root = inspection.root;
      }

      return { workspace: clone(current), inspection };
    });
  }

  async remove(id) {
    return this.#mutate(async (draft) => {
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
      };
    });
  }

  async setDefault(id) {
    return this.#mutate(async (draft) => {
      const workspaceId = validateWorkspaceId(id);
      const workspace = draft.workspaces[workspaceId];

      if (!workspace || !workspace.enabled) {
        throw new Error(`Khong tim thay workspace: ${workspaceId}`);
      }

      draft.defaultWorkspace = workspaceId;
      return { defaultWorkspace: workspaceId };
    });
  }

  async pickDirectory() {
    if (process.platform !== "win32") {
      throw new Error(
        "Folder picker native hien chi ho tro Windows."
      );
    }

    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Chon thu muc workspace'",
      "$dialog.ShowNewFolderButton = $false",
      "$result = $dialog.ShowDialog()",
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "  Write-Output $dialog.SelectedPath",
      "}",
    ].join("\n");

    const { stdout = "" } = await execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", script],
      {
        windowsHide: false,
        timeout: 300000,
        maxBuffer: 100000,
        encoding: "utf8",
      }
    );
    const selectedPath = stdout.trim();

    if (!selectedPath) {
      return { cancelled: true };
    }

    return {
      cancelled: false,
      ...(await inspectWorkspaceRoot(selectedPath)),
    };
  }

  #refreshFromDisk() {
    const parsed = JSON.parse(readFileSync(this.configFile, "utf8"));
    this.state = normalizeState(parsed);
  }

  async #mutate(mutator) {
    const operation = this.mutationQueue.then(async () => {
      this.#refreshFromDisk();
      const draft = clone(this.state);
      const result = await mutator(draft);
      const normalized = normalizeState(draft);
      await this.#persist(normalized);
      this.state = normalized;
      return result;
    });

    this.mutationQueue = operation.catch(() => {});
    return operation;
  }

  async #persist(state) {
    const directory = path.dirname(this.configFile);
    const temporaryFile = `${this.configFile}.${process.pid}.tmp`;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      temporaryFile,
      `${JSON.stringify(stateForDisk(state), null, 2)}\n`,
      "utf8"
    );

    try {
      await fs.rename(temporaryFile, this.configFile);
    } catch (error) {
      if (!["EEXIST", "EPERM"].includes(error.code)) {
        throw error;
      }

      await fs.copyFile(temporaryFile, this.configFile);
      await fs.unlink(temporaryFile).catch(() => {});
    }
  }
}

export const workspaceRegistry = new WorkspaceRegistry();

export function getWorkspace(workspaceName) {
  return workspaceRegistry.get(workspaceName);
}

export function getDefaultWorkspaceName() {
  return workspaceRegistry.getDefaultWorkspaceName();
}

export function listWorkspaces() {
  return workspaceRegistry.list();
}

export function assertWorkspacePermission(workspace, permission) {
  if (!workspace.permissions?.[permission]) {
    throw new Error(
      `Workspace ${workspace.id} khong co quyen ${permission}.`
    );
  }
}
