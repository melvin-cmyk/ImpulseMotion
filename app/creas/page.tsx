/**
 * /creas — Créas par client (staff): generated visuals with the consultant's
 * verdict, swipe file of templates (competitors, winners), brand assets.
 * Deep links: ?client=<id>&tab=templates&template=<id> · ?asset=<id>.
 */
import { Suspense } from "react";
import { CreasPage } from "@/components/creas/creas-page";

export const metadata = { title: "Créas · ImpulseMotion" };

export default function Page() {
  return <Suspense fallback={null}><CreasPage /></Suspense>;
}
