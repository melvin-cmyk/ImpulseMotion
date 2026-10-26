# FigCraft sur l'hôte du relay (éditeur de design, `/design`)

FigCraft (https://github.com/storytold/figcraft, MIT/Apache-2.0) est l'éditeur de
maquettes « classe Figma » intégré à ImpulseMotion. Trois pièces tournent sur
l'hôte du relay, installées le 2026-10-26 (v0.11.2) :

| Pièce | Où | Rôle |
|---|---|---|
| `figcraft-server` | `/usr/local/bin`, service systemd `figcraft-server`, données `/var/lib/figcraft-server`, config `/etc/figcraft-server/server.toml` (copie : `server.toml` ici) | Serveur de collaboration : garde les fichiers, donne les liens d'édition/lecture, synchronise en direct. Écoute en loopback (:47900) ; Caddy l'expose en `wss://…/figcraft-collab/`. |
| version web | `/var/www/figcraft` (contenu de `figcraft-web-<version>.zip`, `.wasm`/`.js` pré-compressés en gzip) | L'éditeur dans le navigateur, servi par Caddy sous `/figcraft/`, affiché dans un iframe par `/design/[id]` avec `#join=<lien d'édition>`. |
| `figcraft-cli` | `/usr/local/bin` | FigCraft sans fenêtre : `server/figcraft.mjs` (création, export, aperçu, suppression) et `server/mcp-figcraft.mjs` (le serveur MCP de l'IA, qui rejoint le fichier du consultant). |

Variables du relay (`/etc/impulsemotion-relay.env`) : `FIGCRAFT_SERVER_URL`
(adresse loopback **avec la clé de publication**, imprimée par
`figcraft-server --config /etc/figcraft-server/server.toml key` ; jamais
transmise aux processus enfants), `FIGCRAFT_COLLAB_PUBLIC_URL`
(`wss://<hôte>/figcraft-collab/`, ce que les navigateurs ouvrent),
`FIGCRAFT_PUBLIC_URL` (l'éditeur). Côté app : `NEXT_PUBLIC_FIGCRAFT_URL`.

## Mise à jour de FigCraft

1. Release GitHub : télécharger `figcraft-<v>-linux-x86_64.tar.gz`,
   `figcraft-server-<v>-linux-x86_64.tar.gz`, `figcraft-web-<v>.zip` et
   `SHA256SUMS.txt` ; vérifier les sommes.
2. `install -m 755 bin/figcraft-cli /usr/local/bin/figcraft-cli`, idem
   `figcraft-server`, puis `systemctl restart figcraft-server` (les apps
   ouvertes se reconnectent) et `systemctl restart impulsemotion-relay`.
3. Version web : remplacer le contenu de `/var/www/figcraft`, puis
   `gzip -k -9 *.wasm *.js` (Caddy sert les `.gz`).
4. Vérifier : `curl https://<hôte>/figcraft-collab/healthz` → `ok`, puis
   `curl -H "Authorization: Bearer $RELAY_SHARED_SECRET" localhost:3457/api/figcraft/status`.

## Changement de domaine

Caddy (`/etc/caddy/Caddyfile`, bloc `/figcraft/`) : `frame-ancestors` doit
nommer l'origine de l'app. `server.toml` : `public_url` si l'hôte change (puis
`figcraft-server key` pour vérifier l'adresse imprimée).

## Sécurité

- Seul le relay publie et supprime (clé). Le navigateur et l'IA n'ont que le
  lien d'un fichier (jeton d'édition ou de lecture), stocké dans `DesignFile`.
- L'IA ne lit que `uploads/` et n'écrit que `out/` du workspace de la
  conversation (`--automation-read-root` / `--automation-write-root`), et ne
  peut ni changer de fichier, ni couper le partage (`server/mcp-figcraft.mjs`).
- Le service tourne sous l'utilisateur `figcraft`, durci par son unité systemd
  (unité fournie par la release, copiée telle quelle).
