"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { PageHeader, Pill, Card } from "@/components/ui/surface";

type User = {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  createdAt: string;
  adAccounts: { id: string; platform: string; accountId: string; label: string | null }[];
  mcpPermissions: { mcpServer: string }[];
};

const inputCls =
  "px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none";
const primaryBtnCls =
  "px-4 py-2 rounded-lg font-semibold text-sm bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-50";

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const [createName, setCreateName] = useState("");
  const [createRole, setCreateRole] = useState<"client" | "consultant" | "admin">("client");
  const [creating, setCreating] = useState(false);
  const [lastCreated, setLastCreated] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/users");
    if (res.ok) {
      const data = await res.json();
      setUsers(data.users);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: createEmail, name: createName || undefined, role: createRole }),
    });
    setCreating(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Création échouée");
      return;
    }
    const data = await res.json();
    setLastCreated({ email: data.user.email, password: data.tempPassword });
    setCreateEmail("");
    setCreateName("");
    setShowCreate(false);
    load();
  }

  async function handleDelete(id: string, email: string | null) {
    if (!confirm(`Supprimer ${email ?? id} ?`)) return;
    const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Utilisateurs"
        subtitle="Gérer les clients et leurs accès aux comptes publicitaires."
        action={
          <button onClick={() => setShowCreate((s) => !s)} className={primaryBtnCls}>
            {showCreate ? "Annuler" : "+ Nouveau client"}
          </button>
        }
      />

      {lastCreated && (
        <Card padded className="border-emerald-900/40 bg-emerald-500/5">
          <div className="text-sm font-semibold text-emerald-300 mb-1">Compte créé</div>
          <div className="text-xs text-gray-300">
            Email : <code className="text-white">{lastCreated.email}</code>
          </div>
          <div className="text-xs text-gray-300 mt-0.5">
            Mot de passe temporaire :{" "}
            <code className="px-2 py-0.5 rounded bg-gray-950 text-white">{lastCreated.password}</code>
          </div>
          <div className="text-xs mt-2 text-gray-500">
            Notez-le maintenant — il ne sera plus affiché.
          </div>
          <button onClick={() => setLastCreated(null)} className="mt-2 text-xs text-gray-400 hover:text-white underline">
            Fermer
          </button>
        </Card>
      )}

      {showCreate && (
        <Card padded>
          <form onSubmit={handleCreate} className="flex flex-col gap-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <input
                type="email"
                required
                placeholder="client@exemple.com"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
                className={inputCls}
              />
              <input
                type="text"
                placeholder="Nom (optionnel)"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                className={inputCls}
              />
              <select
                value={createRole}
                onChange={(e) => setCreateRole(e.target.value as "client" | "consultant" | "admin")}
                className={inputCls}
              >
                <option value="client">Client</option>
                <option value="consultant">Consultant</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            {error && <div className="text-xs text-red-400">{error}</div>}
            <button type="submit" disabled={creating} className={`${primaryBtnCls} self-start`}>
              {creating ? "Création…" : "Créer"}
            </button>
          </form>
        </Card>
      )}

      {loading ? (
        <p className="text-gray-500">Chargement…</p>
      ) : users.length === 0 ? (
        <Card padded className="text-center text-gray-500 border-dashed">
          Aucun utilisateur. Crée-en un avec le bouton ci-dessus.
        </Card>
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <Card key={u.id} padded className="flex items-center justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm text-white truncate">{u.email}</span>
                  <Pill tone={u.role === "admin" ? "violet" : u.role === "consultant" ? "amber" : "blue"} className="uppercase font-bold tracking-wide">
                    {u.role}
                  </Pill>
                </div>
                <div className="text-xs mt-1 text-gray-500">
                  {u.adAccounts.length} compte{u.adAccounts.length > 1 ? "s" : ""} pub · {u.mcpPermissions.length} serveur{u.mcpPermissions.length > 1 ? "s" : ""} MCP
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Link
                  href={`/admin/users/${u.id}`}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/30 transition-colors"
                >
                  Gérer
                </Link>
                <button
                  onClick={() => handleDelete(u.id, u.email)}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/30 transition-colors"
                >
                  Supprimer
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
