"use client";

/**
 * The page of the alerts, in one screen: on one side the alerts of the person,
 * on the other either the choice of a client (a new alert) or the conversation
 * of the alert that is open. No wizard: pick a client, say what you want in a
 * sentence, validate the card.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Plus } from "lucide-react";
import { Card, PageHeader } from "@/components/ui/surface";
import type { SlackIdentity } from "@/lib/client-alerts/types";
import { AlertChat } from "@/components/client-alerts/alert-chat";
import { AlertList, type AlertAction } from "@/components/client-alerts/alert-list";
import { ClientPicker } from "@/components/client-alerts/client-picker";
import { SlackBanner, type SlackState } from "@/components/client-alerts/slack-banner";
import type { AlertView, ClientOption } from "@/components/client-alerts/alert-model";

interface Payload {
  alerts: AlertView[];
  clients: ClientOption[];
  /** The list of clients could not be built; the cause stays in the server's logs. */
  clientsError?: boolean;
  slack: SlackState;
  sending: boolean;
  viewer: { userId: string; realAdmin: boolean };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export function AlertsAssistant() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // The alert whose conversation is open; null = the choice of a client.
  const [open, setOpen] = useState<{ id: string; fresh: boolean } | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const [creating, setCreating] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, AlertAction | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  const load = useCallback(async (all: boolean) => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/client-alerts${all ? "?all=1" : ""}`, { cache: "no-store" });
      const body = await readJson(res);
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `Erreur ${res.status}`);
      setData(body as unknown as Payload);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { void load(showAll); }, 0);
    return () => clearTimeout(t);
  }, [load, showAll]);

  const putAlert = useCallback((alert: AlertView) => {
    setData((d) => {
      if (!d) return d;
      const known = d.alerts.some((a) => a.id === alert.id);
      return { ...d, alerts: known ? d.alerts.map((a) => (a.id === alert.id ? alert : a)) : [alert, ...d.alerts] };
    });
  }, []);

  function newAlert() {
    setOpen(null);
    setCreateError(null);
    setFocusKey((k) => k + 1);
  }

  async function pick(client: ClientOption) {
    setCreating(client.id);
    setCreateError(null);
    try {
      const res = await fetch("/api/client-alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertClientId: client.id }),
      });
      const body = await readJson(res);
      if (!res.ok || !body.alert) throw new Error(typeof body.error === "string" ? body.error : `Erreur ${res.status}`);
      const alert = body.alert as AlertView;
      putAlert(alert);
      setOpen({ id: alert.id, fresh: true });
    } catch (e) {
      setCreateError(`L'alerte n'a pas pu être ouverte pour ${client.name} (${e instanceof Error ? e.message : "erreur"}).`);
    } finally {
      setCreating(null);
    }
  }

  async function act(alert: AlertView, action: AlertAction) {
    setBusy((b) => ({ ...b, [alert.id]: action }));
    setErrors((e) => ({ ...e, [alert.id]: undefined }));
    try {
      const res = await fetch(`/api/client-alerts/${alert.id}`, action === "delete"
        ? { method: "DELETE" }
        : { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const body = await readJson(res);
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `Erreur ${res.status}`);
      if (action === "delete") {
        setData((d) => (d ? { ...d, alerts: d.alerts.filter((a) => a.id !== alert.id) } : d));
        setOpen((o) => (o?.id === alert.id ? null : o));
      } else if (body.alert) {
        putAlert(body.alert as AlertView);
      }
    } catch (e) {
      setErrors((all) => ({ ...all, [alert.id]: e instanceof Error ? e.message : "L'action a échoué." }));
    } finally {
      setBusy((b) => ({ ...b, [alert.id]: undefined }));
    }
  }

  const opened = open && data ? data.alerts.find((a) => a.id === open.id && a.mine) ?? null : null;
  const mineCount = data ? data.alerts.filter((a) => a.mine).length : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Alertes"
        subtitle="Choisissez un client et dites, en une phrase, de quoi vous voulez être prévenu. L'IA propose l'alerte sur ses comptes Meta, Google Ads et TikTok Ads réunis ; vous validez, puis vous recevez un message privé dans Slack quand elle se déclenche."
        action={
          <div className="flex items-center gap-4 shrink-0 ml-4">
            {/* The rules set by hand still run: they keep a way in. */}
            <Link href="/admin/alerts" className="text-xs text-gray-400 hover:text-white underline whitespace-nowrap">Règles manuelles</Link>
            <button type="button" onClick={newAlert} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold">
              <Plus className="w-4 h-4" /> Nouvelle alerte
            </button>
          </div>
        }
      />

      {error && (
        <Card padded className="border-red-900/40">
          <p className="text-sm text-red-400">Les alertes n&apos;ont pas pu être chargées ({error}).</p>
          <button type="button" onClick={() => void load(showAll)} className="mt-2 text-xs underline text-gray-300">Réessayer</button>
        </Card>
      )}

      {!data && !error && <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Chargement…</div>}

      {data && (
        <>
          <SlackBanner
            slack={data.slack}
            sending={data.sending}
            onIdentity={(identity: SlackIdentity) => setData((d) => (d ? { ...d, slack: { ...d.slack, identity } } : d))}
          />

          <div className="grid gap-6 items-start lg:grid-cols-[22rem_minmax(0,1fr)]">
            <section className="order-2 lg:order-1 bg-gray-900 border border-gray-800 rounded-2xl min-w-0">
              <header className="px-4 py-3 border-b border-gray-800 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  {showAll ? "Toutes les alertes" : "Mes alertes"}
                  <span className="text-gray-500 font-normal tabular-nums">{data.alerts.length}</span>
                  {refreshing && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-500" />}
                </h2>
                {data.viewer.realAdmin && (
                  <label className="flex items-center gap-1.5 text-xs text-gray-400">
                    <input type="checkbox" className="accent-violet-500" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                    Toutes les alertes
                  </label>
                )}
              </header>
              {data.alerts.length === 0 ? (
                <p className="px-4 py-6 text-sm text-gray-400 leading-relaxed">
                  {showAll ? "Personne n'a encore créé d'alerte." : "Aucune alerte pour l'instant. Choisissez un client, écrivez votre demande, validez : c'est tout."}
                </p>
              ) : (
                <div className="lg:max-h-[calc(100vh-13rem)] lg:overflow-y-auto">
                  <AlertList
                    alerts={data.alerts}
                    openId={opened?.id ?? null}
                    everyone={showAll}
                    busy={busy}
                    errors={errors}
                    onOpen={(a) => setOpen({ id: a.id, fresh: false })}
                    onAction={(a, action) => void act(a, action)}
                  />
                </div>
              )}
              {showAll && mineCount < data.alerts.length && (
                <p className="px-4 py-2 border-t border-gray-800 text-[11px] text-gray-500">
                  Les alertes des autres se lisent, se mettent en pause et se suppriment ; seule la personne qui a créé une alerte peut la modifier.
                </p>
              )}
            </section>

            <div className="order-1 lg:order-2 min-w-0">
              {opened ? (
                <AlertChat
                  key={opened.id}
                  alert={opened}
                  fresh={open?.fresh}
                  onActivated={putAlert}
                  onClose={() => setOpen(null)}
                />
              ) : (
                <ClientPicker
                  clients={data.clients}
                  busyId={creating}
                  error={createError ?? (data.clientsError ? "La liste des clients n'a pas pu être lue. Rechargez la page dans un instant." : null)}
                  focusKey={focusKey}
                  onPick={(c) => void pick(c)}
                />
              )}
            </div>
          </div>

          <p className="text-xs text-gray-500">
            Ces alertes sont les vôtres, en message privé. Les vérifications faites pour toute l&apos;agence, dans les canaux des clients, se règlent dans{" "}
            <Link href="/admin/auto-alerts" className="underline text-gray-400 hover:text-gray-200">Alertes automatiques</Link>.
          </p>
        </>
      )}
    </div>
  );
}
