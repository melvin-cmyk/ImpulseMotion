import { redirect } from "next/navigation";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

// Staff only: proxy.ts keeps clients on their dashboards, checked again here before anything is rendered.
// Every request of the page is guarded again by the API (app/api/pilot).
export default async function PilotLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.userId) redirect("/login");
  if (session.role !== "admin" && session.role !== "consultant") redirect("/d");
  return <>{children}</>;
}
