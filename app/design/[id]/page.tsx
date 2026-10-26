import { DesignPage } from "@/components/design/design-page";

export const metadata = { title: "Design · ImpulseMotion" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DesignPage id={id} />;
}
