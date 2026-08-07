"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./page.module.css";

const TABS = [
  "overview",
  "workspaces",
  "files",
  "git",
  "write",
  "tools",
];

const TOOL_PRESETS = {
  workspace_server_info: {},
  workspace_list_available: {},
  workspace_list_files: {
    workspace: "ems",
    directory: ".",
    depth: 2,
  },
  workspace_read_file: {
    workspace: "ems",
    file: "README.md",
    maxCharacters: 40000,
  },
  workspace_read_many_files: {
    workspace: "ems",
    files: ["README.md", "package.json"],
    maxCharactersPerFile: 15000,
  },
  workspace_search_text: {
    workspace: "ems",
    query: "TODO",
    directory: ".",
    caseSensitive: false,
  },
  workspace_repo_map: {
    workspace: "ems",
    directory: ".",
    maxFiles: 200,
  },
  workspace_git_status: {
    workspace: "bess",
  },
  workspace_git_diff: {
    workspace: "bess",
  },
  workspace_git_log: {
    workspace: "bess",
    maxCount: 20,
  },
  workspace_git_show: {
    workspace: "bess",
    ref: "HEAD",
    maxCharacters: 70000,
  },
  workspace_run_script: {
    runner: "bess_root_test",
  },
  workspace_run_command: {
    workspace: "bess",
    cwd: ".",
    command: "npm.cmd",
    args: ["run", "test"],
  },
};

function Icon({ name }) {
  const paths = {
    refresh: "M4 12a8 8 0 1 1 2.34 5.66",
    file: "M7 3h7l5 5v13H7z",
    git: "M12 3v6m0 6v6M9 6l3-3 3 3M9 18l3 3 3-3",
    play: "M8 5l11 7-11 7z",
    tools: "M4 7h16M4 12h16M4 17h16",
    list: "M5 6h14M5 12h14M5 18h14",
    terminal: "M5 7l5 5-5 5M12 17h7",
    folder: "M3 6h7l2 2h9v10H3z",
  };

  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.list} />
    </svg>
  );
}

function pretty(value) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function tabIcon(tabName) {
  return {
    overview: "list",
    workspaces: "folder",
    files: "file",
    git: "git",
    write: "play",
    tools: "tools",
  }[tabName] ?? "tools";
}

function normalizeWorkspaceItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  const seenIds = new Set();
  const normalized = [];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const rawId = item.id ?? item.name;

    if (typeof rawId !== "string" || !rawId.trim()) {
      continue;
    }

    const id = rawId.trim();

    if (seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    normalized.push({
      id,
      name:
        typeof item.name === "string" && item.name.trim()
          ? item.name.trim()
          : id,
      root: typeof item.root === "string" ? item.root : "",
      default: item.default === true,
      enabled: item.enabled !== false,
      permissions: {
        read: item.permissions?.read !== false,
        write: item.permissions?.write === true,
        git: item.permissions?.git !== false,
        commit: item.permissions?.commit === true,
        execute: item.permissions?.execute === true,
      },
    });
  }

  return normalized;
}

function firstText(result) {
  if (!result) {
    return "";
  }

  if (typeof result.text === "string") {
    return result.text;
  }

  if (Array.isArray(result.content)) {
    return result.content
      .map((entry) =>
        entry?.type === "text"
          ? entry.text ?? ""
          : JSON.stringify(entry, null, 2)
      )
      .join("\n");
  }

  return pretty(result);
}

function Field({
  label,
  children,
  hint,
}) {
  return (
    <label className={styles.fieldRow}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {hint ? <span className={styles.panelNote}>{hint}</span> : null}
    </label>
  );
}

