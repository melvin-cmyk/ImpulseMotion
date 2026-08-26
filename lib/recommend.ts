import {
  getAds,
  getAdInsights,
  getAccountInsights,
  computeRoas,
  computeCpa,
  getMetaSystemToken,
  type MetaCreativeInsight,
} from "@/lib/meta-api";

import { RELAY_URLS } from "@/lib/relay-server";

function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

interface AlertContext {
  metric: string;
  condition: string;
  threshold: number;
  value: number;
  message: string;
  clientId: string;
  window: string;
}

async function buildContextJson(alert: AlertContext, accountLabel?: string): Promise<string> {
  const token = getMetaSystemToken();
  const range = { since: offsetDate(-14), until: offsetDate(0) };

  const [account, ads, insights] = await Promise.all([
    getAccountInsights(token, alert.clientId, range).catch(() => null),
    getAds(token, alert.clientId, 30).catch(() => []),
    getAdInsights(token, alert.clientId, range, 30).catch((): MetaCreativeInsight[] => []),
  ]);

  const adsById = new Map(ads.map((a) => [a.id, a]));

  const topAds = [...insights]
    .sort((a, b) => parseFloat(b.spend) - parseFloat(a.spend))
    .slice(0, 8)
    .map((i) => {
      const ad = adsById.get(i.ad_id);
      return {
        id: i.ad_id,
        name: ad?.name ?? i.ad_name ?? i.ad_id,
        spend: Math.round(parseFloat(i.spend)),
        impressions: parseInt(i.impressions, 10),
        ctr: parseFloat(i.ctr),
        roas: computeRoas(i),
        cpa: computeCpa(i),
      };
    });

  const accountSummary = account
    ? {
        spend: Math.round(parseFloat(account.spend ?? "0")),
        clicks: parseInt(account.clicks ?? "0", 10),
        impressions: parseInt(account.impressions ?? "0", 10),
        ctr: parseFloat(account.ctr ?? "0"),
        frequency: parseFloat(account.frequency ?? "0"),
        roas: computeRoas({
          ...account,
          ad_id: "",
          ad_name: "",
          adset_id: "",
          campaign_id: "",
        } as unknown as MetaCreativeInsight),
      }
    : null;

  return JSON.stringify(
    {
      alert: {
        metric: alert.metric,
        condition: alert.condition,
        threshold: alert.threshold,
        observed: alert.value,
        window: alert.window,
        message: alert.message,
      },
      account: {
        id: alert.clientId,
        label: accountLabel,
        period: "14 derniers jours",
        ...accountSummary,
      },
      topAds,
    },
    null,
    2,
  );
}

const RECOMMENDATION_SYSTEM_PROMPT = `Tu es un consultant média senior en performance marketing (Meta Ads). Une alerte vient de se déclencher sur un compte client. À partir des données fournies par l'utilisateur, produis un plan d'action court et concret.

Contraintes de format STRICTES :
- En français
- 3 à 5 actions maximum
- Chaque action : 1-2 phrases max, commençant par un verbe à l'impératif (Pause, Réalloue, Lance, Vérifie, etc.)
- Si une créa spécifique est en cause, nomme-la (par son name)
- Si tu manques d'info, dis-le ("vérifier X dans Ads Manager")
- Pas de bullshit ni de banalités ("optimiser les enchères" sans précision = banni)
- Format de réponse : uniquement une liste numérotée brute, sans headers, sans introduction, sans conclusion, sans emojis
- N'appelle aucun tool — toutes les données dont tu as besoin sont dans le message utilisateur

Exemple de format attendu :
1. Pause la créa "Black Friday V3" — elle consomme 40% du budget à 0.8x ROAS.
2. Réalloue ~30% du budget vers "Christmas Hero" (3.2x ROAS, sous-financée).
3. Vérifie dans Ads Manager si l'audience est saturée (fréquence à 5.8).`;

interface RelayStreamEvent {
  type: string;
  text?: string;
  message?: string;
}

async function callRelay(userMessage: string, systemPrompt: string): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.RELAY_SHARED_SECRET || "";
  if (secret) headers.Authorization = `Bearer ${secret}`;

  const body = JSON.stringify({
    messages: [{ role: "user", content: userMessage }],
    systemPrompt,
    // No MCP tools — we provide all the context inline; this keeps the call
    // fast (no tool-call round trips) and cheap.
    allowedServers: [],
    accountScope: {},
  });

  const errors: string[] = [];
  for (const url of RELAY_URLS) {
    const isLocalhost = url.includes("localhost");
    const timeoutMs = isLocalhost ? 3000 : 100000;
    try {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        errors.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      if (!res.body) {
        errors.push(`${url}: no body`);
        continue;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      let lastError: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          let evt: RelayStreamEvent;
          try {
            evt = JSON.parse(payload) as RelayStreamEvent;
          } catch {
            continue;
          }
          if (evt.type === "delta" && evt.text) fullText += evt.text;
          else if (evt.type === "content" && evt.text && !fullText) fullText = evt.text;
          else if (evt.type === "error" && evt.message) lastError = evt.message;
        }
      }

      const result = fullText.trim();
      if (result) return result;
      if (lastError) {
        errors.push(`${url}: ${lastError}`);
        continue;
      }
      errors.push(`${url}: empty response`);
    } catch (e) {
      errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  throw new Error(`Relay inaccessible — ${errors.join(" · ")}`);
}

export async function generateRecommendations(
  alert: AlertContext,
  accountLabel?: string,
): Promise<string> {
  const context = await buildContextJson(alert, accountLabel);
  return callRelay(`Données (JSON) :\n${context}`, RECOMMENDATION_SYSTEM_PROMPT);
}
