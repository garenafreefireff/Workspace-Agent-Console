import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  DEFAULT_WORKSPACE,
  HOST,
  MCP_PATHS,
  PORT,
  SERVER_VERSION,
  WORKSPACES,
} from "./config.js";
import { createWorkspaceServer } from "./mcpServer.js";

function workspaceSummary() {
  return Object.entries(WORKSPACES)
    .map(
      ([name, root]) =>
        `${name}${name === DEFAULT_WORKSPACE ? " (default)" : ""}: ${root}`
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
              schemaMode: "multi-workspace",
              processId: process.pid,
              workingDirectory: process.cwd(),
              mcpPaths: MCP_PATHS,
              defaultWorkspace: DEFAULT_WORKSPACE,
              workspaces: Object.entries(WORKSPACES).map(
                ([name, root]) => ({
                  name,
                  root,
                  default: name === DEFAULT_WORKSPACE,
                })
              ),
            },
            null,
            2
          )
        );
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
  });

  return httpServer;
}
