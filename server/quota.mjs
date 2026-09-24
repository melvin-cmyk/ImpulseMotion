/**
 * Claude Max quota monitor + Bedrock fallback switch for the relay.
 *
 * The relay's CLI runs on the host's Claude Max subscription. Anthropic
 * exposes the subscription's utilisation (5-hour and 7-day windows, in %)
 * on the OAuth usage endpoint the CLI itself uses for `/usage`. The relay
 * polls it, warns on Slack at QUOTA_WARN_PCT, and above QUOTA_SWITCH_PCT
 * (or after a "usage limit" error from the CLI) routes every chat to
 * Amazon Bedrock until the window resets — nobody at the agency loses the
 * AI because the subscription ran dry in the afternoon.
 *
 * Notifications reuse the n8n alert webhook (same payload v1 as the app's
 * alert rules), so they land in the consultants' Slack channel with the
 * same look as any other alert.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export function createQuotaMonitor(opts = {}) {
  const credentialsPath = opts.credentialsPath || path.join(os.homedir(), ".claude", ".credentials.json");
  const warnPct = Number(opts.warnPct ?? 80);
  const switchPct = Number(opts.switchPct ?? 95);
  const log = opts.log || ((...a) => console.log("[quota]", ...a));
  const notify = opts.notify || (async () => {});

  const state = {
    fiveHour: null, // { utilization, resetsAt }
    sevenDay: null,
    checkedAt: null,
    error: null,
    /** Set by markExhausted(): Bedrock until then, whatever the probe says. */
    exhaustedUntil: 0,
    exhaustedReason: null,
    /** false when the token cannot read the usage endpoint (setup-token scope). */
    usageVisible: null,
    /** Dedup of Slack notices: one warn and one switch per 5-hour window. */
    warnedFor: null,
    switchedFor: null,
  };

  // Which subscription this monitor watches: the host's CLI login by
  // default, or a long-lived OAuth token (`claude setup-token`) for the
  // other Max accounts of the pool (server/max-accounts.mjs).
  const label = opts.label || "Claude Max";
  function readToken() {
    if (typeof opts.readToken === "function") return opts.readToken();
    const raw = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    const t = raw?.claudeAiOauth?.accessToken;
    if (!t) throw new Error("no claudeAiOauth.accessToken in credentials");
    return t;
  }

  const pct = (w) => (w && typeof w.utilization === "number" ? w.utilization : 0);
  const windowKey = () => state.fiveHour?.resetsAt ?? "none";

  function level() {
    return Math.max(pct(state.fiveHour), pct(state.sevenDay));
  }

  function fallbackActive() {
    if (state.exhaustedUntil > Date.now()) return true;
    return level() >= switchPct;
  }

  let refreshedAt = 0;
  async function probe(retried = false) {
    try {
      const res = await fetch(USAGE_URL, {
        headers: { Authorization: `Bearer ${readToken()}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 && !retried && typeof opts.refresh === "function" && Date.now() - refreshedAt > 60 * 60 * 1000) {
        // Access token expired while the account sat idle: let the CLI
        // refresh it (one tiny turn), then read the new token once.
        refreshedAt = Date.now();
        log(`${label}: jeton expiré, rafraîchissement`);
        await opts.refresh();
        return probe(true);
      }
      if (res.status === 429) {
        // Probing too often (three accounts, tests): keep the last reading.
        state.checkedAt = new Date().toISOString();
        return snapshot();
      }
      if (res.status === 403) {
        // `claude setup-token` tokens carry the inference scope only: the
        // usage endpoint refuses them. The account stays usable; exhaustion
        // is then learnt from the CLI's own errors (markExhausted).
        state.usageVisible = false;
        state.checkedAt = new Date().toISOString();
        state.error = null;
        return snapshot();
      }
      if (!res.ok) throw new Error(`usage endpoint ${res.status}`);
      state.usageVisible = true;
      const j = await res.json();
      const pick = (w) => (w ? { utilization: Number(w.utilization) || 0, resetsAt: w.resets_at || null } : null);
      state.fiveHour = pick(j.five_hour);
      state.sevenDay = pick(j.seven_day);
      state.checkedAt = new Date().toISOString();
      state.error = null;
      // A new 5-hour window clears the manual exhaustion flag and the notices.
      if (state.exhaustedUntil && state.fiveHour?.resetsAt && new Date(state.fiveHour.resetsAt).getTime() > state.exhaustedUntil) {
        state.exhaustedUntil = 0;
        state.exhaustedReason = null;
      }
      await evaluate();
    } catch (e) {
      state.error = e.message;
      log("probe failed:", e.message);
    }
    return snapshot();
  }

  async function evaluate() {
    const lvl = level();
    const key = windowKey();
    if (lvl >= switchPct && state.switchedFor !== key) {
      state.switchedFor = key;
      log(`${label}: switch (${lvl}% ≥ ${switchPct}%)`);
      await notify({
        kind: "switch",
        message: `${label} à ${lvl}% (5 h : ${pct(state.fiveHour)}%, 7 j : ${pct(state.sevenDay)}%). Les chats et rapports basculent sur Amazon Bedrock jusqu'à la remise à zéro (${fmt(state.fiveHour?.resetsAt)}).`,
        value: lvl,
      });
    } else if (lvl >= warnPct && lvl < switchPct && state.warnedFor !== key) {
      state.warnedFor = key;
      log(`${label}: warn (${lvl}% ≥ ${warnPct}%)`);
      await notify({
        kind: "warn",
        message: `${label} à ${lvl}% (5 h : ${pct(state.fiveHour)}%, remise à zéro ${fmt(state.fiveHour?.resetsAt)} ; 7 j : ${pct(state.sevenDay)}%). Bascule automatique sur Bedrock à ${switchPct}%.`,
        value: lvl,
      });
    }
  }

  /** Called when the CLI itself reports a usage limit: switch now, until the window resets. */
  async function markExhausted(reason) {
    const resetsAt = state.fiveHour?.resetsAt ? new Date(state.fiveHour.resetsAt).getTime() : 0;
    state.exhaustedUntil = Math.max(resetsAt, Date.now() + 30 * 60 * 1000);
    state.exhaustedReason = String(reason || "usage limit").slice(0, 300);
    const key = windowKey();
    if (state.switchedFor !== key) {
      state.switchedFor = key;
      log(`${label}: exhausted:`, state.exhaustedReason);
      await notify({
        kind: "switch",
        message: `${label} : le CLI Claude a refusé une requête (quota atteint : « ${state.exhaustedReason.slice(0, 120)} »). Les chats et rapports basculent sur Amazon Bedrock jusqu'à ${fmt(new Date(state.exhaustedUntil).toISOString())}.`,
        value: level(),
      });
    }
  }

  function snapshot() {
    return {
      fiveHour: state.fiveHour,
      sevenDay: state.sevenDay,
      checkedAt: state.checkedAt,
      error: state.error,
      level: level(),
      warnPct,
      switchPct,
      fallbackActive: fallbackActive(),
      usageVisible: state.usageVisible,
      exhaustedUntil: state.exhaustedUntil ? new Date(state.exhaustedUntil).toISOString() : null,
      exhaustedReason: state.exhaustedReason,
    };
  }

  function start(intervalMs) {
    void probe();
    const t = setInterval(() => void probe(), intervalMs);
    t.unref?.();
    return t;
  }

  return { probe, evaluate, markExhausted, fallbackActive, level, snapshot, start, state, label };
}

