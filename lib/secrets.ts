/**
 * Symmetric encryption for per-client source secrets (HubSpot private-app tokens…).
 * AES-256-GCM, key = SOURCE_SECRETS_KEY (base64, 32 bytes). Format:
 *   v1:<iv b64>:<tag b64>:<cipher b64>
 * No plaintext fallback: without a key, encrypt/decrypt throw an explicit error.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_ENV = "SOURCE_SECRETS_KEY";
const VERSION = "v1";
const IV_BYTES = 12;

function loadKey(): Buffer {
  const raw = process.env[KEY_ENV]?.trim();
  if (!raw) throw new Error(`${KEY_ENV} manquante : définir une clé base64 de 32 octets (openssl rand -base64 32)`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${KEY_ENV} invalide : attendu 32 octets en base64, reçu ${key.length}`);
  return key;
}

/** True when a well-formed key is configured (no throw). */
export function hasSecretsKey(): boolean {
  try { loadKey(); return true; } catch { return false; }
}

export function encryptSecret(plain: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decryptSecret(enc: string): string {
  const key = loadKey();
  const parts = enc.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Secret chiffré illisible (format inattendu)");
  const [, ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error("Secret chiffré illisible (iv/tag invalides)");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Secret chiffré illisible (authentification échouée : clé différente ou données altérées)");
  }
}
