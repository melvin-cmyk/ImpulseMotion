/**
 * Pilotage — « Nouvelle publicité », format Dynamique: the form rendered on
 * the server (no browser): the Dynamique tab is open only in an ad set
 * created in dynamic creative, where the other formats are greyed with the
 * reason; the editor shows the counters and the combinations.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NewAdForm } from "@/components/pilot/ad-form";
import { DynamicEditor, dynamicFormError, emptyVariants } from "@/components/pilot/ad-form/dynamic-editor";
import { DYNAMIC_ADSET_ONLY_FORMAT, DYNAMIC_TAB_LOCKED, DYNAMIC_TAB_OCCUPIED, formatLock } from "@/components/pilot/ad-form/shared";

const base = { clientId: "c-nat", accountId: "1668772300254268", adsetId: "23857040420440567", adsetName: "IA - Broad", preset: null, onCancel: () => undefined, onDone: () => undefined };
const tab = (html: string, label: string) => html.match(new RegExp(`<button[^>]*role="tab"[^>]*>${label}<`))?.[0] ?? "";

describe("formulaire Nouvelle publicité — onglet Dynamique", () => {
  it("dans un ensemble ordinaire, Dynamique est grisé avec la raison et Image est l'onglet ouvert", () => {
    const html = renderToStaticMarkup(createElement(NewAdForm, { ...base }));
    expect(tab(html, "Dynamique")).toContain("disabled");
    expect(tab(html, "Dynamique")).toContain(DYNAMIC_TAB_LOCKED.replace(/'/g, "&#x27;").slice(0, 30));
    expect(tab(html, "Image")).toContain('aria-selected="true"');
    expect(tab(html, "Image")).not.toContain("disabled");
  });

  it("dans un ensemble dynamique, Dynamique est l'onglet ouvert (le temps de compter ses publicités) et les autres formats sont grisés", () => {
    const html = renderToStaticMarkup(createElement(NewAdForm, { ...base, adsetDynamic: true }));
    expect(tab(html, "Dynamique")).toContain('aria-selected="true"');
    for (const other of ["Image", "Vidéo", "Carrousel"]) {
      expect(tab(html, other)).toContain("disabled");
      expect(tab(html, other)).toContain(DYNAMIC_ADSET_ONLY_FORMAT.replace(/'/g, "&#x27;").slice(0, 30));
    }
    expect(html).toContain("Visuels de la publicité dynamique");
    expect(html).toContain("Textes principaux");
    expect(html).toContain("un seul pour toutes les combinaisons");
  });

  it("formatLock : ensemble dynamique vide → ouvert ; occupé → grisé ; ordinaire → Dynamique grisé, le reste ouvert", () => {
    expect(formatLock("dynamic", { dynamic: true, adCount: 0 })).toBeNull();
    expect(formatLock("dynamic", { dynamic: true, adCount: 1 })).toBe(DYNAMIC_TAB_OCCUPIED);
    expect(formatLock("dynamic", { dynamic: true, adCount: null })).toMatch(/Lecture/);
    expect(formatLock("dynamic", { dynamic: false, adCount: 0 })).toBe(DYNAMIC_TAB_LOCKED);
    expect(formatLock("image", { dynamic: true, adCount: 0 })).toBe(DYNAMIC_ADSET_ONLY_FORMAT);
    expect(formatLock("image", { dynamic: false, adCount: 3 })).toBeNull();
  });

  it("l'éditeur compte les visuels, les variantes et les combinaisons ; dynamicFormError dit ce qui manque", () => {
    const media = [{ kind: "image" as const, url: "https://cdn.example.org/1.jpg" }, { kind: "video" as const, url: "https://cdn.example.org/2.mp4", thumbUrl: "https://cdn.example.org/2.jpg" }];
    const variants = { primary: ["Texte A", "Texte B"], headline: ["Titre"], description: [], ctas: ["SHOP_NOW", "LEARN_MORE"] };
    const html = renderToStaticMarkup(createElement(DynamicEditor, { media, onMediaChange: () => undefined, variants, onVariantsChange: () => undefined, studio: [], clientId: "c-nat", ctas: [["SHOP_NOW", "Acheter"], ["LEARN_MORE", "En savoir plus"]] }));
    expect(html).toContain("1/10 images · 1/10 vidéos");
    expect(html).toContain("2/5");
    expect(html).toMatch(/8 combinaisons possibles/);
    expect(dynamicFormError(media, variants)).toBeNull();
    expect(dynamicFormError([], variants)).toBe("Ajoutez au moins une image ou une vidéo.");
    expect(dynamicFormError([{ kind: "video", url: "https://cdn.example.org/2.mp4" }], variants)).toMatch(/vignette/);
    expect(dynamicFormError(media, { ...emptyVariants(), primary: [" "] })).toBe("Écrivez au moins un texte principal.");
    expect(dynamicFormError(media, { ...variants, primary: ["a", "b", "c", "d", "e", "f"] })).toBe("5 textes principaux au plus.");
  });
});
