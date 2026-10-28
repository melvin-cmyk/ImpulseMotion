#!/bin/bash
# Prints the two connection strings to put on Vercel (Settings → Environment Variables, all three
# environments, type Sensitive). Run it yourself: the session guard forbids the assistant to print them.
set -euo pipefail
. /root/.config/impulsemotion/pg-vps.env
echo "DATABASE_URL="
echo "postgresql://${PGVPS_USER}:${PGVPS_PASSWORD}@${PGVPS_HOST}:6432/impulsemotion?sslmode=require&sslaccept=accept_invalid_certs&pgbouncer=true&connect_timeout=15"
echo
echo "DIRECT_DATABASE_URL="
echo "postgresql://${PGVPS_USER}:${PGVPS_PASSWORD}@${PGVPS_HOST}:6432/impulsemotion_direct?sslmode=require&sslaccept=accept_invalid_certs&connect_timeout=15"
