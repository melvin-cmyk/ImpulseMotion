import { redirect } from "next/navigation";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

// Staff only: checked again by every route of /api/studio.
export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.userId) redirect("/login");
  if (session.role !== "admin" && session.role !== "consultant") redirect("/d");
  return <>{children}</>;
}
