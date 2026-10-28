import { redirect } from "next/navigation";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

/** Mo is staff only (admin, consultant): clients are sent back to their space. */
export default async function MoLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.userId) redirect("/login?callbackUrl=/mo");
  if (session.role !== "admin" && session.role !== "consultant") redirect("/");
  return <>{children}</>;
}
