import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/relay-tool", () => ({ relayDirectTool: vi.fn() }));

import { googleCustomerDigits, googleMutation, microsToMinor, minorToMicros } from "@/lib/pilot/google";
import { describeOperation, prepareOperation, type PilotObjectState } from "@/lib/pilot/ops";
import {
  buildPilotTurnContext, extractPilotProposals, stripPilotBlocks, validatePilotProposal, PILOT_CONTEXT_MAX_CHARS, type ContextAccount,
} from "@/lib/pilot/assistant";

const campaign = (over: Partial<PilotObjectState> = {}): PilotObjectState => ({
  id: "111", type: "campaign", accountId: "1234567890", name: "Search Marque", status: "ACTIVE", effectiveStatus: "ACTIVE",
  dailyBudget: 5000, lifetimeBudget: null, endTime: null, bidAmount: null, parentName: "", budgetLock: null, endTimeLock: "date gérée dans Google Ads.", ...over,
});

describe("Google Ads — conversions et opérations", () => {
  it("lit un identifiant client avec ou sans tirets", () => {
    expect(googleCustomerDigits("123-456-7890")).toBe("1234567890");
    expect(googleCustomerDigits("act_123")).toBeNull();
  });

  it("micros ↔ centimes, arrondi au centime", () => {
    expect(microsToMinor(12_340_000, "EUR")).toBe(1234);
    expect(microsToMinor(500_000_000, "JPY")).toBe(500);
    expect(minorToMicros(1234, "EUR")).toBe(12_340_000);
    expect(minorToMicros(500, "JPY")).toBe(500_000_000);
  });

  it("statut, nom, enchère et budget deviennent des opérations mutate", () => {
    expect(googleMutation("1234567890", "111", "campaign", "status", "PAUSED", "EUR")).toEqual({
      resource: "campaigns", operation: { update: { resourceName: "customers/1234567890/campaigns/111", status: "PAUSED" }, updateMask: "status" },
    });
    expect(googleMutation("1234567890", "222", "adset", "status", "DELETED", "EUR")).toEqual({ resource: "adGroups", operation: { remove: "customers/1234567890/adGroups/222" } });
    expect(googleMutation("1234567890", "222", "adset", "bid_amount", 150, "EUR")).toMatchObject({ operation: { update: { cpcBidMicros: "1500000" }, updateMask: "cpc_bid_micros" } });
    expect(googleMutation("1234567890", "111", "campaign", "daily_budget", 7000, "EUR", "customers/1234567890/campaignBudgets/9")).toEqual({
      resource: "campaignBudgets", operation: { update: { resourceName: "customers/1234567890/campaignBudgets/9", amountMicros: "70000000" }, updateMask: "amount_micros" },
    });
  });

  it("refuse un budget d'un autre client, une annonce ou un champ inconnu", () => {
    expect(googleMutation("1234567890", "111", "campaign", "daily_budget", 7000, "EUR", "customers/999/campaignBudgets/9")).toBeNull();
    expect(googleMutation("1234567890", "111", "ad", "status", "PAUSED", "EUR")).toBeNull();
    expect(googleMutation("1234567890", "111", "campaign", "end_time", "2026-12-01", "EUR")).toBeNull();
  });

  it("budget partagé et date de fin : refusés avec la raison ; libellés Google", () => {
    const shared = prepareOperation({ kind: "set_daily_budget", objectType: "campaign", objectId: "111", value: 80 }, campaign({ budgetLock: "budget partagé." }), "EUR", new Date(), "google");
    expect(shared).toEqual({ ok: false, error: "la campagne « Search Marque » : budget partagé." });
    const end = prepareOperation({ kind: "set_end_time", objectType: "campaign", objectId: "111", value: "2027-01-01T00:00:00Z" }, campaign(), "EUR", new Date(), "google");
    expect(end.ok).toBe(false);
    const ad = prepareOperation({ kind: "set_status", objectType: "ad", objectId: "111", value: "PAUSED" }, { ...campaign(), type: "ad" }, "EUR", new Date(), "google");
    expect(ad.ok).toBe(false);
    const ok = prepareOperation({ kind: "set_daily_budget", objectType: "campaign", objectId: "111", value: 60 }, campaign(), "EUR", new Date(), "google");
    expect(ok).toMatchObject({ ok: true, op: { field: "daily_budget", before: 5000, after: 6000, double: null } });
    expect(describeOperation({ kind: "set_status", objectType: "adset", objectName: "Groupe A", field: "status", before: "ACTIVE", after: "PAUSED" }, "EUR", "google")).toContain("Groupe d'annonces « Groupe A »");
  });
});

