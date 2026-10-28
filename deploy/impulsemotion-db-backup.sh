#!/bin/bash
# Nightly backup of the ImpulseMotion database (PostgreSQL on the VPS):
# compressed pg_dump in /root/backups (14 days kept) + a copy in the data@ Drive
# through the relay when DRIVE_BACKUP_FOLDER_ID is set in /root/.config/impulsemotion/pg-vps.env.
# Install: cp deploy/impulsemotion-db-backup.{service,timer} /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now impulsemotion-db-backup.timer
set -euo pipefail
. /root/.config/impulsemotion/pg-vps.env
DIR=/root/backups
STAMP=$(date +%F-%H%M)
FILE="$DIR/impulsemotion-$STAMP.dump"
mkdir -p "$DIR"
PGPASSWORD="$PGVPS_PASSWORD" pg_dump "host=127.0.0.1 port=5432 dbname=$PGVPS_DB user=$PGVPS_USER" -Fc --no-owner --no-privileges -f "$FILE"
SIZE=$(stat -c %s "$FILE")
echo "[db-backup] $FILE ($SIZE octets)"
# Keep 14 days locally.
find "$DIR" -name 'impulsemotion-*.dump' -mtime +14 -delete
# Copy to the Drive (best effort): the relay uploads with the data@ token.
if [ -n "${DRIVE_BACKUP_FOLDER_ID:-}" ]; then
  SECRET=$(grep -E '^RELAY_SHARED_SECRET=' /root/ImpulseMotion/.env.local | cut -d= -f2- | tr -d '"')
  python3 - "$FILE" "$DRIVE_BACKUP_FOLDER_ID" "$SECRET" <<'PY'
import base64, json, sys, urllib.request
path, folder, secret = sys.argv[1:4]
data = base64.b64encode(open(path, "rb").read()).decode()
body = json.dumps({"folderId": folder, "name": path.split("/")[-1], "mimeType": "application/octet-stream", "data": data}).encode()
req = urllib.request.Request("http://localhost:3457/api/drive/upload", data=body, headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=300) as r: print("[db-backup] Drive:", json.loads(r.read()).get("webViewLink"))
except Exception as e: print("[db-backup] Drive KO:", e)
PY
fi
