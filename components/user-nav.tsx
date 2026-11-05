"use client";

import { signOut } from "next-auth/react";
import type { Session } from "next-auth";
import Image from "next/image";

interface UserNavProps {
  session: Session & {
    provider?: string | null;
    accessToken?: string | null;
  };
}

const providerLabel = (provider: string | null | undefined) => {
  if (provider === "facebook") return { label: "Meta Ads", color: "bg-blue-500" };
  if (provider === "tiktok") return { label: "TikTok Ads", color: "bg-ui-raised border border-ui-line-strong" };
  return { label: "Connected", color: "bg-ui-line-strong" };
};

export function clearScopedStorage() {
  // Clear any client-side cache or selection that could leak across users
  // when the same browser tab signs out then signs back in as someone else.
  try {
    sessionStorage.clear();
  } catch { /* ignore */ }
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("impulse_")) keysToRemove.push(key);
    }
    for (const k of keysToRemove) localStorage.removeItem(k);
  } catch { /* ignore */ }
}

export function UserNav({ session }: UserNavProps) {
  const { label, color } = providerLabel(session.provider);
  const user = session.user;

  return (
    <div className="flex items-center gap-3">
      {/* Provider badge */}
      <span className={`text-xs px-2 py-0.5 rounded-full text-ui-fg2 ${color}`}>
        {label}
      </span>

      {/* Avatar + name */}
      <div className="flex items-center gap-2">
        {user?.image ? (
          <Image
            src={user.image}
            alt={user.name ?? "User"}
            width={28}
            height={28}
            className="rounded-full"
          />
        ) : (
          <div className="w-7 h-7 rounded-full bg-ui-accent flex items-center justify-center text-xs font-medium text-ui-on-accent">
            {(user?.name ?? "U")[0].toUpperCase()}
          </div>
        )}
        <span className="text-sm text-ui-fg2 hidden sm:block">
          {user?.name ?? "User"}
        </span>
      </div>

      {/* Sign out */}
      <button
        onClick={() => {
          clearScopedStorage();
          signOut({ callbackUrl: "/login" });
        }}
        className="text-xs text-ui-muted hover:text-ui-fg2 transition-colors ml-1"
      >
        Déconnexion
      </button>
    </div>
  );
}
