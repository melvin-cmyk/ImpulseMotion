export interface MetricDefinition {
  label: string;
  description: string;
  formula: string;
  benchmark?: string;
  note?: string;
}

export const METRIC_DEFINITIONS: Record<string, MetricDefinition> = {
  spend: {
    label: "Spend",
    description: "Montant total dépensé sur cette créa ou ce groupe sur la période sélectionnée.",
    formula: "Somme de tous les coûts publicitaires facturés par la plateforme.",
    benchmark: "Pas de benchmark universel — dépend du budget alloué.",
  },
  roas: {
    label: "ROAS",
    description: "Return on Ad Spend — revenus générés pour chaque dollar dépensé en pub.",
    formula: "ROAS = Revenus attribués / Spend",
    benchmark: "≥ 2x pour rentabiliser, ≥ 4x = excellent.",
    note: "Les revenus sont basés sur les conversions trackées par le pixel Meta/TikTok.",
  },
  cpa: {
    label: "CPA",
    description: "Cost Per Acquisition — coût moyen pour obtenir une conversion (achat, lead, etc.).",
    formula: "CPA = Spend / Nombre de conversions",
    benchmark: "Dépend de la marge produit. Comparer au CPA cible défini dans la stratégie.",
    note: "Affiché uniquement si au moins une conversion a été enregistrée.",
  },
  ctr: {
    label: "CTR",
    description: "Click-Through Rate — pourcentage d'impressions ayant généré un clic sur l'annonce.",
    formula: "CTR = (Clics / Impressions) × 100",
    benchmark: "≥ 1% correct, ≥ 2% bon, ≥ 3% excellent (Meta).",
  },
  hookRate: {
    label: "Hook Rate",
    description: "Taux de rétention dans les 3 premières secondes — mesure si l'accroche de la vidéo capte l'attention.",
    formula: "Hook Rate = (Vues 3 secondes / Impressions) × 100",
    benchmark: "≥ 25% bon, ≥ 40% excellent. En dessous de 15% = problème d'accroche.",
    note: "Disponible uniquement pour les formats vidéo.",
  },
  holdRate: {
    label: "Hold Rate",
    description: "Taux de rétention globale de la vidéo — mesure si les spectateurs regardent jusqu'au bout après les 3 premières secondes.",
    formula: "Hold Rate = (Vues P75 / Vues 3 secondes) × 100",
    benchmark: "≥ 25% = bonne rétention. Faible = la vidéo perd les spectateurs tôt.",
    note: "Disponible uniquement pour les formats vidéo.",
  },
  cpm: {
    label: "CPM",
    description: "Cost Per Mille — coût pour 1 000 impressions. Reflète le coût d'achat d'inventaire publicitaire.",
    formula: "CPM = (Spend / Impressions) × 1 000",
    benchmark: "$10–$30 normal sur Meta, > $50 = cher. Dépend du ciblage et de la concurrence.",
  },
  cpc: {
    label: "CPC",
    description: "Cost Per Click — coût moyen par clic sur l'annonce.",
    formula: "CPC = Spend / Nombre de clics",
    benchmark: "< $1 excellent, $1–$3 normal, > $5 élevé (varie selon le secteur).",
  },
  impressions: {
    label: "Impressions",
    description: "Nombre total de fois où l'annonce a été affichée, incluant les ré-affichages au même utilisateur.",
    formula: "Comptage brut fourni par la plateforme.",
    note: "Différent du Reach qui compte les utilisateurs uniques.",
  },
  conversions: {
    label: "Conversions",
    description: "Nombre total d'actions de conversion attribuées (achats, leads, inscriptions...) selon la fenêtre d'attribution configurée.",
    formula: "Comptage des événements de conversion tracés par le pixel sur la fenêtre d'attribution.",
    note: "Fenêtre d'attribution par défaut Meta : 7 jours clic + 1 jour vue.",
  },
  funnelHook: {
    label: "Score Hook",
    description: "Score de 0 à 100 mesurant la performance de l'accroche vidéo par rapport au benchmark de 15%.",
    formula: "Score Hook = (Hook Rate / 15%) × 100, plafonné à 100",
    benchmark: "Vert ≥ 67, Jaune ≥ 34, Rouge < 34.",
    note: "Disponible uniquement pour les formats vidéo avec Hook Rate > 0.",
  },
  funnelWatch: {
    label: "Score Watch",
    description: "Score de 0 à 100 mesurant la rétention vidéo au 75e percentile par rapport au benchmark de 50%.",
    formula: "Score Watch = (Video P75 Rate / 50%) × 100, plafonné à 100",
    benchmark: "Vert ≥ 67, Jaune ≥ 34, Rouge < 34.",
    note: "P75 = 75% de la durée de la vidéo regardée.",
  },
  funnelClick: {
    label: "Score Click",
    description: "Score de 0 à 100 mesurant la performance du CTR par rapport au benchmark de 3%.",
    formula: "Score Click = (CTR / 3%) × 100, plafonné à 100",
    benchmark: "Vert ≥ 67, Jaune ≥ 34, Rouge < 34.",
  },
  funnelConvert: {
    label: "Score Convert",
    description: "Score de 0 à 100 mesurant la performance du ROAS par rapport au benchmark de 4x.",
    formula: "Score Convert = (ROAS / 4) × 100, plafonné à 100",
    benchmark: "Vert ≥ 67, Jaune ≥ 34, Rouge < 34.",
  },
  hitRate: {
    label: "Hit Rate",
    description: "Pourcentage de créas classées Winner dans un groupe (audience, angle, pattern, format...).",
    formula: "Hit Rate = (Nombre de Winners / Nombre total de créas dans le groupe) × 100",
    benchmark: "Hit rate > 30% = groupe très performant.",
  },
  score: {
    label: "Score (A/B/C/D)",
    description: "Score composite de qualité de la créa calculé selon le format.",
    formula: "Vidéo — A: Hook ≥ 30% ET ROAS ≥ 4 | B: Hook ≥ 20% OU ROAS ≥ 3.5 | C: Hook ≥ 10% OU ROAS ≥ 2 | D: reste. Image/Carousel — A: ROAS ≥ 4 ET CTR ≥ 2.5% | B: ROAS ≥ 3 OU CTR ≥ 2% | C: ROAS ≥ 1.5 OU CTR ≥ 1% | D: reste.",
    note: "Score A = meilleur. D = performances insuffisantes.",
  },
  wowChange: {
    label: "Variation WoW",
    description: "Variation Week-over-Week — évolution en pourcentage d'une métrique par rapport à la semaine précédente.",
    formula: "WoW% = ((Valeur semaine actuelle − Valeur semaine précédente) / Valeur semaine précédente) × 100",
    note: "Vert si positif (sauf pour le CPA où une baisse = amélioration).",
  },
  frequency: {
    label: "Fréquence",
    description: "Nombre moyen de fois qu'un utilisateur unique a vu cette annonce sur la période.",
    formula: "Fréquence = Impressions / Reach (utilisateurs uniques)",
    benchmark: "Fréquence > 3–4 = risque de fatigue créative.",
    note: "Une fréquence élevée associée à un CTR baissant = signal de fatigue.",
  },
};
