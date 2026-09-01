/**
 * Shared layout of the Analyse Ads section (route group — URLs unchanged).
 * Renders the provenance banner (Démo / Meta · données au HH:MM · …) once,
 * above every Analyse Ads page.
 */

import { DataBanner } from "@/components/creatives/data-banner";

export default function AnalyseLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <DataBanner />
      {children}
    </>
  );
}
