"use client";

/**
 * « Commentaires » tab of a creative's sheet (Motion shows the comments of an
 * ad): what people write under the creative's Meta ads, most liked first,
 * spam and tags-only comments dropped. Readable only for the Pages assigned
 * to our system user.
 */

import { useEffect, useState } from "react";
import { Heart, Loader2, MessageCircle } from "lucide-react";
import type { AdComment } from "@/lib/meta-comments";

interface Res { open: boolean; comments: AdComment[]; errors: number; error?: string }

export function CommentsPane({ adIds }: { adIds: string[] }) {
  const key = adIds.slice(0, 20).join(",");
  const [res, setRes] = useState<Res | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    queueMicrotask(() => setRes(null));
    fetch(`/api/ads/comments?adIds=${encodeURIComponent(key)}`)
      .then(async (r) => ({ ...(await r.json().catch(() => ({}))), ...(r.ok ? {} : { error: `Erreur ${r.status}` }) }) as Res)
      .then((j) => { if (live) setRes(j); })
      .catch(() => { if (live) setRes({ open: true, comments: [], errors: 0, error: "Lecture impossible" }); });
    return () => { live = false; };
  }, [key]);

  if (!res) return <div className="py-16 flex items-center justify-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Lecture des commentaires…</div>;
  if (res.error) return <div className="py-16 text-center text-sm text-red-300">{res.error}</div>;
  if (!res.open) return <div className="py-16 text-center text-sm text-gray-400">La lecture des commentaires Meta n&apos;est pas activée.</div>;
  const shown = all ? res.comments : res.comments.slice(0, 30);
  return (
    <div className="space-y-3">
      {res.errors > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {res.errors} annonce{res.errors > 1 ? "s" : ""} non lisible{res.errors > 1 ? "s" : ""} : la Page du client n&apos;est pas attribuée à l&apos;utilisateur système (Business Settings → Utilisateurs système → Ajouter des ressources → Pages).
        </div>
      )}
      {!res.comments.length ? (
        <div className="py-12 text-center text-sm text-gray-400">{res.errors ? "Aucun commentaire lisible." : "Aucun commentaire utile sous cette créa."}</div>
      ) : (
        <>
          <div className="text-xs text-gray-500 flex items-center gap-1.5"><MessageCircle className="w-3.5 h-3.5" /> {res.comments.length} commentaire{res.comments.length > 1 ? "s" : ""}, les plus aimés d&apos;abord (spam et simples mentions retirés)</div>
          <ul className="space-y-2">
            {shown.map((c, i) => (
              <li key={`${c.adId}-${i}`} className="rounded-xl border border-gray-800 bg-gray-900 px-3 py-2">
                <p className="text-sm text-gray-100 whitespace-pre-wrap break-words">{c.text}</p>
                <div className="mt-1 flex items-center gap-3 text-[11px] text-gray-500">
                  {c.likes > 0 && <span className="inline-flex items-center gap-1"><Heart className="w-3 h-3" /> {c.likes}</span>}
                  {c.at && <span>{new Date(c.at).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}</span>}
                </div>
              </li>
            ))}
          </ul>
          {res.comments.length > 30 && <button type="button" onClick={() => setAll((x) => !x)} className="text-xs text-gray-400 hover:text-white">{all ? "Réduire" : `Voir les ${res.comments.length} commentaires`}</button>}
        </>
      )}
    </div>
  );
}
