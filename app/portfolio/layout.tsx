import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

export default async function PortfolioLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.userId) redirect("/login?callbackUrl=/portfolio");
  if (session.role !== "admin" && session.role !== "consultant") redirect("/");
  return <Suspense fallback={<div className="p-6 text-sm text-gray-500">Chargement…</div>}>{children}</Suspense>;
}
