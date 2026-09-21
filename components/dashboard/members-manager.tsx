"use client";

/**
 * Access panel of a dashboard card (/d list) — the silo, made visible.
 * Shows who is attached: consultants (work on the client) and clients (read
 * access), plus which clients may talk to the private bot. Admins attach
 * people by email (POST /api/dashboards/[id]/members — an unknown email gets a
 * login + a temp password shown once), detach them, and grant the bot.
 * Consultants see the same panel read-only.
 */

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Pill } from "@/components/ui/surface";

export type DashboardMemberEntry = {
  id: string;
  userId: string;
  user: { id: string; email: string | null; name: string | null; role: string };
};

export type DashboardBotInfo = { enabled: boolean; name: string; accessUserIds: string[] } | null;

type Role = "consultant" | "client";
type Invite = { email: string; tempPassword: string };

const inputCls =
  "px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none";

export function DashboardMembersManager({
  dashboardId,
  initialMembers,
  bot,
}: {
  dashboardId: string;
  initialMembers: DashboardMemberEntry[];
  bot: DashboardBotInfo;
}) {
  const { data: session } = useSession();
  const isAdmin = session?.role === "admin";

  const [members, setMembers] = useState(initialMembers);
  const [botUsers, setBotUsers] = useState<Set<string>>(() => new Set(bot?.accessUserIds ?? []));
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("client");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);

  const consultants = members.filter((m) => m.user.role === "consultant");
  const clients = members.filter((m) => m.user.role !== "consultant");

  async function call(url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(typeof data.error === "string" ? data.error : `Erreur ${res.status}`);
      return null;
    }
    return data;
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const data = await call(`/api/dashboards/${dashboardId}/members`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    });
    if (!data) return;
    const member = data.member as DashboardMemberEntry;
    setMembers((prev) => (prev.some((m) => m.userId === member.userId) ? prev : [...prev, member]));
    if (typeof data.tempPassword === "string") {
      setInvites((prev) => [...prev, { email: member.user.email ?? email, tempPassword: data.tempPassword as string }]);
    }
    setEmail("");
  }

  async function remove(m: DashboardMemberEntry) {
    if (!confirm(`Retirer ${m.user.email ?? m.user.name} de ce dashboard ? Son accès aux données et au bot est révoqué.`)) return;
    const data = await call(`/api/dashboards/${dashboardId}/members?userId=${encodeURIComponent(m.userId)}`, { method: "DELETE" });
    if (!data) return;
    setMembers((prev) => prev.filter((x) => x.userId !== m.userId));
    setBotUsers((prev) => { const next = new Set(prev); next.delete(m.userId); return next; });
  }

  async function toggleBot(m: DashboardMemberEntry) {
    const has = botUsers.has(m.userId);
    const data = has
      ? await call(`/api/admin/bots/${dashboardId}/access/${m.userId}`, { method: "DELETE" })
      : await call(`/api/admin/bots/${dashboardId}/access`, { method: "POST", body: JSON.stringify({ email: m.user.email }) });
    if (!data) return;
    setBotUsers((prev) => { const next = new Set(prev); if (has) next.delete(m.userId); else next.add(m.userId); return next; });
  }

  const label = (m: DashboardMemberEntry) => m.user.name ?? m.user.email ?? m.userId;

  function group(title: string, list: DashboardMemberEntry[], tone: "violet" | "blue", withBot: boolean) {
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] uppercase tracking-wide font-medium text-gray-500 w-24 shrink-0">{title}</span>
        {list.length === 0 && <span className="text-xs text-gray-600">aucun</span>}
        {list.map((m) => (
          <Pill key={m.id} tone={tone} className="inline-flex items-center gap-1.5">
            {label(m)}
            {withBot && bot && botUsers.has(m.userId) && <span title="Accès au bot privé">· bot</span>}
            {isAdmin && open && withBot && bot && (
              <button type="button" disabled={busy} onClick={() => toggleBot(m)} className="underline opacity-80 hover:opacity-100">
                {botUsers.has(m.userId) ? "retirer le bot" : "donner le bot"}
              </button>
            )}
            {isAdmin && open && (
              <button type="button" disabled={busy} onClick={() => remove(m)} aria-label={`Retirer ${label(m)}`} className="opacity-70 hover:opacity-100">
                ×
              </button>
            )}
          </Pill>
        ))}
      </div>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-800/60 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5 min-w-0">
          {group("Consultants", consultants, "violet", false)}
          {group("Clients", clients, "blue", true)}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] uppercase tracking-wide font-medium text-gray-500 w-24 shrink-0">Bot privé</span>
            {bot ? (
              <>
                <Pill tone={bot.enabled ? "emerald" : "default"}>{bot.name} · {bot.enabled ? "actif" : "désactivé"}</Pill>
                <Pill tone="amber">IA AWS Bedrock · UE</Pill>
                <span className="text-xs text-gray-500">{botUsers.size} client{botUsers.size > 1 ? "s" : ""} autorisé{botUsers.size > 1 ? "s" : ""}</span>
              </>
            ) : (
              <span className="text-xs text-gray-600">non configuré</span>
            )}
          </div>
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/30 transition-colors shrink-0"
          >
            {open ? "Fermer" : "Gérer les accès"}
          </button>
        )}
      </div>

      {isAdmin && open && (
        <form onSubmit={add} className="rounded-xl bg-gray-950 border border-gray-800 p-3 flex flex-wrap items-center gap-2">
          <input
            type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="email@exemple.fr" className={inputCls + " w-64"}
          />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={inputCls}>
            <option value="client">Client</option>
            <option value="consultant">Consultant</option>
          </select>
          <button
            type="submit" disabled={busy}
            className="px-3 py-2 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-50"
          >
            {busy ? "…" : "Donner l'accès"}
          </button>
          <p className="basis-full text-[11px] text-gray-500">
            Email inconnu → le compte est créé et son mot de passe temporaire s&apos;affiche ici une seule fois.
          </p>
        </form>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
      <InviteList invites={invites} />
    </div>
  );
}

/** Temp passwords of logins just created — shown once, to hand over. */
export function InviteList({ invites }: { invites: Invite[] }) {
  if (invites.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
      <p className="text-xs font-semibold text-amber-300">Comptes créés — mots de passe temporaires (affichés une seule fois)</p>
      {invites.map((i) => (
        <p key={i.email} className="text-xs text-gray-300 font-mono break-all">
          {i.email} · {i.tempPassword}
        </p>
      ))}
    </div>
  );
}
