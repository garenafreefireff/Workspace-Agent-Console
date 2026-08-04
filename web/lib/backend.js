import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BACKEND_URL =
  process.env.BACKEND_URL ?? "http://127.0.0.1:8787";
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

export async function getBackendHealth() {
  const response = await fetch(HEALTH_URL, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(
      `Backend health check failed: ${response.status}`
    );
  }

  return response.json();
}

export async function listBackendTools() {
  return withClient((client) => client.listTools());
}

export async function callBackendTool(name, args = {}) {
  return withClient((client) =>
    client.callTool({
      name,
      arguments: args,
    })
  );
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
  const [health, tools] = await Promise.all([
    getBackendHealth(),
    listBackendTools(),
  ]);

  return {
    health,
    tools: tools.tools ?? [],
  };
}
