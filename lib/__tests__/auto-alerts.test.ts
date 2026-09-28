import { describe, expect, it } from "vitest";
import {
  classifyStoppedAds, detectFromAccount, detectFromDays, detectFromPacing, fillDays, findStoppedAds, heavyAds, pruneFindings,
  type DayPoint, type Finding,
} from "@/lib/auto-alerts/detect";
import { planIncidents, type IncidentState } from "@/lib/auto-alerts/incidents";
import { enabledKinds, isDue, normalizeConfig, slotOf } from "@/lib/auto-alerts/config";
import { cleanChannel, linkStatus, matchChannels, type SlackChannel } from "@/lib/auto-alerts/slack";
import { buildDigest, hasNews } from "@/lib/auto-alerts/message";
import { parseMatches } from "@/lib/auto-alerts/match-ai";

const day = (i: number, spend: number, conversions = 0, revenue: number | null = null): DayPoint => ({
  date: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), spend, conversions, revenue,
});
const series = (spends: number[], conv: number[] = [], rev: Array<number | null> = []) => spends.map((s, i) => day(i, s, conv[i] ?? 0, rev[i] ?? null));
const kinds = (fs: Finding[]) => fs.map((f) => f.kind);

describe("detectFromDays", () => {
  it("stays silent on a steady account", () => {
    expect(detectFromDays({ platform: "meta", full: series([100, 110, 95, 105, 100, 98, 102, 101, 99, 104]), today: { spend: 40, hour: 10 }, currency: "EUR" })).toEqual([]);
  });

  it("raises a stop when yesterday is far under the baseline", () => {
    const f = detectFromDays({ platform: "meta", full: series([100, 100, 100, 100, 100, 100, 100, 100, 100, 0]), today: { spend: 0, hour: 9 }, currency: "EUR" });
    expect(kinds(f)).toEqual(["spend_stopped"]);
    expect(f[0].severity).toBe("critical");
    expect(f[0].needsAi).toBe(true);
  });

  it("raises a stop in the afternoon when today is still at zero", () => {
    const full = series([100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
    expect(kinds(detectFromDays({ platform: "google", full, today: { spend: 0, hour: 15 }, currency: "EUR" }))).toEqual(["spend_stopped"]);
    expect(detectFromDays({ platform: "google", full, today: { spend: 0, hour: 8 }, currency: "EUR" })).toEqual([]);
  });

  it("ignores accounts too small to matter", () => {
    expect(detectFromDays({ platform: "meta", full: series([3, 4, 2, 5, 3, 4, 2, 3, 4, 0]), today: null, currency: "EUR" })).toEqual([]);
  });

  it("raises a spike", () => {
    expect(kinds(detectFromDays({ platform: "meta", full: series([100, 100, 100, 100, 100, 100, 100, 100, 100, 400]), today: null, currency: "EUR" }))).toEqual(["spend_spike"]);
  });

  it("raises zero conversions while spending, and not the drift on top", () => {
    const f = detectFromDays({
      platform: "meta", today: null, currency: "EUR",
      full: series([100, 100, 100, 100, 100, 100, 100, 100, 100, 100], [5, 5, 5, 5, 5, 5, 5, 5, 0, 0]),
    });
    expect(kinds(f)).toEqual(["conversions_zero"]);
  });

  it("raises a drift on CPA and ROAS", () => {
    const f = detectFromDays({
      platform: "meta", today: null, currency: "EUR",
      full: series([100, 100, 100, 100, 100, 100, 100, 100, 100, 100], [5, 5, 5, 5, 5, 5, 5, 2, 2, 2], [400, 400, 400, 400, 400, 400, 400, 150, 150, 150]),
    });
    expect(kinds(f)).toEqual(["perf_drift"]);
    expect(f[0].detail).toContain("ROAS");
    expect(f[0].detail).toContain("CPA");
  });
});

describe("fillDays", () => {
  it("turns missing days into zeros", () => {
    const out = fillDays([day(0, 50), day(2, 60)], day(0, 0).date, day(3, 0).date);
    expect(out.map((d) => d.spend)).toEqual([50, 0, 60, 0]);
  });
});

describe("detectFromAccount", () => {
  it("says nothing on an active account", () => {
    expect(detectFromAccount({ accountStatus: 1, disableReason: 0, spendCap: 0, amountSpent: 5000 }, "EUR")).toEqual([]);
  });
  it("flags an unpaid account as critical", () => {
    const f = detectFromAccount({ accountStatus: 3, disableReason: 0, spendCap: null, amountSpent: null }, "EUR");
    expect(f[0].kind).toBe("account_blocked");
    expect(f[0].severity).toBe("critical");
    expect(f[0].needsAi).toBeUndefined();
  });
  it("flags a spend cap nearly reached", () => {
    expect(detectFromAccount({ accountStatus: 1, disableReason: 0, spendCap: 100_000, amountSpent: 92_000 }, "EUR")[0].severity).toBe("warning");
    expect(detectFromAccount({ accountStatus: 1, disableReason: 0, spendCap: 100_000, amountSpent: 99_500 }, "EUR")[0].severity).toBe("critical");
  });
});

describe("stopped ads", () => {
  const full = series([100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
  const heavy = heavyAds([{ adId: "a", spend: 350 }, { adId: "b", spend: 210 }, { adId: "c", spend: 14 }], full);

  it("keeps only the ads that carry budget", () => {
    expect(heavy.map((h) => h.adId)).toEqual(["a", "b"]);
  });

  it("leaves paused and ended ads alone, flags the unexplained and the rejected", () => {
    const cands = findStoppedAds(heavy, new Set());
    const now = new Date("2026-09-12T10:00:00Z");
    const active = classifyStoppedAds(cands, [
      { id: "a", name: "Vidéo UGC", effectiveStatus: "ACTIVE" },
      { id: "b", name: "Statique", effectiveStatus: "PAUSED" },
    ], "EUR", now);
    expect(active.map((f) => f.key)).toEqual(["meta:ad_stopped:a"]);
    expect(active[0].severity).toBe("critical"); // 50 % of the account

    const ended = classifyStoppedAds(cands, [{ id: "a", name: "Vidéo UGC", effectiveStatus: "ACTIVE", adsetEndTime: "2026-09-10T00:00:00+0000" }], "EUR", now);
    expect(ended).toEqual([]);

    const rejected = classifyStoppedAds(cands, [{ id: "b", name: "Statique", effectiveStatus: "DISAPPROVED", issue: "Texte trompeur" }], "EUR", now);
    expect(rejected[0].kind).toBe("ad_blocked");
    expect(rejected[0].detail).toContain("Texte trompeur");
  });

  it("does not flag an ad that spent yesterday", () => {
    expect(findStoppedAds(heavy, new Set(["a", "b"]))).toEqual([]);
  });
});

describe("pacing and pruning", () => {
  it("waits for 5 full days before judging the month", () => {
    const base = { status: "critical_over", pacingPct: 160, projectedSpend: 16000, monthlyTarget: 10000, currency: "EUR", daysInMonth: 30, month: "2026-09" };
    expect(detectFromPacing({ ...base, fullDays: 3 })).toEqual([]);
    expect(detectFromPacing({ ...base, fullDays: 12 })[0].key).toBe("meta:pacing:2026-09:over");
  });

  it("keeps the cause and drops its symptoms", () => {
    const f = (kind: Finding["kind"], severity: Finding["severity"] = "critical"): Finding => ({ key: `meta:${kind}`, scope: "meta:days", platform: "meta", kind, severity, title: kind, detail: "" });
    expect(kinds(pruneFindings([f("spend_stopped"), f("ad_stopped"), f("account_blocked")]))).toEqual(["account_blocked"]);
    expect(kinds(pruneFindings([f("pacing", "warning"), f("spend_stopped")]))).toEqual(["spend_stopped"]);
  });
});

describe("planIncidents", () => {
  const now = new Date("2026-09-28T09:00:00Z");
  const finding = (severity: Finding["severity"] = "critical"): Finding => ({ key: "meta:spend_stopped", scope: "meta:days", platform: "meta", kind: "spend_stopped", severity, title: "Dépense à l'arrêt", detail: "d" });
  const incident = (over: Partial<IncidentState> = {}): IncidentState => ({
    id: "i1", key: "meta:spend_stopped", scope: "meta:days", kind: "spend_stopped", severity: "critical", status: "open", title: "Dépense à l'arrêt", detail: "d",
    missCount: 0, remindCount: 0, notifiedAt: new Date("2026-09-28T06:00:00Z"), lastNotifiedAt: new Date("2026-09-28T06:00:00Z"), ...over,
  });
  const all = new Set(["meta:days", "meta:account", "meta:ads", "meta:pacing", "google:days"] as const);

  it("announces a new problem once", () => {
    const first = planIncidents([], [finding()], all, now);
    expect(first.announce.map((a) => a.reason)).toEqual(["new"]);
    const second = planIncidents([incident()], [finding()], all, now);
    expect(second.announce).toEqual([]);
    expect(second.touch).toHaveLength(1);
    expect(hasNews(second)).toBe(false);
  });

  it("speaks again when it gets worse", () => {
    const plan = planIncidents([incident({ severity: "warning" })], [finding("critical")], all, now);
    expect(plan.announce[0].reason).toBe("escalated");
  });

  it("reminds once after 3 days, then stays silent", () => {
    const old = new Date("2026-09-24T06:00:00Z");
    expect(planIncidents([incident({ notifiedAt: old, lastNotifiedAt: old })], [finding()], all, now).announce[0].reason).toBe("reminder");
    expect(planIncidents([incident({ notifiedAt: old, lastNotifiedAt: old, remindCount: 1 })], [finding()], all, now).announce).toEqual([]);
  });

  it("needs two clean runs to close, and says so only if it had been announced", () => {
    expect(planIncidents([incident()], [], all, now).miss).toEqual(["i1"]);
    const closed = planIncidents([incident({ missCount: 1 })], [], all, now);
    expect(closed.resolve[0].say).toBe(true);
    expect(planIncidents([incident({ missCount: 1, notifiedAt: null, lastNotifiedAt: null })], [], all, now).resolve[0].say).toBe(false);
  });

  it("does not close what could not be read", () => {
    const plan = planIncidents([incident({ missCount: 1 })], [], new Set(["meta:account"] as const), now);
    expect(plan.resolve).toEqual([]);
    expect(plan.miss).toEqual([]);
  });

  it("announces again a problem that comes back after being closed", () => {
    const plan = planIncidents([incident({ status: "resolved" })], [finding()], all, now);
    expect(plan.announce[0]).toMatchObject({ reason: "new", incidentId: "i1" });
  });

  it("builds one message per client", () => {
    const plan = planIncidents([], [finding()], all, now);
    const text = buildDigest({ clientName: "LPEV", plan, reading: "Vérifier le moyen de paiement.", link: "https://app/portfolio/x", stillOpen: 1 });
    expect(text).toContain("*LPEV* — 1 point à regarder");
    expect(text).toContain("Lecture");
    expect(text).toContain("1 autre point toujours en cours");
  });
});

describe("config", () => {
  it("defaults to everything, twice a day", () => {
    const c = normalizeConfig({});
    expect(c.frequency).toBe("2x");
    expect(enabledKinds(c).has("spend_stopped")).toBe(true);
  });
  it("drops the kinds of a topic switched off", () => {
    const c = normalizeConfig({ topics: { budget: false }, frequency: "nope" });
    expect(enabledKinds(c).has("pacing")).toBe(false);
    expect(c.frequency).toBe("2x");
  });
  it("maps a cron firing to its slot and respects the frequency", () => {
    expect(slotOf(new Date("2026-09-28T06:03:00Z"))).toBe(0);
    expect(slotOf(new Date("2026-09-28T12:10:00Z"))).toBe(2);
    expect(slotOf(new Date("2026-09-28T20:00:00Z"))).toBeNull();
    const at = (h: number) => new Date(Date.UTC(2026, 8, 28, h, 1));
    expect(isDue(normalizeConfig({ frequency: "1x" }), at(6))).toBe(true);
    expect(isDue(normalizeConfig({ frequency: "1x" }), at(12))).toBe(false);
    expect(isDue(normalizeConfig({ frequency: "2x" }), at(12))).toBe(true);
    expect(isDue(normalizeConfig({ frequency: "2x" }), at(9))).toBe(false);
    expect(isDue(normalizeConfig({ frequency: "4x" }), at(9))).toBe(true);
  });
  it("skips the weekend when asked", () => {
    const saturday = new Date("2026-09-26T06:01:00Z");
    expect(isDue(normalizeConfig({ weekdaysOnly: true }), saturday)).toBe(false);
    expect(isDue(normalizeConfig({}), saturday)).toBe(true);
  });
});

describe("slack", () => {
  const ch = (name: string, over: Partial<SlackChannel> = {}): SlackChannel => ({ id: `C${name.toUpperCase().replace(/[^A-Z0-9]/g, "").padEnd(9, "0")}`, name, isPrivate: false, isMember: false, ...over });

  it("cleans a channel name", () => {
    expect(cleanChannel("c_lpev")).toBe("#c_lpev");
    expect(cleanChannel("#c_lpev")).toBe("#c_lpev");
    expect(cleanChannel("C03MD0V37BN")).toBe("C03MD0V37BN");
    expect(cleanChannel("pas un canal")).toBeNull();
  });

  it("matches clients and channels by name", () => {
    const channels = [ch("c_saveurs-et-vie"), ch("c_lpev"), ch("c_cottonbird"), ch("c_leroy_merlin")];
    const { matches, unmatched } = matchChannels([
      { id: "1", name: "Saveurs & Vie" },
      { id: "2", name: "Leroy Merlin" },
      { id: "3", name: "Cotton Bird España" },
      { id: "4", name: "Cotton Bird Deutschland" },
      { id: "5", name: "ICN Business School" },
    ], channels);
    expect(matches.map((m) => [m.clientId, m.channel.name])).toEqual([["1", "c_saveurs-et-vie"], ["2", "c_leroy_merlin"]]);
    // Two clients claim c_cottonbird: left to a human.
    expect(unmatched.map((u) => u.id)).toEqual(["3", "4", "5"]);
  });

  it("tells whether the bot can write in the channel", () => {
    const channels = [ch("c_a", { isMember: true }), ch("c_b"), ch("c_c", { isPrivate: true })];
    expect(linkStatus({ slackChannel: "#c_a", slackChannelId: null }, channels).status).toBe("connected");
    expect(linkStatus({ slackChannel: "#c_b", slackChannelId: null }, channels).status).toBe("public");
    expect(linkStatus({ slackChannel: "#c_c", slackChannelId: null }, channels).status).toBe("absent");
    expect(linkStatus({ slackChannel: "#c_zzz", slackChannelId: null }, channels).status).toBe("absent");
    expect(linkStatus({ slackChannel: null, slackChannelId: null }, channels).status).toBe("none");
  });

  it("keeps only valid, unique AI matches", () => {
    const channels = [ch("c_icn"), ch("c_lm")];
    const raw = "```json\n" + JSON.stringify({ matches: [{ client: "5", channel: channels[0].id }, { client: "5", channel: channels[1].id }, { client: "x", channel: channels[1].id }] }) + "\n```";
    expect(parseMatches(raw, [{ id: "5" }], channels).map((m) => m.channel.name)).toEqual(["c_icn"]);
  });
});
