"use client";

import { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";

type AdAccount = { id: string; platform: string; accountId: string; label: string | null };
type User = {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  adAccounts: AdAccount[];
  mcpPermissions: { mcpServer: string }[];
};

const MCP_SERVERS = ["meta-ads-impulse", "mcp-google-ads", "mcp-google-analytics"];
const PLATFORMS = [
  { value: "meta", label: "Meta Ads" },
  { value: "google", label: "Google Ads" },
  { value: "tiktok", label: "TikTok Ads" },
];

export default function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const [addPlatform, setAddPlatform] = useState<"meta" | "google" | "tiktok">("meta");
  const [addAccountId, setAddAccountId] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState("");
  const [passwordStatus, setPasswordStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/users");
    if (res.ok) {
      const data = await res.json();
      const u = data.users.find((x: User) => x.id === id);
      setUser(u ?? null);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function addAdAccount(e: React.FormEvent) {
    e.preventDefault();
    setAddError(null);
    const res = await fetch(`/api/admin/users/${id}/ad-accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: addPlatform,
        accountId: addAccountId.trim(),
        label: addLabel || undefined,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setAddError(data.error || "Erreur");
      return;
    }
    setAddAccountId("");
    setAddLabel("");
    load();
  }

  async function removeAdAccount(rowId: string) {
    const res = await fetch(`/api/admin/users/${id}/ad-accounts?rowId=${rowId}`, {
      method: "DELETE",
    });
    if (res.ok) load();
  }

  async function toggleMcp(server: string, enabled: boolean) {
    if (!user) return;
    const current = new Set(user.mcpPermissions.map((p) => p.mcpServer));
    if (enabled) current.add(server);
    else current.delete(server);
    const res = await fetch(`/api/admin/users/${id}/mcp`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ servers: Array.from(current) }),
    });
    if (res.ok) load();
  }

  async function resetPassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordStatus(null);
    if (newPassword.length < 8) {
      setPasswordStatus("Minimum 8 caractères");
      return;
    }
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: newPassword }),
    });
    setPasswordStatus(res.ok ? "Mot de passe mis à jour" : "Erreur");
    if (res.ok) setNewPassword("");
  }

  if (loading) return <div className="text-sm" style={{ color: "#6b7280" }}>Chargement...</div>;
  if (!user) return <div className="text-sm text-red-400">Utilisateur introuvable</div>;

  const mcpEnabled = new Set(user.mcpPermissions.map((p) => p.mcpServer));

  return (
    <div>
      <div className="mb-6">
        <Link href="/admin" className="text-xs hover:underline" style={{ color: "#9ca3af" }}>
          ← Retour
        </Link>
        <h1 className="text-2xl font-bold mt-2">{user.email}</h1>
        <div className="text-xs mt-1" style={{ color: "#6b7280" }}>
          Rôle: <span style={{ color: "#c4b5fd" }}>{user.role}</span>
        </div>
      </div>

      <section className="mb-8">
        <h2 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: "#c4b5fd" }}>
          Comptes publicitaires attribués
        </h2>
        <div className="flex flex-col gap-2 mb-4">
          {user.adAccounts.length === 0 && (
            <div className="text-sm" style={{ color: "#6b7280" }}>
              Aucun compte attribué.
            </div>
          )}
          {user.adAccounts.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between p-3 rounded-lg"
              style={{
                background: "rgba(255,255,255,0.02)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <div className="flex items-center gap-3">
                <span
                  className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded"
                  style={{
                    background: "rgba(124,58,237,0.15)",
                    color: "#c4b5fd",
                  }}
                >
                  {a.platform}
                </span>
                <code className="text-sm">{a.accountId}</code>
                {a.label && (
                  <span className="text-xs" style={{ color: "#9ca3af" }}>
                    — {a.label}
                  </span>
                )}
              </div>
              <button
                onClick={() => removeAdAccount(a.id)}
                className="text-xs px-2 py-1 rounded"
                style={{
                  background: "rgba(239,68,68,0.1)",
                  border: "1px solid rgba(239,68,68,0.2)",
                  color: "#fca5a5",
                }}
              >
                Retirer
              </button>
            </div>
          ))}
        </div>

        <form
          onSubmit={addAdAccount}
          className="p-4 rounded-xl flex flex-col gap-3"
          style={{
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <select
              value={addPlatform}
              onChange={(e) => setAddPlatform(e.target.value as "meta" | "google" | "tiktok")}
              className="px-3 py-2 rounded-lg text-sm"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#fff",
              }}
            >
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder={addPlatform === "meta" ? "act_123... ou 123..." : "ID compte"}
              value={addAccountId}
              onChange={(e) => setAddAccountId(e.target.value)}
              required
              className="px-3 py-2 rounded-lg text-sm md:col-span-2"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#fff",
              }}
            />
            <input
              type="text"
              placeholder="Label (ex: Nike FR)"
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
              className="px-3 py-2 rounded-lg text-sm"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#fff",
              }}
            />
          </div>
          {addError && <div className="text-xs text-red-400">{addError}</div>}
          <button
            type="submit"
            className="self-start px-4 py-2 rounded-lg font-semibold text-sm"
            style={{
              background: "linear-gradient(135deg,#7c3aed,#a855f7)",
              color: "#fff",
            }}
          >
            Ajouter le compte
          </button>
        </form>
      </section>

      <section className="mb-8">
        <h2 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: "#c4b5fd" }}>
          Serveurs MCP autorisés pour l&apos;IA
        </h2>
        <div className="flex flex-col gap-2">
          {MCP_SERVERS.map((s) => (
            <label
              key={s}
              className="flex items-center gap-3 p-3 rounded-lg cursor-pointer"
              style={{
                background: "rgba(255,255,255,0.02)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <input
                type="checkbox"
                checked={mcpEnabled.has(s)}
                onChange={(e) => toggleMcp(s, e.target.checked)}
                className="accent-violet-500"
              />
              <code className="text-sm">{s}</code>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: "#c4b5fd" }}>
          Réinitialiser le mot de passe
        </h2>
        <form onSubmit={resetPassword} className="flex items-center gap-2">
          <input
            type="text"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Nouveau mot de passe (min 8)"
            className="flex-1 px-3 py-2 rounded-lg text-sm"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "#fff",
            }}
          />
          <button
            type="submit"
            className="px-4 py-2 rounded-lg font-semibold text-sm"
            style={{
              background: "rgba(124,58,237,0.15)",
              border: "1px solid rgba(124,58,237,0.3)",
              color: "#c4b5fd",
            }}
          >
            Mettre à jour
          </button>
        </form>
        {passwordStatus && (
          <div className="text-xs mt-2" style={{ color: "#9ca3af" }}>
            {passwordStatus}
          </div>
        )}
      </section>
    </div>
  );
}
