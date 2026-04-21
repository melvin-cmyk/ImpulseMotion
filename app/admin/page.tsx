"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

type User = {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  createdAt: string;
  adAccounts: { id: string; platform: string; accountId: string; label: string | null }[];
  mcpPermissions: { mcpServer: string }[];
};

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const [createName, setCreateName] = useState("");
  const [createRole, setCreateRole] = useState<"client" | "admin">("client");
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
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Utilisateurs</h1>
          <p className="text-sm mt-1" style={{ color: "#9ca3af" }}>
            Gérer les clients et leurs accès aux comptes publicitaires.
          </p>
        </div>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="px-4 py-2 rounded-lg font-semibold text-sm"
          style={{
            background: "linear-gradient(135deg,#7c3aed,#a855f7)",
            color: "#fff",
          }}
        >
          {showCreate ? "Annuler" : "+ Nouveau client"}
        </button>
      </div>

      {lastCreated && (
        <div
          className="mb-6 p-4 rounded-xl"
          style={{
            background: "rgba(34,197,94,0.1)",
            border: "1px solid rgba(34,197,94,0.3)",
          }}
        >
          <div className="text-sm font-semibold text-emerald-300 mb-1">Compte créé</div>
          <div className="text-xs" style={{ color: "#d1d5db" }}>
            Email: <code>{lastCreated.email}</code>
          </div>
          <div className="text-xs" style={{ color: "#d1d5db" }}>
            Mot de passe temporaire:{" "}
            <code
              className="px-2 py-0.5 rounded"
              style={{ background: "rgba(0,0,0,0.4)" }}
            >
              {lastCreated.password}
            </code>
          </div>
          <div className="text-xs mt-2" style={{ color: "#9ca3af" }}>
            Notez-le maintenant — il ne sera plus affiché.
          </div>
          <button
            onClick={() => setLastCreated(null)}
            className="mt-2 text-xs underline"
            style={{ color: "#9ca3af" }}
          >
            Fermer
          </button>
        </div>
      )}

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="mb-6 p-5 rounded-xl flex flex-col gap-3"
          style={{
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input
              type="email"
              required
              placeholder="client@exemple.com"
              value={createEmail}
              onChange={(e) => setCreateEmail(e.target.value)}
              className="px-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#fff",
              }}
            />
            <input
              type="text"
              placeholder="Nom (optionnel)"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              className="px-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#fff",
              }}
            />
            <select
              value={createRole}
              onChange={(e) => setCreateRole(e.target.value as "client" | "admin")}
              className="px-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#fff",
              }}
            >
              <option value="client">Client</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          {error && (
            <div className="text-xs text-red-400">{error}</div>
          )}
          <button
            type="submit"
            disabled={creating}
            className="self-start px-4 py-2 rounded-lg font-semibold text-sm disabled:opacity-50"
            style={{
              background: "linear-gradient(135deg,#7c3aed,#a855f7)",
              color: "#fff",
            }}
          >
            {creating ? "Création..." : "Créer"}
          </button>
        </form>
      )}

      {loading ? (
        <div className="text-sm" style={{ color: "#6b7280" }}>
          Chargement...
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {users.map((u) => (
            <div
              key={u.id}
              className="flex items-center justify-between p-4 rounded-xl"
              style={{
                background: "rgba(255,255,255,0.02)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <div className="flex flex-col">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{u.email}</span>
                  <span
                    className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded"
                    style={{
                      background: u.role === "admin" ? "rgba(168,85,247,0.2)" : "rgba(59,130,246,0.15)",
                      color: u.role === "admin" ? "#c4b5fd" : "#93c5fd",
                    }}
                  >
                    {u.role}
                  </span>
                </div>
                <div className="text-xs mt-1" style={{ color: "#6b7280" }}>
                  {u.adAccounts.length} compte(s) pub · {u.mcpPermissions.length} serveur(s) MCP
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/admin/users/${u.id}`}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg"
                  style={{
                    background: "rgba(124,58,237,0.15)",
                    border: "1px solid rgba(124,58,237,0.3)",
                    color: "#c4b5fd",
                  }}
                >
                  Gérer
                </Link>
                <button
                  onClick={() => handleDelete(u.id, u.email)}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg"
                  style={{
                    background: "rgba(239,68,68,0.1)",
                    border: "1px solid rgba(239,68,68,0.2)",
                    color: "#fca5a5",
                  }}
                >
                  Supprimer
                </button>
              </div>
            </div>
          ))}
          {users.length === 0 && (
            <div className="text-sm" style={{ color: "#6b7280" }}>
              Aucun utilisateur. Créez-en un avec le bouton ci-dessus.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
