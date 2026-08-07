import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { inspectLocalWorkspaceRoot } from "../../../../lib/localWorkspace.js";

const execFile = promisify(execFileCallback);
const pickerScript = fileURLToPath(
  new URL("../../../../lib/modernFolderPicker.ps1", import.meta.url)
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function openWindowsFolderPicker() {
  if (process.platform !== "win32") {
    throw new Error(
      "Choose folder hien chi ho tro khi GUI dang chay tren Windows."
    );
  }

  const { stdout = "", stderr = "" } = await execFile(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      pickerScript,
    ],
    {
      windowsHide: false,
      timeout: 300000,
      maxBuffer: 100000,
      encoding: "utf8",
    }
  );

  const selectedPath = stdout.replace(/^\uFEFF/, "").trim();

  if (!selectedPath && stderr.trim()) {
    throw new Error(stderr.trim());
  }

  return selectedPath;
}

export async function POST() {
  try {
    const selectedPath = await openWindowsFolderPicker();

    if (!selectedPath) {
      return NextResponse.json(
        { ok: true, selection: { cancelled: true } },
        { headers: { "cache-control": "no-store" } }
      );
    }

    const inspection = await inspectLocalWorkspaceRoot(selectedPath);

    return NextResponse.json(
      {
        ok: true,
        selection: {
          cancelled: false,
          ...inspection,
        },
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      {
        status: 400,
        headers: { "cache-control": "no-store" },
      }
    );
  }
}
