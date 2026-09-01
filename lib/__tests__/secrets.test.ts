import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, hasSecretsKey } from "@/lib/secrets";

const KEY = randomBytes(32).toString("base64");
let saved: string | undefined;

beforeEach(() => { saved = process.env.SOURCE_SECRETS_KEY; process.env.SOURCE_SECRETS_KEY = KEY; });
afterEach(() => { if (saved === undefined) delete process.env.SOURCE_SECRETS_KEY; else process.env.SOURCE_SECRETS_KEY = saved; });

describe("secrets (AES-256-GCM)", () => {
  it("round-trips and never stores the plaintext", () => {
    const plain = "pat-eu1-0123456789-abcdef";
    const enc = encryptSecret(plain);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc.split(":")).toHaveLength(4);
    expect(enc).not.toContain(plain);
    expect(decryptSecret(enc)).toBe(plain);
    // fresh iv each time → different ciphertext for the same input
    expect(encryptSecret(plain)).not.toBe(enc);
  });

  it("handles unicode and empty strings", () => {
    expect(decryptSecret(encryptSecret("clé à ç 🚀"))).toBe("clé à ç 🚀");
    expect(decryptSecret(encryptSecret(""))).toBe("");
  });

  it("throws an explicit error when the key is missing (no plaintext fallback)", () => {
    delete process.env.SOURCE_SECRETS_KEY;
    expect(hasSecretsKey()).toBe(false);
    expect(() => encryptSecret("x")).toThrow(/SOURCE_SECRETS_KEY manquante/);
    expect(() => decryptSecret("v1:a:b:c")).toThrow(/SOURCE_SECRETS_KEY manquante/);
  });

  it("rejects a key that is not 32 bytes", () => {
    process.env.SOURCE_SECRETS_KEY = Buffer.from("short").toString("base64");
    expect(hasSecretsKey()).toBe(false);
    expect(() => encryptSecret("x")).toThrow(/32 octets/);
  });

  it("fails on tampered ciphertext, tag, or a different key", () => {
    const enc = encryptSecret("secret");
    const [v, iv, tag, data] = enc.split(":");
    const flip = (b64: string) => { const b = Buffer.from(b64, "base64"); b[0] ^= 0xff; return b.toString("base64"); };
    expect(() => decryptSecret([v, iv, tag, flip(data)].join(":"))).toThrow(/illisible/);
    expect(() => decryptSecret([v, iv, flip(tag), data].join(":"))).toThrow(/illisible/);
    expect(() => decryptSecret("plain-text")).toThrow(/illisible/);
    process.env.SOURCE_SECRETS_KEY = randomBytes(32).toString("base64");
    expect(() => decryptSecret(enc)).toThrow(/illisible/);
    expect(hasSecretsKey()).toBe(true);
  });
});
