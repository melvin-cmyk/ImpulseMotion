import { NextResponse } from "next/server";
import { auth } from "@/auth";

export async function requireSession() {
  const session = await auth();
  if (!session?.userId) {
    return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) } as const;
  }
  return { session } as const;
}

/** Staff = admin or consultant. Consultants have every staff capability except
 *  user & ACL management, which stays admin-only (requireAdmin). */
export async function requireStaff() {
  const session = await auth();
  if (!session?.userId) {
    return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) } as const;
  }
  if (session.role !== "admin" && session.role !== "consultant") {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as const;
  }
  return { session } as const;
}

/** True for admin or consultant sessions (same scope as requireStaff). */
export function isStaff(session: { role?: string | null } | null | undefined): boolean {
  return session?.role === "admin" || session?.role === "consultant";
}

export async function requireAdmin() {
  const session = await auth();
  if (!session?.userId) {
    return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) } as const;
  }
  if (session.role !== "admin") {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as const;
  }
  return { session } as const;
}
