import { describe, expect, it } from "vitest";
import { completeQuickAsk, ghostTitle, matchClientName, orderClientCandidates, parseNavIntent, parseQuickIntent, type QuickIntent, type QuickResult } from "@/lib/mo/intents";

/** The quick intent of a sentence (fails the test when it is an ask or nothing). */
const quick = (r: QuickResult | null): QuickIntent | null => (r && r.kind !== "ask" ? r : null);

const clients = [
  { id: "c1", name: "Naturalia", dashboardId: "d1" },
  { id: "c2", name: "Cours Legendre", dashboardId: "d2" },
  { id: "c3", name: "LPEV", dashboardId: null },
  { id: "c4", name: "Le Barth Villas", dashboardId: "d4" },
  { id: "c5", name: "Saveurs & Vie", dashboardId: "d5" },
];

describe("Mo — client names said out loud", () => {
  it("finds exact, partial and slightly misspelt names", () => {
    expect(matchClientName("ouvre le cockpit de naturalia", clients)?.id).toBe("c1");
    expect(matchClientName("va sur l'analyse de cours legendre", clients)?.id).toBe("c2");
    expect(matchClientName("montre moi les rapports de legendre", clients)?.id).toBe("c2");
    expect(matchClientName("ouvre lpev", clients)?.id).toBe("c3");
    expect(matchClientName("ouvre naturalya", clients)?.id).toBe("c1");
    expect(matchClientName("le barth", clients)?.id).toBe("c4");
    expect(matchClientName("saveurs et vie", clients)?.id).toBe("c5");
  });
  it("survives what the recogniser actually returns", () => {
    expect(matchClientName("va sur l'analysade de courtle gendre", clients)?.id).toBe("c2");
    expect(matchClientName("ouvrons les rapports de cours le jendin", clients)?.id).toBe("c2");
    expect(matchClientName("cpa de court legendre cette semaine", clients)?.id).toBe("c2");
    expect(matchClientName("ouvre le copie de naturalya", clients)?.id).toBe("c1");
    expect(matchClientName("ouvre le barre villa", clients)?.id).toBe("c4");
  });
  it("gives up when nothing or several match", () => {
    expect(matchClientName("ouvre le cockpit", clients)).toBeNull();
    expect(matchClientName("ouvre le client", clients)).toBeNull();
  });
});

describe("Mo — navigation intents", () => {
  it("opens pages of a client", () => {
    expect(parseNavIntent("Ouvre le cockpit de Naturalia", clients)).toMatchObject({ path: "/portfolio/c1", clientName: "Naturalia" });
    expect(parseNavIntent("va sur l'analyse ads de LPEV", clients)?.path).toBe("/analyse?client=c3");
    expect(parseNavIntent("montre-moi les rapports de Cours Legendre", clients)?.path).toBe("/reports?dashboardId=d2");
    expect(parseNavIntent("ouvre le dashboard de Naturalia", clients)?.path).toBe("/d/d1");
    expect(parseNavIntent("ouvre les créas de naturalia", clients)?.path).toBe("/creas?client=c1");
    expect(parseNavIntent("ouvre le pilotage de LPEV", clients)?.path).toBe("/pilotage?dashboardId=c3");
  });
  it("opens pages without a client", () => {
    expect(parseNavIntent("ouvre le studio", clients)?.path).toBe("/studio");
    expect(parseNavIntent("va sur la liste des clients", clients)?.path).toBe("/portfolio");
    expect(parseNavIntent("ouvre mon tableau", clients)?.path).toBe("/mo");
    expect(parseNavIntent("ouvre le cockpit", clients)?.path).toBe("/cockpit");
  });
  it("understands misheard pages and names", () => {
    expect(parseNavIntent("Ouvre le copie de Naturalia.", clients)?.path).toBe("/portfolio/c1");
    expect(parseNavIntent("Va sur l'analysade de courtle Gendre.", clients)?.path).toBe("/analyse?client=c2");
    expect(parseNavIntent("Ouvrons les rapports de cours le jendin.", clients)?.path).toBe("/reports?dashboardId=d2");
    expect(parseNavIntent("Ouvre mon table.", clients)?.path).toBe("/mo");
    expect(parseNavIntent("CPA de court Legendre cette semaine.", clients)).toBeNull();
  });
  it("leaves data questions to the model", () => {
    expect(parseNavIntent("montre-moi les créas Meta de Naturalia postées vendredi avec CPA, CPL et leads", clients)).toBeNull();
    expect(parseNavIntent("quel client a le CPL le plus bas sur Meta cette semaine ?", clients)).toBeNull();
    expect(parseNavIntent("compare ça avec la semaine d'avant", clients)).toBeNull();
    expect(parseNavIntent("affiche le top des créas de LPEV", clients)).toBeNull();
    expect(parseNavIntent("bonjour Mo", clients)).toBeNull();
  });
});