function Panel({ title, note, children, actions }) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <h2 className={styles.panelTitle}>{title}</h2>
          {note ? <p className={styles.panelNote}>{note}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export default function Page() {
  const [tab, setTab] = useState("overview");
  const [boot, setBoot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState("");
  const [busy, setBusy] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [error, setError] = useState("");
  const [outputTitle, setOutputTitle] = useState("Ready");
  const [output, setOutput] = useState("Open the dashboard and run a tool.");
  const [toolName, setToolName] = useState("workspace_server_info");
  const [argsJson, setArgsJson] = useState("{}");
  const [workspace, setWorkspace] = useState("ems");
  const [directory, setDirectory] = useState(".");
  const [depth, setDepth] = useState(2);
  const [file, setFile] = useState("README.md");
  const [maxCharacters, setMaxCharacters] = useState(50000);
  const [query, setQuery] = useState("TODO");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [readManyFiles, setReadManyFiles] = useState("README.md\npackage.json");
  const [readManyMax, setReadManyMax] = useState(15000);
  const [repoMaxFiles, setRepoMaxFiles] = useState(200);
  const [gitRef, setGitRef] = useState("HEAD");
  const [gitMaxCount, setGitMaxCount] = useState(20);
  const [gitMessage, setGitMessage] = useState("");
  const [gitAll, setGitAll] = useState(false);
  const [writeFile, setWriteFile] = useState("");
  const [writeContent, setWriteContent] = useState("");
  const [overwrite, setOverwrite] = useState(true);
  const [expectedCurrentContent, setExpectedCurrentContent] = useState("");
  const [moveSource, setMoveSource] = useState("");
  const [moveDestination, setMoveDestination] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmMove, setConfirmMove] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [editingWorkspaceId, setEditingWorkspaceId] = useState("");
  const [workspaceInspection, setWorkspaceInspection] = useState(null);

  const tools = useMemo(
    () =>
      Array.isArray(boot?.tools)
        ? boot.tools.filter(
            (tool) =>
              tool && typeof tool.name === "string" && tool.name
          )
        : [],
    [boot?.tools]
  );
  const workspaces = useMemo(
    () => normalizeWorkspaceItems(boot?.health?.workspaces),
    [boot?.health?.workspaces]
  );

  useEffect(() => {
    loadBootstrap();
  }, []);

  async function loadBootstrap() {
    setLoading(true);
    setWorkspaceBusy(false);
    setPickerBusy(false);
    setError("");

    try {
      const response = await fetch("/api/bootstrap", {
        cache: "no-store",
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      const normalizedWorkspaces = normalizeWorkspaceItems(
        data.health?.workspaces
      );
      const requestedDefault =
        typeof data.health?.defaultWorkspace === "string"
          ? data.health.defaultWorkspace
          : "";
      const fallbackWorkspace =
        normalizedWorkspaces.find((item) => item.default)?.id ??
        normalizedWorkspaces[0]?.id ??
        "";
      const resolvedDefault = normalizedWorkspaces.some(
        (item) => item.id === requestedDefault
      )
        ? requestedDefault
        : fallbackWorkspace;

      setBoot(data);
      setWorkspace((current) =>
        normalizedWorkspaces.some((item) => item.id === current)
          ? current
          : resolvedDefault
      );
      setOutputTitle("Bootstrap loaded");
      setOutput(
        `Backend: ${data.health?.serverVersion ?? "unknown"}\nTools: ${Array.isArray(data.tools) ? data.tools.length : 0}`
      );
    } catch (err) {
      setError(err.message);
      setOutputTitle("Connection error");
      setOutput(err.message);
    } finally {
      setLoading(false);
    }
  }

  function selectPreset(name) {
    setToolName(name);
    const preset = TOOL_PRESETS[name] ?? {};
    setArgsJson(JSON.stringify(preset, null, 2));
  }

  async function runTool(name, args, label) {
    setBusy(true);
    setAction(label || name);
    setError("");

    try {
      const response = await fetch("/api/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ tool: name, args }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      setOutputTitle(label || name);
      setOutput(data.text || firstText(data.result));
    } catch (err) {
      setOutputTitle(label || name);
      setOutput(err.message);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function parseArgs() {
    const parsed = JSON.parse(argsJson || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  }

  function resetWorkspaceEditor() {
    setWorkspaceBusy(false);
    setPickerBusy(false);
    setWorkspaceId("");
    setWorkspaceName("");
    setWorkspaceRoot("");
    setEditingWorkspaceId("");
    setWorkspaceInspection(null);
  }

  function editWorkspace(item) {
    const id = typeof item?.id === "string" ? item.id : "";

    if (!id) {
      setError("Workspace khong co ID hop le. Hay restart backend.");
      return;
    }

    setWorkspaceId(id);
    setWorkspaceName(
      typeof item.name === "string" ? item.name : id
    );
    setWorkspaceRoot(
      typeof item.root === "string" ? item.root : ""
    );
    setEditingWorkspaceId(id);
    setWorkspaceInspection(null);
    setTab("workspaces");
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      cache: "no-store",
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers ?? {}),
      },
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    return data;
  }

  async function validateWorkspacePath() {
    if (!workspaceRoot.trim()) {
      setError("Nhap duong dan workspace truoc.");
      return;
    }

    setWorkspaceBusy(true);
    setAction("Validate workspace");
    setError("");

    try {
      const data = await requestJson("/api/workspaces/validate", {
        method: "POST",
        body: JSON.stringify({ root: workspaceRoot }),
      });
      const inspection = data.inspection ?? {};
      setWorkspaceRoot(
        typeof inspection.root === "string" ? inspection.root : workspaceRoot
      );
      setWorkspaceInspection(inspection);
      setOutputTitle("Workspace path valid");
      setOutput(JSON.stringify(data.inspection, null, 2));
    } catch (err) {
      setError(err.message);
      setOutputTitle("Workspace path invalid");
      setOutput(err.message);
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function pickWorkspaceDirectory() {
    if (pickerBusy) {
      return;
    }

    setPickerBusy(true);
    setAction("Open folder picker");
    setError("");

    try {
      const data = await requestJson("/api/workspaces/pick", {
        method: "POST",
        body: "{}",
      });

      const selection = data.selection ?? {};

      if (selection.cancelled) {
        setOutputTitle("Folder picker cancelled");
        setOutput("Khong co thu muc nao duoc chon.");
        return;
      }

      if (typeof selection.root !== "string" || !selection.root) {
        throw new Error("Folder picker khong tra ve duong dan hop le.");
      }

      setWorkspaceRoot(selection.root);
      setWorkspaceInspection(selection);
      setOutputTitle("Folder selected");
      setOutput(JSON.stringify(selection, null, 2));
    } catch (err) {
      setError(err.message);
      setOutputTitle("Folder picker error");
      setOutput(err.message);
    } finally {
      setPickerBusy(false);
    }
  }

  async function saveWorkspace() {
    if (
      !workspaceId.trim() ||
      !workspaceName.trim() ||
      !workspaceRoot.trim()
    ) {
      setError("Can nhap day du ID, ten va duong dan workspace.");
      return;
    }

    setWorkspaceBusy(true);
    setAction(editingWorkspaceId ? "Update workspace" : "Add workspace");
    setError("");

    try {
      const editing = Boolean(editingWorkspaceId);
      const data = await requestJson(
        editing
          ? `/api/workspaces/${encodeURIComponent(editingWorkspaceId)}`
          : "/api/workspaces",
        {
          method: editing ? "PATCH" : "POST",
          body: JSON.stringify({
            id: workspaceId.trim(),
            name: workspaceName.trim(),
            root: workspaceRoot.trim(),
          }),
        }
      );
      const selectedId = editingWorkspaceId || workspaceId.trim();
      await loadBootstrap();
      setWorkspace(selectedId);
      setOutputTitle(editing ? "Workspace updated" : "Workspace added");
      setOutput(JSON.stringify(data.result, null, 2));
      resetWorkspaceEditor();
    } catch (err) {
      setError(err.message);
      setOutputTitle("Workspace save error");
      setOutput(err.message);
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function removeWorkspace(id) {
    if (typeof id !== "string" || !id.trim()) {
      setError("Khong the xoa workspace vi thieu ID hop le.");
      return;
    }

    if (!window.confirm(`Xoa workspace ${id} khoi danh sach?`)) {
      return;
    }

    setWorkspaceBusy(true);
    setAction("Remove workspace");
    setError("");

    try {
      const data = await requestJson(
        `/api/workspaces/${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
      await loadBootstrap();
      resetWorkspaceEditor();
      setOutputTitle("Workspace removed");
      setOutput(JSON.stringify(data.result, null, 2));
    } catch (err) {
      setError(err.message);
      setOutputTitle("Workspace remove error");
      setOutput(err.message);
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function setDefaultWorkspace(id) {
    if (typeof id !== "string" || !id.trim()) {
      setError("Khong the dat workspace mac dinh vi thieu ID hop le.");
      return;
    }

    setWorkspaceBusy(true);
    setAction("Set default workspace");
    setError("");

    try {
      const data = await requestJson(
        `/api/workspaces/${encodeURIComponent(id)}/default`,
        { method: "POST", body: "{}" }
      );
      await loadBootstrap();
      setWorkspace(id);
      setOutputTitle("Default workspace updated");
      setOutput(JSON.stringify(data.result, null, 2));
    } catch (err) {
      setError(err.message);
      setOutputTitle("Default workspace error");
      setOutput(err.message);
    } finally {
      setWorkspaceBusy(false);
    }
  }

  return (
    <main className={styles.shell}>
      <div className={styles.frame}>
        <aside className={styles.sidebar}>
          <div className={styles.brand}>
            <div>
              <h1 className={styles.title}>Local Agent GUI</h1>
              <p className={styles.subtitle}>
                Next.js dashboard for the workspace MCP server.
              </p>
            </div>
            <span className={`${styles.badge} ${styles.badgeStrong}`}>
              <Icon name="terminal" />
              {loading ? "Loading" : error ? "Offline" : "Online"}
            </span>
          </div>

          <div>
            <p className={styles.sectionTitle}>Workspace summary</p>
            <div className={styles.workspaceList}>
              {workspaces.map((item) => (
                <div key={item.id} className={styles.workspaceRow}>
                  <div>
                    <div className={styles.workspaceName}>
                      {item.name} ({item.id})
                      {item.default ? " (default)" : ""}
                    </div>
                    <div className={styles.workspacePath}>
                      {item.root}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className={styles.sectionTitle}>Tools</p>
            <div className={styles.toolList}>
              {tools.slice(0, 14).map((tool) => (
                <button
                  key={tool.name}
                  type="button"
                  className={styles.toolRow}
                  onClick={() => {
                    selectPreset(tool.name);
                    setTab("tools");
                  }}
                >
                  <div>
                    <div className={styles.toolName}>{tool.name}</div>
                    <div className={styles.toolDesc}>
                      {tool.description ?? "No description"}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            className={styles.ghostButton}
            onClick={loadBootstrap}
            disabled={busy}
          >
            <Icon name="refresh" />
            Refresh
          </button>
        </aside>

        <section className={styles.main}>
          <div className={styles.toolbar}>
            <div className={styles.tabs}>
              {TABS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`${styles.tabButton} ${
                    tab === item ? styles.tabActive : ""
                  }`}
                  onClick={() => setTab(item)}
                >
                  <Icon name={tabIcon(item)} />
                  {item}
                </button>
              ))}
            </div>

            <div className={styles.inlineRow}>
              <span className={styles.badge}>
                {boot?.health?.serverVersion ?? "n/a"}
              </span>
              <span className={styles.badge}>
                Default: {boot?.health?.defaultWorkspace ?? "n/a"}
              </span>
              <button
                type="button"
                className={styles.actionButton}
                onClick={loadBootstrap}
                disabled={busy}
              >
                <Icon name="refresh" />
                Reload
              </button>
            </div>
          </div>

          {tab === "overview" ? (
            <div className={`${styles.grid} ${styles.gridTwo}`}>
              <Panel
                title="Connection"
                note="Backend health and workspace metadata."
                actions={
                  <button
                    type="button"
                    className={styles.ghostButton}
                    onClick={() =>
                      runTool(
                        "workspace_server_info",
                        {},
                        "Workspace server info"
                      )
                    }
                    disabled={busy}
                  >
                    <Icon name="tools" />
                    Inspect server
                  </button>
                }
              >
                <div className={styles.fieldGrid}>
                  <div className={styles.inlineRow}>
                    <span className={styles.badge}>
                      Host: {boot?.health?.workingDirectory ?? "n/a"}
                    </span>
                    <span className={styles.badge}>
                      MCP: {boot?.health?.mcpPaths?.join(", ") ?? "n/a"}
                    </span>
                    <span className={styles.badge}>
                      Workspaces: {workspaces.length}
                    </span>
                  </div>
                  <p className={styles.panelNote}>
                    {error || "Ready for file, git, and script actions."}
                  </p>
                </div>
              </Panel>

              <Panel
                title="Quick actions"
                note="Common read-only operations."
              >
                <div className={styles.inlineRow}>
                  <button
                    type="button"
                    className={styles.actionButton}
                    onClick={() =>
                      runTool(
                        "workspace_list_available",
                        {},
                        "List workspaces"
                      )
                    }
                    disabled={busy}
                  >
                    <Icon name="list" />
                    List workspaces
                  </button>
                  <button
                    type="button"
                    className={styles.actionButton}
                    onClick={() =>
                      runTool(
                        "workspace_repo_map",
                        {
                          workspace,
                          directory,
                          maxFiles: repoMaxFiles,
                        },
                        "Repo map"
                      )
                    }
                    disabled={busy}
                  >
                    <Icon name="file" />
                    Repo map
                  </button>
                  <button
                    type="button"
                    className={styles.actionButton}
                    onClick={() =>
                      runTool(
                        "workspace_git_status",
                        { workspace },
                        "Git status"
                      )
                    }
                    disabled={busy}
                  >
                    <Icon name="git" />
                    Git status
                  </button>
                </div>
              </Panel>
            </div>
          ) : null}

          {tab === "workspaces" ? (
            <div className={`${styles.grid} ${styles.gridTwo}`}>
              <Panel
                title={
                  editingWorkspaceId
                    ? `Edit workspace: ${editingWorkspaceId}`
                    : "Add workspace"
                }
                note="Workspace moi mac dinh chi doc, khong duoc ghi file, commit hay chay command."
              >
                <div className={styles.fieldGrid}>
                  <Field
                    label="Workspace ID"
                    hint="Chu thuong, so, gach ngang hoac gach duoi."
                  >
                    <input
                      className={styles.fieldInput}
                      value={workspaceId}
                      disabled={Boolean(editingWorkspaceId)}
                      placeholder="my-project"
                      onChange={(event) =>
                        setWorkspaceId(event.target.value.toLowerCase())
                      }
                    />
                  </Field>
                  <Field label="Display name">
                    <input
                      className={styles.fieldInput}
                      value={workspaceName}
                      placeholder="My Project"
                      onChange={(event) =>
                        setWorkspaceName(event.target.value)
                      }
                    />
                  </Field>
                  <Field label="Absolute folder path">
                    <div className={styles.pathPickerRow}>
                      <input
                        className={styles.fieldInput}
                        value={workspaceRoot}
                        placeholder="E:\\projects\\my-project"
                        onChange={(event) => {
                          setWorkspaceRoot(event.target.value);
                          setWorkspaceInspection(null);
                        }}
                      />
                      <button
                        type="button"
                        className={styles.ghostButton}
                        onClick={pickWorkspaceDirectory}
                        disabled={pickerBusy}
                      >
                        <Icon name="folder" />
                        {pickerBusy ? "Opening..." : "Choose folder"}
                      </button>
                    </div>
                  </Field>

                  {workspaceInspection ? (
                    <div className={styles.inspectionBox}>
                      <div className={styles.inlineRow}>
                        <span className={`${styles.badge} ${styles.badgeStrong}`}>
                          Valid directory
                        </span>
                        <span className={styles.badge}>
                          Git: {workspaceInspection.isGitRepository ? "yes" : "no"}
                        </span>
                      </div>
                      <div className={styles.workspacePath}>
                        {workspaceInspection.root}
                      </div>
                      <div className={styles.inlineRow}>
                        {(workspaceInspection.markers ?? []).map(
                          (marker, index) => (
                            <span
                              key={`${String(marker)}-${index}`}
                              className={styles.badge}
                            >
                              {String(marker)}
                            </span>
                          )
                        )}
                      </div>
                    </div>
                  ) : null}

                  <div className={styles.inlineRow}>
                    <button
                      type="button"
                      className={styles.ghostButton}
                      onClick={validateWorkspacePath}
                      disabled={workspaceBusy || !workspaceRoot.trim()}
                    >
                      Validate path
                    </button>
                    <button
                      type="button"
                      className={styles.actionButton}
                      onClick={saveWorkspace}
                      disabled={workspaceBusy}
                    >
                      {editingWorkspaceId ? "Save changes" : "Add workspace"}
                    </button>
                    {editingWorkspaceId ? (
                      <button
                        type="button"
                        className={styles.ghostButton}
                        onClick={resetWorkspaceEditor}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </div>
                </div>
              </Panel>

              <Panel
                title="Registered workspaces"
                note="Changes are available to MCP tools immediately; no backend restart is required."
                actions={
                  <span className={styles.badge}>
                    {workspaces.length} workspaces
                  </span>
                }
              >
                <div className={styles.workspaceManagerList}>
                  {workspaces.map((item) => (
                    <article key={item.id} className={styles.workspaceCard}>
                      <div className={styles.workspaceCardHeader}>
                        <div>
                          <div className={styles.workspaceName}>
                            {item.name} ({item.id})
                          </div>
                          <div className={styles.workspacePath}>{item.root}</div>
                        </div>
                        {item.default ? (
                          <span className={`${styles.badge} ${styles.badgeStrong}`}>
                            Default
                          </span>
                        ) : null}
                      </div>

                      <div className={styles.inlineRow}>
                        <span className={styles.badge}>Read</span>
                        {item.permissions?.write ? (
                          <span className={styles.badge}>Write</span>
                        ) : (
                          <span className={styles.badge}>Read-only</span>
                        )}
                        {item.permissions?.git ? (
                          <span className={styles.badge}>Git inspect</span>
                        ) : null}
                        {item.permissions?.commit ? (
                          <span className={styles.badge}>Commit</span>
                        ) : null}
                        {item.permissions?.execute ? (
                          <span className={styles.badge}>Execute</span>
                        ) : null}
                      </div>

                      <div className={styles.inlineRow}>
                        <button
                          type="button"
                          className={styles.ghostButton}
                          onClick={() => setDefaultWorkspace(item.id)}
                          disabled={workspaceBusy || item.default}
                        >
                          Set default
                        </button>
                        <button
                          type="button"
                          className={styles.ghostButton}
                          onClick={() => editWorkspace(item)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={styles.dangerButton}
                          onClick={() => removeWorkspace(item.id)}
                          disabled={workspaceBusy || workspaces.length <= 1}
                        >
                          Remove
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </Panel>
            </div>
          ) : null}

          {tab === "files" ? (
            <div className={`${styles.grid} ${styles.gridTwo}`}>
              <Panel
                title="File explorer"
                note="List, read, search, and summarize files."
              >
                <div className={styles.fieldGrid}>
                  <Field label="Workspace">
                    <select
                      className={styles.fieldSelect}
                      value={workspace}
                      onChange={(e) => setWorkspace(e.target.value)}
                    >
                      {workspaces.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({item.id})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className={styles.gridTwo}>
                    <Field label="Directory">
                      <input
                        className={styles.fieldInput}
                        value={directory}
                        onChange={(e) =>
                          setDirectory(e.target.value)
                        }
                      />
                    </Field>
                    <Field label="Depth">
                      <input
                        className={styles.fieldInput}
                        type="number"
                        min="0"
                        max="6"
                        value={depth}
                        onChange={(e) =>
                          setDepth(Number(e.target.value))
                        }
                      />
                    </Field>
                  </div>
                  <div className={styles.inlineRow}>
                    <button
                      type="button"
                      className={styles.actionButton}
                      onClick={() =>
                        runTool(
                          "workspace_list_files",
                          { workspace, directory, depth },
                          "List files"
                        )
                      }
                      disabled={busy}
                    >
                      <Icon name="list" />
                      List files
                    </button>
                    <button
                      type="button"
                      className={styles.actionButton}
                      onClick={() =>
                        runTool(
                          "workspace_repo_map",
                          {
                            workspace,
                            directory,
                            maxFiles: repoMaxFiles,
                          },
                          "Repo map"
                        )
                      }
                      disabled={busy}
                    >
                      <Icon name="tools" />
                      Repo map
                    </button>
                  </div>
                </div>
              </Panel>

              <Panel title="Read and search" note="Single file or multiple files.">
                <div className={styles.fieldGrid}>
                  <Field label="File">
                    <input
                      className={styles.fieldInput}
                      value={file}
                      onChange={(e) => setFile(e.target.value)}
                    />
                  </Field>
                  <div className={styles.gridTwo}>
                    <Field label="Max characters">
                      <input
                        className={styles.fieldInput}
                        type="number"
                        min="1000"
                        max="200000"
                        value={maxCharacters}
                        onChange={(e) =>
                          setMaxCharacters(Number(e.target.value))
                        }
                      />
                    </Field>
                    <Field label="Query">
                      <input
                        className={styles.fieldInput}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </Field>
                  </div>
                  <div className={styles.inlineRow}>
                    <label className={styles.switch}>
                      <input
                        type="checkbox"
                        checked={caseSensitive}
                        onChange={(e) =>
                          setCaseSensitive(e.target.checked)
                        }
                      />
                      Case sensitive
                    </label>
                  </div>
                  <div className={styles.inlineRow}>
                    <button
                      type="button"
                      className={styles.actionButton}
                      onClick={() =>
                        runTool(
                          "workspace_read_file",
                          {
                            workspace,
                            file,
                            maxCharacters,
                          },
                          "Read file"
                        )
                      }
                      disabled={busy}
                    >
                      <Icon name="file" />
                      Read file
                    </button>
                    <button
                      type="button"
                      className={styles.actionButton}
                      onClick={() =>
                        runTool(
                          "workspace_search_text",
                          {
                            workspace,
                            directory,
                            query,
                            caseSensitive,
                          },
                          "Search text"
                        )
                      }
                      disabled={busy}
                    >
                      <Icon name="list" />
                      Search text
                    </button>
                    <button
                      type="button"
                      className={styles.ghostButton}
                      onClick={() =>
                        runTool(
                          "workspace_read_many_files",
                          {
                            workspace,
                            files: readManyFiles
                              .split(/\r?\n/)
                              .map((item) => item.trim())
                              .filter(Boolean),
                            maxCharactersPerFile: readManyMax,
                          },
                          "Read many files"
                        )
                      }
                      disabled={busy}
                    >
                      <Icon name="tools" />
                      Read many
                    </button>
                  </div>
                  <Field label="Files (one per line)">
                    <textarea
                      className={styles.fieldTextArea}
                      value={readManyFiles}
                      onChange={(e) =>
                        setReadManyFiles(e.target.value)
                      }
                    />
                  </Field>
                  <div className={styles.gridTwo}>
                    <Field label="Max characters per file">
                      <input
                        className={styles.fieldInput}
                        type="number"
                        min="1000"
                        max="100000"
                        value={readManyMax}
                        onChange={(e) =>
                          setReadManyMax(Number(e.target.value))
                        }
                      />
                    </Field>
                    <Field label="Repo map max files">
                      <input
                        className={styles.fieldInput}
                        type="number"
                        min="20"
                        max="1000"
                        value={repoMaxFiles}
                        onChange={(e) =>
                          setRepoMaxFiles(Number(e.target.value))
                        }
                      />
                    </Field>
                  </div>
                </div>
              </Panel>
            </div>
          ) : null}

          {tab === "git" ? (
            <div className={`${styles.grid} ${styles.gridTwo}`}>
              <Panel title="Git" note="Inspect history and create commits.">
                <div className={styles.fieldGrid}>
                  <Field label="Workspace">
                    <select
                      className={styles.fieldSelect}
                      value={workspace}
                      onChange={(e) => setWorkspace(e.target.value)}
                    >
                      {workspaces.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({item.id})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="File filter">
                    <input
                      className={styles.fieldInput}
                      value={file}
                      onChange={(e) => setFile(e.target.value)}
                    />
                  </Field>
                  <div className={styles.gridTwo}>
                    <Field label="Revision">
                      <input
                        className={styles.fieldInput}
                        value={gitRef}
                        onChange={(e) => setGitRef(e.target.value)}
                      />
                    </Field>
                    <Field label="Max commits">
                      <input
                        className={styles.fieldInput}
                        type="number"
                        min="1"
                        max="100"
                        value={gitMaxCount}
                        onChange={(e) =>
                          setGitMaxCount(Number(e.target.value))
                        }
                      />
                    </Field>
                  </div>
                  <div className={styles.inlineRow}>
                    <button
                      type="button"
                      className={styles.actionButton}
                      onClick={() =>
                        runTool(
                          "workspace_git_status",
                          { workspace },
                          "Git status"
                        )
                      }
                      disabled={busy}
                    >
                      <Icon name="git" />
                      Status
                    </button>
                    <button
                      type="button"
                      className={styles.actionButton}
                      onClick={() =>
                        runTool(
                          "workspace_git_diff",
                          { workspace, file },
                          "Git diff"
                        )
                      }
                      disabled={busy}
                    >
                      <Icon name="git" />
                      Diff
                    </button>
                    <button
                      type="button"
                      className={styles.actionButton}
                      onClick={() =>
                        runTool(
                          "workspace_git_log",
                          { workspace, file, maxCount: gitMaxCount },
                          "Git log"
                        )
                      }
                      disabled={busy}
                    >
                      <Icon name="git" />
                      Log
                    </button>
                    <button
                      type="button"
                      className={styles.ghostButton}
                      onClick={() =>
                        runTool(
                          "workspace_git_show",
                          {
                            workspace,
                            ref: gitRef,
                          },
                          "Git show"
                        )
                      }
                      disabled={busy}
                    >
                      <Icon name="git" />
                      Show
                    </button>
                  </div>
                </div>
              </Panel>

              <Panel title="Commit" note="Stage and commit from the GUI.">
                <div className={styles.fieldGrid}>
                  <Field label="Commit message">
                    <input
                      className={styles.fieldInput}
                      value={gitMessage}
                      onChange={(e) => setGitMessage(e.target.value)}
                      placeholder="Update dashboard"
                    />
                  </Field>
                  <div className={styles.inlineRow}>
                    <label className={styles.switch}>
                      <input
                        type="checkbox"
                        checked={gitAll}
                        onChange={(e) => setGitAll(e.target.checked)}
                      />
                      Add all changes
                    </label>
                  </div>
                  <div className={styles.inlineRow}>
                    <button
                      type="button"
                      className={styles.actionButton}
                      onClick={() =>
                        runTool(
                          "workspace_git_commit",
                          {
                            workspace,
                            message: gitMessage || "Update workspace",
                            all: gitAll,
                            files: gitAll ? [] : [file].filter(Boolean),
                          },
                          "Git commit"
                        )
                      }
                      disabled={busy}
                    >
                      <Icon name="play" />
                      Commit
                    </button>
                  </div>
                </div>
              </Panel>
            </div>
          ) : null}

          {tab === "write" ? (
            <div className={`${styles.grid} ${styles.gridThree}`}>
              <Panel title="Write file" note="Create or overwrite a UTF-8 file.">
                <div className={styles.fieldGrid}>
                  <Field label="Path">
                    <input
                      className={styles.fieldInput}
                      value={writeFile}
                      onChange={(e) => setWriteFile(e.target.value)}
                    />
                  </Field>
                  <Field label="Content">
                    <textarea
                      className={styles.fieldTextArea}
                      value={writeContent}
                      onChange={(e) =>
                        setWriteContent(e.target.value)
                      }
                    />
                  </Field>
                  <div className={styles.inlineRow}>
                    <label className={styles.switch}>
                      <input
                        type="checkbox"
                        checked={overwrite}
                        onChange={(e) =>
                          setOverwrite(e.target.checked)
                        }
                      />
                      Overwrite
                    </label>
                  </div>
                  <Field label="Expected current content">
                    <textarea
                      className={styles.fieldTextArea}
                      value={expectedCurrentContent}
                      onChange={(e) =>
                        setExpectedCurrentContent(e.target.value)
                      }
                    />
                  </Field>
                  <button
                    type="button"
                    className={styles.actionButton}
                    onClick={() =>
                      runTool(
                        "workspace_write_file",
                        {
                          workspace,
                          file: writeFile,
                          content: writeContent,
                          overwrite,
                          expectedCurrentContent:
                            expectedCurrentContent || undefined,
                        },
                        "Write file"
                      )
                    }
                    disabled={busy}
                  >
                    <Icon name="play" />
                    Write file
                  </button>
                </div>
              </Panel>

              <Panel title="Move file" note="Rename or move inside workspace.">
                <div className={styles.fieldGrid}>
                  <Field label="Source">
                    <input
                      className={styles.fieldInput}
                      value={moveSource}
                      onChange={(e) => setMoveSource(e.target.value)}
                    />
                  </Field>
                  <Field label="Destination">
                    <input
                      className={styles.fieldInput}
                      value={moveDestination}
                      onChange={(e) =>
                        setMoveDestination(e.target.value)
                      }
                    />
                  </Field>
                  <div className={styles.inlineRow}>
                    <label className={styles.switch}>
                      <input
                        type="checkbox"
                        checked={confirmMove}
                        onChange={(e) =>
                          setConfirmMove(e.target.checked)
                        }
                      />
                      Confirm
                    </label>
                  </div>
                  <button
                    type="button"
                    className={styles.actionButton}
                    onClick={() =>
                      runTool(
                        "workspace_move_file",
                        {
                          workspace,
                          source: moveSource,
                          destination: moveDestination,
                          overwrite: false,
                          confirm: confirmMove,
                        },
                        "Move file"
                      )
                    }
                    disabled={busy}
                  >
                    <Icon name="play" />
                    Move file
                  </button>
                </div>
              </Panel>

              <Panel title="Delete file" note="Removal is explicit.">
                <div className={styles.fieldGrid}>
                  <Field label="Path">
                    <input
                      className={styles.fieldInput}
                      value={writeFile}
                      onChange={(e) => setWriteFile(e.target.value)}
                    />
                  </Field>
                  <div className={styles.inlineRow}>
                    <label className={styles.switch}>
                      <input
                        type="checkbox"
                        checked={confirmDelete}
                        onChange={(e) =>
                          setConfirmDelete(e.target.checked)
                        }
                      />
                      Confirm
                    </label>
                  </div>
                  <button
                    type="button"
                    className={styles.actionButton}
                    onClick={() =>
                      runTool(
                        "workspace_delete_file",
                        {
                          workspace,
                          file: writeFile,
                          confirm: confirmDelete,
                        },
                        "Delete file"
                      )
                    }
                    disabled={busy}
                  >
                    <Icon name="play" />
                    Delete file
                  </button>
                </div>
              </Panel>
            </div>
          ) : null}

          {tab === "tools" ? (
            <div className={`${styles.grid} ${styles.gridTwo}`}>
              <Panel
                title="Tool runner"
                note="Invoke any registered MCP tool with JSON arguments."
                actions={
                  <span className={styles.badge}>
                    {tools.length} tools
                  </span>
                }
              >
                <div className={styles.fieldGrid}>
                  <Field label="Tool">
                    <select
                      className={styles.fieldSelect}
                      value={toolName}
                      onChange={(e) => selectPreset(e.target.value)}
                    >
                      {tools.map((tool) => (
                        <option key={tool.name} value={tool.name}>
                          {tool.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Arguments JSON">
                    <textarea
                      className={styles.fieldTextArea}
                      value={argsJson}
                      onChange={(e) => setArgsJson(e.target.value)}
                    />
                  </Field>
                  <div className={styles.inlineRow}>
                    <button
                      type="button"
                      className={styles.actionButton}
                      onClick={() => {
                        const parsed = parseArgs();
                        runTool(toolName, parsed, toolName);
                      }}
                      disabled={busy}
                    >
                      <Icon name="play" />
                      Run tool
                    </button>
                    <button
                      type="button"
                      className={styles.ghostButton}
                      onClick={() =>
                        setArgsJson(
                          JSON.stringify(
                            TOOL_PRESETS[toolName] ?? {},
                            null,
                            2
                          )
                        )
                      }
                      disabled={busy}
                    >
                      <Icon name="refresh" />
                      Load preset
                    </button>
                  </div>
                </div>
              </Panel>

              <Panel
                title="Catalog"
                note="Full tool list from the backend."
              >
                <div className={styles.toolSelectList}>
                  {tools.map((tool) => (
                    <button
                      key={tool.name}
                      type="button"
                      className={`${styles.toolPill} ${
                        toolName === tool.name
                          ? styles.toolPillActive
                          : ""
                      }`}
                      onClick={() => selectPreset(tool.name)}
                    >
                      <div className={styles.toolName}>{tool.name}</div>
                      <div className={styles.toolDesc}>
                        {tool.description ?? "No description"}
                      </div>
                    </button>
                  ))}
                </div>
              </Panel>
            </div>
          ) : null}

          <div className={styles.resultPanel}>
            <div className={styles.resultMeta}>
              <span>{outputTitle}</span>
              <span>
                {busy || workspaceBusy || pickerBusy
                  ? `Running ${action}...`
                  : "Idle"}
              </span>
            </div>
            <pre className={styles.resultText}>{output}</pre>
          </div>
        </section>
      </div>
    </main>
  );
}
