"use client";

/**
 * Staff-side member management for a dashboard card (/d list).
 * Shows the client logins having read access as badges; admins can open a
 * panel (checkbox list of all clients) and replace the member list via
 * PUT /api/dashboards/[id]/members. Consultants see the badges read-only.
 */

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Pill } from "@/components/ui/surface";

export type DashboardMemberEntry = {
  id: string;
  userId: string;
  user: { id: string; email: string | null; name: string | null };
};

type ClientOption = { id: string; email: string | null; name: string | null };

export function DashboardMembersManager({
  dashboardId,
  initialMembers,
}: {
  dashboardId: string;
  initialMembers: DashboardMemberEntry[];
}) {
  const { data: session } = useSession();
  const isAdmin = session?.role === "admin";

  const [members, setMembers] = useState<DashboardMemberEntry[]>(initialMembers);
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState<ClientOption[] | null>(null);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialMembers.map((m) => m.userId)),
  );
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || clients !== null || clientsLoading) return;
    setClientsLoading(true);
    setError(null);
    fetch("/api/dashboards/clients")
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Erreur API");
        setClients(data.clients || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Erreur de chargement"))
      .finally(() => setClientsLoading(false));
  }, [open, clients, clientsLoading]);

  function toggle(userId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/dashboards/${dashboardId}/members`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds: Array.from(selected) }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Sauvegarde échouée");
      return;
    }
    const data = await res.json();
    const next: DashboardMemberEntry[] = data.members || [];
    setMembers(next);
    setSelected(new Set(next.map((m) => m.userId)));
    setOpen(false);
  }

  const filteredClients = (clients ?? []).filter((c) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (c.name ?? "").toLowerCase().includes(q) || (c.email ?? "").toLowerCase().includes(q);
  });

  return (
    <div className="mt-3 pt-3 border-t border-gray-800/60">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] uppercase tracking-wide font-medium text-gray-500">
            Clients membres
          </span>
          {members.length === 0 && (
            <span className="text-xs text-gray-600">aucun</span>
          )}
          {members.map((m) => (
            <Pill key={m.id} tone="blue">
              {m.user.name ?? m.user.email ?? m.userId}
            </Pill>
          ))}
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/30 transition-colors shrink-0"
          >
            {open ? "Fermer" : "Gérer les clients"}
          </button>
        )}
      </div>

      {isAdmin && open && (
        <div className="mt-3 rounded-xl bg-gray-950 border border-gray-800 p-3 flex flex-col gap-2">
          <input
            type="text"
            placeholder="Rechercher un client (nom ou email)…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none"
          />
          {clientsLoading && <p className="text-xs text-gray-400">Chargement des clients…</p>}
          {clients && clients.length === 0 && (
            <p className="text-xs text-gray-500">Aucun compte client — crée-les depuis l&apos;admin.</p>
          )}
          {clients && clients.length > 0 && (
            <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-800/60 divide-y divide-gray-800/60">
              {filteredClients.length === 0 ? (
                <p className="p-3 text-xs text-gray-500">Aucun client ne correspond.</p>
              ) : (
                filteredClients.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-gray-800/50 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={(e) => toggle(c.id, e.target.checked)}
                      className="accent-violet-500"
                    />
                    <span className="flex-1 truncate text-white">{c.name ?? c.email}</span>
                    {c.name && c.email && (
                      <span className="text-xs text-gray-500 truncate">{c.email}</span>
                    )}
                  </label>
                ))
              )}
            </div>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving || clientsLoading}
              className="px-4 py-2 rounded-lg font-semibold text-sm bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-50 self-start"
            >
              {saving ? "Enregistrement…" : "Enregistrer"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setSelected(new Set(members.map((m) => m.userId)));
                setError(null);
              }}
              className="text-xs text-gray-400 hover:text-white underline"
            >
              Annuler
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
