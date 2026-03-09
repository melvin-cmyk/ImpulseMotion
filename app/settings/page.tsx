"use client";

import { useState } from "react";
import { Settings, User, Bell, Link2, Check, ChevronRight } from "lucide-react";

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

function IntegrationCard({
  platform,
  color,
  permissions,
  connected,
}: {
  platform: string;
  color: string;
  permissions: string[];
  connected: boolean;
}) {
  const [isConnected, setIsConnected] = useState(connected);
  const [showTooltip, setShowTooltip] = useState(false);

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

        <div className="relative">
          <button
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
            onClick={() => setIsConnected((v) => !v)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
              isConnected
                ? "bg-gray-800 hover:bg-gray-700 text-gray-300"
                : "bg-violet-600 hover:bg-violet-500 text-white"
            }`}
          >
            {isConnected ? "Disconnect" : "Connect"}
          </button>
          {showTooltip && !isConnected && (
            <div className="absolute right-0 top-10 z-10 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 w-48 shadow-lg">
              OAuth flow — requires App Review in production
            </div>
          )}
        </div>
      </div>

      {isConnected && (
        <div className="mb-4 p-3 bg-green-900/20 border border-green-800/40 rounded-xl flex items-center gap-2 text-xs text-green-300">
          <Check className="w-3.5 h-3.5" />
          Account connected successfully. Data syncing in real-time.
        </div>
      )}

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
            App ID
          </label>
          <input
            type="text"
            placeholder={`${platform.toLowerCase()}_app_••••••••`}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-400 placeholder-gray-600 outline-none focus:border-violet-500 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
            App Secret
          </label>
          <input
            type="password"
            placeholder="••••••••••••••••"
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-400 placeholder-gray-600 outline-none focus:border-violet-500 transition-colors"
          />
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-gray-800">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Permissions</p>
        <div className="flex flex-wrap gap-2">
          {permissions.map((p) => (
            <span key={p} className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700 font-mono">
              {p}
            </span>
          ))}
        </div>
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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <IntegrationCard
            platform="Meta"
            color="bg-blue-600"
            permissions={["ads_read", "ads_management", "business_management"]}
            connected={false}
          />
          <IntegrationCard
            platform="TikTok"
            color="bg-gradient-to-br from-pink-600 to-red-600"
            permissions={["tiktok_business_manager_read", "tiktok_business_manager_write"]}
            connected={false}
          />
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
            Notifications are sent to <span className="text-gray-400">{notifEmail || "your account email"}</span>.
            Real-time alerts require Meta / TikTok integrations to be active.
          </p>
        </div>
      )}
    </div>
  );
}
