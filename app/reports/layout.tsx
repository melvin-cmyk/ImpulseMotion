import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div className="p-6 text-sm text-gray-500">Chargement…</div>}>{children}</Suspense>;
}
