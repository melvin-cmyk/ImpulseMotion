import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { hasRoutinesAccess } from "@/lib/routines/access-rule";

export const dynamic = "force-dynamic";

// proxy.ts sends clients back to /d (/routines is not in their allowed prefixes) and the staff without the
// access (ROUTINES_ACCESS) back to the home page. Checked again here, on the server, before anything is rendered.
export default async function RoutinesLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.userId) redirect("/login");
  if (!hasRoutinesAccess(session)) redirect(session.role === "client" ? "/d" : "/");
  return <Suspense fallback={<div className="p-6 text-sm text-gray-500">Chargement…</div>}>{children}</Suspense>;
}
