import { describe, expect, it } from "vitest";
import { followDailyPages, mergePages, nextCall, readPage, todayInParis } from "../../server/mcp-meta-paging.mjs";

const day = (n: number) => new Date(Date.UTC(2026, 7, 30 + n)).toISOString().slice(0, 10); // 2026-08-30 + n

function result(rows: object[], next: boolean, wrapped = false) {
  const body = { data: rows, paging: next ? { cursors: { after: "x" }, next: "https://graph.facebook.com/next" } : { cursors: { after: "x" } } };
  return { content: [{ type: "text", text: JSON.stringify(wrapped ? [body] : body) }] };
}
const daily = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ date_start: day(from + i), date_stop: day(from + i), spend: String(10 + from + i) }));
const legacy = (p: object) => ({ input: JSON.stringify(p) });
const range = (since: string, until: string) => JSON.stringify({ since, until });

describe("nextCall", () => {
  const params = { ad_account_id: "act_1", fields: "spend", level: "account", date_preset: "", time_range: range(day(0), day(29)), time_increment: "1" };

  it("repart du dernier jour reçu jusqu'à la fin demandée, dans la convention d'origine", () => {
    const step = nextCall(legacy(params), readPage(result(daily(0, 25), true)))!;
    expect(step.from).toBe(day(24));
    const sent = JSON.parse(step.args.input);
    expect(JSON.parse(sent.time_range)).toEqual({ since: day(24), until: day(29) });
    expect(sent.date_preset).toBe("");
    expect(sent.ad_account_id).toBe("act_1");

    const typed = nextCall(params, readPage(result(daily(0, 25), true)))!;
    expect(typed.args.input).toBeUndefined();
    expect(JSON.parse(typed.args.time_range).since).toBe(day(24));
  });

  it("ne poursuit pas une page complète, une série non quotidienne ou une période déjà couverte", () => {
    expect(nextCall(legacy(params), readPage(result(daily(0, 25), false)))).toBeNull();
    expect(nextCall(legacy({ ...params, time_increment: "" }), readPage(result(daily(0, 25), true)))).toBeNull();
    expect(nextCall(legacy(params), readPage(result(daily(5, 25), true)))).toBeNull();
  });

  it("déduit la fin d'un date_preset, et renonce quand elle n'est pas connue", () => {
    const preset = { ...params, time_range: "", date_preset: "last_30d" };
    const step = nextCall(legacy(preset), readPage(result(daily(0, 25), true)), "2026-09-29")!;
    expect(JSON.parse(JSON.parse(step.args.input).time_range)).toEqual({ since: day(24), until: "2026-09-28" });
    const month = nextCall(legacy({ ...preset, date_preset: "this_month" }), readPage(result(daily(0, 25), true)), "2026-09-29")!;
    expect(JSON.parse(JSON.parse(month.args.input).time_range).until).toBe("2026-09-29");
    expect(nextCall(legacy({ ...preset, date_preset: "last_month" }), readPage(result(daily(0, 25), true)), "2026-09-29")).toBeNull();
  });

  it("ne tourne pas en rond quand une page entière tient sur un seul jour", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ date_start: day(3), campaign_name: `c${i}`, spend: "1" }));
    expect(nextCall(legacy(params), readPage(result(rows, true)))).toBeNull();
  });

  it("laisse intact ce qui n'est pas une série datée", () => {
    expect(readPage({ isError: true, content: [{ type: "text", text: "{}" }] })).toBeNull();
    expect(readPage({ content: [{ type: "text", text: "pas du JSON" }] })).toBeNull();
    expect(nextCall(legacy(params), readPage(result([{ campaign_name: "a", spend: "1" }], true)))).toBeNull();
  });
});

