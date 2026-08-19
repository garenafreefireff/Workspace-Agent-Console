import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  HOST,
  MCP_PATHS,
  PORT,
  SERVER_VERSION,
} from "./config.js";
import { createWorkspaceServer } from "./mcpServer.js";
import {
  getLoopStatus,
  runLoopIteration,
  stopLoopRun,
  updateLoopMemory,
} from "./services/loopStore.js";
import {
  getDefaultWorkspaceName,
  listWorkspaces,
  workspaceRegistry,
} from "./services/workspaceRegistry.js";
import { assertWriteEnabled } from "./utils/writeGuard.js";

const JSON_BODY_LIMIT = 64 * 1024;

function sendJson(response, statusCode, body) {
  response
    .writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    })
    .end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > JSON_BODY_LIMIT) {
      throw new Error("Request body vuot qua gioi han 64 KB.");
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body khong phai JSON hop le.");
  }
}

function workspaceApiMatch(pathname) {
  const match = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function workspaceDefaultApiMatch(pathname) {
  const match = pathname.match(
    /^\/api\/workspaces\/([^/]+)\/default$/
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function loopApiMatch(pathname) {
  const match = pathname.match(/^\/api\/loops\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function loopStopApiMatch(pathname) {
  const match = pathname.match(/^\/api\/loops\/([^/]+)\/stop$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function loopMemoryApiMatch(pathname) {
  const match = pathname.match(/^\/api\/loops\/([^/]+)\/memory$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function workspaceSummary() {
  return listWorkspaces()
    .map(
      (workspace) =>
        `${workspace.id}${workspace.default ? " (default)" : ""}: ${workspace.root}`
    )
    .join("\n");
}

function isMcpPath(pathname) {
  return MCP_PATHS.includes(pathname);
}

export function createWorkspaceHttpServer() {
  return createServer(async (request, response) => {
    if (!request.url) {
      response.writeHead(400).end("Missing URL");
      return;
    }

    const startedAt = Date.now();
    const requestLabel = Math.random()
      .toString(36)
      .slice(2, 10);

    console.log(
      `[HTTP ${requestLabel}] --> ${request.method} ${request.url}`
    );

    response.on("finish", () => {
      console.log(
        `[HTTP ${requestLabel}] <-- ${response.statusCode} ${request.method} ${request.url} (${Date.now() - startedAt}ms)`
      );
    });

    const url = new URL(
      request.url,
      `http://${request.headers.host ?? "localhost"}`
    );

    if (request.method === "GET" && url.pathname === "/") {
      response
        .writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        })
        .end(
          [
            `Local workspace MCP server v${SERVER_VERSION}`,
            `PID: ${process.pid}`,
            `CWD: ${process.cwd()}`,
            `MCP paths: ${MCP_PATHS.join(", ")}`,
            "",
            workspaceSummary(),
          ].join("\n")
        );
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      response
        .writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        })
        .end(
          JSON.stringify(
            {
              ok: true,
              serverVersion: SERVER_VERSION,
              schemaMode: "dynamic-multi-workspace",
              processId: process.pid,
              workingDirectory: process.cwd(),
              mcpPaths: MCP_PATHS,
              workspaceApi: "/api/workspaces",
              loopApi: "/api/loops",
              loopCapabilities: {
                verifiers: [
                  "browser_runner",
                  "sld_geometry",
                  "http_api",
                  "websocket_probe",
                  "socketio_probe",
                ],
                secretTemplates: true,
                evidenceRedaction: true,
                networkAllowlist: true,
                nativeWebSocket: typeof globalThis.WebSocket === "function",
                webSocketFallback: "ws-if-installed",
                worktreeIsolation: true,
                durableMemory: true,
              },
              defaultWorkspace: getDefaultWorkspaceName(),
              workspaces: listWorkspaces(),
            },
            null,
            2
          )
        );
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/loops") {
      try {
        sendJson(response, 200, {
          ok: true,
          runs: await getLoopStatus(),
        });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loops/run") {
      try {
        assertWriteEnabled();
        const body = await readJsonBody(request);
        const result = await runLoopIteration({
          runId: body.runId,
          spec: body.spec,
          criterionResults: body.criterionResults ?? [],
          iterationContext: body.iterationContext,
        });
        sendJson(response, body.runId ? 200 : 201, { ok: true, result });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    const loopMemoryId = loopMemoryApiMatch(url.pathname);

    if (request.method === "GET" && loopMemoryId) {
      try {
        const run = await getLoopStatus(loopMemoryId);
        sendJson(response, 200, { ok: true, memory: run.memory ?? {} });
      } catch (error) {
        sendJson(response, 404, { ok: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && loopMemoryId) {
      try {
        assertWriteEnabled();
        const body = await readJsonBody(request);
        const memory = await updateLoopMemory(loopMemoryId, {
          note: body.note,
          lesson: body.lesson,
        });
        sendJson(response, 200, { ok: true, memory });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    const loopStopId = loopStopApiMatch(url.pathname);

    if (request.method === "POST" && loopStopId) {
      try {
        const body = await readJsonBody(request);
        const result = await stopLoopRun(
          loopStopId,
          typeof body.reason === "string" ? body.reason : "stopped_by_user"
        );
        sendJson(response, 200, { ok: true, result });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    const loopId = loopApiMatch(url.pathname);

    if (request.method === "GET" && loopId) {
      try {
        sendJson(response, 200, {
          ok: true,
          result: await getLoopStatus(loopId),
        });
      } catch (error) {
        sendJson(response, 404, { ok: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/workspaces") {
      sendJson(response, 200, {
        ok: true,
        defaultWorkspace: getDefaultWorkspaceName(),
        workspaces: listWorkspaces(),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/workspaces") {
      try {
        const body = await readJsonBody(request);
        const result = await workspaceRegistry.add({
          id: body.id,
          name: body.name,
          root: body.root,
          permissions: body.permissions,
        });
        sendJson(response, 201, { ok: true, result });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/workspaces/validate"
    ) {
      try {
        const body = await readJsonBody(request);
        const inspection = await workspaceRegistry.validateRoot(body.root);
        sendJson(response, 200, { ok: true, inspection });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    const defaultWorkspaceId = workspaceDefaultApiMatch(url.pathname);

    if (request.method === "POST" && defaultWorkspaceId) {
      try {
        const result = await workspaceRegistry.setDefault(
          defaultWorkspaceId
        );
        sendJson(response, 200, { ok: true, result });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    const workspaceId = workspaceApiMatch(url.pathname);

    if (request.method === "PATCH" && workspaceId) {
      try {
        const body = await readJsonBody(request);
        const result = await workspaceRegistry.update(workspaceId, {
          name: body.name,
          root: body.root,
          permissions: body.permissions,
        });
        sendJson(response, 200, { ok: true, result });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (request.method === "DELETE" && workspaceId) {
      try {
        const result = await workspaceRegistry.remove(workspaceId);
        sendJson(response, 200, { ok: true, result });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (request.method === "OPTIONS" && isMcpPath(url.pathname)) {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "content-type, mcp-session-id, authorization",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
      });

      response.end();
      return;
    }

    const allowedMethods = new Set(["POST", "GET", "DELETE"]);

    if (
      isMcpPath(url.pathname) &&
      request.method &&
      allowedMethods.has(request.method)
    ) {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

      const server = createWorkspaceServer();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      response.on("close", () => {
        transport.close();
        server.close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(request, response);
      } catch (error) {
        console.error("MCP request error:", error);

        if (!response.headersSent) {
          response.writeHead(500).end("Internal server error");
        }
      }

      return;
    }

    response.writeHead(404).end("Not Found");
  });
}

export function startHttpServer() {
  const httpServer = createWorkspaceHttpServer();

  httpServer.listen(PORT, HOST, () => {
    console.log(`Local workspace MCP server v${SERVER_VERSION} started`);
    console.log(`PID: ${process.pid}`);
    console.log(`CWD: ${process.cwd()}`);
    console.log(workspaceSummary());

    for (const mcpPath of MCP_PATHS) {
      console.log(`MCP URL: http://${HOST}:${PORT}${mcpPath}`);
    }

    console.log(`Health: http://${HOST}:${PORT}/health`);
    console.log(`Workspace API: http://${HOST}:${PORT}/api/workspaces`);
    console.log(`Loop API: http://${HOST}:${PORT}/api/loops`);
  });

  return httpServer;
}
