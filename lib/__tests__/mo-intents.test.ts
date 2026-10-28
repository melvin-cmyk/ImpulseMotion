import { describe, expect, it } from "vitest";
import { matchClientName, parseNavIntent } from "@/lib/mo/intents";

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
  it("leaves data questions to the model", () => {
    expect(parseNavIntent("montre-moi les créas Meta de Naturalia postées vendredi avec CPA, CPL et leads", clients)).toBeNull();
    expect(parseNavIntent("quel client a le CPL le plus bas sur Meta cette semaine ?", clients)).toBeNull();
    expect(parseNavIntent("compare ça avec la semaine d'avant", clients)).toBeNull();
    expect(parseNavIntent("affiche le top des créas de LPEV", clients)).toBeNull();
    expect(parseNavIntent("bonjour Mo", clients)).toBeNull();
  });
});
