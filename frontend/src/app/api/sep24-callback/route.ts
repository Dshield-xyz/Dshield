import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
export async function POST(request: NextRequest) {
  const secret = process.env.SEP24_CALLBACK_SECRET;
  const provided = request.headers.get("x-sep24-callback-secret") ?? "";
  const a = Buffer.from(provided), b = Buffer.from(secret ?? "");
  if (!secret) return NextResponse.json({ error: "SEP-24 callbacks are not configured." }, { status: 503 });
  if (a.length !== b.length || !timingSafeEqual(a, b)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const payload = await request.json().catch(() => null) as { id?: unknown; status?: unknown } | null;
  if (!payload || typeof payload.id !== "string" || typeof payload.status !== "string") return NextResponse.json({ error: "Invalid callback payload." }, { status: 400 });
  return NextResponse.json({ received: true });
}
