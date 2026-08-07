import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  assertWorkspacePermission,
  getWorkspace,
} from "../services/workspaceRegistry.js";
import { textResult } from "../utils/result.js";
import {
  collectTextFiles,
  resolveExistingPath,
  resolveWritableFile,
  toWorkspaceRelative,
  walkDirectory,
} from "../utils/paths.js";
import { assertWriteEnabled } from "../utils/writeGuard.js";

const workspaceSchema = z.string().min(1).optional();

function selectWorkspace(workspaceName, permission) {
  const selected = getWorkspace(workspaceName);
  assertWorkspacePermission(selected, permission);
  return selected;
}

function lineCount(value) {
  if (!value) {
    return 0;
  }

  return value.split(/\r?\n/).length;
}

function contentSummary(oldContent, newContent) {
  return {
    oldCharacters: oldContent.length,
    newCharacters: newContent.length,
    oldLines: lineCount(oldContent),
    newLines: lineCount(newContent),
  };
}

async function pathExists(absolutePath) {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function sortObjectEntries(entries) {
  return Object.fromEntries(
    Object.entries(entries).sort((a, b) =>
      a[0].localeCompare(b[0])
    )
  );
}

export function registerFileTools(server) {
  server.registerTool(
    "workspace_list_files",
    {
      title: "List workspace files",
      description:
        "Inspect files and directories in any dynamically registered workspace.",
      inputSchema: {
        workspace: workspaceSchema,
        directory: z.string().default("."),
        depth: z.number().int().min(0).max(6).default(3),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      workspace,
      directory = ".",
      depth = 3,
    }) => {
      try {
        const selected = selectWorkspace(workspace, "read");
        const absoluteDirectory = await resolveExistingPath(
          selected.root,
          directory
        );
        const stat = await fs.stat(absoluteDirectory);

        if (!stat.isDirectory()) {
          throw new Error("Duong dan khong phai thu muc.");
        }

        const files = [];
        await walkDirectory(
          selected.root,
          absoluteDirectory,
          0,
          depth,
          files,
          500
        );

        const truncated =
          files.length >= 500
            ? "\n\nKet qua da gioi han o 500 muc."
            : "";

        return textResult(
          [
            `Workspace: ${selected.name}`,
            `Root: ${selected.root}`,
            "",
            `${files.join("\n")}${truncated}`,
          ].join("\n")
        );
      } catch (error) {
        return textResult(`Loi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_read_file",
    {
      title: "Read workspace file",
      description:
        "Read a UTF-8 text file from one permitted workspace.",
      inputSchema: {
        workspace: workspaceSchema,
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
    async ({
      workspace,
      file,
      maxCharacters = 50000,
    }) => {
      try {
        const selected = selectWorkspace(workspace, "read");
        const absoluteFile = await resolveExistingPath(
          selected.root,
          file
        );
        const stat = await fs.stat(absoluteFile);

        if (!stat.isFile()) {
          throw new Error("Duong dan khong phai file.");
        }

        if (stat.size > 2_000_000) {
          throw new Error("File lon hon gioi han 2 MB.");
        }

        const content = await fs.readFile(absoluteFile, "utf8");
        const truncated = content.length > maxCharacters;

        return textResult(
          [
            `WORKSPACE: ${selected.name}`,
            `FILE: ${toWorkspaceRelative(
              selected.root,
              absoluteFile
            )}`,
            "",
            content.slice(0, maxCharacters),
            truncated
              ? "\n\n[File da duoc rut gon do vuot gioi han.]"
              : "",
          ].join("\n")
        );
      } catch (error) {
        return textResult(`Loi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_read_many_files",
    {
      title: "Read many workspace files",
      description:
        "Read multiple UTF-8 text files from one permitted workspace in one call.",
      inputSchema: {
        workspace: workspaceSchema,
        files: z.array(z.string().min(1)).min(1).max(20),
        maxCharactersPerFile: z
          .number()
          .int()
          .min(1000)
          .max(100000)
          .default(25000),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      workspace,
      files,
      maxCharactersPerFile = 25000,
    }) => {
      const sections = [];

      try {
        const selected = selectWorkspace(workspace, "read");

        for (const file of files) {
          try {
            const absoluteFile = await resolveExistingPath(
              selected.root,
              file
            );
            const stat = await fs.stat(absoluteFile);

            if (!stat.isFile()) {
              throw new Error("Duong dan khong phai file.");
            }

            if (stat.size > 2_000_000) {
              throw new Error("File lon hon gioi han 2 MB.");
            }

            const content = await fs.readFile(
              absoluteFile,
              "utf8"
            );
            const truncated =
              content.length > maxCharactersPerFile;

            sections.push(
              [
                `FILE: ${toWorkspaceRelative(
                  selected.root,
                  absoluteFile
                )}`,
                "",
                content.slice(0, maxCharactersPerFile),
                truncated
                  ? "\n[File da duoc rut gon do vuot gioi han.]"
                  : "",
              ].join("\n")
            );
          } catch (error) {
            sections.push(
              [`FILE: ${file}`, "", `Loi: ${error.message}`].join(
                "\n"
              )
            );
          }
        }

        return textResult(
          [
            `Workspace: ${selected.name}`,
            "",
            sections.join("\n\n---\n\n"),
          ].join("\n")
        );
      } catch (error) {
        return textResult(`Loi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_search_text",
    {
      title: "Search workspace text",
      description:
        "Search source-code text in one permitted workspace.",
      inputSchema: {
        workspace: workspaceSchema,
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
      workspace,
      query,
      directory = ".",
      caseSensitive = false,
    }) => {
      try {
        const selected = selectWorkspace(workspace, "read");
        const absoluteDirectory = await resolveExistingPath(
          selected.root,
          directory
        );
        const stat = await fs.stat(absoluteDirectory);

        if (!stat.isDirectory()) {
          throw new Error("Duong dan tim kiem khong phai thu muc.");
        }

        const files = [];
        await collectTextFiles(absoluteDirectory, files, 1000);

        const expected = caseSensitive
          ? query
          : query.toLowerCase();
        const matches = [];

        for (const absoluteFile of files) {
          if (matches.length >= 100) {
            break;
          }

          const fileStat = await fs.stat(absoluteFile);

          if (fileStat.size > 1_000_000) {
            continue;
          }

          let content;

          try {
            content = await fs.readFile(absoluteFile, "utf8");
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
                `${toWorkspaceRelative(
                  selected.root,
                  absoluteFile
                )}:${index + 1}: ${line.slice(0, 300)}`
              );
            }
          });
        }

        if (matches.length === 0) {
          return textResult(
            `Workspace: ${selected.name}\nKhong tim thay ket qua.`
          );
        }

        return textResult(
          [
            `Workspace: ${selected.name}`,
            "",
            matches.join("\n"),
            "",
            `Tong ket qua: ${matches.length}${
              matches.length >= 100 ? " (da gioi han)" : ""
            }`,
          ].join("\n")
        );
      } catch (error) {
        return textResult(`Loi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_repo_map",
    {
      title: "Summarize workspace repository map",
      description:
        "Summarize source files, extensions, top-level directories, and notable project markers in one permitted workspace.",
      inputSchema: {
        workspace: workspaceSchema,
        directory: z.string().default("."),
        maxFiles: z.number().int().min(20).max(1000).default(250),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      workspace,
      directory = ".",
      maxFiles = 250,
    }) => {
      try {
        const selected = selectWorkspace(workspace, "read");
        const absoluteDirectory = await resolveExistingPath(
          selected.root,
          directory
        );
        const stat = await fs.stat(absoluteDirectory);

        if (!stat.isDirectory()) {
          throw new Error("Duong dan khong phai thu muc.");
        }

        const files = [];
        await collectTextFiles(absoluteDirectory, files, maxFiles);

        const extensions = {};
        const topDirectories = {};
        const notableFiles = [];
        let totalBytes = 0;

        for (const absoluteFile of files) {
          const relative = toWorkspaceRelative(
            selected.root,
            absoluteFile
          );
          const extension =
            path.extname(absoluteFile).toLowerCase() ||
            "(none)";
          const topDirectory = relative.includes("/")
            ? relative.split("/")[0]
            : ".";
          const fileStat = await fs.stat(absoluteFile);

          totalBytes += fileStat.size;
          extensions[extension] =
            (extensions[extension] ?? 0) + 1;
          topDirectories[topDirectory] =
            (topDirectories[topDirectory] ?? 0) + 1;

          if (
            /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|Dockerfile|docker-compose\.ya?ml|README\.md|vite\.config|next\.config|tsconfig\.json)$/i.test(
              relative
            )
          ) {
            notableFiles.push(relative);
          }
        }

        return textResult(
          JSON.stringify(
            {
              workspace: selected.name,
              root: selected.root,
              directory: toWorkspaceRelative(
                selected.root,
                absoluteDirectory
              ),
              scannedTextFiles: files.length,
              maxFiles,
              truncated: files.length >= maxFiles,
              totalTextBytes: totalBytes,
              extensions: sortObjectEntries(extensions),
              topDirectories: sortObjectEntries(topDirectories),
              notableFiles: notableFiles.slice(0, 100),
              sampleFiles: files
                .slice(0, 80)
                .map((file) =>
                  toWorkspaceRelative(selected.root, file)
                ),
            },
            null,
            2
          )
        );
      } catch (error) {
        return textResult(`Loi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_replace_text",
    {
      title: "Replace text in workspace file",
      description:
        "Replace exactly one matching text block in an existing file in the selected workspace.",
      inputSchema: {
        workspace: workspaceSchema,
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
    async ({
      workspace,
      file,
      oldText,
      newText,
    }) => {
      try {
        assertWriteEnabled();

        if (oldText === newText) {
          throw new Error("Noi dung cu va moi giong nhau.");
        }

        const selected = selectWorkspace(workspace, "write");
        const absoluteFile = await resolveExistingPath(
          selected.root,
          file
        );
        const stat = await fs.stat(absoluteFile);

        if (!stat.isFile()) {
          throw new Error("Duong dan khong phai file.");
        }

        if (stat.size > 2_000_000) {
          throw new Error("File lon hon gioi han 2 MB.");
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
            "Khong tim thay chinh xac doan oldText trong file."
          );
        }

        if (count > 1) {
          throw new Error(
            "Doan oldText xuat hien nhieu hon mot lan. Can cung cap doan cu the hon."
          );
        }

        const updatedContent = content.replace(
          oldText,
          newText
        );
        await fs.writeFile(
          absoluteFile,
          updatedContent,
          "utf8"
        );

        return textResult(
          `Da cap nhat [${selected.name}]: ${toWorkspaceRelative(
            selected.root,
            absoluteFile
          )}`
        );
      } catch (error) {
        return textResult(`Loi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_write_file",
    {
      title: "Write workspace file",
      description:
        "Create or overwrite a UTF-8 file in the selected workspace. Parent directory must already exist.",
      inputSchema: {
        workspace: workspaceSchema,
        file: z.string().min(1),
        content: z.string().max(1000000),
        overwrite: z.boolean().default(true),
        expectedCurrentContent: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async ({
      workspace,
      file,
      content,
      overwrite = true,
      expectedCurrentContent,
    }) => {
      try {
        assertWriteEnabled();

        const selected = selectWorkspace(workspace, "write");
        let absoluteFile;
        let previousContent = "";
        let existed = false;

        try {
          absoluteFile = await resolveExistingPath(
            selected.root,
            file
          );
          const stat = await fs.stat(absoluteFile);

          if (!stat.isFile()) {
            throw new Error("Duong dan khong phai file.");
          }

          if (!overwrite) {
            throw new Error(
              "File da ton tai va overwrite=false."
            );
          }

          if (stat.size > 2_000_000) {
            throw new Error("File lon hon gioi han 2 MB.");
          }

          previousContent = await fs.readFile(
            absoluteFile,
            "utf8"
          );
          existed = true;
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }

          absoluteFile = await resolveWritableFile(
            selected.root,
            file
          );
        }

        if (
          expectedCurrentContent !== undefined &&
          previousContent !== expectedCurrentContent
        ) {
          throw new Error(
            "Noi dung hien tai khong khop expectedCurrentContent."
          );
        }

        await fs.writeFile(absoluteFile, content, "utf8");

        return textResult(
          [
            `Da ghi [${selected.name}]: ${toWorkspaceRelative(
              selected.root,
              absoluteFile
            )}`,
            `Existed: ${existed}`,
            JSON.stringify(
              contentSummary(previousContent, content),
              null,
              2
            ),
          ].join("\n")
        );
      } catch (error) {
        return textResult(`Loi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_delete_file",
    {
      title: "Delete workspace file",
      description:
        "Delete one existing file in the selected workspace. Directories are not deleted.",
      inputSchema: {
        workspace: workspaceSchema,
        file: z.string().min(1),
        confirm: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async ({
      workspace,
      file,
      confirm = false,
    }) => {
      try {
        assertWriteEnabled();

        if (!confirm) {
          throw new Error(
            "Can truyen confirm=true de xoa file."
          );
        }

        const selected = selectWorkspace(workspace, "write");
        const absoluteFile = await resolveExistingPath(
          selected.root,
          file
        );
        const stat = await fs.stat(absoluteFile);

        if (!stat.isFile()) {
          throw new Error("Chi duoc xoa file, khong xoa thu muc.");
        }

        await fs.unlink(absoluteFile);

        return textResult(
          `Da xoa [${selected.name}]: ${toWorkspaceRelative(
            selected.root,
            absoluteFile
          )}`
        );
      } catch (error) {
        return textResult(`Loi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_move_file",
    {
      title: "Move workspace file",
      description:
        "Move or rename one file inside the selected workspace. Parent destination directory must already exist.",
      inputSchema: {
        workspace: workspaceSchema,
        source: z.string().min(1),
        destination: z.string().min(1),
        overwrite: z.boolean().default(false),
        confirm: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async ({
      workspace,
      source,
      destination,
      overwrite = false,
      confirm = false,
    }) => {
      try {
        assertWriteEnabled();

        if (!confirm) {
          throw new Error(
            "Can truyen confirm=true de move/rename file."
          );
        }

        if (source === destination) {
          throw new Error("Source va destination giong nhau.");
        }

        const selected = selectWorkspace(workspace, "write");
        const absoluteSource = await resolveExistingPath(
          selected.root,
          source
        );
        const sourceStat = await fs.stat(absoluteSource);

        if (!sourceStat.isFile()) {
          throw new Error("Chi duoc move file, khong move thu muc.");
        }

        const absoluteDestination = await resolveWritableFile(
          selected.root,
          destination
        );

        if (await pathExists(absoluteDestination)) {
          const destinationStat = await fs.stat(
            absoluteDestination
          );

          if (!destinationStat.isFile()) {
            throw new Error(
              "Destination ton tai nhung khong phai file."
            );
          }

          if (!overwrite) {
            throw new Error(
              "Destination da ton tai. Truyen overwrite=true neu muon ghi de."
            );
          }

          await fs.unlink(absoluteDestination);
        }

        await fs.rename(absoluteSource, absoluteDestination);

        return textResult(
          [
            `Da move [${selected.name}]`,
            `From: ${toWorkspaceRelative(
              selected.root,
              absoluteSource
            )}`,
            `To: ${toWorkspaceRelative(
              selected.root,
              absoluteDestination
            )}`,
          ].join("\n")
        );
      } catch (error) {
        return textResult(`Loi: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "workspace_create_file",
    {
      title: "Create workspace file",
      description:
        "Create a new file in the selected workspace. Existing files are never overwritten.",
      inputSchema: {
        workspace: workspaceSchema,
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
    async ({
      workspace,
      file,
      content,
    }) => {
      try {
        assertWriteEnabled();

        const selected = selectWorkspace(workspace, "write");
        const absoluteFile = await resolveWritableFile(
          selected.root,
          file
        );

        await fs.writeFile(absoluteFile, content, {
          encoding: "utf8",
          flag: "wx",
        });

        return textResult(
          `Da tao [${selected.name}]: ${toWorkspaceRelative(
            selected.root,
            absoluteFile
          )}`
        );
      } catch (error) {
        if (error.code === "EEXIST") {
          return textResult(
            "Loi: File da ton tai. Tool nay khong duoc phep ghi de."
          );
        }

        return textResult(`Loi: ${error.message}`);
      }
    }
  );
}
