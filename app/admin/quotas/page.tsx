import { PageHeader } from "@/components/ui/surface";
import { QuotasPanel } from "@/components/admin/quotas-panel";

/** Admin → Quotas: daily caps of the AI generation and of the client bots (lib/quotas.ts). */
export default function AdminQuotasPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Quotas" subtitle="Plafonds journaliers de la génération d'images et de vidéos (Studio, Créas) et des bots clients. Le prix est rappelé avant chaque génération." />
      <QuotasPanel />
    </div>
  );
}
