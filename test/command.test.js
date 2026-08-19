import assert from "node:assert/strict";
import test from "node:test";
import { resolvePortableInvocation } from "../src/utils/command.js";

test("Windows batch commands are routed through cmd.exe", () => {
  const invocation = resolvePortableInvocation(
    "npm.cmd",
    ["run", "build"],
    {
      platform: "win32",
      commandProcessor: "C:\\Windows\\System32\\cmd.exe",
    }
  );

  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args, [
    "/d",
    "/s",
    "/c",
    "npm.cmd run build",
  ]);
});

test("Windows batch command tokens reject shell metacharacters", () => {
  assert.throws(
    () =>
      resolvePortableInvocation("npm.cmd", ["run", "build&whoami"], {
        platform: "win32",
        commandProcessor: "cmd.exe",
      }),
    /khong an toan/
  );
});

test("Normal executables stay on direct execFile path", () => {
  const invocation = resolvePortableInvocation(
    "python",
    ["-m", "pytest"],
    { platform: "win32", commandProcessor: "cmd.exe" }
  );

  assert.deepEqual(invocation, {
    command: "python",
    args: ["-m", "pytest"],
  });
});
