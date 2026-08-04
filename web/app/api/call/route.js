import { NextResponse } from "next/server";
import { callBackendTool, extractText } from "../../../lib/backend.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const body = await request.json().catch(() => null);

  if (!body || typeof body.tool !== "string") {
    return NextResponse.json(
      { ok: false, error: "Invalid request body." },
      { status: 400 }
    );
  }

  try {
    const result = await callBackendTool(body.tool, body.args ?? {});

    return NextResponse.json(
      {
        ok: true,
        tool: body.tool,
        result,
        text: extractText(result),
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      {
        status: 502,
        headers: { "cache-control": "no-store" },
      }
    );
  }
}
