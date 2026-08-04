"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./page.module.css";

const TABS = [
  "overview",
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

  const tools = boot?.tools ?? [];
  const toolMap = useMemo(
    () => new Map(tools.map((tool) => [tool.name, tool])),
    [tools]
  );
  const workspaces = boot?.health?.workspaces ?? [];

  useEffect(() => {
    loadBootstrap();
  }, []);

  async function loadBootstrap() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/bootstrap", {
        cache: "no-store",
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      setBoot(data);
      setWorkspace(data.health?.defaultWorkspace ?? "ems");
      setOutputTitle("Bootstrap loaded");
      setOutput(
        `Backend: ${data.health?.serverVersion ?? "unknown"}\nTools: ${data.tools.length}`
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
                <div key={item.name} className={styles.workspaceRow}>
                  <div>
                    <div className={styles.workspaceName}>
                      {item.name}
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
                  <Icon
                    name={
                      item === "overview"
                        ? "list"
                        : item === "files"
                          ? "file"
                          : item === "git"
                            ? "git"
                            : item === "write"
                              ? "play"
                              : "tools"
                    }
                  />
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
                        <option key={item.name} value={item.name}>
                          {item.name}
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
                        <option key={item.name} value={item.name}>
                          {item.name}
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
              <span>{busy ? `Running ${action}...` : "Idle"}</span>
            </div>
            <pre className={styles.resultText}>{output}</pre>
          </div>
        </section>
      </div>
    </main>
  );
}
