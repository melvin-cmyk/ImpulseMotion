"use client";

import { useEffect, useState } from "react";
import { Building2, ChevronDown } from "lucide-react";
import { useSession } from "next-auth/react";
import { useCreativesContext, setStoredMetaAccount } from "@/lib/creatives-context";
import { useAccountList, normalizeAct } from "@/lib/use-account-list";
import { AccountPalette } from "@/components/account-palette";
import { useRouter } from "next/navigation";

/**
 * "Compte analysé" control of the Analyse Ads section — the only place where
 * the selected account has an effect, so the only place it is shown.
 * Persists to localStorage (read by CreativesProvider) and auto-selects the
 * first allowed account on a fresh login. ⌘K also opens it (see
 * components/command-palette.tsx).
 */
export function AccountPicker() {
  const { data: session } = useSession();
  const userId = session?.userId ?? null;
  const router = useRouter();
  const { metaAccountId, metaAccountName } = useCreativesContext();
  const [open, setOpen] = useState(false);
  const { accounts, loading, reload } = useAccountList(userId);

  // Reconcile on load: keep the stored account when still allowed, otherwise
  // fall back to the first allowed one (fresh login, revoked access…).
  useEffect(() => {
    if (accounts.length === 0) return;
    const isAllowed = metaAccountId
      ? accounts.some((a) => normalizeAct(a.id) === normalizeAct(metaAccountId) && !a.outOfScope)
      : false;
    if (isAllowed) return;
    const first = accounts.find((a) => !a.outOfScope);
    if (first) setStoredMetaAccount(first.id, first.name);
  }, [accounts, metaAccountId]);

  // Refresh the list when opening (cache is 5 min).
  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  const label = metaAccountName ?? metaAccountId ?? "Choisir un compte";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Changer le compte analysé (⌘K)"
        className="group inline-flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 pl-2 pr-2.5 py-1 text-sm text-gray-200 hover:border-violet-500/50 hover:bg-gray-900/80 transition-colors"
      >
        <span className="w-6 h-6 rounded-md bg-violet-500/15 text-violet-300 inline-flex items-center justify-center shrink-0">
          <Building2 className="w-3.5 h-3.5" />
        </span>
        <span className="flex flex-col items-start leading-tight">
          <span className="text-[10px] uppercase tracking-wider text-gray-500">Compte analysé</span>
          <span className="max-w-[220px] truncate font-medium">{label}</span>
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-gray-500 group-hover:text-gray-300 shrink-0" />
      </button>

      <AccountPalette
        open={open}
        onClose={() => setOpen(false)}
        accounts={accounts}
        loading={loading}
        currentId={metaAccountId}
        primary="analyse"
        title="Changer le compte analysé…"
        onPick={(a, action) => {
          setOpen(false);
          if (action === "client" && a.clientId) {
            router.push(`/portfolio/${a.clientId}`);
            return;
          }
          setStoredMetaAccount(a.id, a.name);
        }}
      />
    </>
  );
}
