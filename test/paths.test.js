import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertInsideWorkspace,
  resolveExistingPath,
  resolveWritableFile,
  resolveWorkspacePath,
} from "../src/utils/paths.js";

test("resolveWorkspacePath rejects absolute and parent escapes", () => {
  const root = path.join(os.tmpdir(), "local-agent-root");

  assert.throws(
    () => resolveWorkspacePath(root, path.resolve(root, "file.txt")),
    /tuong doi/
  );

  assert.throws(
    () => resolveWorkspacePath(root, "../outside.txt"),
    /ngoai workspace/
  );
});

test("assertInsideWorkspace accepts root and nested paths", () => {
  const root = path.join(os.tmpdir(), "local-agent-root");

  assert.equal(assertInsideWorkspace(root, root), path.resolve(root));
  assert.equal(
    assertInsideWorkspace(root, path.join(root, "src", "index.js")),
    path.resolve(root, "src", "index.js")
  );
});

test("resolveExistingPath checks real paths stay inside workspace", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "local-agent-paths-")
  );

  try {
    await fs.writeFile(path.join(root, "inside.txt"), "ok", "utf8");

    assert.equal(
      await resolveExistingPath(root, "inside.txt"),
      path.join(root, "inside.txt")
    );

    await assert.rejects(
      () => resolveExistingPath(root, "missing.txt"),
      /ENOENT/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resolveWritableFile requires an existing safe parent", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "local-agent-write-")
  );

  try {
    await fs.mkdir(path.join(root, "src"));

    assert.equal(
      await resolveWritableFile(root, "src/new.txt"),
      path.join(root, "src", "new.txt")
    );

    await assert.rejects(
      () => resolveWritableFile(root, "missing/new.txt"),
      /ENOENT/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
