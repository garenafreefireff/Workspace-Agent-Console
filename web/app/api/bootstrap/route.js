import { NextResponse } from "next/server";
import { getBootstrapData } from "../../../lib/backend.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getBootstrapData();

    return NextResponse.json(
      { ok: true, ...data },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
      },
      {
        status: 502,
        headers: { "cache-control": "no-store" },
      }
    );
  }
}
