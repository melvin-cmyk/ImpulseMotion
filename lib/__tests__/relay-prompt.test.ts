import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildSystemPrompt, buildTurnPrompt, cliTokenEnv, createTurnMeter, promptLogExcerpt, scopeBlock, splitAtBoundary, todayParis, turnContextHash, turnUsage,
  DEFAULT_MAX_MCP_OUTPUT_TOKENS, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, TURN_CONTEXT_MAX_CHARS,
} from "../../server/relay-prompt.mjs";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY as LIB_BOUNDARY } from "@/lib/ai-tool-guidance";
import { COPILOT_CONTEXT_MAX_CHARS } from "@/lib/dashboard-copilot";

const source = (file: string) => fs.readFileSync(path.resolve(__dirname, "../../server", file), "utf8");
/** `const NAME = 12_000;` read in a server file, NaN when absent. */
const constant = (text: string, name: string) => Number((text.match(new RegExp(`^const ${name} = ([\\d_]+);`, "m"))?.[1] ?? "x").replace(/_/g, ""));

const B = SYSTEM_PROMPT_DYNAMIC_BOUNDARY;

describe("relay-prompt — date du jour", () => {
  it("donne la date de Paris, pas celle du serveur (UTC)", () => {
    expect(todayParis(new Date("2026-09-28T21:59:00Z"))).toBe("2026-09-28");
    expect(todayParis(new Date("2026-09-28T22:01:00Z"))).toBe("2026-09-29"); // 00:01 à Paris
    expect(todayParis(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
  });

  it("la met en tête du message utilisateur, à chaque tour", () => {
    const { text } = buildTurnPrompt({ prompt: "Dépense d'hier ?", now: new Date("2026-09-29T08:00:00Z") });
    expect(text).toBe("[Aujourd'hui : 2026-09-29]\nDépense d'hier ?");
  });

  it("laisse le prompt système identique d'un jour à l'autre", () => {
    const prompt = buildSystemPrompt({ base: "Tu es un assistant.", accountScope: { meta: ["act_1"] } });
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(prompt).toContain("[Aujourd'hui : AAAA-MM-JJ]");
    expect(prompt).toContain("jours complets");
  });
});

describe("relay-prompt — prompt système", () => {
  it("place le texte fixe avant la frontière, le périmètre après", () => {
    const prompt = buildSystemPrompt({ base: "Consignes.", accountScope: { meta: ["act_1"], google: ["123"] }, useNotion: true });
    const [fixed, dynamic] = prompt.split(`\n${B}\n`);
    expect(fixed.startsWith("Consignes.")).toBe(true);
    expect(fixed).toContain("Notion");
    expect(fixed).toContain("DATE :");
    expect(fixed).not.toContain("act_1");
    expect(dynamic).toContain("RESTRICTIONS DE PÉRIMÈTRE (ne JAMAIS ignorer)");
    expect(dynamic).toContain("Comptes Meta Ads autorisés: act_1");
    expect(dynamic).toContain("Comptes Google Ads autorisés: 123");
    expect(dynamic).toContain("Tu ne dois interroger AUCUN autre compte");
  });

  it("garde la partie propre à l'appelant derrière la frontière, et une seule frontière", () => {
    const prompt = buildSystemPrompt({ base: `Consignes.\n${B}\nCLIENT : LPEV\n${B}\nSuite`, accountScope: { meta: ["act_1"] } });
    expect(prompt.split("\n").filter((l) => l === B)).toHaveLength(1);
    const [fixed, dynamic] = prompt.split(`\n${B}\n`);
    expect(fixed).not.toContain("LPEV");
    expect(dynamic.indexOf("CLIENT : LPEV")).toBeLessThan(dynamic.indexOf("RESTRICTIONS"));
    expect(dynamic).toContain("Suite");
  });

  it("n'écrit pas de frontière quand rien ne varie", () => {
    expect(buildSystemPrompt({ base: "Consignes." })).not.toContain(B);
  });

  it("donne la même partie fixe à deux appelants de périmètres différents", () => {
    const a = buildSystemPrompt({ base: `Consignes.\n${B}\nSignature A`, accountScope: { meta: ["act_1"] }, useHq: true });
    const b = buildSystemPrompt({ base: `Consignes.\n${B}\nSignature B`, accountScope: { unrestricted: true, meta: ["act_9"] }, useHq: true });
    expect(a.split(B)[0]).toBe(b.split(B)[0]);
  });

  it("ajoute le bloc HQ du relay sauf si l'appelant dit s'en charger", () => {
    expect(buildSystemPrompt({ base: "Consignes.", useHq: true })).toContain("LECTURE SEULE, à HQ");
    expect(buildSystemPrompt({ base: "Consignes. HQ : seulement sur demande.", useHq: true, callerTeachesHq: true })).not.toContain("LECTURE SEULE, à HQ");
    expect(buildSystemPrompt({ base: "Consignes.", useHq: false })).not.toContain("HQ");
    expect(buildSystemPrompt({ base: "Consignes.", useHq: false, callerTeachesHq: true })).not.toContain("HQ");
  });

  it("ne déduit rien du texte de l'appelant : citer « HQ » ne retire pas le bloc", () => {
    for (const base of ["Ne parle pas du siège (HQ) au client.", "Consignes. HQ : seulement sur demande.", "outils hq_* interdits"]) {
      expect(buildSystemPrompt({ base, useHq: true })).toContain("LECTURE SEULE, à HQ");
    }
  });

  it("utilise la même frontière que les prompts de l'application", () => {
    expect(LIB_BOUNDARY).toBe(B);
  });

  it("découpe un prompt sans frontière en une seule partie", () => {
    expect(splitAtBoundary("a\nb")).toEqual({ head: "a\nb", tail: "" });
    expect(splitAtBoundary(null)).toEqual({ head: "", tail: "" });
  });
});

describe("relay-prompt — périmètre", () => {
  it("liste les comptes d'un appelant restreint", () => {
    const block = scopeBlock({ meta: ["act_1", "act_2"], tiktok: ["t1"] }, "properties/42");
    expect(block).toContain("act_1, act_2");
    expect(block).toContain("Comptes TikTok autorisés: t1");
    expect(block).toContain("Propriété GA4 autorisée : properties/42");
    expect(block).toContain("AUCUN autre compte");
  });

  it("ne liste pas les comptes d'un périmètre illimité", () => {
    const block = scopeBlock({ unrestricted: true, meta: ["act_1"], google: ["123"] }, null);
    expect(block).toContain("RESTRICTIONS DE PÉRIMÈTRE");
    expect(block).toContain("tous les comptes de l'agence sont autorisés");
    expect(block).not.toContain("act_1");
    expect(block).not.toContain("AUCUN autre compte");
  });

  it("ne traite comme illimité que unrestricted === true", () => {
    for (const unrestricted of ["true", 1, null, undefined, false]) {
      const block = scopeBlock({ unrestricted, meta: ["act_1"] }, null);
      expect(block).toContain("Comptes Meta Ads autorisés: act_1");
      expect(block).toContain("AUCUN autre compte");
    }
  });

  it("garde la propriété GA4 fermée même en périmètre illimité", () => {
    const block = scopeBlock({ unrestricted: true }, "properties/42");
    expect(block).toContain("Propriété GA4 autorisée : properties/42");
    expect(block).toContain("AUCUNE autre propriété GA4");
  });

  it("ne dit rien sans périmètre", () => {
    expect(scopeBlock(null, null)).toBe("");
    expect(scopeBlock({ meta: [], google: [] }, null)).toBe("");
  });
});

describe("relay-prompt — contexte de tour", () => {
  const now = new Date("2026-09-29T08:00:00Z");
  const state = "[ÉTAT ACTUEL DU DASHBOARD \"Démo\"\nWidgets : w1]";

  it("l'envoie au premier tour et retient son empreinte", () => {
    const turn = buildTurnPrompt({ prompt: "Ajoute un KPI", now, turnContext: state });
    expect(turn.text).toBe(`[Aujourd'hui : 2026-09-29]\n${state}\nAjoute un KPI`);
    expect(turn.contextHash).toBe(turnContextHash(state));
  });

  it("ne le renvoie pas tant qu'il n'a pas changé", () => {
    const first = buildTurnPrompt({ prompt: "a", now, turnContext: state });
    const second = buildTurnPrompt({ prompt: "b", now, turnContext: state, sentContextHash: first.contextHash });
    expect(second.text).toBe("[Aujourd'hui : 2026-09-29]\nb");
    expect(second.contextHash).toBe(first.contextHash);
  });

  it("le renvoie dès qu'il change", () => {
    const first = buildTurnPrompt({ prompt: "a", now, turnContext: state });
    const changed = state.replace("w1", "w1, w2");
    const third = buildTurnPrompt({ prompt: "c", now, turnContext: changed, sentContextHash: first.contextHash });
    expect(third.text).toContain("w1, w2");
    expect(third.contextHash).not.toBe(first.contextHash);
  });

  it("ignore un contexte absent ou mal typé", () => {
    expect(buildTurnPrompt({ prompt: "a", now, turnContext: { x: 1 } }).text).toBe("[Aujourd'hui : 2026-09-29]\na");
    expect(buildTurnPrompt({ prompt: "a", now, turnContext: "  " }).contextHash).toBeNull();
    expect(buildTurnPrompt({ prompt: "a", now, turnContext: state }).contextTruncated).toBe(false);
  });

  const lines = (n: number, last: string) => `[ÉTAT\n${Array.from({ length: n }, (_, i) => `- id=w${i} | config=${"x".repeat(60)}`).join("\n")}\n${last}]`;

  it("coupe un contexte trop long en fin de ligne et le dit au modèle", () => {
    const long = lines(400, "FIN");
    const turn = buildTurnPrompt({ prompt: "Question", now, turnContext: long });
    expect(turn.contextTruncated).toBe(true);
    expect(turn.contextChars).toBe(long.length);
    const sent = turn.text.slice("[Aujourd'hui : 2026-09-29]\n".length, -"\nQuestion".length);
    expect(sent.length).toBeLessThanOrEqual(TURN_CONTEXT_MAX_CHARS);
    const [kept, notice] = sent.split("\n[CONTEXTE TRONQUÉ par le relay");
    expect(notice).toContain(`${kept.length} caractères transmis sur ${long.length}`);
    expect(notice).toContain("La suite manque");
    // Whole lines only: the last one kept is a widget line, complete.
    expect(long.startsWith(kept)).toBe(true);
    expect(kept.split("\n").at(-1)).toMatch(/^- id=w\d+ \| config=x{60}$/);
  });

  it("coupe aussi un contexte sans retour à la ligne", () => {
    const turn = buildTurnPrompt({ prompt: "a", now, turnContext: "x".repeat(TURN_CONTEXT_MAX_CHARS + 500) });
    expect(turn.text.length).toBeLessThan(TURN_CONTEXT_MAX_CHARS + 100);
    expect(turn.text).toContain("CONTEXTE TRONQUÉ");
  });

  it("calcule l'empreinte sur le contexte entier : un changement après la coupe le renvoie", () => {
    const first = buildTurnPrompt({ prompt: "a", now, turnContext: lines(400, "FIN") });
    expect(first.contextHash).toBe(turnContextHash(lines(400, "FIN")));
    const same = buildTurnPrompt({ prompt: "b", now, turnContext: lines(400, "FIN"), sentContextHash: first.contextHash });
    expect(same.contextSent).toBe(false);
    const changed = buildTurnPrompt({ prompt: "c", now, turnContext: lines(400, "FIN MODIFIÉE"), sentContextHash: first.contextHash });
    expect(changed.contextHash).not.toBe(first.contextHash);
    expect(changed.contextSent).toBe(true);
    expect(changed.text).toContain("[ÉTAT");
  });

  it("laisse au copilote une marge sous la coupe du relay", () => {
    expect(COPILOT_CONTEXT_MAX_CHARS).toBeLessThan(TURN_CONTEXT_MAX_CHARS);
  });
});

describe("relay-prompt — journal", () => {
  it("donne la question sur une ligne, bornée", () => {
    expect(promptLogExcerpt("Quelle est la\n  dépense d'hier ?")).toBe("Quelle est la dépense d'hier ?");
    expect(promptLogExcerpt("x".repeat(200))).toBe(`${"x".repeat(80)}...`);
    expect(promptLogExcerpt(null)).toBe("");
  });
});

describe("relay-prompt — environnement du CLI", () => {
  it("pose toujours le plafond des sorties MCP", () => {
    expect(cliTokenEnv()).toEqual({ MAX_MCP_OUTPUT_TOKENS: String(DEFAULT_MAX_MCP_OUTPUT_TOKENS) });
    expect(cliTokenEnv({ maxMcpOutputTokens: "15000" }).MAX_MCP_OUTPUT_TOKENS).toBe("15000");
  });

  it("revient au défaut sur une valeur illisible ou hors bornes", () => {
    for (const v of ["", "abc", "0", "200", "1000000", "12000.5", undefined, null]) {
      expect(cliTokenEnv({ maxMcpOutputTokens: v }).MAX_MCP_OUTPUT_TOKENS).toBe(String(DEFAULT_MAX_MCP_OUTPUT_TOKENS));
    }
  });

  // The relay's cap and the servers' own caps live in different files: what
  // the comment of relay-prompt.mjs says of them is checked against the code.
  it("cite dans son commentaire les plafonds réels des serveurs", () => {
    const comment = source("relay-prompt.mjs").split("export const DEFAULT_MAX_MCP_OUTPUT_TOKENS")[0];
    const servers = { sandbox: source("mcp-sandbox.mjs"), gws: source("mcp-gws.mjs") };
    const cited = [...comment.matchAll(/\b(sandbox|gws) ([A-Z][A-Z_]+) = ([\d ]+\d)/g)].map((m) => ({ server: m[1] as "sandbox" | "gws", name: m[2], value: Number(m[3].replace(/ /g, "")) }));
    expect(cited.map((c) => c.name)).toEqual(expect.arrayContaining(["OUTPUT_CAP_MAX", "OUTPUT_CAP", "READ_CAP_MAX"]));
    for (const c of cited) expect(`${c.server} ${c.name} = ${constant(servers[c.server], c.name)}`).toBe(`${c.server} ${c.name} = ${c.value}`);
  });

  it("reste au-dessus de ce que les serveurs de l'agence renvoient", () => {
    const sandbox = source("mcp-sandbox.mjs");
    // Dense figures: about 0.52 token per character.
    for (const chars of [constant(sandbox, "OUTPUT_CAP_MAX"), constant(source("mcp-gws.mjs"), "OUTPUT_CAP")]) {
      expect(chars * 0.52).toBeLessThanOrEqual(DEFAULT_MAX_MCP_OUTPUT_TOKENS);
    }
    // read_file: bounded in tokens by the server, whatever max_chars asks.
    expect(constant(sandbox, "RESULT_TOKEN_BUDGET")).toBeLessThanOrEqual(DEFAULT_MAX_MCP_OUTPUT_TOKENS);
  });

  it("demande un cache d'une heure sur Bedrock pour une conversation seulement", () => {
    expect(cliTokenEnv({ useBedrock: true, resumable: true }).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("1h");
    expect(cliTokenEnv({ useBedrock: true, resumable: false })).not.toHaveProperty("CLAUDE_CODE_PROMPT_CACHE_TTL");
    expect(cliTokenEnv({ useBedrock: false, resumable: true })).not.toHaveProperty("CLAUDE_CODE_PROMPT_CACHE_TTL");
  });
});

describe("relay-prompt — consommation d'un tour", () => {
  // Relevé sur le CLI 2.1.284 (abonnement, claude-sonnet-5) : une session de
  // trois tours, les deux premiers avec deux appels d'outil chacun.
  const result = (usage: number[] | null, cumulative: number[] | null, total?: number) => ({
    ...(usage ? { usage: { input_tokens: usage[0], output_tokens: usage[1], cache_read_input_tokens: usage[2], cache_creation_input_tokens: usage[3], cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: usage[3] } } } : {}),
    ...(cumulative ? { modelUsage: { "claude-sonnet-5": { inputTokens: cumulative[0], outputTokens: cumulative[1], cacheReadInputTokens: cumulative[2], cacheCreationInputTokens: cumulative[3] } } } : {}),
    ...(total === undefined ? {} : { total_cost_usd: total }),
  });
  const tokens = ([input, output, cacheRead, cacheWrite]: number[]) => ({ input, output, cacheRead, cacheWrite });
  const T1 = [8, 259, 6399, 3429];
  const T2 = [6, 147, 11274, 1573];
  const T3 = [2, 5, 5002, 79];
  const SUM2 = [14, 406, 17673, 5002];
  const SUM3 = [16, 411, 22675, 5081];
  const [TOTAL1, TOTAL2] = [0.0176018, 0.0276306];
  const logged = () => { const lines: string[] = []; return { lines, log: (m: string) => { lines.push(m); } }; };

  it("prend le coût tel quel pour une session neuve", () => {
    const { lines, log } = logged();
    const spent = turnUsage(result(T1, T1, TOTAL1), { log });
    expect(spent).toEqual({ tokens: tokens(T1), cost: TOTAL1, costEstimated: false, totalCost: TOTAL1 });
    // A stored total is not this session's when the session is new.
    expect(turnUsage(result(T1, T1, TOTAL1), { resumed: false, storedCost: 1, log }).cost).toBe(TOTAL1);
    expect(lines).toEqual([]);
  });

  it("compte le tour repris, pas le cumul de la session", () => {
    const { lines, log } = logged();
    const spent = turnUsage(result(T2, SUM2, TOTAL2), { resumed: true, storedCost: TOTAL1, log });
    expect(spent.tokens).toEqual(tokens(T2));
    expect(spent.cost).toBeCloseTo(0.0100288, 9);
    expect(spent.totalCost).toBe(TOTAL2);
    expect(lines).toEqual([]);
  });

  it("estime le tour d'une session reprise sans cumul connu, et le dit", () => {
    const { lines, log } = logged();
    const spent = turnUsage(result(T2, SUM2, TOTAL2), { resumed: true, storedCost: null, log });
    expect(spent.cost).toBeLessThan(TOTAL2 / 2);
    expect(spent.cost).toBeCloseTo(0.0100288, 6); // the real cost of that turn
    expect(spent.costEstimated).toBe(true);
    expect(spent.totalCost).toBe(TOTAL2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("session reprise sans cumul connu");
  });

  it("compte 0 plutôt que le cumul quand rien ne permet d'estimer", () => {
    const { lines, log } = logged();
    // The reviewer's case: total 0.52 for a turn worth 0.02, nothing else known.
    const spent = turnUsage({ usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.52 }, { resumed: true, storedCost: null, log });
    expect(spent.cost).toBe(0);
    expect(spent.costEstimated).toBe(true);
    expect(spent.totalCost).toBe(0.52);
    expect(lines[0]).toContain("inconnu, compté 0");
  });

  it("ne fait jamais reculer le cumul sur un total absent ou nul", () => {
    for (const total of [undefined, 0, null, NaN, "abc", -1]) {
      const { lines, log } = logged();
      const spent = turnUsage({ usage: { input_tokens: 3 }, total_cost_usd: total, is_error: true }, { resumed: true, storedCost: 0.4, log });
      expect(spent.cost).toBe(0);
      expect(spent.totalCost).toBeNull();
      expect(lines[0]).toContain("cumul de la session conservé (0.4)");
    }
  });

  it("journalise un total qui recule", () => {
    const { lines, log } = logged();
    const spent = turnUsage(result(T3, SUM3, 0.02), { resumed: true, storedCost: 0.05, log });
    expect(spent.cost).toBe(0.02);
    expect(spent.totalCost).toBe(0.02);
    expect(lines[0]).toContain("total_cost_usd recule (0.05 → 0.02)");
  });

  it("reconnaît des totaux qui ne sont pas des cumuls, même quand ils montent", () => {
    // Per-invocation costs 0.05, 0.08, 0.02: modelUsage is then the turn alone.
    const { lines, log } = logged();
    let storedCost: number | null = null;
    const costs = [0.05, 0.08, 0.02].map((total, i) => {
      const spent = turnUsage(result(T3, T3, total), { resumed: i > 0, storedCost, log });
      storedCost = spent.totalCost;
      return spent.cost;
    });
    expect(costs).toEqual([0.05, 0.08, 0.02]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("ne couvre que ce tour");
  });

  it("retient la somme des appels vus quand usage annonce moins", () => {
    const { lines, log } = logged();
    // `usage` holding the last call only, against the four calls of the turn.
    const spent = turnUsage(result([2, 27, 2710, 719], T1, TOTAL1), { live: tokens(T1), log });
    expect(spent.tokens).toEqual(tokens(T1));
    expect(lines[0]).toContain("inférieur à la somme des appels du tour");
    expect(lines[0]).toContain("output 27 < 259");
  });

  it("ne prend pas un cumul pour le tour seul quand le flux a surcompté", () => {
    const { lines, log } = logged();
    // The stream counted one call twice: more tokens seen than modelUsage holds.
    const seen = tokens([4, 147, 22548, 3146]);
    const spent = turnUsage(result(T2, SUM2, TOTAL2), { resumed: true, storedCost: TOTAL1, live: seen, log });
    expect(spent.cost).toBeCloseTo(0.0100288, 9);
    expect(spent.totalCost).toBe(TOTAL2);
    // The floor raised the tokens, and said so; it took no part in the cost.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("inférieur à la somme des appels du tour");
  });

  it("tient les totaux pour un cumul quand usage manque", () => {
    const { log } = logged();
    const spent = turnUsage(result(null, SUM2, TOTAL2), { resumed: true, storedCost: TOTAL1, live: tokens([4, 147, 22548, 3146]), log });
    expect(spent.cost).toBeCloseTo(0.0100288, 9);
  });

  it("garde usage quand il couvre les appels vus", () => {
    const { lines, log } = logged();
    expect(turnUsage(result(T1, T1, TOTAL1), { live: tokens(T1), log }).tokens).toEqual(tokens(T1));
    // Calls the stream did not show (none seen, or fewer): usage stands.
    expect(turnUsage(result(T1, T1, TOTAL1), { live: tokens([2, 111, 0, 1700]), log }).tokens).toEqual(tokens(T1));
    expect(lines).toEqual([]);
  });

  it("se rabat sur le flux, puis sur modelUsage, quand usage manque ou est vide", () => {
    const { lines, log } = logged();
    expect(turnUsage({ ...result(null, SUM2, TOTAL2), usage: {} }, { resumed: true, storedCost: TOTAL1, live: tokens(T2), log }).tokens).toEqual(tokens(T2));
    expect(lines[0]).toContain("tokens pris dans le flux");
    expect(turnUsage({ usage: {}, modelUsage: { m: { inputTokens: 5, outputTokens: 6 } }, total_cost_usd: 0.1 }, { log }).tokens).toEqual(tokens([5, 6, 0, 0]));
    expect(turnUsage(result(null, T1, TOTAL1), { log }).tokens).toEqual(tokens(T1));
    expect(turnUsage({}).tokens).toEqual(tokens([0, 0, 0, 0]));
  });
});

describe("relay-prompt — compteur d'un tour", () => {
  const start = (input: number, cacheRead: number, cacheWrite: number) => ({ type: "message_start", message: { usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } } });
  const delta = (output: number) => ({ type: "message_delta", usage: { output_tokens: output } });
  const stop = { type: "message_stop" };

  it("compte les appels au fil du flux, celui en cours compris", () => {
    const meter = createTurnMeter();
    expect(meter.observed()).toBeNull();
    expect(meter.onStreamEvent(start(2, 0, 1700))).toBe(false);
    expect(meter.onStreamEvent(delta(111))).toBe(false);
    expect(meter.observed()).toEqual({ tokens: { input: 2, output: 111, cacheRead: 0, cacheWrite: 1700 }, calls: 0 });
    expect(meter.onStreamEvent(stop)).toBe(true);
    meter.onStreamEvent(start(2, 1700, 289));
    meter.onStreamEvent(delta(40));
    meter.onStreamEvent(delta(61));
    expect(meter.observed()).toEqual({ tokens: { input: 4, output: 172, cacheRead: 1700, cacheWrite: 1989 }, calls: 1 });
    expect(meter.onStreamEvent({ type: "content_block_delta" })).toBe(false);
    expect(meter.onStreamEvent(null)).toBe(false);
  });

  it("remplace le relevé d'un appel relancé avant sa fin, au lieu de l'ajouter", () => {
    const lines: string[] = [];
    const meter = createTurnMeter({ resumed: true, stored: { cost: 0.0176018 }, log: (m) => { lines.push(m); } });
    meter.onStreamEvent(start(2, 3429, 133));
    meter.onStreamEvent(delta(61));
    meter.onStreamEvent(stop);
    meter.onStreamEvent(start(2, 11274, 1573)); // cut before its end
    meter.onStreamEvent(delta(12));
    meter.onStreamEvent(start(2, 11274, 1573)); // the same call, sent again
    expect(meter.observed()).toEqual({ tokens: { input: 4, output: 62, cacheRead: 14703, cacheWrite: 1706 }, calls: 1 });
    meter.onStreamEvent(delta(147));
    meter.onStreamEvent(stop);
    expect(meter.observed()).toEqual({ tokens: { input: 4, output: 208, cacheRead: 14703, cacheWrite: 1706 }, calls: 2 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("appel relancé avant sa fin");
  });

  it("facture le tour par différence quand un message_start est vu deux fois", () => {
    // The reviewer's case: turn 2 of a session whose first turn cost 0.0176018.
    const meter = createTurnMeter({ resumed: true, stored: { cost: 0.0176018 } });
    expect(meter.settled).toBe(false);
    meter.onStreamEvent(start(2, 11274, 1573));
    meter.onStreamEvent(start(2, 11274, 1573));
    meter.onStreamEvent(delta(147));
    meter.onStreamEvent(stop);
    const spent = meter.settle({
      usage: { input_tokens: 6, output_tokens: 147, cache_read_input_tokens: 11274, cache_creation_input_tokens: 1573 },
      modelUsage: { m: { inputTokens: 14, outputTokens: 406, cacheReadInputTokens: 17673, cacheCreationInputTokens: 5002 } },
      total_cost_usd: 0.0276306,
    });
    expect(spent.cost).toBeCloseTo(0.0100288, 9);
    expect(spent.tokens).toEqual({ input: 6, output: 147, cacheRead: 11274, cacheWrite: 1573 });
    expect(meter.settled).toBe(true);
    expect(meter.sessionFields()).toEqual({ cost: 0.0276306 });
  });

  it("suit une session de tour en tour à travers ce que garde sessions.json", () => {
    const lines: string[] = [];
    const log = (m: string) => { lines.push(m); };
    // The session entry, as written to and read back from the file.
    let entry: Record<string, unknown> | null = null;
    const turn = (event: Record<string, unknown> | null) => {
      const meter = createTurnMeter({ resumed: entry !== null, stored: entry, log });
      entry = JSON.parse(JSON.stringify({ id: "s1", ...meter.sessionFields() }));
      if (!event) return null; // killed before its result
      const spent = meter.settle(event);
      entry = JSON.parse(JSON.stringify({ ...entry, ...meter.sessionFields() }));
      return spent.cost;
    };
    const event = (total?: number) => ({ usage: { input_tokens: 2, output_tokens: 5 }, modelUsage: { m: { inputTokens: 200, outputTokens: 500 } }, ...(total === undefined ? {} : { total_cost_usd: total }) });

    expect(turn(event(0.10))).toBe(0.10);
    expect(turn(event(0.25))).toBeCloseTo(0.15, 9);
    expect(turn({ ...event(), is_error: true })).toBe(0); // error without a total
    expect(entry).toEqual({ id: "s1", cost: 0.25 });
    expect(turn(null)).toBeNull(); // interrupted
    expect(entry).toEqual({ id: "s1", cost: 0.25 });
    expect(turn(event(0.30))).toBeCloseTo(0.05, 9);
    expect(entry).toEqual({ id: "s1", cost: 0.30 });
    expect(lines).toHaveLength(1);
  });

  it("n'écrit aucun cumul tant qu'aucun n'est connu", () => {
    expect(createTurnMeter().sessionFields()).toEqual({});
    expect(createTurnMeter({ resumed: true, stored: {} }).sessionFields()).toEqual({});
    expect(createTurnMeter({ resumed: true, stored: { cost: "0.2" } }).sessionFields()).toEqual({});
    expect(createTurnMeter({ resumed: true, stored: { cost: 0 } }).sessionFields()).toEqual({ cost: 0 });
    // A new session never inherits the total of the one it replaces.
    expect(createTurnMeter({ resumed: false, stored: { cost: 0.2 } }).sessionFields()).toEqual({});
  });
});