describe("IA du pilotage — propositions", () => {
  const text = `Je propose de baisser le budget.

\`\`\`pilot
{"platform":"google","accountId":"123-456-7890","why":"CPA trop haut","requests":[{"kind":"set_daily_budget","objectType":"campaign","objectId":"11111111","value":40,"label":"Search Marque : 50 → 40 €/j"}]}
\`\`\`

Et sur Meta :

\`\`\`pilot
{"platform":"meta","accountId":"act_42","requests":[{"kind":"set_status","objectType":"adset","objectId":"777777","value":"PAUSED"}]}
\`\`\`

\`\`\`pilot
{pas du json}
\`\`\``;

  it("lit chaque bloc, garde les libellés, signale un bloc illisible", () => {
    const list = extractPilotProposals(text);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ ok: true, proposal: { platform: "google", accountId: "123-456-7890", why: "CPA trop haut", labels: ["Search Marque : 50 → 40 €/j"] } });
    expect(list[1]).toMatchObject({ ok: true, proposal: { platform: "meta", requests: [{ kind: "set_status", value: "PAUSED" }] } });
    expect(list[2].ok).toBe(false);
    expect(stripPilotBlocks(text)).toBe("Je propose de baisser le budget.\n\nEt sur Meta :");
  });

  it("refuse un compte qui n'est pas au client, un objet inconnu, un réglage en double", () => {
    const same = (p: string, a: string, b: string) => a.replace(/\D/g, "") === b.replace(/\D/g, "");
    const [g] = extractPilotProposals(text).map((p) => (p.ok ? p.proposal : null));
    expect(validatePilotProposal(g!, [{ platform: "google", accountId: "1234567890" }], same)).toEqual({ ok: true });
    expect(validatePilotProposal(g!, [{ platform: "meta", accountId: "1234567890" }], same).ok).toBe(false);
    expect(validatePilotProposal(g!, [{ platform: "google", accountId: "1234567890", objectIds: new Set(["999"]) }], same).ok).toBe(false);
    const twice = { ...g!, requests: [g!.requests[0], g!.requests[0]] };
    expect(validatePilotProposal(twice, [{ platform: "google", accountId: "1234567890" }], same).ok).toBe(false);
  });

  it("le contexte tient dans la limite et dit quand un compte est illisible", () => {
    const big: ContextAccount = {
      platform: "meta", accountId: "42", name: "Client FR", currency: "EUR", error: null, writesOpen: true,
      campaigns: Array.from({ length: 400 }, (_, i) => ({
        id: String(1000 + i), name: `Campagne ${i} `.repeat(4), status: "ACTIVE", effectiveStatus: i % 2 ? "ACTIVE" : "PAUSED",
        dailyBudget: 5000, lifetimeBudget: null, bidAmount: null, bidStrategy: null, budgetLock: null, parentId: null, spend7d: i,
        last7: { spend: i, conversions: 2, cpa: i / 2, roas: 1.5, roasAvailable: true }, prev7: null,
      })),
      adsets: [],
    };
    const down: ContextAccount = { platform: "google", accountId: "1234567890", name: "Client Search", currency: null, error: "Google Ads ne répond pas", writesOpen: false, campaigns: [], adsets: [] };
    const ctx = buildPilotTurnContext("Client", [big, down], "lundi 5 octobre 2026");
    expect(ctx.length).toBeLessThanOrEqual(PILOT_CONTEXT_MAX_CHARS);
    expect(ctx).toContain("Compte illisible pour le moment : Google Ads ne répond pas");
    expect(ctx).toContain("envoi vers cette plateforme pas encore ouvert");
    // Active and spending campaigns come first.
    expect(ctx).toContain("[1399]");
    expect(ctx).not.toContain("[1000]");
    expect(ctx).toMatch(/campagne\(s\) en pause ou sans dépense non détaillée/);
  });
});
