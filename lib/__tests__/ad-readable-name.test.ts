import { describe, expect, it } from "vitest";
import { readableAdName } from "@/lib/ad-readable-name";

describe("readableAdName — nom de créa lisible par un client", () => {
  it("convention de l'agence : valeurs utiles, dans l'ordre, sans les clés techniques", () => {
    expect(readableAdName("W45Y26_SGL_IMG_b-brand_g-sport-desti_sp-trek_de-capvert_th-solo_pc-solo_co-promessespot_m-paysages_f-story_i-sentiervolcanique_lp-desti-capvert_it-v1"))
      .toBe("Trek · Cap-Vert · Solo · Promessespot · Paysages");
    expect(readableAdName("W45Y26_SGL_VID_b-brand_g-sport-desti_sp-rando_de-monde_pc-all_co-randoetrangercircuit_m-experience_f-facecam_ho-imaginetuparsou_lp-theme-circuitdecouverte_it-v1"))
      .toBe("Rando · Monde · Randoetrangercircuit · Experience");
    expect(readableAdName("W44Y26_SGL_IMG_b-brand_g-generique_th-nouvelan_pc-famille_co-noelausoleilfamille_m-experience")).toBe("Nouvel an · Famille · Noelausoleilfamille · Experience");
  });
  it("nom tronqué : le dernier segment incomplet reste tel quel, sans casser", () => {
    expect(readableAdName("W45Y26_SGL_IMG_b-brand_g-sport-desti_sp-trek_de-capvert_th-s")).toBe("Trek · Cap-Vert · S");
  });
  it("nom hors convention ou déjà lisible : inchangé", () => {
    expect(readableAdName("Decathlon Travel 2025-01-14-88c1d12289ba")).toBe("Decathlon Travel 2025-01-14-88c1d12289ba");
    expect(readableAdName("Trek · Cap-Vert · Solo")).toBe("Trek · Cap-Vert · Solo");
    expect(readableAdName("Promo été - vidéo 2")).toBe("Promo été - vidéo 2");
    expect(readableAdName("")).toBe("");
  });
});
