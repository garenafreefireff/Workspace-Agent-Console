import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WorkspaceRegistry,
  assertWorkspacePermission,
} from "../src/services/workspaceRegistry.js";

test("workspace registry supports live CRUD with read-only defaults", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "workspace-registry-")
  );
  const firstRoot = path.join(directory, "first");
  const secondRoot = path.join(directory, "second");
  const configFile = path.join(directory, "workspaces.json");

  try {
    await fs.mkdir(firstRoot);
    await fs.mkdir(secondRoot);
    await fs.writeFile(
      path.join(secondRoot, "package.json"),
      "{}",
      "utf8"
    );
    await fs.writeFile(
      configFile,
      JSON.stringify(
        {
          defaultWorkspace: "first",
          workspaces: {
            first: {
              id: "first",
              name: "First",
              root: firstRoot,
              enabled: true,
              permissions: {
                read: true,
                write: true,
                git: true,
                commit: true,
                execute: true,
              },
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const registry = new WorkspaceRegistry({ configFile });
    const added = await registry.add({
      id: "second",
      name: "Second",
      root: secondRoot,
    });

    assert.equal(added.workspace.root, await fs.realpath(secondRoot));
    assert.deepEqual(added.workspace.permissions, {
      read: true,
      write: false,
      git: true,
      commit: false,
      execute: false,
    });
    assert.deepEqual(added.inspection.markers, ["package.json"]);

    const readOnlyWorkspace = registry.get("second");
    assert.doesNotThrow(() =>
      assertWorkspacePermission(readOnlyWorkspace, "read")
    );
    assert.throws(
      () => assertWorkspacePermission(readOnlyWorkspace, "write"),
      /khong co quyen write/
    );

    await registry.setDefault("second");
    assert.equal(registry.getDefaultWorkspaceName(), "second");

    await registry.update("second", {
      name: "Second Updated",
      root: firstRoot,
    });
    assert.equal(registry.get("second").name, "Second Updated");
    assert.equal(registry.get("second").root, await fs.realpath(firstRoot));

    await registry.remove("first");
    assert.deepEqual(
      registry.list().map((workspace) => workspace.id),
      ["second"]
    );

    const persisted = JSON.parse(
      await fs.readFile(configFile, "utf8")
    );
    assert.equal(persisted.defaultWorkspace, "second");
    assert.equal(
      persisted.workspaces.second.permissions.write,
      false
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
