import { redirect } from "next/navigation";

// The Studio créa is merged into the Créas (per client): its generator is the « Générer » tab.
// /studio?client=<AlertClient id> keeps its client.
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const client = typeof sp.client === "string" ? sp.client : null;
  const q = new URLSearchParams({ tab: "generer" });
  if (client) q.set("client", client);
  redirect(`/creas?${q.toString()}`);
}
