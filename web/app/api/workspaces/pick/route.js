import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { inspectLocalWorkspaceRoot } from "../../../../lib/localWorkspace.js";

const execFile = promisify(execFileCallback);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function openWindowsFolderPicker() {
  if (process.platform !== "win32") {
    throw new Error(
      "Choose folder hien chi ho tro khi GUI dang chay tren Windows."
    );
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
    "$owner.Size = [System.Drawing.Size]::new(1, 1)",
    "$owner.Opacity = 0.01",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Chon thu muc workspace'",
    "$dialog.ShowNewFolderButton = $false",
    "try {",
    "  $owner.Show()",
    "  $owner.Activate()",
    "  $result = $dialog.ShowDialog($owner)",
    "  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
    "    Write-Output $dialog.SelectedPath",
    "  }",
    "} finally {",
    "  $dialog.Dispose()",
    "  $owner.Close()",
    "  $owner.Dispose()",
    "}",
  ].join("\n");

  const { stdout = "", stderr = "" } = await execFile(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
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