/** True when a CLI error text looks like a subscription usage limit. */
export function looksLikeUsageLimit(text) {
  const t = String(text || "");
  return /usage limit|rate limit|hit your limit|limit reached|out of (extra )?usage|quota/i.test(t) && !/max[- ]turns/i.test(t);
}

function fmt(iso) {
  if (!iso) return "prochaine fenêtre";
  try {
    return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Posts a quota notice through the n8n alert webhook (payload v1, same as the app's alert rules). */
export function makeWebhookNotifier({ url, secret, slackChannel, appUrl }) {
  if (!url || !slackChannel) return async () => {};
  return async ({ kind, message, value }) => {
    const payload = {
      version: 1,
      event: {
        id: `quota-${kind}-${Date.now()}`,
        triggeredAt: new Date().toISOString(),
        metric: "claude_max_usage",
        condition: "above",
        threshold: 0,
        value,
        window: "5h",
        message,
        accountId: "claude-max",
        accountLabel: "Abonnement Claude Max (relay)",
        platform: "system",
        entityLevel: null,
        entityName: null,
      },
      rule: { id: "quota", ownerEmail: null, ownerName: null, label: kind === "switch" ? "Bascule Bedrock" : "Quota Claude Max", mode: "system" },
      notify: { slackChannel, emails: [] },
      links: { alerts: `${appUrl}/admin/usage`, event: `${appUrl}/admin/usage` },
    };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(secret ? { "X-Alert-Secret": secret } : {}) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.error(`[quota] notify ${res.status}`);
    } catch (e) {
      console.error("[quota] notify failed:", e.message);
    }
  };
}