describe("mergePages", () => {
  it("remplace le jour de reprise, peut-être coupé, par le jour complet de la page suivante", () => {
    const first = readPage(result([{ date_start: day(0), campaign_name: "a", spend: "1" }, { date_start: day(1), campaign_name: "a", spend: "2" }], true));
    const second = readPage(result([{ date_start: day(1), campaign_name: "a", spend: "2" }, { date_start: day(1), campaign_name: "b", spend: "3" }, { date_start: day(2), campaign_name: "a", spend: "4" }], false));
    const merged = mergePages(first, second, day(1));
    expect(merged.body.data.map((r: { date_start: string; campaign_name: string }) => `${r.date_start}:${r.campaign_name}`)).toEqual([`${day(0)}:a`, `${day(1)}:a`, `${day(1)}:b`, `${day(2)}:a`]);
    expect(merged.body.paging.next).toBeUndefined();
  });
});

describe("followDailyPages", () => {
  const params = { ad_account_id: "act_1", fields: "spend", level: "account", date_preset: "", time_range: range(day(0), day(29)), time_increment: "1" };

  /** Amont simulé : 25 lignes par page, comme l'API Insights sans `limit`. */
  function upstream(all: { date_start: string }[], calls: object[]) {
    return async (args: { input: string }) => {
      calls.push(args);
      const p = JSON.parse(args.input);
      const { since, until } = JSON.parse(p.time_range);
      const rows = all.filter((r) => r.date_start >= since && r.date_start <= until);
      return result(rows.slice(0, 25), rows.length > 25, true);
    };
  }

  it("rend les 30 jours demandés, sans doublon, dans l'ordre, et la somme du compte", async () => {
    const all = daily(0, 30);
    const calls: object[] = [];
    const call = upstream(all, calls);
    const first = await call(legacy(params));
    calls.length = 0;
    const { result: out, pages } = await followDailyPages(first, legacy(params), call);
    const body = JSON.parse(out.content[0].text)[0];
    expect(pages).toBe(1);
    expect(calls).toHaveLength(1);
    expect(body.data.map((r: { date_start: string }) => r.date_start)).toEqual(all.map((r) => r.date_start));
    expect(body.data.reduce((s: number, r: { spend: string }) => s + Number(r.spend), 0)).toBe(all.reduce((s, r) => s + Number(r.spend), 0));
    expect(body.paging.next).toBeUndefined();
  });

  it("enchaîne plusieurs pages sur une longue période", async () => {
    const all = daily(0, 90);
    const long = { ...params, time_range: range(day(0), day(89)) };
    const calls: object[] = [];
    const call = upstream(all, calls);
    const { result: out, pages } = await followDailyPages(await call(legacy(long)), legacy(long), call);
    const body = JSON.parse(out.content[0].text)[0];
    expect(body.data).toHaveLength(90);
    expect(new Set(body.data.map((r: { date_start: string }) => r.date_start)).size).toBe(90);
    expect(pages).toBe(3);
  });

  it("garde la page partielle et son signal quand la suite échoue", async () => {
    const first = result(daily(0, 25), true);
    const failing = async () => { throw new Error("amont indisponible"); };
    const { result: out, pages } = await followDailyPages(first, legacy(params), failing);
    expect(pages).toBe(0);
    expect(out).toBe(first);
    expect(JSON.parse(out.content[0].text).paging.next).toBeTruthy();
  });

  it("s'arrête au plafond de pages en laissant le signal de page partielle", async () => {
    const all = daily(0, 90);
    const long = { ...params, time_range: range(day(0), day(89)) };
    const call = upstream(all, []);
    const { result: out, pages } = await followDailyPages(await call(legacy(long)), legacy(long), call, { maxPages: 1 });
    const body = JSON.parse(out.content[0].text)[0];
    expect(pages).toBe(1);
    expect(body.data).toHaveLength(49);
    expect(body.paging.next).toBeTruthy();
  });

  it("ne rappelle rien pour un résultat complet ou une erreur", async () => {
    const calls: object[] = [];
    const call = async (a: object) => { calls.push(a); return result([], false); };
    await followDailyPages(result(daily(0, 10), false), legacy(params), call);
    await followDailyPages({ isError: true, content: [{ type: "text", text: "boom" }] }, legacy(params), call);
    expect(calls).toHaveLength(0);
  });
});

describe("todayInParis", () => {
  it("donne la date de Paris, pas celle d'UTC, juste après minuit", () => {
    expect(todayInParis(new Date("2026-09-28T22:30:00Z"))).toBe("2026-09-29");
  });
});
