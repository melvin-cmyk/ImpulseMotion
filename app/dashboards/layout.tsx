import { redirect } from "next/navigation";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

// proxy.ts sends clients back to /d (/dashboards is not in their allowed prefixes). Checked again here,
// on the server, before anything is rendered: « Mes dashboards » is the staff's own space.
export default async function StaffDashboardsLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.userId) redirect("/login");
  if (session.role === "client") redirect("/d");
  return <>{children}</>;
}