describe("Mo — quick path (no model)", () => {
  it("creatives of a client over a period", () => {
    const q = quick(parseQuickIntent("Affiche-moi les créas de cette semaine sur Cours Legendre", clients));
    expect(q).toMatchObject({ kind: "creatives", args: { client: "c2", period: "this_week" } });
    expect(q?.say).toContain("Cours Legendre");
  });
  it("the N latest, the top spenders, launched this week", () => {
    expect(quick(parseQuickIntent("sors-moi les 10 dernières créas qu'on a mises sur Meta pour Cours Legendre", clients))?.args).toMatchObject({ client: "c2", sort: "launch", order: "desc", limit: 10, platform: "meta" });
    expect(quick(parseQuickIntent("montre les créas de LPEV qui ont le plus dépensé ces 7 derniers jours", clients))?.args).toMatchObject({ client: "c3", sort: "spend", period: "last_7d" });
    expect(quick(parseQuickIntent("les créas lancées cette semaine chez Naturalia", clients))?.args).toMatchObject({ launched_in_period: true, period: "this_week" });
  });
  it("figures of a client", () => {
    expect(parseQuickIntent("le CPA de Naturalia cette semaine", clients)).toMatchObject({ kind: "metrics", args: { client: "c1", period: "this_week" } });
    expect(quick(parseQuickIntent("ça donne quoi sur LPEV ce mois-ci par campagne ?", clients))?.args).toMatchObject({ period: "this_month", by: "campaign" });
  });
  it("a client without a period: the last 7 days, no question asked", () => {
    expect(parseQuickIntent("créas cours legendre", clients)).toMatchObject({ kind: "creatives", args: { client: "c2", period: "last_7d" }, periodLabel: "sur 7 jours" });
    expect(parseQuickIntent("montre-moi les créas de Naturalia", clients)).toMatchObject({ kind: "creatives", args: { client: "c1", period: "last_7d" } });
    expect(parseQuickIntent("le CPA de LPEV", clients)).toMatchObject({ kind: "metrics", args: { client: "c3", period: "last_7d" } });
    expect(quick(parseQuickIntent("les 5 dernières créas de LPEV", clients))?.args).toMatchObject({ sort: "launch", limit: 5 });
    expect(quick(parseQuickIntent("les 5 dernières créas de LPEV", clients))?.args.period).toBeUndefined();
  });
  it("a period without a client: asks which client, with every client as a candidate", () => {
    const a = parseQuickIntent("créas cette semaine", clients);
    expect(a).toMatchObject({ kind: "ask", missing: "client", draft: { what: "creatives", text: "créas cette semaine" } });
    if (!a || a.kind !== "ask" || a.missing !== "client") throw new Error("expected an ask");
    expect(a.candidates.map((c) => c.name)).toEqual(["Cours Legendre", "Le Barth Villas", "LPEV", "Naturalia", "Saveurs & Vie"]);
    expect(a.question).toBe("Pour quel client ?");
    expect(parseQuickIntent("le CPA ce mois-ci ?", clients)).toMatchObject({ kind: "ask", missing: "client", draft: { what: "metrics" } });
    expect(parseQuickIntent("les 10 dernières créas", clients)).toMatchObject({ kind: "ask", missing: "client" });
    // The chip completes the sentence, which then goes the quick way.
    const done = completeQuickAsk(a, clients[1]);
    expect(done).toBe("créas cette semaine pour Cours Legendre");
    expect(parseQuickIntent(done, clients)).toMatchObject({ kind: "creatives", args: { client: "c2", period: "this_week" } });
    expect(parseQuickIntent(completeQuickAsk(parseQuickIntent("le CPA ce mois-ci ?", clients) as Extract<QuickResult, { kind: "ask" }>, clients[0]), clients)).toMatchObject({ kind: "metrics", args: { client: "c1", period: "this_month" } });
  });
  it("two things missing, or an empty registry: the model", () => {
    expect(parseQuickIntent("les créas", clients)).toBeNull();
    expect(parseQuickIntent("montre les chiffres", clients)).toBeNull();
    expect(parseQuickIntent("créas cette semaine", [])).toBeNull();
  });
  it("orders the chips: clients of the day first, then alphabetically", () => {
    const cards = [
      { title: "Créas Naturalia · cette semaine", subtitle: "Meta · Naturalia · 20-26 oct.", at: "2026-10-28T08:00:00Z" },
      { title: "Chiffres", subtitle: "Meta · LPEV · 7 jours", at: "2026-10-28T09:00:00Z" },
    ];
    expect(orderClientCandidates(clients, cards).map((c) => c.id)).toEqual(["c3", "c1", "c2", "c4", "c5"]);
    expect(orderClientCandidates(clients, []).map((c) => c.id)).toEqual(["c2", "c4", "c3", "c1", "c5"]);
  });
  it("names the ghost card from the ask", () => {
    expect(ghostTitle("créas cours legendre cette semaine", parseQuickIntent("créas cours legendre cette semaine", clients))).toBe("Créas Cours Legendre · cette semaine");
    expect(ghostTitle("le cpa de naturalia", parseQuickIntent("le cpa de naturalia", clients))).toBe("Chiffres Naturalia · sur 7 jours");
    expect(ghostTitle("hello Mo, pourquoi le CPA de LPEV monte ?", null)).toBe("Pourquoi le CPA de LPEV monte ?");
    expect(ghostTitle("x".repeat(80), null)).toHaveLength(60);
  });
  it("leaves the rest to the model", () => {
    expect(parseQuickIntent("compare les créas de Naturalia avec la semaine dernière", clients)).toBeNull();
    expect(parseQuickIntent("crée-moi deux créas pour Naturalia", clients)).toBeNull();
    expect(parseQuickIntent("pourquoi le CPA de LPEV monte cette semaine ?", clients)).toBeNull();
    expect(parseQuickIntent("ouvre le cockpit de Naturalia", clients)).toBeNull();
    expect(parseQuickIntent("affiche les créas", clients)).toBeNull();
  });
});

