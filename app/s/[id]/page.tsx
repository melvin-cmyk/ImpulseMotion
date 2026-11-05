/**
 * /s/[id] — public snapshot of an Analyse Ads report (Motion's « Snapshot »):
 * read-only, numbers frozen when the link was created, no account needed.
 */

import type { Metadata } from "next";
import { getSnapshot } from "@/lib/ads-warehouse/snapshots";
import { SnapshotView } from "@/components/analyse-v2/snapshot-view";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const s = await getSnapshot(id);
  return { title: s ? `${s.title}${s.clientName ? ` · ${s.clientName}` : ""} — ImpulseMotion` : "Lien indisponible — ImpulseMotion", robots: { index: false, follow: false } };
}

export default async function SnapshotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSnapshot(id, true);
  if (!s) {
    return (
      <div className="min-h-screen bg-ui-bg text-ui-fg flex items-center justify-center p-6">
        <div className="text-center max-w-sm">
          <div className="text-lg font-medium text-ui-fg">Lien indisponible</div>
          <p className="mt-1 text-sm text-ui-fg2">Ce rapport partagé a été révoqué ou n&apos;existe pas. Demande un nouveau lien à ton consultant.</p>
        </div>
      </div>
    );
  }
  return <SnapshotView title={s.title} emoji={s.emoji} description={s.description} clientName={s.clientName} createdAt={s.createdAt.toISOString()} createdByName={s.createdByName} payload={s.payload} />;
}
