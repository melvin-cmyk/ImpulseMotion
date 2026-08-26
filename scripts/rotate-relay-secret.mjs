#!/usr/bin/env node
/**
 * Generates a fresh RELAY_SHARED_SECRET and writes it to .env.local and to
 * /etc/impulsemotion-relay.env (read by the relay systemd unit), so the Next.js
 * backend and the relay always share the same value.
 *
 * After running this, mirror the value to Vercel:
 *   npx vercel env add RELAY_SHARED_SECRET production
 * (paste the value printed by `--show`), then redeploy.
 *
 * Usage: node scripts/rotate-relay-secret.mjs [--show]
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const ENV_LOCAL = new URL("../.env.local", import.meta.url).pathname;
const RELAY_ENV = "/etc/impulsemotion-relay.env";

const secret = randomBytes(32).toString("hex");

// .env.local — replace or append
let env = readFileSync(ENV_LOCAL, "utf8");
if (/^RELAY_SHARED_SECRET=.*$/m.test(env)) {
  env = env.replace(/^RELAY_SHARED_SECRET=.*$/m, `RELAY_SHARED_SECRET=${secret}`);
} else {
  env += `\nRELAY_SHARED_SECRET=${secret}\n`;
}
writeFileSync(ENV_LOCAL, env);

// relay env file — systemd EnvironmentFile
let relayEnv = "";
try { relayEnv = readFileSync(RELAY_ENV, "utf8"); } catch { /* first run */ }
if (/^RELAY_SHARED_SECRET=.*$/m.test(relayEnv)) {
  relayEnv = relayEnv.replace(/^RELAY_SHARED_SECRET=.*$/m, `RELAY_SHARED_SECRET=${secret}`);
} else {
  relayEnv += `RELAY_SHARED_SECRET=${secret}\n`;
}
writeFileSync(RELAY_ENV, relayEnv, { mode: 0o600 });

console.log("RELAY_SHARED_SECRET rotated in .env.local and /etc/impulsemotion-relay.env");
if (process.argv.includes("--show")) console.log(secret);
