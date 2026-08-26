import { redirect } from "next/navigation";
import { auth } from "@/auth";

export default async function PortfolioLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.userId) redirect("/login?callbackUrl=/portfolio");
  if (session.role !== "admin" && session.role !== "consultant") redirect("/");
  return <>{children}</>;
}
