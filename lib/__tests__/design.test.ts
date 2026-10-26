/**
 * Design files (FigCraft): the pure helpers of lib/design and the share-link
 * logic of server/figcraft.mjs (no server, no CLI).
 */

import { describe, expect, it, beforeAll } from "vitest";
import { DESIGN_PRESETS, designSessionKey, editorUrlFor, presetByKey, DESIGN_FILES_UPLOAD_RE } from "@/lib/design/model";
import { parseDesignMessages, serializeDesignMessages } from "@/lib/design/thread";
import { buildDesignSystemPrompt, designUploadsNote } from "@/lib/design/prompt";

type FigcraftModule = typeof import("../../server/figcraft.mjs");
let fc: FigcraftModule;

beforeAll(async () => {
  process.env.FIGCRAFT_SERVER_URL = "ws://127.0.0.1:47900/?key=test-key-abcdef";
  process.env.FIGCRAFT_COLLAB_PUBLIC_URL = "wss://relay.example.test/figcraft-collab/";
  process.env.FIGCRAFT_CLI = "/nonexistent/figcraft-cli";
  fc = await import("../../server/figcraft.mjs");
});

describe("lib/design/model", () => {
  it("offers ad formats and an empty page", () => {
    expect(presetByKey("square")).toMatchObject({ width: 1080, height: 1080 });
    expect(presetByKey("free")).toMatchObject({ width: 0, height: 0 });
    expect(presetByKey("nope")).toBeNull();
    expect(DESIGN_PRESETS.length).toBeGreaterThan(3);
  });

  it("keeps one session per design and puts the link in the fragment", () => {
    expect(designSessionKey("abc")).toBe("design:abc");
    const link = "figcraft://join?server=wss%3A%2F%2Fx%2Fc%2F&file=0123456789abcdef&token=tokentoken";
    expect(editorUrlFor("https://host/figcraft/", link)).toBe(`https://host/figcraft/#join=${encodeURIComponent(link)}`);
    expect(editorUrlFor("", link)).toBeNull();
    expect(editorUrlFor(undefined, link)).toBeNull();
  });

  it("accepts the files the AI can place", () => {
    for (const ok of ["logo.png", "photo.JPG", "icon.svg", "maquette.figcraft", "export.fig", "doc.pdf"]) expect(DESIGN_FILES_UPLOAD_RE.test(ok)).toBe(true);
    for (const bad of ["script.js", "data.xlsx", "x.exe"]) expect(DESIGN_FILES_UPLOAD_RE.test(bad)).toBe(false);
  });
});

describe("lib/design/thread", () => {
  it("parses a stored thread and drops what is not a message", () => {
    const json = JSON.stringify([
      { role: "user", content: "Une bannière", at: "2026-10-26T10:00:00.000Z", author: "a@b.c", files: [{ name: "l.png", path: "uploads/l.png", bytes: 12 }] },
      { role: "assistant", content: "Fait ![x](sandbox:out/x.png)", at: "2026-10-26T10:01:00.000Z" },
      { role: "system", content: "nope" },
      "garbage",
      { role: "user" },
    ]);
    const msgs = parseDesignMessages(json);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: "user", author: "a@b.c" });
    expect(msgs[0].files?.[0].path).toBe("uploads/l.png");
    expect(parseDesignMessages("not json")).toEqual([]);
    expect(parseDesignMessages(null)).toEqual([]);
  });

  it("caps what is stored", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ role: "user" as const, content: `m${i}`, at: "2026-01-01T00:00:00.000Z" }));
    const back = parseDesignMessages(serializeDesignMessages(many));
    expect(back).toHaveLength(200);
    expect(back[0].content).toBe("m50");
  });
});

describe("lib/design/prompt", () => {
  it("names the file, the client and its brief, and the workflow", () => {
    const p = buildDesignSystemPrompt({ name: "Promo rentrée", clientName: "Naturalia", clientBrief: "## Ton\nChaleureux, bio.", author: "m@impulse.test" });
    expect(p).toContain("« Promo rentrée »");
    expect(p).toContain("CLIENT : Naturalia");
    expect(p).toContain("Chaleureux, bio.");
    expect(p).toContain("inspect_document");
    expect(p).toContain("sandbox:out/");
    expect(p).toContain("uploads/");
    const free = buildDesignSystemPrompt({ name: "X", clientName: null, clientBrief: null, author: null });
    expect(free).toContain("aucun client rattaché");
  });

  it("lists the uploads of the turn", () => {
    expect(designUploadsNote([])).toContain("Aucun fichier");
    expect(designUploadsNote([{ name: "logo.png", path: "uploads/logo.png", bytes: 2048 }])).toContain("uploads/logo.png (2 Ko)");
  });
});

describe("server/figcraft.mjs share links", () => {
  const file = "3d69f6d210af9afd";
  const token = "7Vms7mR7H8uUqnHJN9jolg";

  it("parses every link form FigCraft hands out", () => {
    expect(fc.parseShareLink(`figcraft://join?host=127.0.0.1:47900&file=${file}&token=${token}`)).toEqual({ file, token, server: "ws://127.0.0.1:47900/" });
    expect(fc.parseShareLink(`figcraft://join?server=wss%3A%2F%2Fh%2Fc%2F&file=${file}&token=${token}`)).toEqual({ file, token, server: "wss://h/c/" });
    expect(fc.parseShareLink(`wss://h/c/?file=${file}&token=${token}`)).toEqual({ file, token, server: "wss://h/c/" });
    expect(fc.parseShareLink(`ws://127.0.0.1:47900/?file=${file}&token=${token}`)).toMatchObject({ file, token });
  });

  it("refuses what is not a share link", () => {
    expect(fc.parseShareLink("https://evil.test/?file=abc&token=def")).toBeNull();
    expect(fc.parseShareLink(`figcraft://join?host=h&file=${file}`)).toBeNull();
    expect(fc.parseShareLink(`figcraft://join?host=h&file=../x&token=${token}`)).toBeNull();
    expect(fc.parseShareLink("")).toBeNull();
    expect(fc.parseShareLink(null)).toBeNull();
    expect(fc.parseShareLink("x".repeat(3000))).toBeNull();
  });

  it("joins on the loopback address and publishes the public one", () => {
    const pub = `figcraft://join?server=${encodeURIComponent("wss://relay.example.test/figcraft-collab/")}&file=${file}&token=${token}`;
    expect(fc.loopbackLink(pub)).toBe(`ws://127.0.0.1:47900/?file=${file}&token=${token}`);
    expect(fc.publicLink(`figcraft://join?host=127.0.0.1:47900&file=${file}&token=${token}`)).toBe(pub);
    expect(fc.loopbackLink("nope")).toBeNull();
    expect(fc.serverOrigin()).toBe("ws://127.0.0.1:47900/");
  });

  it("is not configured without the CLI", () => {
    expect(fc.figcraftConfigured()).toBe(false);
  });
});
