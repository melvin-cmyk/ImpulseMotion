import { Suspense } from "react";
import { StudioPage } from "@/components/studio/studio-page";

export const metadata = { title: "Studio créa · ImpulseMotion" };

export default function Page() {
  return <Suspense fallback={null}><StudioPage /></Suspense>;
}
