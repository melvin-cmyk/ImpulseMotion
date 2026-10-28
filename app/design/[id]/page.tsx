import { DesignPage } from "@/components/design/design-page";

export const metadata = { title: "Design · ImpulseMotion" };

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ask?: string }> }) {
  const { id } = await params;
  // ?ask= : a first message for the copilot, sent on arrival (a template opened from Créas).
  const { ask } = await searchParams;
  return <DesignPage id={id} ask={typeof ask === "string" ? ask.slice(0, 4000) : undefined} />;
}
