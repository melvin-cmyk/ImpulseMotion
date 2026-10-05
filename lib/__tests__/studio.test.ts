import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => { process.env.RELAY_SHARED_SECRET = "test-secret"; process.env.VERCEL_PROJECT_PRODUCTION_URL = "impulsemotion.vercel.app"; });

describe("Studio créa — liens signés", () => {
  it("un lien signé se vérifie ; signature, fichier ou date faux → refusé", async () => {
    const { mediaUrl, verifyMediaSignature, publicMediaUrl, videoCost, dataUriOk } = await import("@/lib/studio");
    const u = new URL(mediaUrl("http://localhost:3457", "up_abc123.png", 60));
    const exp = Number(u.searchParams.get("exp")), sig = u.searchParams.get("sig")!;
    expect(verifyMediaSignature("up_abc123.png", exp, sig)).toBe(true);
    expect(verifyMediaSignature("up_abc124.png", exp, sig)).toBe(false);
    expect(verifyMediaSignature("up_abc123.png", exp + 1, sig)).toBe(false);
    expect(verifyMediaSignature("up_abc123.png", 1000, sig)).toBe(false);
    expect(verifyMediaSignature("../etc/passwd", exp, sig)).toBe(false);
    expect(publicMediaUrl("up_abc123.png", 60)).toMatch(/^https:\/\/impulsemotion\.vercel\.app\/api\/studio\/media\/up_abc123\.png\?exp=\d+&sig=[a-f0-9]{64}$/);
    expect(videoCost("fast", 12)).toBe(0);
    expect(videoCost("hd", 5)).toBe(0.2);
    expect(dataUriOk("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(dataUriOk("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
  });
});
