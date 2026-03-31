"use client";

import { useState, useEffect } from "react";
import { Settings, User, Bell, Link2, Check, ChevronRight, Loader2, AlertCircle } from "lucide-react";

type Tab = "integrations" | "account" | "notifications";

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-6 rounded-full transition-colors ${checked ? "bg-violet-600" : "bg-gray-700"}`}
    >
      <span
        className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${
          checked ? "translate-x-5" : "translate-x-1"
        }`}
      />
    </button>
  );
}

interface AdAccount {
  id: string;
  name: string;
  currency?: string;
}

function GoogleAdsCard() {
  const [status, setStatus] = useState<"loading" | "connected" | "disconnected">("loading");
  const [accountCount, setAccountCount] = useState(0);

  useEffect(() => {
    fetch("/api/deck/clients")
      .then(r => r.json())
      .then((data: { clients?: Array<{ platform: string }> }) => {
        const googleAccounts = (data.clients ?? []).filter(c => c.platform === "google" || c.platform === "both");
        setAccountCount(googleAccounts.length);
        setStatus(googleAccounts.length > 0 ? "connected" : "disconnected");
      })
      .catch(() => setStatus("disconnected"));
  }, []);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm bg-green-600">G</div>
          <div>
            <h3 className="font-semibold text-white">Google Ads</h3>
            <p className={`text-xs ${status === "connected" ? "text-green-400" : status === "loading" ? "text-gray-500" : "text-amber-400"}`}>
              {status === "loading" ? "● Vérification…" : status === "connected" ? `● Connecté via MCP Relay (${accountCount} compte${accountCount > 1 ? "s" : ""})` : "● Non connecté — relay inactif"}
            </p>
          </div>
        </div>
      </div>
      <div className="text-xs text-gray-500 leading-relaxed">
        Google Ads est accédé via le MCP Relay. Aucune OAuth requise — les données sont récupérées automatiquement via le relay local si disponible.
      </div>
    </div>
  );
}

