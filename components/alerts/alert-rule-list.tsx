"use client";

import { useCallback, useEffect, useState } from "react";
import { Pill } from "@/components/ui/surface";
import {
  type AlertLevel,
  type AlertPlatform,
  type AlertRuleExt,
  LEVEL_LABEL,
  PLATFORM_LABEL,
  filterSummary,
  isPlatform,
  ruleFilter,
  ruleLevel,
  ruleMode,
  rulePlatform,
} from "@/components/alerts/alert-rule-form";

/** Small « Meta » (blue) / « Google » (emerald) pill. */
export function PlatformPill({ platform }: { platform: AlertPlatform }) {
  return (
    <span title={platform === "google" ? "Google Ads" : "Meta Ads"}>
      <Pill tone={platform === "google" ? "emerald" : "blue"}>{PLATFORM_LABEL[platform]}</Pill>
    </span>
  );
}

/** Platform + level + IA pills shown next to a rule's title. */
export function RuleKindPills({ rule }: { rule: AlertRuleExt }) {
  const level = ruleLevel(rule);
  const ai = ruleMode(rule) === "ai";
  return (
    <>
      <PlatformPill platform={rulePlatform(rule)} />
      {level !== "account" && <Pill tone="amber">{LEVEL_LABEL[level]}</Pill>}
      {ai && (
        <span title="Condition évaluée chaque matin par l'IA">
          <Pill tone="violet" className="font-semibold">IA</Pill>
        </span>
      )}
    </>
  );
}

/** Small grey line: filter summary and, for AI rules, the truncated prompt. */
export function RuleDetails({ rule }: { rule: AlertRuleExt }) {
  const summary = filterSummary(ruleFilter(rule));
  const prompt = ruleMode(rule) === "ai" ? rule.prompt?.trim() : null;
  if (!summary && !prompt) return null;
  return (
    <div className="text-xs mt-1 text-gray-500 space-y-0.5">
      {summary && <div>{summary}</div>}
      {prompt && (
        <div className="truncate max-w-xl italic" title={prompt}>
          « {prompt.length > 140 ? `${prompt.slice(0, 140)}…` : prompt} »
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type AlertEventRow = {
  id: string;
  clientId: string;
  metric: string;
  value: number;
  threshold: number;
  message: string;
  triggeredAt: string;
  acknowledged: boolean;
  entityLevel?: string | null;
  entityId?: string | null;
  entityName?: string | null;
};

function entityLabel(level: string | null | undefined): string {
  return level && level in LEVEL_LABEL ? LEVEL_LABEL[level as AlertLevel] : "Élément";
}

/**
 * The backend already embeds the entity name in `message`; when we show it in
 * bold up front, drop a leading « name » / name — / name : so it isn't doubled.
 */
function stripEntityPrefix(message: string, name: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*(?:«\\s*${esc}\\s*»|"${esc}"|“${esc}”|${esc})\\s*(?:—|–|-|:)\\s*`, "u");
  return message.replace(re, "");
}

export function EventLine({ event }: { event: AlertEventRow }) {
  const name = event.entityName?.trim();
  if (!name) return <span className="text-sm text-white">{event.message}</span>;
  return (
    <span className="text-sm text-white">
      <span className="font-semibold">{entityLabel(event.entityLevel)} « {name} »</span>
      <span className="text-gray-400"> — </span>
      {stripEntityPrefix(event.message, name)}
    </span>
  );
}

type AlertEventsListProps = {
  /** Bump to refetch (e.g. after a manual scan). */
  refreshKey?: number;
  limit?: number;
  /** Optional account → entity name resolver (admin page shows account labels). */
  accountLabel?: (clientId: string) => string;
  /**
   * Optional account → platform resolver (events don't carry the platform:
   * the page looks it up in the accounts it already fetched; unknown → no pill).
   */
  accountPlatform?: (clientId: string) => string | null | undefined;
  className?: string;
};

export function AlertEventsList({ refreshKey = 0, limit = 15, accountLabel, accountPlatform, className }: AlertEventsListProps) {
  const [events, setEvents] = useState<AlertEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts/events");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Erreur ${res.status}`);
      setEvents(Array.isArray(data?.events) ? data.events : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement des déclenchements impossible");
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (events === null) return <p className="text-xs text-gray-500">Chargement des déclenchements…</p>;
  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (events.length === 0) return <p className="text-xs text-gray-500">Aucun déclenchement pour l&apos;instant.</p>;

  const shown = showAll ? events : events.slice(0, limit);
  return (
    <div className={className}>
      <ul className="divide-y divide-gray-800">
        {shown.map((ev) => {
          const platform = accountPlatform?.(ev.clientId);
          return (
            <li key={ev.id} className="py-2 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <EventLine event={ev} />
                <div className="text-[11px] text-gray-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                  {isPlatform(platform) && <PlatformPill platform={platform} />}
                  <span>
                    {accountLabel ? accountLabel(ev.clientId) : ev.clientId} · {new Date(ev.triggeredAt).toLocaleString("fr-FR")}
                    {ev.acknowledged && <> · acquittée</>}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {events.length > limit && (
        <button type="button" onClick={() => setShowAll((s) => !s)} className="mt-2 text-xs text-violet-400 hover:text-violet-300">
          {showAll ? "Réduire" : `Voir les ${events.length} déclenchements`}
        </button>
      )}
    </div>
  );
}
