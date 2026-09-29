/**
 * Routines — proposals really written by the composing AI (live trial of
 * 29 September 2026, lib/__tests__/routines-compose-live.test.ts), kept as they
 * came: the integration tests run them through the real steps.
 *
 * The Google Sheets named here do not exist (the trial gave made-up document
 * ids, to see the AI say that it could not read them).
 */

export const LIVE_PROPOSALS = {
 "hebdo": {
  "name": "Top 5 Meta hebdo dans Slack",
  "description": "Chaque lundi à 09:00, les 5 campagnes Meta qui ont le plus dépensé sur 7 jours, avec un commentaire rédigé, dans #c_recette.",
  "schedule": {
   "kind": "weekly",
   "time": "09:00",
   "weekdays": [
    1
   ]
  },
  "definition": {
   "version": 1,
   "steps": [
    {
     "id": "perf",
     "type": "meta.insights",
     "label": "Performances Meta par campagne sur 7 jours",
     "level": "campaign",
     "window": "7d",
     "metrics": [
      "spend",
      "impressions",
      "clicks",
      "ctr",
      "conversions",
      "cpa",
      "roas"
     ]
    },
    {
     "id": "tri",
     "type": "rows.sort",
     "label": "Tri par dépense décroissante",
     "by": "spend",
     "dir": "desc"
    },
    {
     "id": "top",
     "type": "rows.limit",
     "label": "Les 5 plus grosses dépenses",
     "count": 5
    },
    {
     "id": "colonnes",
     "type": "rows.select",
     "label": "Colonnes du tableau",
     "columns": [
      {
       "from": "campaign_name",
       "as": "campagne"
      },
      {
       "from": "spend",
       "as": "depense"
      },
      {
       "from": "impressions"
      },
      {
       "from": "clicks",
       "as": "clics"
      },
      {
       "from": "ctr"
      },
      {
       "from": "conversions"
      },
      {
       "from": "cpa"
      },
      {
       "from": "roas"
      }
     ]
    },
    {
     "id": "resume",
     "type": "ai.summary",
     "label": "Commentaire rédigé",
     "instruction": "En trois ou quatre phrases, en français, ton professionnel : quelle campagne porte la dépense, ce qui fonctionne bien (CPA, ROAS), ce qui décroche, et le point à surveiller cette semaine. Ne pas inventer de chiffres absents du tableau.",
     "maxChars": 700,
     "onFailure": "continue_without"
    },
    {
     "id": "envoi",
     "type": "slack.message",
     "label": "Message Slack",
     "channel": "#c_recette",
     "text": "Top 5 des campagnes Meta – 7 derniers jours (point du {{run.date}})\n{{steps.resume.text}}",
     "includeTable": true
    }
   ]
  },
  "explanation": "Chaque lundi à 09:00, la routine lit les performances Meta par campagne sur les 7 derniers jours et garde les 5 qui ont le plus dépensé. Elle fait rédiger un court commentaire et le poste dans #c_recette avec le tableau. Si le commentaire n'a pas pu être rédigé, le message part quand même avec le tableau seul. Si aucune campagne n'a dépensé, aucun message ne part.",
  "assumptions": [
   "Le canal #c_recette existe et le bot de l'agence y est invité (je n'ai pas pu le vérifier).",
   "L'heure de 09:00 le lundi a été choisie par défaut, car aucune heure n'a été précisée."
  ]
 },
 "suivi_upsert": {
  "name": "Suivi quotidien Meta + Google Ads dans le Sheet",
  "description": "Chaque matin à 7 h 30, dépense et conversions de la veille par campagne, Meta et Google Ads, ajoutées à l'onglet « Suivi quotidien ».",
  "schedule": {
   "kind": "daily",
   "time": "07:30"
  },
  "definition": {
   "version": 1,
   "steps": [
    {
     "id": "meta",
     "type": "meta.insights",
     "label": "Campagnes Meta de la veille",
     "level": "campaign",
     "window": "yesterday",
     "metrics": [
      "spend",
      "conversions"
     ]
    },
    {
     "id": "meta_actives",
     "type": "rows.filter",
     "label": "Campagnes Meta ayant dépensé",
     "where": [
      {
       "column": "spend",
       "op": "gt",
       "value": 0
      }
     ]
    },
    {
     "id": "ecrire_meta",
     "type": "sheet.write",
     "label": "Écrire les lignes Meta",
     "sheet": {
      "spreadsheetId": "1QzXk7Rt3LmN8pVw2YbC5dFg9HjK4sAe6UiOoPl0MnBv",
      "tab": "Suivi quotidien"
     },
     "mode": "upsert",
     "keyColumn": "cle",
     "columns": [
      {
       "column": "cle",
       "value": "{{row.date_start}}-meta-{{row.campaign_id}}"
      },
      {
       "column": "date",
       "value": "{{row.date_start}}"
      },
      {
       "column": "plateforme",
       "value": "Meta"
      },
      {
       "column": "id_campagne",
       "value": "{{row.campaign_id}}"
      },
      {
       "column": "campagne",
       "value": "{{row.campaign_name}}"
      },
      {
       "column": "depense",
       "value": "{{row.spend}}"
      },
      {
       "column": "conversions",
       "value": "{{row.conversions}}"
      },
      {
       "column": "devise",
       "value": "{{row.currency}}"
      }
     ]
    },
    {
     "id": "google",
     "type": "google.insights",
     "label": "Campagnes Google Ads de la veille",
     "level": "campaign",
     "window": "yesterday",
     "metrics": [
      "spend",
      "conversions"
     ]
    },
    {
     "id": "google_actives",
     "type": "rows.filter",
     "label": "Campagnes Google Ads ayant dépensé",
     "where": [
      {
       "column": "spend",
       "op": "gt",
       "value": 0
      }
     ]
    },
    {
     "id": "ecrire_google",
     "type": "sheet.write",
     "label": "Écrire les lignes Google Ads",
     "sheet": {
      "spreadsheetId": "1QzXk7Rt3LmN8pVw2YbC5dFg9HjK4sAe6UiOoPl0MnBv",
      "tab": "Suivi quotidien"
     },
     "mode": "upsert",
     "keyColumn": "cle",
     "columns": [
      {
       "column": "cle",
       "value": "{{row.date_start}}-google-{{row.campaign_id}}"
      },
      {
       "column": "date",
       "value": "{{row.date_start}}"
      },
      {
       "column": "plateforme",
       "value": "Google Ads"
      },
      {
       "column": "id_campagne",
       "value": "{{row.campaign_id}}"
      },
      {
       "column": "campagne",
       "value": "{{row.campaign_name}}"
      },
      {
       "column": "depense",
       "value": "{{row.spend}}"
      },
      {
       "column": "conversions",
       "value": "{{row.conversions}}"
      },
      {
       "column": "devise",
       "value": "{{row.currency}}"
      }
     ]
    }
   ]
  },
  "maxItemsPerRun": 50,
  "explanation": "Chaque matin à 7 h 30, la routine lit la dépense et les conversions de la veille par campagne sur Meta puis sur Google Ads. Elle ne garde que les campagnes qui ont dépensé et écrit une ligne par campagne dans « Suivi quotidien ». La colonne « cle » (date, plateforme, identifiant de campagne) permet de mettre à jour une ligne existante au lieu de la dupliquer en cas de relance.",
  "assumptions": [
   "Le Sheet sera partagé en éditeur avec data@impulse-analytics.com avant l'essai à blanc : je n'ai pas pu y accéder aujourd'hui.",
   "La ligne 1 de l'onglet « Suivi quotidien » contient exactement : cle, date, plateforme, id_campagne, campagne, depense, conversions, devise (je n'ai pas pu la relire).",
   "Une cinquantaine de lignes par exécution suffit pour les campagnes Meta et Google Ads qui dépensent un même jour ; au-delà, le surplus attendrait l'exécution suivante."
  ]
 },
 "suivi_append": {
  "name": "Suivi quotidien Meta + Google Ads dans le Sheet",
  "description": "Chaque matin à 7 h 30, ajoute dans l'onglet « Suivi quotidien » la dépense et les conversions de la veille par campagne, pour Meta puis pour Google Ads.",
  "schedule": {
   "kind": "daily",
   "time": "07:30"
  },
  "definition": {
   "version": 1,
   "steps": [
    {
     "id": "meta_perf",
     "type": "meta.insights",
     "label": "Campagnes Meta d'hier",
     "level": "campaign",
     "window": "yesterday",
     "metrics": [
      "spend",
      "conversions"
     ]
    },
    {
     "id": "meta_actives",
     "type": "rows.filter",
     "label": "Campagnes Meta ayant dépensé",
     "where": [
      {
       "column": "spend",
       "op": "gt",
       "value": 0
      }
     ]
    },
    {
     "id": "meta_ecriture",
     "type": "sheet.write",
     "label": "Ajout des lignes Meta",
     "sheet": {
      "spreadsheetId": "1QzXk7Rt3LmN8pVw2YbC5dFg9HjK4sAe6UiOoPl0MnBv",
      "tab": "Suivi quotidien"
     },
     "mode": "append",
     "columns": [
      {
       "column": "date",
       "value": "{{row.date_start}}"
      },
      {
       "column": "plateforme",
       "value": "Meta"
      },
      {
       "column": "campagne",
       "value": "{{row.campaign_name}}"
      },
      {
       "column": "depense",
       "value": "{{row.spend}}"
      },
      {
       "column": "conversions",
       "value": "{{row.conversions}}"
      }
     ]
    },
    {
     "id": "google_perf",
     "type": "google.insights",
     "label": "Campagnes Google Ads d'hier",
     "level": "campaign",
     "window": "yesterday",
     "metrics": [
      "spend",
      "conversions"
     ]
    },
    {
     "id": "google_actives",
     "type": "rows.filter",
     "label": "Campagnes Google Ads ayant dépensé",
     "where": [
      {
       "column": "spend",
       "op": "gt",
       "value": 0
      }
     ]
    },
    {
     "id": "google_ecriture",
     "type": "sheet.write",
     "label": "Ajout des lignes Google Ads",
     "sheet": {
      "spreadsheetId": "1QzXk7Rt3LmN8pVw2YbC5dFg9HjK4sAe6UiOoPl0MnBv",
      "tab": "Suivi quotidien"
     },
     "mode": "append",
     "columns": [
      {
       "column": "date",
       "value": "{{row.date_start}}"
      },
      {
       "column": "plateforme",
       "value": "Google Ads"
      },
      {
       "column": "campagne",
       "value": "{{row.campaign_name}}"
      },
      {
       "column": "depense",
       "value": "{{row.spend}}"
      },
      {
       "column": "conversions",
       "value": "{{row.conversions}}"
      }
     ]
    }
   ]
  },
  "explanation": "Chaque matin à 7 h 30, la routine lit les campagnes Meta de la veille et ajoute au Sheet celles qui ont dépensé, avec la date des chiffres, la plateforme, le nom, la dépense et les conversions. Elle fait ensuite de même pour Google Ads. Si vous la relancez à la main le même jour, les lignes seront ajoutées une deuxième fois.",
  "assumptions": [
   "Le Sheet sera partagé en éditeur avec data@impulse-analytics.com avant l'essai à blanc : je n'ai pas pu le lire.",
   "L'onglet s'appelle exactement « Suivi quotidien » et son en-tête en ligne 1 est exactement : date, plateforme, campagne, depense, conversions (non vérifié).",
   "Les conversions retenues sont celles que la plateforme compte par défaut pour chaque compte ; elles ne se comparent pas forcément d'une plateforme à l'autre."
  ]
 },
 "creas": {
  "name": "Créas du Sheet → publicités Meta en pause",
  "description": "Du lundi au vendredi à 8 h, crée en pause les publicités des nouvelles lignes de l'onglet Créas dans l'ensemble LAL BDD + Ex180JPurchases - Static, note le résultat dans le Sheet et prévient #c_recette.",
  "schedule": {
   "kind": "weekly",
   "time": "08:00",
   "weekdays": [
    1,
    2,
    3,
    4,
    5
   ]
  },
  "definition": {
   "version": 1,
   "steps": [
    {
     "id": "lecture",
     "type": "sheet.read",
     "label": "Lire l'onglet Créas",
     "sheet": {
      "spreadsheetId": "1Hn4RkT9wZqLp2XcV7bM5sDfG8jYaE3uKoPi6NmBvCxQ",
      "tab": "Créas"
     },
     "requiredColumns": [
      "id",
      "nom_pub",
      "texte_principal",
      "titre",
      "description",
      "lien",
      "url_media",
      "statut",
      "id_pub",
      "erreur"
     ]
    },
    {
     "id": "nouvelles",
     "type": "rows.filter",
     "label": "Garder les lignes pas encore traitées",
     "where": [
      {
       "column": "statut",
       "op": "empty"
      },
      {
       "column": "id",
       "op": "not_empty"
      }
     ]
    },
    {
     "id": "creation",
     "type": "meta.create_ads",
     "label": "Créer les publicités en pause",
     "campaignId": "120233510168830703",
     "adsetId": "120250524723890703",
     "pageId": "103591049029300",
     "keyColumn": "id",
     "mapping": {
      "adName": "{{row.nom_pub}}",
      "primaryText": "{{row.texte_principal}}",
      "headline": "{{row.titre}}",
      "description": "{{row.description}}",
      "linkUrl": "{{row.lien}}",
      "mediaType": "image",
      "mediaUrl": "{{row.url_media}}"
     },
     "writeBack": {
      "sheet": {
       "spreadsheetId": "1Hn4RkT9wZqLp2XcV7bM5sDfG8jYaE3uKoPi6NmBvCxQ",
       "tab": "Créas"
      },
      "statusColumn": "statut",
      "adIdColumn": "id_pub",
      "errorColumn": "erreur"
     }
    },
    {
     "id": "bilan",
     "type": "rows.select",
     "label": "Colonnes du bilan",
     "columns": [
      {
       "from": "id"
      },
      {
       "from": "nom_pub",
       "as": "publicité"
      },
      {
       "from": "meta_statut",
       "as": "statut"
      },
      {
       "from": "meta_ad_id",
       "as": "id_pub"
      },
      {
       "from": "meta_erreur",
       "as": "erreur"
      }
     ]
    },
    {
     "id": "slack",
     "type": "slack.message",
     "label": "Prévenir #c_recette",
     "channel": "#c_recette",
     "text": "Créas Meta du {{run.date}} : voici les publicités traitées dans l'ensemble « LAL BDD + Ex180JPurchases - Static ». Elles sont EN PAUSE : à relire et activer dans le Gestionnaire de publicités.",
     "includeTable": true
    }
   ]
  },
  "maxItemsPerRun": 20,
  "explanation": "Chaque jour ouvré à 8 h, la routine lit l'onglet Créas, garde les lignes dont le statut est vide et crée une publicité Meta en pause par ligne dans l'ensemble LAL BDD + Ex180JPurchases - Static. Elle note statut, id_pub et erreur dans le Sheet, puis poste le bilan dans #c_recette. Une ligne déjà traitée (même id) n'est jamais recréée.",
  "assumptions": [
   "Je n'ai pas pu lire le Sheet : les colonnes id, nom_pub, texte_principal, titre, description, lien, url_media, statut, id_pub et erreur sont reprises de votre message, et l'onglet s'appelle exactement « Créas ».",
   "Le Sheet sera partagé en éditeur avec data@impulse-analytics.com avant l'essai à blanc ; sans ce partage, la routine ne peut ni lire ni écrire le résultat.",
   "Chaque ligne a un id unique et jamais réutilisé ; je n'ai pas pu vérifier l'absence de doublons ni de cases vides.",
   "Les adresses de la colonne url_media sont des images en https publiques, pas des vidéos ni des liens Google Drive privés.",
   "L'identifiant de Page 103591049029300 vient de vous ; je n'ai pas pu vérifier qu'il s'agit de la bonne Page ni que le compte publicitaire peut publier en son nom.",
   "Aucun compte Instagram n'est indiqué : les publicités sont publiées au nom de la Page Facebook.",
   "Le canal #c_recette existe et le bot de l'agence y est invité."
  ]
 }
} as const;
