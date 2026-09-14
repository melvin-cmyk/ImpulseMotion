/**
 * Shared layout of the Analyse Ads section (route group — URLs unchanged).
 * Renders the context bar once, above every Analyse Ads page: the analysed
 * account (the only section where that selection applies), provenance
 * (Démo / Meta · données au HH:MM · …) and the refresh button.
 */

import { AnalyseContextBar } from "@/components/analyse/context-bar";

export default function AnalyseLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AnalyseContextBar />
      {children}
    </>
  );
}
