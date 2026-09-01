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
    description: "Return on Ad Spend — revenu généré pour chaque unité de devise dépensée en pub.",
    formula: "ROAS = Revenus attribués / Spend",
    benchmark: "≥ 2x pour rentabiliser, ≥ 4x = excellent.",
    note: "Revenu = valeur d'achat trackée par le pixel. Si le compte ne remonte pas de valeur, le ROAS est estimé (conversions × panier moyen, marqué *) ; sans panier moyen configuré il est affiché « — ».",
  },
  cpa: {
    label: "CPA",
    description: "Cost Per Acquisition — coût moyen pour obtenir une conversion (achat, lead… selon l'événement de conversion du compte).",
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
    label: "Hook (démarrages / impressions)",
    description: "Part des impressions qui ont déclenché un démarrage de la vidéo (Meta video_play_actions). Mesure si l'accroche capte l'attention.",
    formula: "Hook = (Démarrages vidéo / Impressions) × 100",
    benchmark: "≥ 25% bon, ≥ 40% excellent. En dessous de 20% = signal de fatigue / accroche faible.",
    note: "Disponible uniquement pour les formats vidéo. Meta ne fournit pas de « vues 3 s » au niveau annonce : le démarrage (video_play_actions) est la métrique disponible.",
  },
  holdRate: {
    label: "Hold (ThruPlay / impressions)",
    description: "Part des impressions ayant abouti à un ThruPlay (vidéo vue jusqu'au bout ou ≥ 15 s). Mesure la rétention globale.",
    formula: "Hold = (ThruPlays / Impressions) × 100",
    benchmark: "≥ 40% = bonne rétention. Faible = la vidéo perd les spectateurs tôt.",
    note: "Disponible uniquement pour les formats vidéo. Même définition partout (fiche créa, tableaux, score Watch).",
  },
  cpm: {
    label: "CPM",
    description: "Cost Per Mille — coût pour 1 000 impressions. Reflète le coût d'achat d'inventaire publicitaire.",
    formula: "CPM = (Spend / Impressions) × 1 000",
    benchmark: "Dépend du marché, du ciblage et de la devise du compte ; à comparer au CPM du compte.",
  },
  cpc: {
    label: "CPC",
    description: "Cost Per Click — coût moyen par clic sur l'annonce.",
    formula: "CPC = Spend / Nombre de clics",
    benchmark: "Varie selon le secteur et la devise ; à comparer au CPC du compte.",
  },
  impressions: {
    label: "Impressions",
    description: "Nombre total de fois où l'annonce a été affichée, incluant les ré-affichages au même utilisateur.",
    formula: "Comptage brut fourni par la plateforme.",
    note: "Différent du Reach qui compte les utilisateurs uniques.",
  },
  conversions: {
    label: "Conversions",
    description: "Nombre d'actions de conversion attribuées pour l'événement configuré sur le compte (achats par défaut, leads pour un compte lead-gen…) selon la fenêtre d'attribution.",
    formula: "Comptage des événements de conversion tracés par le pixel sur la fenêtre d'attribution.",
    note: "Fenêtre d'attribution par défaut Meta : 7 jours clic + 1 jour vue.",
  },
  funnelHook: {
    label: "Score Hook",
    description: "Score de 0 à 100 mesurant la performance de l'accroche vidéo (démarrages / impressions) par rapport au benchmark de 15%.",
    formula: "Score Hook = (Hook / 15%) × 100, plafonné à 100",
    benchmark: "Vert ≥ 67, Jaune ≥ 34, Rouge < 34.",
    note: "Disponible uniquement pour les formats vidéo avec Hook > 0.",
  },
  funnelWatch: {
    label: "Score Watch",
    description: "Score de 0 à 100 mesurant la rétention vidéo (ThruPlay / impressions) par rapport au benchmark de 40%.",
    formula: "Score Watch = (Hold / 40%) × 100, plafonné à 100",
    benchmark: "Vert ≥ 67, Jaune ≥ 34, Rouge < 34.",
    note: "Même définition que le Hold rate (ThruPlay / impressions).",
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
    note: "« — » quand le ROAS n'est pas disponible (pas de valeur d'achat trackée ni de panier moyen).",
  },
  status: {
    label: "Statut (Winner / Loser / Fatigued)",
    description: "Statut de performance calculé par rapport au compte sur la période, pas un champ Meta.",
    formula: "Dépense significative = ≥ max(3 % du spend du compte, 5 × spend médian). Winner : significative ET (CPA ≤ 0,8 × CPA compte OU ROAS ≥ 1,25 × ROAS compte). Loser : significative ET (CPA ≥ 1,5 × CPA compte OU aucune conversion avec spend > 3 × CPA compte). Fatigued : hook vidéo < 20 % ou fréquence hebdo ≥ 3,5.",
    note: "Sans conversion sur le compte, aucun Winner/Loser. Un ROAS estimé ou indisponible n'influence jamais le statut.",
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
    note: "Score A = meilleur. D = performances insuffisantes. Un ROAS indisponible compte comme 0 (seuls les critères Hook / CTR jouent).",
  },
  wowChange: {
    label: "Variation WoW",
    description: "Variation Week-over-Week — évolution en pourcentage d'une métrique par rapport à la semaine précédente.",
    formula: "WoW% = ((Valeur semaine actuelle − Valeur semaine précédente) / Valeur semaine précédente) × 100",
    note: "Vert si positif (sauf pour le CPA où une baisse = amélioration).",
  },
  frequency: {
    label: "Fréquence",
    description: "Nombre moyen de fois qu'un utilisateur unique a vu cette annonce sur la période (Meta : impressions / reach).",
    formula: "Fréquence = Impressions / Reach (utilisateurs uniques)",
    benchmark: "Fréquence hebdo ≥ 3,5 = saturation d'audience probable.",
    note: "Pour comparer des périodes différentes, la fréquence est normalisée par semaine : fréquence × 7 / nombre de jours de la période.",
  },
  frequencyWeekly: {
    label: "Fréquence hebdo",
    description: "Fréquence Meta ramenée à 7 jours pour être comparable quelle que soit la période sélectionnée.",
    formula: "Fréquence hebdo = Fréquence × 7 / jours de la période",
    benchmark: "≥ 3,5 = saturation d'audience (signal de fatigue).",
  },
};
