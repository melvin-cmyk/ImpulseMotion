"use client";

/**
 * Le cadre isolé d'un dashboard du staff : un <iframe sandbox="allow-scripts" srcdoc>
 * construit par lib/staff-dashboards/frame (thème, d3, runtime public/dash-runtime.js,
 * la page, puis le démarrage). La page ne touche jamais au réseau : c'est ce
 * composant qui lit les données par POST /api/staff-dashboards/[id]/data et les
 * renvoie au cadre par postMessage.
 *
 * Protocole (voir l'en-tête de public/dash-runtime.js) :
 *   iframe → parent  dash:ready {datasets}   → lecture des jeux nommés, puis dash:data
 *                    dash:refresh {ids|null}  → relecture (refresh: true), puis dash:data
 *                    dash:params {params}     → mémorisés, relecture de tout, puis dash:data
 *                    dash:height {height}     → hauteur du cadre
 *                    dash:sources {sources}   → remontées au parent (panneau Sources)
 *                    dash:link {hash}         → ignoré
 *   parent → iframe  dash:data {results, params}
 */

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import { buildFrameDocument } from "@/lib/staff-dashboards/frame";
import type { FrameCatalog } from "@/lib/staff-dashboards/catalog-types";
import type { DataResponse, Dataset, FrameSource, ParamValue } from "./model";
import { apiErrorText } from "./model";

export interface DashFrameHandle {
  /** Relit des jeux (tous si `ids` est omis) en forçant le relay, puis les renvoie au cadre. */
  refresh: (ids?: string[]) => Promise<void>;
}

interface Props {
  dashboardId: string;
  title: string;
  html: string;
  datasets: Record<string, Dataset>;
  params: Record<string, ParamValue>;
  onSources?: (sources: FrameSource[]) => void;
  onParams?: (params: Record<string, ParamValue>) => void;
  ref?: React.Ref<DashFrameHandle>;
}

const MIN_HEIGHT = 400;

let catalogCache: FrameCatalog | null = null;
let catalogPromise: Promise<FrameCatalog> | null = null;
const EMPTY_CATALOG: FrameCatalog = { metrics: [], dimensions: [] };
function fetchFrameCatalog(): Promise<FrameCatalog> {
  if (catalogCache) return Promise.resolve(catalogCache);
  if (!catalogPromise) {
    catalogPromise = fetch("/api/staff-dashboards/catalog", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return EMPTY_CATALOG;
        const json = (await res.json()) as { metrics?: unknown; dimensions?: unknown };
        return { metrics: Array.isArray(json.metrics) ? json.metrics : [], dimensions: Array.isArray(json.dimensions) ? json.dimensions : [] } as FrameCatalog;
      })
      .catch(() => EMPTY_CATALOG)
      .then((c) => { catalogCache = c; return c; });
  }
  return catalogPromise;
}
/** Forgets the cached catalogue (the catalogue page calls it after a change). */
export function invalidateFrameCatalog() { catalogCache = null; catalogPromise = null; }
function useFrameCatalog(): FrameCatalog | null {
  const [catalog, setCatalog] = useState<FrameCatalog | null>(catalogCache);
  useEffect(() => {
    let cancelled = false;
    void fetchFrameCatalog().then((c) => { if (!cancelled) setCatalog(c); });
    return () => { cancelled = true; };
  }, []);
  return catalog;
}

const noop = () => () => {};
const readOrigin = () => window.location.origin;
const serverOrigin = () => "";

