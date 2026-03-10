import { auth } from "@/auth";
import { getAdAccounts } from "@/lib/meta-api";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();

  if (!session || !session.metaAccessToken) {
    return NextResponse.json({ error: "Not authenticated with Meta" }, { status: 401 });
  }

  try {
    const accounts = await getAdAccounts(session.metaAccessToken as string);
    return NextResponse.json(accounts);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