describe("Mo — follow-ups over the card at hand", () => {
  it("« mets les chiffres dessous » asks the figures under the visuals", async () => {
    const { parseFollowUpIntent } = await import("@/lib/mo/intents");
    expect(parseFollowUpIntent("Mets les chiffres sous chaque créa")).toMatchObject({ kind: "creative_metrics" });
    expect(parseFollowUpIntent("mets les chiffres dessous")).toMatchObject({ kind: "creative_metrics" });
    expect(parseFollowUpIntent("les chiffres en dessous, cette semaine")).toMatchObject({ kind: "creative_metrics", period: "this_week" });
    expect(parseFollowUpIntent("ajoute le CPA sous les visuels")).toMatchObject({ kind: "creative_metrics" });
    expect(parseFollowUpIntent("chiffres ?")).toMatchObject({ kind: "creative_metrics" });
  });
  it("« garde / coupe celle-là » is a verdict on the hovered, the n-th, or every visual", async () => {
    const { parseFollowUpIntent } = await import("@/lib/mo/intents");
    expect(parseFollowUpIntent("garde celle-là")).toMatchObject({ kind: "verdict", verdict: "keep", target: { which: "this" } });
    expect(parseFollowUpIntent("coupe celle-ci")).toMatchObject({ kind: "verdict", verdict: "cut", target: { which: "this" } });
    expect(parseFollowUpIntent("on coupe la deuxième")).toMatchObject({ kind: "verdict", verdict: "cut", target: { which: "index", index: 1 } });
    expect(parseFollowUpIntent("garde la 3")).toMatchObject({ kind: "verdict", verdict: "keep", target: { which: "index", index: 2 } });
    expect(parseFollowUpIntent("vire-la")).toMatchObject({ kind: "verdict", verdict: "cut", target: { which: "this" } });
    expect(parseFollowUpIntent("garde tout")).toMatchObject({ kind: "verdict", verdict: "keep", target: { which: "all" } });
    expect(parseFollowUpIntent("coupe les deux")).toMatchObject({ kind: "verdict", verdict: "cut", target: { which: "all" } });
  });
  it("leaves the rest to the quick path or the model", async () => {
    const { parseFollowUpIntent } = await import("@/lib/mo/intents");
    expect(parseFollowUpIntent("les chiffres de Naturalia cette semaine")).toBeNull();
    expect(parseFollowUpIntent("compare les chiffres avec la semaine d'avant")).toBeNull();
    expect(parseFollowUpIntent("garde le budget mais coupe la campagne")).toBeNull();
    expect(parseFollowUpIntent("pourquoi le CPA monte ?")).toBeNull();
    expect(parseFollowUpIntent("créas cours legendre cette semaine")).toBeNull();
    expect(parseFollowUpIntent("ouvre le cockpit de naturalia")).toBeNull();
  });
});

