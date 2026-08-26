"use client";

import { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import { Card, Pill } from "@/components/ui/surface";

type AdAccount = { id: string; platform: string; accountId: string; label: string | null };
type User = {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  adAccounts: AdAccount[];
  mcpPermissions: { mcpServer: string }[];
};
type AccountOption = { accountId: string; name: string; currency: string };

const MCP_SERVERS = ["meta-ads-impulse", "mcp-google-ads", "mcp-google-analytics"];
const PLATFORMS = [
  { value: "meta", label: "Meta Ads" },
  { value: "google", label: "Google Ads" },
  { value: "tiktok", label: "TikTok Ads" },
];

const inputCls =
  "px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none";
const sectionTitleCls = "text-sm font-bold uppercase tracking-wider mb-3 text-violet-300";
const primaryBtnCls =
  "px-4 py-2 rounded-lg font-semibold text-sm bg-violet-600 hover:bg-violet-500 text-white transition-colors";
const secondaryBtnCls =
  "px-4 py-2 rounded-lg font-semibold text-sm bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/30 transition-colors";
const dangerBtnCls =
  "text-xs px-2 py-1 rounded bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/30 transition-colors";

export default function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const [addPlatform, setAddPlatform] = useState<"meta" | "google" | "tiktok">("meta");
  const [addAccountId, setAddAccountId] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [remoteOptions, setRemoteOptions] = useState<Record<string, AccountOption[]>>({});
  const [remoteLoading, setRemoteLoading] = useState<Record<string, boolean>>({});
  const [remoteError, setRemoteError] = useState<Record<string, string | null>>({});
  const [pickerSearch, setPickerSearch] = useState("");

  const [newPassword, setNewPassword] = useState("");
  const [passwordStatus, setPasswordStatus] = useState<string | null>(null);

  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<string | null>(null);

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

  const PICKER_ENDPOINTS: Record<string, string> = {
    meta: "/api/admin/meta/accounts",
    google: "/api/admin/google-ads/accounts",
  };

  useEffect(() => {
    const endpoint = PICKER_ENDPOINTS[addPlatform];
    if (!endpoint) return;
    if (remoteOptions[addPlatform] !== undefined || remoteLoading[addPlatform]) return;
    setRemoteLoading((p) => ({ ...p, [addPlatform]: true }));
    setRemoteError((p) => ({ ...p, [addPlatform]: null }));
    fetch(endpoint)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Erreur API");
        setRemoteOptions((p) => ({ ...p, [addPlatform]: data.accounts || [] }));
      })
      .catch((err) => setRemoteError((p) => ({ ...p, [addPlatform]: err.message })))
      .finally(() => setRemoteLoading((p) => ({ ...p, [addPlatform]: false })));
  }, [addPlatform, remoteOptions, remoteLoading]);

  const pickerEnabled = Boolean(PICKER_ENDPOINTS[addPlatform]);
  const currentOptions = remoteOptions[addPlatform];
  const currentLoading = remoteLoading[addPlatform];
  const currentError = remoteError[addPlatform];
  const assignedIdsForPlatform = new Set(
    user?.adAccounts.filter((a) => a.platform === addPlatform).map((a) => a.accountId) ?? [],
  );
  const normalizedAssigned = new Set(
    Array.from(assignedIdsForPlatform).map((id) => id.replace(/^act_/, "")),
  );
  const filteredOptions = (currentOptions ?? []).filter((o) => {
    const raw = o.accountId.replace(/^act_/, "");
    if (assignedIdsForPlatform.has(o.accountId) || normalizedAssigned.has(raw)) return false;
    const q = pickerSearch.trim().toLowerCase();
    if (!q) return true;
    return o.name.toLowerCase().includes(q) || o.accountId.toLowerCase().includes(q);
  });

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
    setPickerSearch("");
    load();
  }

  function pickAccount(opt: AccountOption) {
    setAddAccountId(opt.accountId);
    if (!addLabel) setAddLabel(opt.name);
  }

  async function removeAdAccount(rowId: string) {
    const res = await fetch(`/api/admin/users/${id}/ad-accounts?rowId=${rowId}`, {
      method: "DELETE",
    });
    if (res.ok) load();
  }

  async function fetchPlatformOptions(platform: "meta" | "google"): Promise<AccountOption[]> {
    if (remoteOptions[platform]) return remoteOptions[platform];
    const res = await fetch(PICKER_ENDPOINTS[platform]);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur ${platform}`);
    const list: AccountOption[] = data.accounts || [];
    setRemoteOptions((p) => ({ ...p, [platform]: list }));
    return list;
  }

  async function grantAllAccounts() {
    setBulkBusy(true);
    setBulkStatus("Récupération des comptes Meta + Google…");
    try {
      const [meta, google] = await Promise.all([
        fetchPlatformOptions("meta").catch(() => [] as AccountOption[]),
        fetchPlatformOptions("google").catch(() => [] as AccountOption[]),
      ]);
      setBulkStatus(`Attribution de ${meta.length} comptes Meta + ${google.length} Google…`);
      const [metaRes, googleRes] = await Promise.all([
        meta.length === 0
          ? Promise.resolve({ created: 0, skipped: 0 })
          : fetch(`/api/admin/users/${id}/ad-accounts/bulk`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                platform: "meta",
                accounts: meta.map((a) => ({ accountId: a.accountId, label: a.name })),
              }),
            }).then((r) => r.json()),
        google.length === 0
          ? Promise.resolve({ created: 0, skipped: 0 })
          : fetch(`/api/admin/users/${id}/ad-accounts/bulk`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                platform: "google",
                accounts: google.map((a) => ({ accountId: a.accountId, label: a.name })),
              }),
            }).then((r) => r.json()),
      ]);
      const created = (metaRes?.created ?? 0) + (googleRes?.created ?? 0);
      const skipped = (metaRes?.skipped ?? 0) + (googleRes?.skipped ?? 0);
      setBulkStatus(
        `✓ ${created} compte${created > 1 ? "s" : ""} ajouté${created > 1 ? "s" : ""}${
          skipped > 0 ? ` · ${skipped} déjà attribué${skipped > 1 ? "s" : ""}` : ""
        }`,
      );
      await load();
    } catch (e) {
      setBulkStatus(`Erreur · ${e instanceof Error ? e.message : "inconnu"}`);
    } finally {
      setBulkBusy(false);
    }
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

  async function changeRole(role: string) {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
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

  if (loading) return <div className="text-sm text-gray-500">Chargement…</div>;
  if (!user) return <div className="text-sm text-red-400">Utilisateur introuvable</div>;

  const mcpEnabled = new Set(user.mcpPermissions.map((p) => p.mcpServer));

  return (
    <div className="space-y-8">
      <div>
        <Link href="/admin" className="text-xs text-gray-400 hover:text-white hover:underline">
          ← Retour
        </Link>
        <h1 className="text-2xl font-bold text-white mt-2">{user.email}</h1>
        <div className="text-xs mt-1 text-gray-500 flex items-center gap-2">
          Rôle :
          <select
            value={user.role}
            onChange={(e) => changeRole(e.target.value)}
            className="px-2 py-1 rounded bg-gray-950 border border-gray-800 text-violet-300 text-xs focus:border-violet-500 focus:outline-none"
          >
            <option value="client">client</option>
            <option value="consultant">consultant</option>
            <option value="admin">admin</option>
          </select>
        </div>
      </div>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className={sectionTitleCls + " mb-0"}>Comptes publicitaires attribués</h2>
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              onClick={grantAllAccounts}
              disabled={bulkBusy}
              className={secondaryBtnCls + " disabled:opacity-50 disabled:cursor-wait"}
            >
              {bulkBusy ? "Attribution en cours…" : "Donner accès à tous les comptes"}
            </button>
            {bulkStatus && <span className="text-[11px] text-gray-400">{bulkStatus}</span>}
          </div>
        </div>
        <div className="flex flex-col gap-2 mb-4">
          {user.adAccounts.length === 0 && (
            <p className="text-sm text-gray-500">Aucun compte attribué.</p>
          )}
          {user.adAccounts.map((a) => (
            <Card key={a.id} padded className="flex items-center justify-between !p-3">
              <div className="flex items-center gap-3">
                <Pill tone="violet" className="uppercase font-bold tracking-wide">{a.platform}</Pill>
                <code className="text-sm text-white">{a.accountId}</code>
                {a.label && <span className="text-xs text-gray-400">— {a.label}</span>}
              </div>
              <button onClick={() => removeAdAccount(a.id)} className={dangerBtnCls}>
                Retirer
              </button>
            </Card>
          ))}
        </div>

        <Card padded>
          <form onSubmit={addAdAccount} className="flex flex-col gap-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <select
                value={addPlatform}
                onChange={(e) => {
                  setAddPlatform(e.target.value as "meta" | "google" | "tiktok");
                  setAddAccountId("");
                  setAddLabel("");
                  setPickerSearch("");
                }}
                className={inputCls}
              >
                {PLATFORMS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder={pickerEnabled ? "ID (auto-rempli depuis la liste)" : "ID compte"}
                value={addAccountId}
                onChange={(e) => setAddAccountId(e.target.value)}
                required
                readOnly={pickerEnabled}
                className={`${inputCls} md:col-span-2`}
              />
              <input
                type="text"
                placeholder="Label (ex: Nike FR)"
                value={addLabel}
                onChange={(e) => setAddLabel(e.target.value)}
                className={inputCls}
              />
            </div>

            {pickerEnabled && (
              <div className="flex flex-col gap-2">
                <input
                  type="text"
                  placeholder={`Rechercher un compte ${addPlatform === "meta" ? "Meta" : "Google Ads"} (nom ou ID)…`}
                  value={pickerSearch}
                  onChange={(e) => setPickerSearch(e.target.value)}
                  className={inputCls}
                />
                {currentLoading && (
                  <p className="text-xs text-gray-400">
                    Chargement des comptes{addPlatform === "google" ? " (peut prendre ~5s)" : ""}…
                  </p>
                )}
                {currentError && <p className="text-xs text-red-400">{currentError}</p>}
                {currentOptions && (
                  <div className="max-h-64 overflow-y-auto rounded-lg bg-gray-950 border border-gray-800">
                    {filteredOptions.length === 0 ? (
                      <p className="p-3 text-xs text-gray-500">
                        Aucun compte {pickerSearch ? "ne correspond" : "disponible"}.
                      </p>
                    ) : (
                      filteredOptions.map((opt) => {
                        const selected = addAccountId === opt.accountId;
                        return (
                          <button
                            type="button"
                            key={opt.accountId}
                            onClick={() => pickAccount(opt)}
                            className={`w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors border-b border-gray-800/60 last:border-0 ${
                              selected ? "bg-violet-500/15" : "hover:bg-gray-800/50"
                            }`}
                          >
                            <span className="flex-1 truncate">
                              <span className={selected ? "text-violet-300" : "text-white"}>{opt.name}</span>
                              {opt.currency && (
                                <span className="ml-2 text-xs text-gray-500">{opt.currency}</span>
                              )}
                            </span>
                            <code className="text-xs shrink-0 text-gray-400">{opt.accountId}</code>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            )}

            {addError && <p className="text-xs text-red-400">{addError}</p>}
            <button type="submit" className={`${primaryBtnCls} self-start`}>
              Ajouter le compte
            </button>
          </form>
        </Card>
      </section>

      <section>
        <h2 className={sectionTitleCls}>Serveurs MCP autorisés pour l&apos;IA</h2>
        <div className="flex flex-col gap-2">
          {MCP_SERVERS.map((s) => (
            <label key={s}>
              <Card padded className="!p-3 flex items-center gap-3 cursor-pointer hover:bg-gray-800/30">
                <input
                  type="checkbox"
                  checked={mcpEnabled.has(s)}
                  onChange={(e) => toggleMcp(s, e.target.checked)}
                  className="accent-violet-500"
                />
                <code className="text-sm text-white">{s}</code>
              </Card>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h2 className={sectionTitleCls}>Réinitialiser le mot de passe</h2>
        <form onSubmit={resetPassword} className="flex items-center gap-2">
          <input
            type="text"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Nouveau mot de passe (min 8)"
            className={`${inputCls} flex-1`}
          />
          <button type="submit" className={secondaryBtnCls}>
            Mettre à jour
          </button>
        </form>
        {passwordStatus && <p className="text-xs mt-2 text-gray-400">{passwordStatus}</p>}
      </section>
    </div>
  );
}
