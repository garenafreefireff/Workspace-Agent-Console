import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getLocalWorkspaceSnapshot } from "./localWorkspaceStore.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "..", "..");
const rootEnvFile = path.join(projectRoot, ".env");

function readRootEnv() {
  if (!existsSync(rootEnvFile)) {
    return {};
  }

  const values = {};
  const content = readFileSync(rootEnvFile, "utf8");

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

const rootEnv = readRootEnv();
const configuredHost =
  process.env.BACKEND_HOST ?? rootEnv.HOST ?? "127.0.0.1";
const backendHost =
  configuredHost === "0.0.0.0" ? "127.0.0.1" : configuredHost;
const backendPort =
  process.env.BACKEND_PORT ?? rootEnv.PORT ?? "8787";
const BACKEND_URL =
  process.env.BACKEND_URL ?? `http://${backendHost}:${backendPort}`;
const HEALTH_URL = new URL("/health", BACKEND_URL);
const MCP_URL = new URL("/mcp-v2", BACKEND_URL);

async function withClient(handler) {
  const client = new Client({
    name: "local-agent-web",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(MCP_URL);

  await client.connect(transport);

  try {
    return await handler(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function callBackendRest(pathname, options = {}) {
  const url = new URL(pathname, BACKEND_URL);
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.ok === false) {
    const detail = data.error || `HTTP ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;

    if (response.status === 404) {
      error.code = "WORKSPACE_REST_UNAVAILABLE";
    }

    throw error;
  }

  return data;
}

export async function getBackendHealth() {
  try {
    const response = await fetch(HEALTH_URL, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  } catch (error) {
    const detail = error?.cause?.code ?? error?.message ?? "fetch failed";
    throw new Error(
      `Backend unavailable at ${HEALTH_URL.href}: ${detail}`
    );
  }
}

export async function listBackendTools() {
  try {
    return await withClient((client) => client.listTools());
  } catch (error) {
    const detail = error?.cause?.code ?? error?.message ?? "connection failed";
    throw new Error(
      `MCP unavailable at ${MCP_URL.href}: ${detail}`
    );
  }
}

export async function callBackendTool(name, args = {}) {
  return withClient((client) =>
    client.callTool({
      name,
      arguments: args,
    })
  );
}

function parseJsonPayload(text) {
  const normalized = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .trim();

  if (!normalized) {
    throw new Error("Backend tool returned an empty response.");
  }

  const fencedMatch = normalized.match(
    /```(?:json)?\s*([\s\S]*?)\s*```/i
  );
  const candidates = [normalized];

  if (fencedMatch?.[1]) {
    candidates.unshift(fencedMatch[1].trim());
  }

  const objectStart = normalized.indexOf("{");
  const objectEnd = normalized.lastIndexOf("}");

  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(normalized.slice(objectStart, objectEnd + 1));
  }

  const arrayStart = normalized.indexOf("[");
  const arrayEnd = normalized.lastIndexOf("]");

  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(normalized.slice(arrayStart, arrayEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("Backend tool response does not contain valid JSON.");
}

export async function callBackendJsonTool(name, args = {}) {
  const result = await callBackendTool(name, args);

  if (
    result?.structuredContent &&
    typeof result.structuredContent === "object"
  ) {
    return result.structuredContent;
  }

  const text = extractText(result).trim();

  if (/^Loi\s*:/i.test(text)) {
    throw new Error(text.replace(/^Loi\s*:/i, "").trim());
  }

  try {
    return parseJsonPayload(text);
  } catch (error) {
    const preview = text.replace(/\s+/g, " ").slice(0, 240);
    throw new Error(
      `Backend tool ${name} did not return valid JSON. Response: ${preview || "<empty>"}`
    );
  }
}

export function extractText(result) {
  if (!result) {
    return "";
  }

  if (typeof result === "string") {
    return result;
  }

  const content = Array.isArray(result.content)
    ? result.content
    : [];

  if (content.length === 0) {
    return JSON.stringify(result, null, 2);
  }

  return content
    .map((item) => {
      if (item?.type === "text") {
        return item.text ?? "";
      }

      return JSON.stringify(item, null, 2);
    })
    .join("\n");
}

export async function getBootstrapData() {
  const localWorkspaceSnapshot = await getLocalWorkspaceSnapshot();
  const [healthResult, toolsResult] = await Promise.allSettled([
    getBackendHealth(),
    listBackendTools(),
  ]);

  const backendOnline = healthResult.status === "fulfilled";
  const health = backendOnline
    ? healthResult.value
    : {
        serverVersion: "offline",
        workingDirectory: null,
        mcpPaths: [],
      };
  const tools =
    toolsResult.status === "fulfilled"
      ? toolsResult.value.tools ?? []
      : [];
  const backendErrors = [
    healthResult.status === "rejected"
      ? `Health: ${healthResult.reason?.message ?? "fetch failed"}`
      : null,
    toolsResult.status === "rejected"
      ? `Tools: ${toolsResult.reason?.message ?? "fetch failed"}`
      : null,
  ].filter(Boolean);

  return {
    health: {
      ...health,
      backendOnline,
      backendUrl: BACKEND_URL,
      backendError: backendErrors.join(" | ") || null,
      defaultWorkspace: localWorkspaceSnapshot.defaultWorkspace,
      workspaces: localWorkspaceSnapshot.workspaces,
      workspaceConfigSource: "local-config",
    },
    tools,
  };
}
