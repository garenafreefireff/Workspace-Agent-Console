import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const execFile = promisify(execFileCallback);

const ROOT = path.resolve(
  process.env.WORKSPACE_ROOT ?? "E:\\bessplaner"
);

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const MCP_PATH = "/mcp";

const IGNORED_NAMES = new Set([
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
]);

const TEXT_EXTENSIONS = new Set([
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

function textResult(text) {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

function normalizeRelativePath(relativePath = ".") {
  const cleanPath = relativePath.trim() || ".";

  if (path.isAbsolute(cleanPath)) {
    throw new Error("Chỉ được sử dụng đường dẫn tương đối.");
  }

  return cleanPath;
}

function assertInsideWorkspace(targetPath) {
  const resolvedTarget = path.resolve(targetPath);

  const rootComparison =
    process.platform === "win32" ? ROOT.toLowerCase() : ROOT;

  const targetComparison =
    process.platform === "win32"
      ? resolvedTarget.toLowerCase()
      : resolvedTarget;

  const rootWithSeparator = rootComparison.endsWith(path.sep)
    ? rootComparison
    : rootComparison + path.sep;

  if (
    targetComparison !== rootComparison &&
    !targetComparison.startsWith(rootWithSeparator)
  ) {
    throw new Error("Đường dẫn nằm ngoài workspace được phép.");
  }

  return resolvedTarget;
}

function resolveWorkspacePath(relativePath = ".") {
  const normalized = normalizeRelativePath(relativePath);
  return assertInsideWorkspace(path.resolve(ROOT, normalized));
}

async function resolveExistingPath(relativePath = ".") {
  const lexicalPath = resolveWorkspacePath(relativePath);
  const realPath = await fs.realpath(lexicalPath);

  return assertInsideWorkspace(realPath);
}

async function resolveWritableFile(relativePath) {
  const lexicalPath = resolveWorkspacePath(relativePath);
  const parentPath = path.dirname(lexicalPath);

  // Không tự tạo cả cây thư mục để tránh đi qua symlink ngoài workspace.
  const realParentPath = await fs.realpath(parentPath);
  assertInsideWorkspace(realParentPath);

  return assertInsideWorkspace(
    path.join(realParentPath, path.basename(lexicalPath))
  );
}

function toWorkspaceRelative(absolutePath) {
  const relative = path.relative(ROOT, absolutePath);
  return relative.replaceAll("\\", "/") || ".";
}

async function walkDirectory(
  directory,
  currentDepth,
  maxDepth,
  output,
  maxEntries
) {
  if (output.length >= maxEntries) {
    return;
  }

  const entries = await fs.readdir(directory, {
    withFileTypes: true,
  });

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (output.length >= maxEntries) {
      return;
    }

    if (IGNORED_NAMES.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      output.push(`${toWorkspaceRelative(absolutePath)} [symlink skipped]`);
      continue;
    }

    if (entry.isDirectory()) {
      output.push(`${toWorkspaceRelative(absolutePath)}/`);

      if (currentDepth < maxDepth) {
        await walkDirectory(
          absolutePath,
          currentDepth + 1,
          maxDepth,
          output,
          maxEntries
        );
      }

      continue;
    }

    if (entry.isFile()) {
      output.push(toWorkspaceRelative(absolutePath));
    }
  }
}

async function collectTextFiles(
  directory,
  output,
  maxFiles
) {
  if (output.length >= maxFiles) {
    return;
  }

  const entries = await fs.readdir(directory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (output.length >= maxFiles) {
      return;
    }

    if (IGNORED_NAMES.has(entry.name) || entry.isSymbolicLink()) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await collectTextFiles(absolutePath, output, maxFiles);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();

    if (
      TEXT_EXTENSIONS.has(extension) ||
      entry.name === "Dockerfile" ||
      entry.name === "Makefile"
    ) {
      output.push(absolutePath);
    }
  }
}

function createWorkspaceServer() {
  const server = new McpServer({
    name: "local-workspace-agent",
    version: "1.0.0",
  });

  server.registerTool(
    "workspace_list_files",
    {
      title: "List workspace files",
      description:
        "Use this to inspect files and directories inside the permitted local coding workspace.",
      inputSchema: {
        directory: z.string().default("."),
        depth: z.number().int().min(0).max(6).default(3),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ directory = ".", depth = 3 }) => {
      try {
        const absoluteDirectory =
          await resolveExistingPath(directory);

        const stat = await fs.stat(absoluteDirectory);

        if (!stat.isDirectory()) {
          throw new Error("Đường dẫn không phải thư mục.");
        }

        const files = [];

        await walkDirectory(
          absoluteDirectory,
          0,
          depth,
          files,
          500
        );

        const truncated =
          files.length >= 500
            ? "\n\nKết quả đã giới hạn ở 500 mục."
            : "";

        return textResult(
          `Workspace: ${ROOT}\n\n${files.join("\n")}${truncated}`
        );
      } catch (error) {
        return textResult(`Lỗi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_read_file",
    {
      title: "Read workspace file",
      description:
        "Use this to read a UTF-8 text file inside the permitted local workspace.",
      inputSchema: {
        file: z.string().min(1),
        maxCharacters: z
          .number()
          .int()
          .min(1000)
          .max(200000)
          .default(50000),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ file, maxCharacters = 50000 }) => {
      try {
        const absoluteFile = await resolveExistingPath(file);
        const stat = await fs.stat(absoluteFile);

        if (!stat.isFile()) {
          throw new Error("Đường dẫn không phải file.");
        }

        if (stat.size > 2_000_000) {
          throw new Error("File lớn hơn giới hạn 2 MB.");
        }

        const content = await fs.readFile(absoluteFile, "utf8");
        const truncated = content.length > maxCharacters;

        return textResult(
          [
            `FILE: ${toWorkspaceRelative(absoluteFile)}`,
            "",
            content.slice(0, maxCharacters),
            truncated
              ? "\n\n[File đã được rút gọn do vượt giới hạn.]"
              : "",
          ].join("\n")
        );
      } catch (error) {
        return textResult(`Lỗi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_search_text",
    {
      title: "Search workspace text",
      description:
        "Use this to search source-code text inside the permitted local workspace.",
      inputSchema: {
        query: z.string().min(1).max(200),
        directory: z.string().default("."),
        caseSensitive: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      query,
      directory = ".",
      caseSensitive = false,
    }) => {
      try {
        const absoluteDirectory =
          await resolveExistingPath(directory);

        const files = [];
        await collectTextFiles(absoluteDirectory, files, 1000);

        const expected = caseSensitive
          ? query
          : query.toLowerCase();

        const matches = [];

        for (const file of files) {
          if (matches.length >= 100) {
            break;
          }

          const stat = await fs.stat(file);

          if (stat.size > 1_000_000) {
            continue;
          }

          let content;

          try {
            content = await fs.readFile(file, "utf8");
          } catch {
            continue;
          }

          const lines = content.split(/\r?\n/);

          lines.forEach((line, index) => {
            if (matches.length >= 100) {
              return;
            }

            const comparable = caseSensitive
              ? line
              : line.toLowerCase();

            if (comparable.includes(expected)) {
              matches.push(
                `${toWorkspaceRelative(file)}:${index + 1}: ${line.slice(
                  0,
                  300
                )}`
              );
            }
          });
        }

        if (matches.length === 0) {
          return textResult("Không tìm thấy kết quả.");
        }

        return textResult(
          `${matches.join("\n")}\n\nTổng kết quả: ${
            matches.length
          }${matches.length >= 100 ? " (đã giới hạn)" : ""}`
        );
      } catch (error) {
        return textResult(`Lỗi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_replace_text",
    {
      title: "Replace text in workspace file",
      description:
        "Use this to replace exactly one matching text block in an existing source file. It refuses ambiguous replacements.",
      inputSchema: {
        file: z.string().min(1),
        oldText: z.string().min(1),
        newText: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async ({ file, oldText, newText }) => {
      try {
        if (oldText === newText) {
          throw new Error("Nội dung cũ và mới giống nhau.");
        }

        const absoluteFile = await resolveExistingPath(file);
        const stat = await fs.stat(absoluteFile);

        if (!stat.isFile()) {
          throw new Error("Đường dẫn không phải file.");
        }

        if (stat.size > 2_000_000) {
          throw new Error("File lớn hơn giới hạn 2 MB.");
        }

        const content = await fs.readFile(absoluteFile, "utf8");

        let count = 0;
        let position = 0;

        while (true) {
          const index = content.indexOf(oldText, position);

          if (index === -1) {
            break;
          }

          count += 1;
          position = index + oldText.length;

          if (count > 1) {
            break;
          }
        }

        if (count === 0) {
          throw new Error(
            "Không tìm thấy chính xác đoạn oldText trong file."
          );
        }

        if (count > 1) {
          throw new Error(
            "Đoạn oldText xuất hiện nhiều hơn một lần. Cần cung cấp đoạn cụ thể hơn."
          );
        }

        const updatedContent = content.replace(oldText, newText);

        await fs.writeFile(
          absoluteFile,
          updatedContent,
          "utf8"
        );

        return textResult(
          `Đã cập nhật: ${toWorkspaceRelative(absoluteFile)}`
        );
      } catch (error) {
        return textResult(`Lỗi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_create_file",
    {
      title: "Create workspace file",
      description:
        "Use this to create a new file inside an existing directory in the permitted workspace. It will not overwrite an existing file.",
      inputSchema: {
        file: z.string().min(1),
        content: z.string().max(500000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async ({ file, content }) => {
      try {
        const absoluteFile = await resolveWritableFile(file);

        await fs.writeFile(absoluteFile, content, {
          encoding: "utf8",
          flag: "wx",
        });

        return textResult(
          `Đã tạo: ${toWorkspaceRelative(absoluteFile)}`
        );
      } catch (error) {
        if (error.code === "EEXIST") {
          return textResult(
            "Lỗi: File đã tồn tại. Tool này không được phép ghi đè."
          );
        }

        return textResult(`Lỗi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_git_diff",
    {
      title: "Show Git diff",
      description:
        "Use this to inspect uncommitted Git changes in the permitted workspace.",
      inputSchema: {
        file: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ file }) => {
      try {
        const args = ["-C", ROOT, "diff", "--"];

        if (file) {
          const absoluteFile = resolveWorkspacePath(file);
          args.push(toWorkspaceRelative(absoluteFile));
        }

        const { stdout, stderr } = await execFile("git", args, {
          cwd: ROOT,
          windowsHide: true,
          maxBuffer: 2_000_000,
        });

        const output = stdout || stderr || "Không có thay đổi Git.";

        return textResult(output.slice(0, 150000));
      } catch (error) {
        return textResult(`Lỗi Git: ${error.message}`);
      }
    }
  );

  return server;
}

const httpServer = createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(
    request.url,
    `http://${request.headers.host ?? "localhost"}`
  );

  if (request.method === "GET" && url.pathname === "/") {
    response
      .writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
      })
      .end(`Local workspace MCP server\nWorkspace: ${ROOT}`);
    return;
  }

  if (
    request.method === "OPTIONS" &&
    url.pathname === MCP_PATH
  ) {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":
        "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type, mcp-session-id, authorization",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });

    response.end();
    return;
  }

  const allowedMethods = new Set(["POST", "GET", "DELETE"]);

  if (
    url.pathname === MCP_PATH &&
    request.method &&
    allowedMethods.has(request.method)
  ) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Access-Control-Expose-Headers",
      "Mcp-Session-Id"
    );

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

httpServer.listen(PORT, HOST, () => {
  console.log("Local workspace MCP server started");
  console.log(`Workspace: ${ROOT}`);
  console.log(`MCP URL: http://${HOST}:${PORT}${MCP_PATH}`);
});