export function DashFrame({ dashboardId, title, html, datasets, params, onSources, onParams, ref }: Props) {
  // L'origine vient du navigateur : vide au rendu serveur, le cadre n'est alors pas rendu.
  const origin = useSyncExternalStore(noop, readOrigin, serverOrigin);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const allIds = useMemo(() => Object.keys(datasets), [datasets]);
  const allIdsRef = useRef(allIds);
  allIdsRef.current = allIds;
  const currentParams = useRef<Record<string, ParamValue>>(params);
  const onSourcesRef = useRef(onSources);
  onSourcesRef.current = onSources;
  const onParamsRef = useRef(onParams);
  onParamsRef.current = onParams;

  // The team's catalogue (metrics, dimensions) the page may use through dash.metric / dash.dimension.
  const catalog = useFrameCatalog();
  const srcDoc = useMemo(() => (origin && catalog ? buildFrameDocument(html, allIds, params, origin, catalog) : ""), [origin, html, allIds, params, catalog]);

  /** Lit des jeux puis renvoie dash:data au cadre. Une requête échouée est affichée, le cadre garde l'état précédent. */
  const fetchData = useCallback(async (ids: string[] | null, opts: { refresh?: boolean; params?: Record<string, ParamValue> } = {}) => {
    const body: { ids?: string[]; refresh?: boolean; params?: Record<string, ParamValue> } = {};
    if (ids) body.ids = ids;
    if (opts.refresh) body.refresh = true;
    if (opts.params) body.params = opts.params;
    setPending((n) => n + 1);
    try {
      const res = await fetch(`/api/staff-dashboards/${encodeURIComponent(dashboardId)}/data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as DataResponse | null;
      if (!res.ok || !json || typeof json !== "object" || !json.results) {
        throw new Error(`${res.status} — ${apiErrorText(json, res.status)}`);
      }
      if (json.params && typeof json.params === "object") currentParams.current = json.params;
      iframeRef.current?.contentWindow?.postMessage({ type: "dash:data", results: json.results, params: json.params }, "*");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending((n) => Math.max(0, n - 1));
    }
  }, [dashboardId]);

  useImperativeHandle(ref, () => ({
    refresh: (ids?: string[]) => fetchData(ids && ids.length ? ids : allIdsRef.current, { refresh: true, params: currentParams.current }),
  }), [fetchData]);

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (!iframeRef.current || ev.source !== iframeRef.current.contentWindow) return;
      const msg = ev.data as { type?: unknown } | null;
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
      switch (msg.type) {
        case "dash:ready": {
          const ds = (msg as { datasets?: unknown }).datasets;
          const ids = Array.isArray(ds) ? ds.filter((x): x is string => typeof x === "string") : allIdsRef.current;
          void fetchData(ids.length ? ids : allIdsRef.current, { params: currentParams.current });
          break;
        }
        case "dash:refresh": {
          const raw = (msg as { ids?: unknown }).ids;
          const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : null;
          void fetchData(ids && ids.length ? ids : allIdsRef.current, { refresh: true, params: currentParams.current });
          break;
        }
        case "dash:params": {
          const p = (msg as { params?: unknown }).params;
          if (p && typeof p === "object" && !Array.isArray(p)) {
            currentParams.current = p as Record<string, ParamValue>;
            onParamsRef.current?.(currentParams.current);
          }
          void fetchData(allIdsRef.current, { params: currentParams.current });
          break;
        }
        case "dash:height": {
          const h = Number((msg as { height?: unknown }).height);
          if (Number.isFinite(h) && h > 0) setHeight(Math.max(MIN_HEIGHT, Math.ceil(h)));
          break;
        }
        case "dash:sources": {
          const s = (msg as { sources?: unknown }).sources;
          if (Array.isArray(s)) onSourcesRef.current?.(s.filter((x): x is FrameSource => !!x && typeof x === "object" && typeof (x as FrameSource).id === "string"));
          break;
        }
        case "dash:link":
        default:
          break;
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [fetchData]);

  return (
    <div className="space-y-2">
      {pending > 0 && (
        <p className="text-xs text-gray-400 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Chargement des données…</p>
      )}
      {error && <p className="text-xs text-red-400 break-words">Les données n&apos;ont pas pu être lues ({error}).</p>}
      {origin ? (
        <iframe
          ref={iframeRef}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          title={title}
          style={{ width: "100%", height, border: "none", background: "transparent", display: "block" }}
        />
      ) : (
        <div style={{ height: MIN_HEIGHT }} />
      )}
    </div>
  );
}
