import { Suspense } from "react";

export const dynamic = "force-dynamic";

// Staff only: proxy.ts sends clients back to /d (/routines is not in their allowed prefixes).
export default function RoutinesLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div className="p-6 text-sm text-gray-500">Chargement…</div>}>{children}</Suspense>;
}
