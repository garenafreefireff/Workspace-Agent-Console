import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import test from "node:test";
import { createWorkspaceHttpServer } from "../src/httpServer.js";

async function listen(server) {
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", resolve)
  );

  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("health endpoint responds with workspace metadata", async () => {
  const server = createWorkspaceHttpServer();
  const port = await listen(server);

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/health`
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.schemaMode, "multi-workspace");
    assert.ok(Array.isArray(body.workspaces));
  } finally {
    await close(server);
  }
});

test("MCP server registers core and extended tools", async () => {
  const server = createWorkspaceHttpServer();
  const port = await listen(server);
  const client = new Client({
    name: "local-agent-smoke-test",
    version: "0.0.0",
  });

  try {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp-v2`)
    );

    await client.connect(transport);

    const response = await client.listTools();
    const toolNames = response.tools.map((tool) => tool.name);

    for (const expected of [
      "workspace_read_many_files",
      "workspace_repo_map",
      "workspace_write_file",
      "workspace_delete_file",
      "workspace_move_file",
      "workspace_run_command",
      "workspace_git_log",
      "workspace_git_show",
      "workspace_git_commit",
    ]) {
      assert.ok(
        toolNames.includes(expected),
        `missing tool ${expected}`
      );
    }

    assert.ok(toolNames.length >= 20);
  } finally {
    await client.close();
    await close(server);
  }
});
