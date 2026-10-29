import { describe, it, expect } from "vitest";
import { cheapestEngine, enginePrice, type Engine } from "@/components/creas/shared";

const ENGINES: Engine[] = [
  { id: "agnes-image-2.5-flash", label: "Agnes 2.5 Flash", provider: "agnes", refs: true, usd: 0 },
  { id: "fal-ai/flux/schnell", label: "FLUX Schnell", provider: "fal", refs: false, usd: 0.003 },
  { id: "fal-ai/nano-banana", label: "Nano Banana", provider: "fal", refs: false, usd: 0.039 },
  { id: "fal-ai/nano-banana/edit", label: "Nano Banana Edit", provider: "fal", refs: true, usd: 0.039 },
  { id: "fal-ai/nano-banana-2/edit", label: "Nano Banana 2 Edit", provider: "fal", refs: true, usd: 0.06 },
];

describe("Créas — Générer : moteur par défaut et prix", () => {
  it("prend le moins cher qui convient : FLUX Schnell sans référence, Nano Banana Edit avec", () => {
    expect(cheapestEngine(ENGINES, false)?.id).toBe("fal-ai/flux/schnell");
    expect(cheapestEngine(ENGINES, true)?.id).toBe("fal-ai/nano-banana/edit");
  });
  it("Agnes seulement quand fal n'est pas configuré", () => {
    expect(cheapestEngine(ENGINES.filter((e) => e.provider === "agnes"), false)?.id).toBe("agnes-image-2.5-flash");
    expect(cheapestEngine([], true)).toBeNull();
  });
  it("affiche le prix par image, même sous le centime", () => {
    expect(enginePrice({ usd: 0.003 })).toBe("0,003 $ / image");
    expect(enginePrice({ usd: 0.039 })).toBe("0,039 $ / image");
    expect(enginePrice({ usd: 0.06 })).toBe("0,06 $ / image");
    expect(enginePrice({ usd: 0 })).toBe("gratuit");
  });
});
