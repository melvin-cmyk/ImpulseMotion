/**
 * /mo — Mo, the voice assistant of the staff: full-screen board of floating
 * cards, push-to-talk microphone, spoken answers. Deep link: /mo?b=<boardId>.
 */
import { Suspense } from "react";
import { MoPage } from "@/components/mo/mo-page";

export default function Page() {
  return <Suspense fallback={null}><MoPage /></Suspense>;
}
