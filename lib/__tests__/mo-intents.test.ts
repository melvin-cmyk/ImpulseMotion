import { describe, expect, it } from "vitest";
import { matchClientName, parseNavIntent, parseQuickIntent } from "@/lib/mo/intents";

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
    const q = parseQuickIntent("Affiche-moi les créas de cette semaine sur Cours Legendre", clients);
    expect(q).toMatchObject({ kind: "creatives", args: { client: "c2", period: "this_week" } });
    expect(q?.say).toContain("Cours Legendre");
  });
  it("the N latest, the top spenders, launched this week", () => {
    expect(parseQuickIntent("sors-moi les 10 dernières créas qu'on a mises sur Meta pour Cours Legendre", clients)?.args).toMatchObject({ client: "c2", sort: "launch", order: "desc", limit: 10, platform: "meta" });
    expect(parseQuickIntent("montre les créas de LPEV qui ont le plus dépensé ces 7 derniers jours", clients)?.args).toMatchObject({ client: "c3", sort: "spend", period: "last_7d" });
    expect(parseQuickIntent("les créas lancées cette semaine chez Naturalia", clients)?.args).toMatchObject({ launched_in_period: true, period: "this_week" });
  });
  it("figures of a client", () => {
    expect(parseQuickIntent("le CPA de Naturalia cette semaine", clients)).toMatchObject({ kind: "metrics", args: { client: "c1", period: "this_week" } });
    expect(parseQuickIntent("ça donne quoi sur LPEV ce mois-ci par campagne ?", clients)?.args).toMatchObject({ period: "this_month", by: "campaign" });
  });
  it("leaves the rest to the model", () => {
    expect(parseQuickIntent("compare les créas de Naturalia avec la semaine dernière", clients)).toBeNull();
    expect(parseQuickIntent("crée-moi deux créas pour Naturalia", clients)).toBeNull();
    expect(parseQuickIntent("pourquoi le CPA de LPEV monte cette semaine ?", clients)).toBeNull();
    expect(parseQuickIntent("ouvre le cockpit de Naturalia", clients)).toBeNull();
    expect(parseQuickIntent("affiche les créas", clients)).toBeNull();
  });
});
