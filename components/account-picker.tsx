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
/**
 * `variant="workspace"`: Motion's workspace switcher (full-width pill with the
 * client's initial), used at the top of the Analyse Ads sidebar; `label`
 * overrides the account name (the client's name).
 */
export function AccountPicker({ variant = "default", label: labelOverride }: { variant?: "default" | "workspace"; label?: string | null } = {}) {
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

  const label = labelOverride ?? metaAccountName ?? metaAccountId ?? "Choisir un client";

  return (
    <>
      {variant === "workspace" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Changer de client (⌘K)"
          className="group w-full h-9 inline-flex items-center gap-2 rounded-[10px] border border-ui-line bg-ui-card pl-1.5 pr-2 text-sm text-ui-fg hover:border-ui-line-strong"
        >
          <span className="w-6 h-6 rounded-md bg-ui-accent text-ui-on-accent text-xs font-medium inline-flex items-center justify-center shrink-0">{(label.trim()[0] ?? "?").toUpperCase()}</span>
          <span className="flex-1 min-w-0 truncate text-left">{label}</span>
          <ChevronDown className="w-4 h-4 text-ui-muted group-hover:text-ui-fg2 shrink-0" />
        </button>
      ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Changer le compte analysé (⌘K)"
        className="group inline-flex items-center gap-2 rounded-lg border border-ui-line bg-ui-card pl-2 pr-2.5 py-1 text-sm text-ui-fg hover:border-ui-accent hover:bg-ui-raised transition-colors"
      >
        <span className="w-6 h-6 rounded-md bg-ui-accent-soft text-ui-accent-ink inline-flex items-center justify-center shrink-0">
          <Building2 className="w-3.5 h-3.5" />
        </span>
        <span className="flex flex-col items-start leading-tight">
          <span className="text-[10px] text-ui-muted">Compte analysé</span>
          <span className="max-w-[220px] truncate font-medium">{label}</span>
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-ui-muted group-hover:text-ui-fg2 shrink-0" />
      </button>
      )}

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