// ── Lot 4 : follow-ups without the model, aliases ────────────────────────────
import { CLIENT_ALIASES, isClientId, parseFollowUpIntent, parseFollowUpQuick, splitBrands, targetIndexes, withClientAliases, type IntentClient } from "@/lib/mo/intents";

describe("Mo — client aliases (CL → Cours Legendre)", () => {
  const aliased: IntentClient[] = withClientAliases<IntentClient>([...clients, { id: "c6", name: "Naturalia Bio", dashboardId: "d6" }]);
  it("adds the spoken aliases of the table to the matching client, nothing to the others", () => {
    expect(aliased.find((c) => c.id === "c2")?.aliases).toEqual(expect.arrayContaining(["cl", "legendre"]));
    expect(aliased.find((c) => c.id === "c3")?.aliases).toEqual(["la petite epicerie verte"]);
    expect(aliased.find((c) => c.id === "c1")?.aliases).toEqual(["natu"]);
    expect(aliased.find((c) => c.id === "c5")?.aliases).toEqual(["sev"]);
    expect(CLIENT_ALIASES.cl).toBe("cours legendre");
  });
  it("matches a short alias only as a whole word", () => {
    expect(matchClientName("créas CL cette semaine", aliased)?.id).toBe("c2");
    expect(matchClientName("chiffres de cl ce mois", aliased)?.id).toBe("c2");
    expect(matchClientName("le cpl de naturalia", aliased)?.id).toBe("c1");
    expect(matchClientName("ouvre le client", aliased)).toBeNull();
  });
  it("runs the quick path on an alias", () => {
    expect(quick(parseQuickIntent("créas CL cette semaine", aliased))).toMatchObject({ kind: "creatives", client: { id: "c2" } });
  });
  it("accepts the merged ids of the registry as the client's id", () => {
    const c = { id: "d2", name: "Cours Legendre", aliasIds: ["c_old", "c_other"] };
    expect(isClientId(c, "d2")).toBe(true);
    expect(isClientId(c, "c_old")).toBe(true);
    expect(isClientId(c, "zzz")).toBe(false);
    expect(isClientId(c, null)).toBe(false);
  });
});

describe("Mo — verdict verbs on the card at hand", () => {
  it("« garde la 2 » → the second visual", () => {
    expect(parseFollowUpIntent("garde la 2")).toMatchObject({ kind: "verdict", verdict: "keep", target: { which: "index", index: 1 } });
  });
  it("« coupe les deux dernières » → the last two, not all", () => {
    expect(parseFollowUpIntent("coupe les deux dernières")).toMatchObject({ kind: "verdict", verdict: "cut", target: { which: "last", count: 2 }, say: "Je les coupe." });
    expect(parseFollowUpIntent("vire la dernière")).toMatchObject({ kind: "verdict", verdict: "cut", target: { which: "last", count: 1 } });
  });
  it("« garde-les toutes » → all", () => {
    expect(parseFollowUpIntent("garde-les toutes")).toMatchObject({ kind: "verdict", verdict: "keep", target: { which: "all" } });
  });
  it("« publie la première » → a publication to prepare for the first visual", () => {
    expect(parseFollowUpIntent("publie la première")).toMatchObject({ kind: "publish", target: { which: "index", index: 0 } });
    expect(parseFollowUpIntent("poste celle-là")).toMatchObject({ kind: "publish", target: { which: "this" } });
    expect(parseFollowUpIntent("publie-les toutes")).toBeNull();
  });
  it("resolves targets to item indexes", () => {
    expect(targetIndexes({ which: "last", count: 2 }, 5, null)).toEqual([3, 4]);
    expect(targetIndexes({ which: "last", count: 3 }, 2, null)).toEqual([0, 1]);
    expect(targetIndexes({ which: "index", index: 7 }, 3, null)).toEqual([]);
    expect(targetIndexes({ which: "this" }, 3, 1)).toEqual([1]);
    expect(targetIndexes({ which: "this" }, 1, null)).toEqual([0]);
    expect(targetIndexes({ which: "this" }, 3, null)).toEqual([]);
    expect(targetIndexes({ which: "all" }, 3, null)).toEqual([0, 1, 2]);
  });
});

