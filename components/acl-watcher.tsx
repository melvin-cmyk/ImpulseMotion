"use client";

/**
 * Notices that an admin changed the viewer's role or ad accounts and brings
 * the open tab up to date — nobody has to sign out and in again.
 *
 * The session is re-read every 30 s and when the tab gets the focus back
 * (SessionProvider in app/layout.tsx). When its fingerprint changes, the
 * caches built for the old access are dropped, the lists that are on screen
 * reload (ACL_CHANGED_EVENT) and the server-rendered chrome is refreshed.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { ACL_CHANGED_EVENT } from "@/lib/acl-version";

const CACHE_PREFIXES = ["impulse_meta_accounts_preview"];

export function AclWatcher() {
  const { data: session } = useSession();
  const router = useRouter();
  const seen = useRef<string | null>(null);
  const current = session?.userId ? `${session.userId}|${session.role}|${session.aclVersion}` : null;

  useEffect(() => {
    if (!current) { seen.current = null; return; }
    const before = seen.current;
    seen.current = current;
    // First reading, or a session that does not carry a fingerprint yet: nothing to compare.
    if (!before || before === current || before.endsWith("|") || current.endsWith("|")) return;
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key && CACHE_PREFIXES.some((p) => key.startsWith(p))) sessionStorage.removeItem(key);
      }
    } catch { /* storage unavailable */ }
    window.dispatchEvent(new Event(ACL_CHANGED_EVENT));
    router.refresh();
  }, [current, router]);

  return null;
}
