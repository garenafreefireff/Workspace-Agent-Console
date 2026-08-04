import path from "node:path";

export const WORKSPACES = Object.freeze({
  bess: path.resolve(
    process.env.WORKSPACE_BESS ?? "E:\\bessplaner"
  ),
  ems: path.resolve(
    process.env.WORKSPACE_EMS ??
      "E:\\img\\bess2\\EMS_DRL_Package_2026-07-11\\EMS_DRL_Package"
  ),
});

export const WORKSPACE_NAMES = Object.freeze(
  Object.keys(WORKSPACES)
);

const configuredDefault =
  process.env.DEFAULT_WORKSPACE ?? "ems";

export const DEFAULT_WORKSPACE = WORKSPACES[configuredDefault]
  ? configuredDefault
  : "ems";

export function getWorkspace(
  workspaceName = DEFAULT_WORKSPACE
) {
  const root = WORKSPACES[workspaceName];

  if (!root) {
    throw new Error(
      `Workspace khong hop le: ${workspaceName}. ` +
        `Cac workspace duoc phep: ${WORKSPACE_NAMES.join(", ")}`
    );
  }

  return {
    name: workspaceName,
    root,
  };
}

export const SERVER_VERSION = "2.1.0";

export const PORT = Number(process.env.PORT ?? 8787);
export const HOST = process.env.HOST ?? "127.0.0.1";

// Keep the original endpoint for compatibility and expose a versioned
// endpoint so clients can force a fresh MCP tool-schema discovery.
export const MCP_PATHS = Object.freeze(["/mcp", "/mcp-v2"]);

export const WRITE_ENABLED =
  process.env.MCP_WRITE_ENABLED === "true";

export const COMMAND_TIMEOUT_MS = Number(
  process.env.COMMAND_TIMEOUT_MS ?? 120000
);

export const MAX_COMMAND_OUTPUT = Number(
  process.env.MAX_COMMAND_OUTPUT ?? 120000
);

export const NPM_COMMAND =
  process.platform === "win32" ? "npm.cmd" : "npm";

export const PYTHON_COMMAND =
  process.platform === "win32" ? "python" : "python3";

export const SAFE_RUNNERS = {
  bess_root_lint: {
    title: "BESS root lint",
    workspace: "bess",
    cwd: ".",
    command: NPM_COMMAND,
    args: ["run", "lint"],
  },
  bess_root_typecheck: {
    title: "BESS root typecheck",
    workspace: "bess",
    cwd: ".",
    command: NPM_COMMAND,
    args: ["run", "typecheck"],
  },
  bess_root_test: {
    title: "BESS root tests",
    workspace: "bess",
    cwd: ".",
    command: NPM_COMMAND,
    args: ["test"],
  },
  bess_root_build: {
    title: "BESS root build",
    workspace: "bess",
    cwd: ".",
    command: NPM_COMMAND,
    args: ["run", "build"],
  },
  bess_frontend_lint: {
    title: "BESS frontend lint",
    workspace: "bess",
    cwd: "frontend",
    command: NPM_COMMAND,
    args: ["run", "lint"],
  },
  bess_frontend_typecheck: {
    title: "BESS frontend typecheck",
    workspace: "bess",
    cwd: "frontend",
    command: NPM_COMMAND,
    args: ["run", "typecheck"],
  },
  bess_frontend_test: {
    title: "BESS frontend tests",
    workspace: "bess",
    cwd: "frontend",
    command: NPM_COMMAND,
    args: ["test"],
  },
  bess_frontend_build: {
    title: "BESS frontend build",
    workspace: "bess",
    cwd: "frontend",
    command: NPM_COMMAND,
    args: ["run", "build"],
  },
  ems_pytest: {
    title: "EMS pytest",
    workspace: "ems",
    cwd: ".",
    command: PYTHON_COMMAND,
    args: ["-m", "pytest", "-q"],
  },
  ems_compileall: {
    title: "EMS Python compile check",
    workspace: "ems",
    cwd: ".",
    command: PYTHON_COMMAND,
    args: ["-m", "compileall", "-q", "."],
  },
};

export const SAFE_COMMAND_PREFIXES = Object.freeze([
  {
    title: "BESS npm run",
    workspace: "bess",
    cwdChoices: [".", "frontend"],
    command: NPM_COMMAND,
    argsPrefix: ["run"],
  },
  {
    title: "BESS npm test",
    workspace: "bess",
    cwdChoices: [".", "frontend"],
    command: NPM_COMMAND,
    argsPrefix: ["test"],
  },
  {
    title: "EMS pytest",
    workspace: "ems",
    cwdChoices: ["."],
    command: PYTHON_COMMAND,
    argsPrefix: ["-m", "pytest"],
  },
  {
    title: "EMS compileall",
    workspace: "ems",
    cwdChoices: ["."],
    command: PYTHON_COMMAND,
    argsPrefix: ["-m", "compileall"],
  },
]);

export const IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "venv",
]);

export const TEXT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".css",
  ".scss",
  ".html",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".env",
  ".sql",
  ".py",
  ".java",
  ".cs",
  ".php",
  ".go",
  ".rs",
  ".sh",
  ".ps1",
  ".toml",
  ".xml",
]);