describe("Mo — « deux autres comme ça »", () => {
  it("understands the ways of asking for more visuals, with the count", () => {
    expect(parseFollowUpQuick("deux autres comme ça", clients)).toMatchObject({ kind: "more_like_this", n: 2, style: "" });
    expect(parseFollowUpQuick("Crée-m'en deux dans le même esprit", clients)).toMatchObject({ kind: "more_like_this", n: 2 });
    expect(parseFollowUpQuick("fais-en 3 autres", clients)).toMatchObject({ kind: "more_like_this", n: 3 });
    expect(parseFollowUpQuick("une variante de celle-là", clients)).toMatchObject({ kind: "more_like_this", n: 1 });
  });
  it("keeps the style asked (« en jaune »)", () => {
    const r = parseFollowUpQuick("encore deux comme ça en jaune", clients);
    expect(r).toMatchObject({ kind: "more_like_this", n: 2, style: "en jaune" });
    expect(parseFollowUpQuick("refais la même plus sobre", clients)).toMatchObject({ kind: "more_like_this", n: 1, style: "plus sobre" });
  });
  it("leaves the rest to the quick path or the model", () => {
    expect(parseFollowUpQuick("montre deux créas de Naturalia", clients)).toBeNull();
    expect(parseFollowUpQuick("pourquoi le CPA monte chez Naturalia ?", clients)).toBeNull();
    expect(parseFollowUpQuick("mets les chiffres dessous", clients)).toBeNull();
  });
});

describe("Mo — « compare avec la semaine d'avant »", () => {
  it("names the other period", () => {
    expect(parseFollowUpQuick("compare avec la semaine d'avant", clients)).toMatchObject({ kind: "compare", period: "last_week", client: null });
    expect(parseFollowUpQuick("compare avec le mois dernier", clients)).toMatchObject({ kind: "compare", period: "last_month" });
    expect(parseFollowUpQuick("et la semaine d'avant ?", clients)).toMatchObject({ kind: "compare", period: "last_week" });
    expect(parseFollowUpQuick("compare Naturalia avec hier", clients)).toMatchObject({ kind: "compare", period: "yesterday", client: { id: "c1" } });
  });
  it("« compare » alone = the previous period of the same length", () => {
    expect(parseFollowUpQuick("compare", clients)).toMatchObject({ kind: "compare", period: "previous" });
    expect(parseFollowUpQuick("compare avec la période d'avant", clients)).toMatchObject({ kind: "compare", period: "previous" });
  });
  it("a comparison of créas is the model's", () => {
    expect(parseFollowUpQuick("compare ça avec les créas de la semaine d'avant", clients)).toBeNull();
  });
});

describe("Mo — brands and competitors", () => {
  it("« montre les pubs de La Fourche » → the Ad Library, brand kept as typed", () => {
    expect(parseFollowUpQuick("Montre-moi les pubs de La Fourche", clients)).toMatchObject({ kind: "competitor_ads", brands: ["La Fourche"], client: null });
    expect(parseFollowUpQuick("montre les pubs de La Fourche et Aroma-Zone en ce moment", clients)).toMatchObject({ kind: "competitor_ads", brands: ["La Fourche", "Aroma-Zone"] });
  });
  it("« les concurrents de Naturalia » → the client, brands from HQ", () => {
    expect(parseFollowUpQuick("les concurrents de Naturalia", clients)).toMatchObject({ kind: "competitor_ads", brands: [], client: { id: "c1" } });
    expect(parseFollowUpQuick("que font les concurrents de cours legendre ?", clients)).toMatchObject({ kind: "competitor_ads", client: { id: "c2" } });
  });
  it("a client's own ads stay on the warehouse path", () => {
    expect(parseFollowUpQuick("montre les pubs de Naturalia", clients)).toBeNull();
  });
  it("splits brands on commas and « et »", () => {
    expect(splitBrands("montre les pubs de La Fourche, Greenweez et Kazidomi", "la fourche greenweez et kazidomi")).toEqual(["La Fourche", "Greenweez", "Kazidomi"]);
  });
});

describe("Mo — ghost titles of the follow-ups", () => {
  it("names what is coming", () => {
    expect(ghostTitle("deux autres comme ça", { kind: "more_like_this", n: 2, style: "", say: "" })).toBe("2 visuels en préparation");
    expect(ghostTitle("compare", { kind: "compare", period: "last_week", periodLabel: "la semaine dernière", client: null, say: "" })).toBe("Chiffres · la semaine dernière");
    expect(ghostTitle("x", { kind: "competitor_ads", brands: ["La Fourche"], client: null, say: "" })).toBe("Pubs La Fourche");
  });
});
