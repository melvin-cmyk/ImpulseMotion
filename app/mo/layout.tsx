import { redirect } from "next/navigation";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

/** Mo is staff only (admin, consultant): clients are sent back to their space. */
export default async function MoLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.userId) redirect("/login?callbackUrl=/mo");
  if (session.role !== "admin" && session.role !== "consultant") redirect("/");
  // Mo stays on the night whatever the day / night choice (Melvin, 2026-11-05):
  // the interface tokens of the subtree follow data-theme.
  return <div data-theme="dark" className="contents">{children}</div>;
}
