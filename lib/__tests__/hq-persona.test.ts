import { describe, expect, it } from "vitest";
import {
  parsePersonaFile, serializePersonaFile, personaIsStale, personaAgeDays, hasEnoughReviews,
  parsePersonaOutput, buildPersonaUserPrompt, personaPath, type PersonaInputs,
} from "@/lib/hq-persona";

const HQ_FILE = `---
statut: a_confirmer
source: recherche
maj: 2026-10-01
confirme_par: ""
---

# Personas et matrice de messages

> Avatars actionnables.
`;

function inputs(over: Partial<PersonaInputs> = {}): PersonaInputs {
  return { clientName: "Client Test", hqSlug: "client-test", hqBrief: null, hqFiles: [], existing: null, reviews: "", reviewsSource: "", notes: "", ads: [], adsWarning: null, ...over };
}

describe("parsePersonaFile", () => {
  it("reads HQ's frontmatter of state and keeps the body", () => {
    const { frontmatter, body, hasFrontmatter } = parsePersonaFile(HQ_FILE);
    expect(hasFrontmatter).toBe(true);
    expect(frontmatter).toMatchObject({ statut: "a_confirmer", source: "recherche", maj: "2026-10-01", confirme_par: "" });
    expect(frontmatter.rafraichir_tous_les).toBe("180j");
    expect(body.startsWith("# Personas et matrice de messages")).toBe(true);
    expect(body).not.toContain("statut:");
  });
  it("treats a file without frontmatter as a draft", () => {
    const r = parsePersonaFile("# Juste un titre\n\ntexte");
    expect(r.hasFrontmatter).toBe(false);
    expect(r.frontmatter.statut).toBe("brouillon");
    expect(r.body).toBe("# Juste un titre\n\ntexte");
  });
  it("falls back to brouillon on an unknown statut and unquotes values", () => {
    const r = parsePersonaFile(`---\nstatut: validé\nconfirme_par: "Sarah K."\nrafraichir_tous_les: 30j\n---\ncorps`);
    expect(r.frontmatter.statut).toBe("brouillon");
    expect(r.frontmatter.confirme_par).toBe("Sarah K.");
    expect(r.frontmatter.rafraichir_tous_les).toBe("30j");
  });
});

describe("serializePersonaFile", () => {
  it("round-trips through parsePersonaFile in HQ's key order", () => {
    const text = serializePersonaFile({ statut: "confirme", source: "mixte", maj: "2026-10-08", confirme_par: "Melvin", rafraichir_tous_les: "180j" }, "# Titre\n\ncorps");
    expect(text.split("\n").slice(0, 7)).toEqual(["---", "statut: confirme", "source: mixte", "maj: 2026-10-08", "confirme_par: Melvin", "rafraichir_tous_les: 180j", "---"]);
    const back = parsePersonaFile(text);
    expect(back.frontmatter.confirme_par).toBe("Melvin");
    expect(back.body).toBe("# Titre\n\ncorps");
  });
  it("quotes empty and risky values", () => {
    const text = serializePersonaFile({ statut: "a_confirmer", source: "", maj: "2026-10-08", confirme_par: "", rafraichir_tous_les: "" }, "corps");
    expect(text).toContain('source: ""');
    expect(text).toContain('confirme_par: ""');
    expect(text).toContain("rafraichir_tous_les: 180j");
    const quoted = serializePersonaFile({ statut: "confirme", source: "recherche", maj: "2026-10-08", confirme_par: "Jo: #1", rafraichir_tous_les: "180j" }, "corps");
    expect(parsePersonaFile(quoted).frontmatter.confirme_par).toBe("Jo: #1");
  });
});

describe("cadence", () => {
  const now = new Date("2026-10-08T10:00:00Z");
  it("flags an artefact older than its cadence", () => {
    expect(personaAgeDays({ maj: "2026-10-01" }, now)).toBe(7);
    expect(personaIsStale({ statut: "confirme", source: "", maj: "2026-01-01", confirme_par: "x", rafraichir_tous_les: "180j" }, now)).toBe(true);
    expect(personaIsStale({ statut: "confirme", source: "", maj: "2026-10-01", confirme_par: "x", rafraichir_tous_les: "180j" }, now)).toBe(false);
  });
  it("never flags without a date or a cadence", () => {
    expect(personaIsStale({ statut: "confirme", source: "", maj: "", confirme_par: "x", rafraichir_tous_les: "180j" }, now)).toBe(false);
    expect(personaIsStale({ statut: "confirme", source: "", maj: "2020-01-01", confirme_par: "x", rafraichir_tous_les: "jamais" }, now)).toBe(false);
  });
});

describe("hasEnoughReviews (HQ rule: no persona without reviews)", () => {
  it("accepts pasted reviews above the floor, or a filled langage-client.md in HQ", () => {
    expect(hasEnoughReviews(inputs())).toBe(false);
    expect(hasEnoughReviews(inputs({ reviews: "x".repeat(1500) }))).toBe(true);
    expect(hasEnoughReviews(inputs({ reviews: "x".repeat(200) }))).toBe(false);
    expect(hasEnoughReviews(inputs({ hqFiles: [{ path: "projects/c/brain/recherche/langage-client.md", label: "L", content: "y".repeat(2000), statut: "a_confirmer" }] }))).toBe(true);
    expect(hasEnoughReviews(inputs({ hqFiles: [{ path: "projects/c/brain/recherche/langage-client.md", label: "L", content: "y".repeat(2000), statut: "manquant" }] }))).toBe(false);
    expect(hasEnoughReviews(inputs({ hqFiles: [{ path: "projects/c/brain/contenu/voix.md", label: "V", content: "y".repeat(5000), statut: "confirme" }] }))).toBe(false);
  });
});

describe("prompt", () => {
  it("states the mode and what was given, and says when nothing was", () => {
    const p = buildPersonaUserPrompt(inputs(), "hypothese");
    expect(p).toContain("MODE : hypothese");
    expect(p).toContain("AVIS CLIENTS : aucun fourni.");
    expect(p).toContain("projects/client-test");
    const q = buildPersonaUserPrompt(inputs({ reviews: "Super produit", reviewsSource: "Trustpilot", ads: [{ name: "Ad 1", headline: "T", body: "B", landingUrl: "https://x", spend: 120, cpa: 12.5, status: "ACTIVE" }] }), "persona");
    expect(q).toContain("MODE : persona");
    expect(q).toContain("provenance : Trustpilot");
    expect(q).toContain("<avis>\nSuper produit\n</avis>");
    expect(q).toContain("CPA 12.5 €");
  });
});

describe("parsePersonaOutput", () => {
  it("takes the markdown fence and refuses an empty or headless answer", () => {
    const body = "# Personas et matrice de messages\n\n" + "ligne de contenu utile.\n".repeat(30);
    expect(parsePersonaOutput("Voici :\n```markdown\n" + body + "```\nfin")).toBe(body.trim());
    expect(parsePersonaOutput(body)).toBe(body.trim());
    expect(parsePersonaOutput("trop court")).toBeNull();
    expect(parsePersonaOutput("pas de titre " + "x".repeat(500))).toBeNull();
  });
});

describe("personaPath", () => {
  it("is HQ's single artefact path", () => {
    expect(personaPath("cours-legendre")).toBe("projects/cours-legendre/brain/recherche/personas.md");
  });
});
