"use client";

import { signOut } from "next-auth/react";
import type { Session } from "next-auth";
import { clearScopedStorage } from "@/components/user-nav";

/** Account corner of the client chrome: initial, name, sign out. */
export function ClientUserNav({ session }: { session: Session }) {
  const name = session.user?.name || session.user?.email || "Compte";
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        <span className="w-7 h-7 rounded-full bg-ui-raised text-ui-fg2 flex items-center justify-center text-xs font-medium" aria-hidden>
          {name[0].toUpperCase()}
        </span>
        <span className="text-sm text-ui-fg2 hidden sm:block max-w-48 truncate">{name}</span>
      </div>
      <button
        type="button"
        onClick={() => { clearScopedStorage(); void signOut({ callbackUrl: "/login" }); }}
        className="text-xs text-ui-muted hover:text-ui-fg transition-colors duration-150"
      >
        Déconnexion
      </button>
    </div>
  );
}
