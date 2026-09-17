/**
 * ACL regression tests for the alert-rule routes.
 *
 * A consultant must only ever see and touch the rules of the ad accounts an
 * admin assigned them in UserAdAccount — before this was enforced, any staff
 * session listed, edited and deleted the rules of the whole business manager.
 *
 * Only the session and the database are mocked: the real lib/scope.ts runs, so
 * these tests cover the routes AND the scope logic together.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const session = { userId: "u-consultant", role: "consultant" as string | null };

vi.mock("@/lib/auth-helpers", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireStaff: async () => {
      if (session.role !== "admin" && session.role !== "consultant") {
        return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
      }
      return { session };
    },
  };
});

// u-consultant is assigned Meta act_111 and Google 999 — nothing else.
const assignments = [
  { userId: "u-consultant", platform: "meta", accountId: "act_111" },
  { userId: "u-consultant", platform: "google", accountId: "999" },
];

const RULES = [
  { id: "r-mine", clientId: "111", userId: "u-consultant", metric: "roas" },
  { id: "r-google", clientId: "999", userId: "u-consultant", metric: "cpa" },
  { id: "r-theirs", clientId: "222", userId: "u-other", metric: "roas" },
  { id: "r-global", clientId: null, userId: "u-admin", metric: "spend" },
];

const created: unknown[] = [];
const deleted: string[] = [];
const updated: unknown[] = [];

const prismaMock = {
  userAdAccount: {
    findMany: async ({ where }: { where: { userId: string } }) =>
      assignments.filter((a) => a.userId === where.userId),
  },
  alertRule: {
    findMany: async () => RULES,
    findUnique: async ({ where }: { where: { id: string } }) =>
      RULES.find((r) => r.id === where.id) ?? null,
    create: async ({ data }: { data: unknown }) => {
      created.push(data);
      return { id: "r-new", ...(data as object) };
    },
    update: async ({ where, data }: { where: { id: string }; data: unknown }) => {
      updated.push({ id: where.id, ...(data as object) });
      return { id: where.id, ...(data as object) };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      deleted.push(where.id);
      return { id: where.id };
    },
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// Next types a route export as possibly returning nothing; the handlers always
// answer, so pin the signatures here rather than null-check every assertion.
type Ctx = { params: Promise<{ id: string }> };
const { GET, POST } = (await import("@/app/api/admin/alerts/route")) as unknown as {
  GET: () => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
};
const { PATCH, DELETE } = (await import("@/app/api/admin/alerts/[id]/route")) as unknown as {
  PATCH: (req: Request, ctx: Ctx) => Promise<Response>;
  DELETE: (req: Request, ctx: Ctx) => Promise<Response>;
};

const postBody = (body: unknown) =>
  new Request("http://localhost/api/admin/alerts", {
    method: "POST",
    body: JSON.stringify(body),
  });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const validRule = {
  userId: "u-consultant",
  metric: "roas",
  condition: "below",
  threshold: 2,
};

beforeEach(() => {
  session.userId = "u-consultant";
  session.role = "consultant";
  created.length = 0;
  deleted.length = 0;
  updated.length = 0;
});

describe("GET /api/admin/alerts", () => {
  it("a consultant only sees the rules of their assigned accounts", async () => {
    const body = await (await GET()).json();
    expect(body.rules.map((r: { id: string }) => r.id)).toEqual(["r-mine", "r-google"]);
  });

  it("an account-agnostic rule (clientId null) stays admin-only", async () => {
    const asConsultant = await (await GET()).json();
    expect(asConsultant.rules.some((r: { id: string }) => r.id === "r-global")).toBe(false);

    session.role = "admin";
    const asAdmin = await (await GET()).json();
    expect(asAdmin.rules).toHaveLength(RULES.length);
  });
});

describe("POST /api/admin/alerts", () => {
  it("refuses an account the consultant was not assigned", async () => {
    const res = await POST(postBody({ ...validRule, clientId: "222" }));
    expect(res.status).toBe(403);
    expect(created).toHaveLength(0);
  });

  it("refuses a rule with no account (that would span the whole BM)", async () => {
    const res = await POST(postBody({ ...validRule, clientId: null }));
    expect(res.status).toBe(403);
    expect(created).toHaveLength(0);
  });

  it("refuses arming an alert on behalf of another user", async () => {
    const res = await POST(postBody({ ...validRule, userId: "u-other", clientId: "111" }));
    expect(res.status).toBe(403);
    expect(created).toHaveLength(0);
  });

  it("accepts an assigned account, both Meta id spellings", async () => {
    expect((await POST(postBody({ ...validRule, clientId: "111" }))).status).toBe(200);
    expect((await POST(postBody({ ...validRule, clientId: "act_111" }))).status).toBe(200);
    expect(created).toHaveLength(2);
  });

  it("an admin keeps full freedom (any user, any account)", async () => {
    session.role = "admin";
    const res = await POST(postBody({ ...validRule, userId: "u-other", clientId: "222" }));
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
  });

  it("still validates the payload before the ACL", async () => {
    const res = await POST(postBody({ userId: "u-consultant", clientId: "111" }));
    expect(res.status).toBe(400);
  });
});

describe("PATCH & DELETE /api/admin/alerts/[id]", () => {
  it("refuses to edit or delete a rule outside the scope", async () => {
    expect((await PATCH(postBody({ enabled: false }), params("r-theirs"))).status).toBe(403);
    expect((await DELETE(postBody({}), params("r-theirs"))).status).toBe(403);
    expect(updated).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });

  it("allows an assigned rule through", async () => {
    expect((await PATCH(postBody({ enabled: false, threshold: 3 }), params("r-mine"))).status).toBe(200);
    expect((await DELETE(postBody({}), params("r-google"))).status).toBe(200);
    expect(deleted).toEqual(["r-google"]);
  });

  it("answers 404 on an unknown rule, without leaking its existence", async () => {
    expect((await PATCH(postBody({ enabled: false }), params("nope"))).status).toBe(404);
    expect((await DELETE(postBody({}), params("nope"))).status).toBe(404);
  });

  it("an admin may edit an account-agnostic rule", async () => {
    session.role = "admin";
    expect((await PATCH(postBody({ enabled: false }), params("r-global"))).status).toBe(200);
  });
});
