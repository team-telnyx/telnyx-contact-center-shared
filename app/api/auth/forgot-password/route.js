import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";

export async function POST(request) {
  try {
    const { email } = await request.json();
    if (!email)
      return NextResponse.json({ error: "Missing email" }, { status: 400 });
    await PgDb.findUserByUsername(email);
    // No-op for security: always respond OK
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to request reset" },
      { status: 500 }
    );
  }
}
