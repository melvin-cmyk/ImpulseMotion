"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
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
  "px-3 py-2 rounded-lg text-sm bg-ui-bg border border-ui-line text-ui-fg focus:border-ui-accent focus:outline-none";
const primaryBtnCls =
  "px-4 py-2 rounded-lg font-medium text-sm bg-ui-accent hover:brightness-110 text-ui-on-accent transition-colors disabled:opacity-50";

const ROLES = ["client", "consultant", "admin"] as const;
type Role = (typeof ROLES)[number];

/** Badge par rôle : admin=violet, consultant=bleu, client=gris. */
const ROLE_TONE: Record<string, "violet" | "blue" | "default"> = {
  admin: "violet",
  consultant: "blue",
  client: "default",
};
const ROLE_FILTERS: { value: "all" | Role; label: string }[] = [
  { value: "all", label: "Tous" },
  { value: "admin", label: "Admins" },
  { value: "consultant", label: "Consultants" },
  { value: "client", label: "Clients" },
];

export default function AdminUsersPage() {
  const { data: session } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [roleFilter, setRoleFilter] = useState<"all" | Role>("all");
  const [roleError, setRoleError] = useState<string | null>(null);
  const [roleBusy, setRoleBusy] = useState<string | null>(null);
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

  async function handleRoleChange(id: string, role: string) {
    setRoleError(null);
    setRoleBusy(id);
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    setRoleBusy(null);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setRoleError(data.error || "Changement de rôle échoué");
      return;
    }
    load();
  }

  async function handleDelete(id: string, email: string | null) {
    if (!confirm(`Supprimer ${email ?? id} ?`)) return;
    const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  const isSelf = (u: User) =>
    u.id === session?.userId || (!!u.email && u.email === session?.user?.email);
  const filteredUsers = roleFilter === "all" ? users : users.filter((u) => u.role === roleFilter);

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
          <div className="text-sm font-medium text-emerald-300 mb-1">Compte créé</div>
          <div className="text-xs text-ui-fg2">
            Email : <code className="text-ui-fg">{lastCreated.email}</code>
          </div>
          <div className="text-xs text-ui-fg2 mt-0.5">
            Mot de passe temporaire :{" "}
            <code className="px-2 py-0.5 rounded bg-ui-bg text-ui-fg">{lastCreated.password}</code>
          </div>
          <div className="text-xs mt-2 text-ui-muted">
            Notez-le maintenant — il ne sera plus affiché.
          </div>
          <button onClick={() => setLastCreated(null)} className="mt-2 text-xs text-ui-fg2 hover:text-ui-fg underline">
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

      <div className="flex items-center gap-2 flex-wrap">
        {ROLE_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setRoleFilter(f.value)}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
              roleFilter === f.value
                ? "bg-ui-accent-soft text-ui-accent-ink border-ui-accent"
                : "bg-ui-card text-ui-fg2 border-ui-line hover:text-ui-fg"
            }`}
          >
            {f.label}
            {!loading && (
              <span className="ml-1.5 text-ui-muted">
                {f.value === "all" ? users.length : users.filter((u) => u.role === f.value).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {roleError && <p className="text-xs text-red-400">{roleError}</p>}

      {loading ? (
        <p className="text-ui-muted">Chargement…</p>
      ) : filteredUsers.length === 0 ? (
        <Card padded className="text-center text-ui-muted border-dashed">
          {users.length === 0
            ? "Aucun utilisateur. Crée-en un avec le bouton ci-dessus."
            : "Aucun utilisateur pour ce filtre."}
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredUsers.map((u) => (
            <Card key={u.id} padded className="flex items-center justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm text-ui-fg truncate">{u.email}</span>
                  <Pill tone={ROLE_TONE[u.role] ?? "default"} className=" font-medium ">
                    {u.role}
                  </Pill>
                  <select
                    value={u.role}
                    onChange={(e) => handleRoleChange(u.id, e.target.value)}
                    disabled={roleBusy === u.id || (isSelf(u) && u.role === "admin")}
                    title={
                      isSelf(u) && u.role === "admin"
                        ? "Vous ne pouvez pas retirer votre propre rôle admin"
                        : "Changer le rôle"
                    }
                    className="px-2 py-1 rounded bg-ui-bg border border-ui-line text-ui-fg2 text-xs focus:border-ui-accent focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>
                <div className="text-xs mt-1 text-ui-muted">
                  {u.adAccounts.length} compte{u.adAccounts.length > 1 ? "s" : ""} pub · {u.mcpPermissions.length} serveur{u.mcpPermissions.length > 1 ? "s" : ""} MCP
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Link
                  href={`/admin/users/${u.id}`}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg bg-ui-accent-soft hover:bg-ui-accent-soft text-ui-accent-ink border border-ui-accent transition-colors"
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
