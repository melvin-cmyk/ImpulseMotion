import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default function DeckLayout({ children }: { children: React.ReactNode }) {
  return <Suspense>{children}</Suspense>;
}