function IntegrationCard({
  platform,
  color,
  permissions,
  apiPath,
  storageKey,
}: {
  platform: "Meta" | "TikTok";
  color: string;
  permissions: string[];
  apiPath: string;
  storageKey: string;
}) {
  const [isConnected, setIsConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [accounts, setAccounts] = useState<AdAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  // On mount, check if we have a stored account
  useEffect(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      try {
        const data = JSON.parse(stored);
        setSelectedAccount(data.accountId ?? "");
        setIsConnected(true);
      } catch {}
    }
  }, [storageKey]);

  async function handleConnect() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiPath);
      if (res.status === 401) {
        // Redirect to OAuth — in production this would be NextAuth signIn
        const provider = platform === "Meta" ? "facebook" : "tiktok";
        window.location.href = `/api/auth/signin/${provider}?callbackUrl=/settings`;
        return;
      }
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to connect");
      }
      const data: AdAccount[] = await res.json();
      setAccounts(data);
      setIsConnected(true);
      if (data.length > 0) {
        setSelectedAccount(data[0].id);
        localStorage.setItem(storageKey, JSON.stringify({ accountId: data[0].id, accountName: data[0].name }));
      }
    } catch (err) {
      // If fetch fails (not authenticated), redirect to OAuth
      const provider = platform === "Meta" ? "facebook" : "tiktok";
      window.location.href = `/api/auth/signin/${provider}?callbackUrl=/settings`;
    } finally {
      setLoading(false);
    }
  }

  function handleDisconnect() {
    localStorage.removeItem(storageKey);
    setIsConnected(false);
    setAccounts([]);
    setSelectedAccount("");
    setError(null);
  }

  function handleAccountChange(accountId: string) {
    setSelectedAccount(accountId);
    const account = accounts.find((a) => a.id === accountId);
    if (account) {
      localStorage.setItem(storageKey, JSON.stringify({ accountId, accountName: account.name }));
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm ${color}`}>
            {platform[0]}
          </div>
          <div>
            <h3 className="font-semibold text-white">{platform} Ads</h3>
            <p className={`text-xs ${isConnected ? "text-green-400" : "text-gray-500"}`}>
              {isConnected ? "● Connected" : "● Not connected"}
            </p>
          </div>
        </div>

        <button
          onClick={isConnected ? handleDisconnect : handleConnect}
          disabled={loading}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors flex items-center gap-2 ${
            isConnected
              ? "bg-gray-800 hover:bg-gray-700 text-gray-300"
              : "bg-violet-600 hover:bg-violet-500 text-white"
          } disabled:opacity-50`}
        >
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {isConnected ? "Disconnect" : "Connect via OAuth"}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-900/20 border border-red-800/40 rounded-xl flex items-center gap-2 text-xs text-red-300">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          {error}
        </div>
      )}

      {isConnected && (
        <div className="mb-4 p-3 bg-green-900/20 border border-green-800/40 rounded-xl flex items-center gap-2 text-xs text-green-300">
          <Check className="w-3.5 h-3.5" />
          Account connected. Data syncing in real-time.
        </div>
      )}

      {isConnected && accounts.length > 0 && (
        <div className="mb-4">
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
            Ad Account
          </label>
          <select
            value={selectedAccount}
            onChange={(e) => handleAccountChange(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 outline-none focus:border-violet-500 transition-colors"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} {a.currency ? `(${a.currency})` : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      {isConnected && selectedAccount && accounts.length === 0 && (
        <div className="mb-4 bg-gray-800/60 rounded-xl px-3 py-2 text-xs text-gray-400">
          Account ID: <span className="text-violet-300 font-mono">{selectedAccount}</span>
        </div>
      )}

      <div className="mt-4 pt-4 border-t border-gray-800">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Required Permissions</p>
        <div className="flex flex-wrap gap-2">
          {permissions.map((p) => (
            <span key={p} className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700 font-mono">
              {p}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-gray-800">
        <p className="text-xs text-gray-600">
          {platform === "Meta"
            ? "Create your app at developers.facebook.com — set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in .env.local"
            : "Create your app at ads.tiktok.com/marketing_api/apps — set TIKTOK_APP_ID and TIKTOK_APP_SECRET in .env.local"}
        </p>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("integrations");
  const [fatigueAlerts, setFatigueAlerts] = useState(true);
  const [weeklyReport, setWeeklyReport] = useState(false);
  const [notifEmail, setNotifEmail] = useState("jordan@company.com");

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "integrations", label: "Integrations", icon: Link2 },
    { id: "account", label: "Account", icon: User },
    { id: "notifications", label: "Notifications", icon: Bell },
  ];

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Settings className="w-5 h-5 text-violet-400" />
        <h1 className="text-2xl font-bold text-white">Settings</h1>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === id ? "bg-violet-600 text-white" : "text-gray-400 hover:text-white"
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Integrations */}
      {tab === "integrations" && (
        <div className="space-y-4">
          <div className="bg-blue-900/10 border border-blue-800/30 rounded-xl p-4 text-sm text-blue-300">
            <p className="font-semibold mb-1">Configuration requise</p>
            <p className="text-xs text-blue-400 leading-relaxed">
              Pour connecter vos comptes publicitaires, configurez d&apos;abord vos variables d&apos;environnement
              (<code className="font-mono bg-blue-900/30 px-1 rounded">.env.local</code>).
              Voir <code className="font-mono bg-blue-900/30 px-1 rounded">.env.local.example</code> pour la liste complète.
            </p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <IntegrationCard
              platform="Meta"
              color="bg-blue-600"
              permissions={["ads_read", "ads_management"]}
              apiPath="/api/meta/accounts"
              storageKey="impulse_meta_account"
            />
            <IntegrationCard
              platform="TikTok"
              color="bg-gradient-to-br from-pink-600 to-red-600"
              permissions={["advertiser.read", "reporting.read"]}
              apiPath="/api/tiktok/accounts"
              storageKey="impulse_tiktok_account"
            />
            <GoogleAdsCard />
          </div>
        </div>
      )}

      {/* Account */}
      {tab === "account" && (
        <div className="max-w-lg space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <div className="flex items-center gap-4 mb-5">
              <div className="w-14 h-14 rounded-full bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center text-xl font-bold text-white">
                JD
              </div>
              <div>
                <h3 className="font-semibold text-white text-lg">Jordan Dupont</h3>
                <p className="text-gray-400 text-sm">jordan@company.com</p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                  Full Name
                </label>
                <input
                  type="text"
                  defaultValue="Jordan Dupont"
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 outline-none focus:border-violet-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  defaultValue="jordan@company.com"
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 outline-none focus:border-violet-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                  Role
                </label>
                <input
                  type="text"
                  defaultValue="Media Buyer"
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 outline-none focus:border-violet-500 transition-colors"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-5">
              <button className="px-4 py-2 rounded-xl text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors">
                Save Changes
              </button>
              <button className="px-4 py-2 rounded-xl text-sm font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors">
                Change Password
              </button>
            </div>
          </div>

          <div className="bg-gray-900 border border-red-900/40 rounded-2xl p-5">
            <h3 className="font-semibold text-white mb-1">Danger Zone</h3>
            <p className="text-gray-500 text-sm mb-4">Actions that cannot be undone.</p>
            <button className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-red-400 hover:bg-red-900/20 border border-red-900/40 transition-colors">
              Sign Out
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Notifications */}
      {tab === "notifications" && (
        <div className="max-w-lg space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-5">
            <h3 className="font-semibold text-white">Email Notifications</h3>

            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                Notification Email
              </label>
              <input
                type="email"
                value={notifEmail}
                onChange={(e) => setNotifEmail(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 outline-none focus:border-violet-500 transition-colors"
              />
            </div>

            <div className="flex items-center justify-between py-3 border-t border-gray-800">
              <div>
                <p className="text-sm font-medium text-gray-200">Fatigue Alerts</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Email when a creative&apos;s CPA rises more than 20% in 48h
                </p>
              </div>
              <Toggle checked={fatigueAlerts} onChange={setFatigueAlerts} />
            </div>

            <div className="flex items-center justify-between py-3 border-t border-gray-800">
              <div>
                <p className="text-sm font-medium text-gray-200">Weekly Report</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Receive a summary of top / worst performing creatives every Monday
                </p>
              </div>
              <Toggle checked={weeklyReport} onChange={setWeeklyReport} />
            </div>
          </div>

          <p className="text-xs text-gray-600 px-1">
            Notifications sent to <span className="text-gray-400">{notifEmail || "your account email"}</span>.
            Real-time alerts require Meta / TikTok integrations to be active.
          </p>
        </div>
      )}
    </div>
  );
}
