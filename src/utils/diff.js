import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "./command.js";

export function validateUnifiedDiff(patch) {
  if (!patch.trim()) {
    throw new Error("Patch dang trong.");
  }

  if (Buffer.byteLength(patch, "utf8") > 300_000) {
    throw new Error("Patch vuot gioi han 300 KB.");
  }

  if (!patch.includes("diff --git ")) {
    throw new Error("Chi chap nhan unified diff dinh dang Git.");
  }

  const forbiddenPatterns = [
    {
      pattern: /^deleted file mode /m,
      message: "Patch xoa file chua duoc phep.",
    },
    {
      pattern: /^rename from /m,
      message: "Patch doi ten file chua duoc phep.",
    },
    {
      pattern: /^rename to /m,
      message: "Patch doi ten file chua duoc phep.",
    },
    {
      pattern: /^GIT binary patch$/m,
      message: "Binary patch chua duoc phep.",
    },
    {
      pattern: /^\+\+\+ \/dev\/null$/m,
      message: "Patch xoa file chua duoc phep.",
    },
    {
      pattern: /^new file mode 120000$/m,
      message: "Patch tao symlink chua duoc phep.",
    },
  ];

  for (const rule of forbiddenPatterns) {
    if (rule.pattern.test(patch)) {
      throw new Error(rule.message);
    }
  }

  const headerLines = patch
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.startsWith("diff --git ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
    );

  for (const line of headerLines) {
    const normalized = line.replaceAll("\\", "/");

    if (
      normalized.includes("../") ||
      normalized.includes("/.git/") ||
      normalized.includes(" a/.git") ||
      normalized.includes(" b/.git") ||
      /[A-Za-z]:\//.test(normalized) ||
      normalized.includes("//")
    ) {
      throw new Error(
        `Patch chua duong dan khong an toan: ${line}`
      );
    }
  }
}

export async function applyUnifiedDiff(root, patch) {
  validateUnifiedDiff(patch);

  const temporaryPatch = path.join(
    os.tmpdir(),
    `local-workspace-${randomUUID()}.patch`
  );

  await fs.writeFile(temporaryPatch, patch, "utf8");

  try {
    await execFile(
      "git",
      [
        "-C",
        root,
        "apply",
        "--check",
        "--whitespace=nowarn",
        temporaryPatch,
      ],
      {
        cwd: root,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 2_000_000,
      }
    );

    await execFile(
      "git",
      [
        "-C",
        root,
        "apply",
        "--whitespace=nowarn",
        temporaryPatch,
      ],
      {
        cwd: root,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 2_000_000,
      }
    );
  } finally {
    await fs.unlink(temporaryPatch).catch(() => {});
  }
}
