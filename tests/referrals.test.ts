import Module from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_SPLIT,
  buildReferralUrl,
  calculateReferral,
  createReferralsClient,
  createReferralsRouteHandler,
  extractCode,
  makeReferralHandlers,
  trackReferralCode,
} from "../src/referrals/index.js";
import type {
  ReferralsRouteRequest,
  ReferralsSupabaseClient,
} from "../src/referrals/index.js";
import type { ReferralCode, ReferralStore, ReferralUsage } from "../src/referrals/index.js";

/* -------------------------------------------------------------------------- */
/* Test doubles                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `makeReferralHandlers` (re-exported from the prebuilt `@profullstack/referrals`
 * dist) lazily calls `require("next/server")`. `next` is an optional peer and
 * is not installed here, so two interception layers are needed:
 *
 * 1. `globalThis.require` — used by the prebuilt `@profullstack/referrals`
 *    dist, whose tsup `__require` shim falls back to the global when no
 *    lexical `require` exists.
 * 2. `Module._load` — vitest injects a real createRequire-based `require`
 *    into transformed src files, which would do genuine Node resolution and
 *    fail. Patching Node's loader makes `next/server` resolve to the stub.
 *
 * `createReferralsRouteHandler` needs no stub: it returns plain Web
 * `Response` objects and never touches `next/server`.
 */
function installNextServerStubs(): void {
  const fakeNextServer = {
    NextResponse: {
      json(data: unknown, init?: ResponseInit): Response {
        return new Response(JSON.stringify(data), {
          status: init?.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  };

  (globalThis as Record<string, unknown>)["require"] = (id: string) => {
    if (id === "next/server") return fakeNextServer;
    throw new Error(`Unexpected require: ${id}`);
  };

  const mod = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = mod._load;
  mod._load = function (this: unknown, ...args: unknown[]): unknown {
    if (args[0] === "next/server") return fakeNextServer;
    return original.apply(this, args);
  };
}

type Row = Record<string, unknown>;

interface FakeSupabaseOptions {
  /** Row returned by `.select().eq().maybeSingle()` (referral code lookups). */
  codeRow?: Row | null;
  /** Rows returned by `.select().eq().order()` (usage listings). Pass null to simulate `data: null`. */
  usageRows?: Row[] | null;
  /** Error returned by `.insert()`. */
  insertError?: { message: string } | null;
}

function makeFakeSupabase(opts: FakeSupabaseOptions = {}) {
  const inserts: Array<{ table: string; values: Row }> = [];
  const queries: Array<{ table: string; column: string; value: string }> = [];
  const orders: Array<{ table: string; column: string; ascending: boolean }> = [];
  const client: ReferralsSupabaseClient = {
    from(table: string) {
      return {
        insert(values: Row) {
          inserts.push({ table, values });
          return Promise.resolve({ data: null, error: opts.insertError ?? null });
        },
        select(_columns?: string) {
          return {
            eq(column: string, value: string) {
              queries.push({ table, column, value });
              return {
                maybeSingle() {
                  return Promise.resolve({ data: opts.codeRow ?? null, error: null });
                },
                order(orderColumn: string, orderOpts: { ascending: boolean }) {
                  orders.push({ table, column: orderColumn, ascending: orderOpts.ascending });
                  const data = opts.usageRows === undefined ? [] : opts.usageRows;
                  return Promise.resolve({ data, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, inserts, queries, orders };
}

function makeMemoryStore() {
  const codes = new Map<string, ReferralCode>();
  const usages: ReferralUsage[] = [];
  const store: ReferralStore = {
    saveCode(code) {
      codes.set(code.code, code);
      return Promise.resolve();
    },
    getCode(code) {
      return Promise.resolve(codes.get(code) ?? null);
    },
    saveUsage(usage) {
      usages.push(usage);
      return Promise.resolve();
    },
    getUsagesByAffiliate(affiliateId) {
      return Promise.resolve(usages.filter((u) => u.affiliateId === affiliateId));
    },
  };
  return { store, codes, usages };
}

function makeReq(url: string, body?: unknown): ReferralsRouteRequest {
  return {
    url,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  };
}

beforeAll(() => {
  installNextServerStubs();
});

/* -------------------------------------------------------------------------- */
/* createReferralsClient                                                       */
/* -------------------------------------------------------------------------- */

describe("createReferralsClient", () => {
  it("saveCode inserts a snake_case row into referral_codes", async () => {
    const fake = makeFakeSupabase();
    const client = createReferralsClient({ getClient: () => fake.client });
    await client.saveCode({
      code: "ABC123",
      ownerId: "user-1",
      createdAt: new Date("2024-01-02T03:04:05.000Z"),
      expiresAt: new Date("2025-01-02T03:04:05.000Z"),
    });
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0]).toEqual({
      table: "referral_codes",
      values: {
        code: "ABC123",
        owner_id: "user-1",
        created_at: "2024-01-02T03:04:05.000Z",
        expires_at: "2025-01-02T03:04:05.000Z",
      },
    });
  });

  it("saveCode maps a null expiresAt to null", async () => {
    const fake = makeFakeSupabase();
    const client = createReferralsClient({ getClient: () => fake.client });
    await client.saveCode({
      code: "ABC123",
      ownerId: "user-1",
      createdAt: new Date("2024-01-02T03:04:05.000Z"),
      expiresAt: null,
    });
    expect(fake.inserts[0]?.values["expires_at"]).toBeNull();
  });

  it("saveCode throws when Supabase is not configured", async () => {
    const client = createReferralsClient({ getClient: () => null });
    await expect(
      client.saveCode({
        code: "ABC123",
        ownerId: "user-1",
        createdAt: new Date(),
        expiresAt: null,
      })
    ).rejects.toThrow("Supabase not configured");
  });

  it("saveCode propagates insert errors by message", async () => {
    const fake = makeFakeSupabase({ insertError: { message: "db down" } });
    const client = createReferralsClient({ getClient: () => fake.client });
    await expect(
      client.saveCode({
        code: "ABC123",
        ownerId: "user-1",
        createdAt: new Date(),
        expiresAt: null,
      })
    ).rejects.toThrow("db down");
  });

  it("getCode maps a row to a camelCase ReferralCode", async () => {
    const fake = makeFakeSupabase({
      codeRow: {
        code: "ABC123",
        owner_id: "user-1",
        created_at: "2024-01-02T03:04:05.000Z",
        expires_at: "2025-01-02T03:04:05.000Z",
      },
    });
    const client = createReferralsClient({ getClient: () => fake.client });
    const code = await client.getCode("ABC123");
    expect(fake.queries[0]).toEqual({
      table: "referral_codes",
      column: "code",
      value: "ABC123",
    });
    expect(code).toEqual({
      code: "ABC123",
      ownerId: "user-1",
      createdAt: new Date("2024-01-02T03:04:05.000Z"),
      expiresAt: new Date("2025-01-02T03:04:05.000Z"),
    });
  });

  it("getCode maps a null expires_at to null", async () => {
    const fake = makeFakeSupabase({
      codeRow: {
        code: "ABC123",
        owner_id: "user-1",
        created_at: "2024-01-02T03:04:05.000Z",
        expires_at: null,
      },
    });
    const client = createReferralsClient({ getClient: () => fake.client });
    expect((await client.getCode("ABC123"))?.expiresAt).toBeNull();
  });

  it("getCode returns null when the code does not exist", async () => {
    const fake = makeFakeSupabase({ codeRow: null });
    const client = createReferralsClient({ getClient: () => fake.client });
    expect(await client.getCode("NOPE")).toBeNull();
  });

  it("getCode returns null when Supabase is not configured", async () => {
    const client = createReferralsClient({ getClient: () => null });
    expect(await client.getCode("ABC123")).toBeNull();
  });

  it("saveUsage inserts a snake_case row into referral_usages", async () => {
    const fake = makeFakeSupabase();
    const client = createReferralsClient({ getClient: () => fake.client });
    await client.saveUsage({
      code: "ABC123",
      affiliateId: "user-1",
      newUserId: "user-2",
      amountCents: 10000,
      commissionCents: 6000,
      discountCents: 2000,
      appliedAt: new Date("2024-06-01T00:00:00.000Z"),
    });
    expect(fake.inserts[0]).toEqual({
      table: "referral_usages",
      values: {
        code: "ABC123",
        affiliate_id: "user-1",
        new_user_id: "user-2",
        amount_cents: 10000,
        commission_cents: 6000,
        discount_cents: 2000,
        applied_at: "2024-06-01T00:00:00.000Z",
      },
    });
  });

  it("saveUsage throws when Supabase is not configured", async () => {
    const client = createReferralsClient({ getClient: () => null });
    await expect(
      client.saveUsage({
        code: "ABC123",
        affiliateId: "user-1",
        newUserId: "user-2",
        amountCents: 10000,
        commissionCents: 6000,
        discountCents: 2000,
        appliedAt: new Date(),
      })
    ).rejects.toThrow("Supabase not configured");
  });

  it("getUsagesByAffiliate maps rows newest-first", async () => {
    const fake = makeFakeSupabase({
      usageRows: [
        {
          code: "ABC123",
          affiliate_id: "user-1",
          new_user_id: "user-2",
          amount_cents: 10000,
          commission_cents: 6000,
          discount_cents: 2000,
          applied_at: "2024-06-01T00:00:00.000Z",
        },
      ],
    });
    const client = createReferralsClient({ getClient: () => fake.client });
    const usages = await client.getUsagesByAffiliate("user-1");
    expect(fake.orders[0]).toEqual({
      table: "referral_usages",
      column: "applied_at",
      ascending: false,
    });
    expect(usages).toEqual([
      {
        code: "ABC123",
        affiliateId: "user-1",
        newUserId: "user-2",
        amountCents: 10000,
        commissionCents: 6000,
        discountCents: 2000,
        appliedAt: new Date("2024-06-01T00:00:00.000Z"),
      },
    ]);
  });

  it("getUsagesByAffiliate returns [] for null data and when unconfigured", async () => {
    const nullData = createReferralsClient({
      getClient: () => makeFakeSupabase({ usageRows: null }).client,
    });
    expect(await nullData.getUsagesByAffiliate("user-1")).toEqual([]);
    const unconfigured = createReferralsClient({ getClient: () => null });
    expect(await unconfigured.getUsagesByAffiliate("user-1")).toEqual([]);
  });

  it("honors custom table names", async () => {
    const fake = makeFakeSupabase();
    const client = createReferralsClient({
      getClient: () => fake.client,
      tables: { codes: "my_codes", usages: "my_usages" },
    });
    await client.saveCode({
      code: "ABC123",
      ownerId: "user-1",
      createdAt: new Date(),
      expiresAt: null,
    });
    await client.saveUsage({
      code: "ABC123",
      affiliateId: "user-1",
      newUserId: "user-2",
      amountCents: 100,
      commissionCents: 60,
      discountCents: 20,
      appliedAt: new Date(),
    });
    expect(fake.inserts.map((i) => i.table)).toEqual(["my_codes", "my_usages"]);
  });

  it("supports an async getClient factory", async () => {
    const fake = makeFakeSupabase();
    const client = createReferralsClient({ getClient: () => Promise.resolve(fake.client) });
    await client.saveCode({
      code: "ABC123",
      ownerId: "user-1",
      createdAt: new Date(),
      expiresAt: null,
    });
    expect(fake.inserts).toHaveLength(1);
  });

  it("validate returns the record for a valid code and null for expired/unknown codes", async () => {
    const validRow = {
      code: "ABC123",
      owner_id: "user-1",
      created_at: "2024-01-02T03:04:05.000Z",
      expires_at: null,
    };
    const valid = createReferralsClient({
      getClient: () => makeFakeSupabase({ codeRow: validRow }).client,
    });
    expect((await valid.validate("abc123"))?.code).toBe("ABC123");

    const expired = createReferralsClient({
      getClient: () =>
        makeFakeSupabase({
          codeRow: { ...validRow, expires_at: "2000-01-01T00:00:00.000Z" },
        }).client,
    });
    expect(await expired.validate("ABC123")).toBeNull();

    const unknown = createReferralsClient({
      getClient: () => makeFakeSupabase({ codeRow: null }).client,
    });
    expect(await unknown.validate("ABC123")).toBeNull();
  });

  it("createCode generates and persists a code for the owner", async () => {
    const fake = makeFakeSupabase();
    const client = createReferralsClient({ getClient: () => fake.client });
    const code = await client.createCode("user-1", { prefix: "vip" });
    expect(code.code).toMatch(/^VIP-[A-Z2-9]{8}$/);
    expect(code.ownerId).toBe("user-1");
    expect(fake.inserts[0]?.table).toBe("referral_codes");
    expect(fake.inserts[0]?.values["owner_id"]).toBe("user-1");
  });

  it("apply validates the code and persists a usage with the configured split", async () => {
    const fake = makeFakeSupabase({
      codeRow: {
        code: "ABC123",
        owner_id: "user-1",
        created_at: "2024-01-02T03:04:05.000Z",
        expires_at: null,
      },
    });
    const client = createReferralsClient({ getClient: () => fake.client });
    const usage = await client.apply({ code: "ABC123", newUserId: "user-2", amountCents: 10000 });
    expect(usage.affiliateId).toBe("user-1");
    expect(usage.commissionCents).toBe(6000);
    expect(usage.discountCents).toBe(2000);
    expect(fake.inserts[0]?.table).toBe("referral_usages");
    expect(fake.inserts[0]?.values["affiliate_id"]).toBe("user-1");
  });

  it("apply honors a custom split and rejects invalid codes", async () => {
    const fake = makeFakeSupabase({
      codeRow: {
        code: "ABC123",
        owner_id: "user-1",
        created_at: "2024-01-02T03:04:05.000Z",
        expires_at: null,
      },
    });
    const client = createReferralsClient({
      getClient: () => fake.client,
      split: { affiliate: 0.5, customer: 0.1, total: 0.6 },
    });
    const usage = await client.apply({ code: "ABC123", newUserId: "user-2", amountCents: 10000 });
    expect(usage.commissionCents).toBe(5000);
    expect(usage.discountCents).toBe(1000);

    const invalid = createReferralsClient({
      getClient: () => makeFakeSupabase({ codeRow: null }).client,
    });
    await expect(
      invalid.apply({ code: "NOPE", newUserId: "user-2", amountCents: 10000 })
    ).rejects.toThrow("Invalid or expired referral code");
  });

  it("getUsages delegates to getUsagesByAffiliate", async () => {
    const fake = makeFakeSupabase({ usageRows: [] });
    const client = createReferralsClient({ getClient: () => fake.client });
    expect(await client.getUsages("user-1")).toEqual([]);
    expect(fake.queries[0]).toEqual({
      table: "referral_usages",
      column: "affiliate_id",
      value: "user-1",
    });
  });

  it("buildUrl builds a referral URL with the ref param", () => {
    const client = createReferralsClient({ getClient: () => null });
    expect(client.buildUrl("https://app.test", "ABC123")).toBe("https://app.test/?ref=ABC123");
  });
});

/* -------------------------------------------------------------------------- */
/* createReferralsRouteHandler — authenticated mode (vendored pattern A)       */
/* -------------------------------------------------------------------------- */

describe("createReferralsRouteHandler (authenticated)", () => {
  it("GET validate returns 400 Missing ref without a code", async () => {
    const { store } = makeMemoryStore();
    const { GET } = createReferralsRouteHandler({ store, getUserId: () => null });
    const res = await GET(makeReq("https://app.test/api/referrals?action=validate"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing ref" });
  });

  it("GET validate returns valid:false for unknown codes", async () => {
    const { store } = makeMemoryStore();
    const { GET } = createReferralsRouteHandler({ store, getUserId: () => null });
    const res = await GET(makeReq("https://app.test/api/referrals?action=validate&ref=NOPE"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: false, code: null });
  });

  it("GET validate matches codes case-insensitively", async () => {
    const { store } = makeMemoryStore();
    await store.saveCode({
      code: "ABC123",
      ownerId: "user-1",
      createdAt: new Date("2024-01-02T03:04:05.000Z"),
      expiresAt: null,
    });
    const { GET } = createReferralsRouteHandler({ store, getUserId: () => null });
    const res = await GET(makeReq("https://app.test/api/referrals?action=validate&ref=abc123"));
    const data = (await res.json()) as { valid: boolean; code: { code: string; ownerId: string } };
    expect(data.valid).toBe(true);
    expect(data.code.code).toBe("ABC123");
    expect(data.code.ownerId).toBe("user-1");
  });

  it("GET myusages returns 401 when unauthenticated and usages for the user", async () => {
    const { store } = makeMemoryStore();
    const anon = createReferralsRouteHandler({ store, getUserId: () => null });
    const unauth = await anon.GET(makeReq("https://app.test/api/referrals?action=myusages"));
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ error: "Unauthorized" });

    await store.saveUsage({
      code: "ABC123",
      affiliateId: "user-1",
      newUserId: "user-2",
      amountCents: 10000,
      commissionCents: 6000,
      discountCents: 2000,
      appliedAt: new Date("2024-06-01T00:00:00.000Z"),
    });
    const authed = createReferralsRouteHandler({ store, getUserId: () => "user-1" });
    const res = await authed.GET(makeReq("https://app.test/api/referrals?action=myusages"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { usages: Array<{ affiliateId: string }> };
    expect(data.usages).toHaveLength(1);
    expect(data.usages[0]?.affiliateId).toBe("user-1");
  });

  it("GET with an unknown action returns 400", async () => {
    const { store } = makeMemoryStore();
    const { GET } = createReferralsRouteHandler({ store, getUserId: () => "user-1" });
    const res = await GET(makeReq("https://app.test/api/referrals?action=nope"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown action" });
  });

  it("POST create returns 401 when unauthenticated", async () => {
    const { store } = makeMemoryStore();
    const { POST } = createReferralsRouteHandler({ store, getUserId: () => null });
    const res = await POST(makeReq("https://app.test/api/referrals", { action: "create" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("POST create persists a code owned by the authenticated user", async () => {
    const { store, codes } = makeMemoryStore();
    const { POST } = createReferralsRouteHandler({ store, getUserId: () => "user-1" });
    const res = await POST(makeReq("https://app.test/api/referrals", { action: "create" }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { code: { code: string; ownerId: string } };
    expect(data.code.ownerId).toBe("user-1");
    expect(codes.has(data.code.code)).toBe(true);
  });

  it("POST apply returns 401/400 on auth and payload failures", async () => {
    const { store } = makeMemoryStore();
    const anon = createReferralsRouteHandler({ store, getUserId: () => null });
    const unauth = await anon.POST(
      makeReq("https://app.test/api/referrals", { action: "apply", code: "ABC123", amount: 10000 })
    );
    expect(unauth.status).toBe(401);

    const authed = createReferralsRouteHandler({ store, getUserId: () => "user-2" });
    const missing = await authed.POST(makeReq("https://app.test/api/referrals", { action: "apply" }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "Missing code or amount" });
  });

  it("POST apply records the usage with the default 60/20 split", async () => {
    const { store, usages } = makeMemoryStore();
    await store.saveCode({
      code: "ABC123",
      ownerId: "user-1",
      createdAt: new Date(),
      expiresAt: null,
    });
    const { POST } = createReferralsRouteHandler({ store, getUserId: () => "user-2" });
    const res = await POST(
      makeReq("https://app.test/api/referrals", { action: "apply", code: "ABC123", amount: 10000 })
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      usage: { affiliateId: string; newUserId: string; commissionCents: number; discountCents: number };
    };
    expect(data.usage.affiliateId).toBe("user-1");
    expect(data.usage.newUserId).toBe("user-2");
    expect(data.usage.commissionCents).toBe(6000);
    expect(data.usage.discountCents).toBe(2000);
    expect(usages).toHaveLength(1);
  });

  it("POST apply throws on invalid codes (vendored behavior: unhandled 500)", async () => {
    const { store } = makeMemoryStore();
    const { POST } = createReferralsRouteHandler({ store, getUserId: () => "user-2" });
    await expect(
      POST(makeReq("https://app.test/api/referrals", { action: "apply", code: "NOPE", amount: 10000 }))
    ).rejects.toThrow("Invalid or expired referral code");
  });

  it("POST with an unknown action returns 400", async () => {
    const { store } = makeMemoryStore();
    const { POST } = createReferralsRouteHandler({ store, getUserId: () => "user-1" });
    const res = await POST(makeReq("https://app.test/api/referrals", { action: "nope" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown action" });
  });

  it("supports an async getUserId", async () => {
    const { store } = makeMemoryStore();
    const { POST } = createReferralsRouteHandler({
      store,
      getUserId: () => Promise.resolve("user-1"),
    });
    const res = await POST(makeReq("https://app.test/api/referrals", { action: "create" }));
    expect(res.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* createReferralsRouteHandler — legacy unauthenticated mode (pattern B)       */
/* -------------------------------------------------------------------------- */

describe("createReferralsRouteHandler (legacy unauthenticated mode)", () => {
  it("POST create takes ownerId from the body", async () => {
    const { store, codes } = makeMemoryStore();
    const { POST } = createReferralsRouteHandler({ store });
    const missing = await POST(makeReq("https://app.test/api/referrals", { action: "create" }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "Missing ownerId" });

    const res = await POST(
      makeReq("https://app.test/api/referrals", { action: "create", ownerId: "user-9" })
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { code: { code: string; ownerId: string } };
    expect(data.code.ownerId).toBe("user-9");
    expect(codes.has(data.code.code)).toBe(true);
  });

  it("myusages and apply are Unknown action without getUserId", async () => {
    const { store } = makeMemoryStore();
    const handlers = createReferralsRouteHandler({ store });
    const myusages = await handlers.GET(makeReq("https://app.test/api/referrals?action=myusages"));
    expect(myusages.status).toBe(400);
    expect(await myusages.json()).toEqual({ error: "Unknown action" });

    const apply = await handlers.POST(
      makeReq("https://app.test/api/referrals", { action: "apply", code: "ABC123", amount: 10000 })
    );
    expect(apply.status).toBe(400);
    expect(await apply.json()).toEqual({ error: "Unknown action" });
  });

  it("GET validate still works without auth", async () => {
    const { store } = makeMemoryStore();
    const { GET } = createReferralsRouteHandler({ store });
    const res = await GET(makeReq("https://app.test/api/referrals?action=validate&ref=NOPE"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: false, code: null });
  });
});

/* -------------------------------------------------------------------------- */
/* Re-exports                                                                  */
/* -------------------------------------------------------------------------- */

describe("re-exports", () => {
  it("re-exports the core SDK from @profullstack/referrals", () => {
    expect(DEFAULT_SPLIT).toEqual({ affiliate: 0.6, customer: 0.2, total: 0.8 });
    const calc = calculateReferral(10000);
    expect(calc.discountCents).toBe(2000);
    expect(calc.commissionCents).toBe(6000);
    expect(calc.finalAmountCents).toBe(8000);
    expect(extractCode("https://app.test/pricing?ref=ABC123")).toBe("ABC123");
    expect(buildReferralUrl("https://app.test", "ABC123")).toBe("https://app.test/?ref=ABC123");
  });

  it("trackReferralCode sets a cookie when the URL carries a ref param", () => {
    const sets: Array<{ name: string; value: string; opts?: object }> = [];
    const request = {
      nextUrl: new URL("https://app.test/pricing?ref=ABC123"),
      cookies: { get: () => undefined },
    };
    const response = {
      cookies: {
        set: (name: string, value: string, opts?: object) => {
          sets.push({ name, value, opts });
        },
      },
    };
    const out = trackReferralCode(
      request,
      response as unknown as Parameters<typeof trackReferralCode>[1]
    );
    expect(out).toBe(response);
    expect(sets).toEqual([
      {
        name: "referral_code",
        value: "ABC123",
        opts: { httpOnly: false, sameSite: "lax", maxAge: 60 * 60 * 24 * 30, path: "/" },
      },
    ]);
  });

  it("trackReferralCode is a no-op without a ref param and honors overrides", () => {
    const sets: Array<{ name: string; value: string; opts?: object }> = [];
    const response = {
      cookies: {
        set: (name: string, value: string, opts?: object) => {
          sets.push({ name, value, opts });
        },
      },
    } as unknown as Parameters<typeof trackReferralCode>[1];

    trackReferralCode(
      { nextUrl: new URL("https://app.test/pricing"), cookies: { get: () => undefined } },
      response
    );
    expect(sets).toEqual([]);

    trackReferralCode(
      { nextUrl: new URL("https://app.test/?via=XYZ"), cookies: { get: () => undefined } },
      response,
      { param: "via", cookieName: "ref", maxAgeSeconds: 60 }
    );
    expect(sets[0]).toEqual({
      name: "ref",
      value: "XYZ",
      opts: { httpOnly: false, sameSite: "lax", maxAge: 60, path: "/" },
    });
  });

  it("makeReferralHandlers serves GET validate against the given store", async () => {
    const { store } = makeMemoryStore();
    const handlers = makeReferralHandlers({ store });
    const req = {
      nextUrl: {
        searchParams: new URL("https://app.test/api/referrals?action=validate&ref=NOPE")
          .searchParams,
      },
      json: () => Promise.resolve({}),
    };
    const res = await handlers.GET(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { valid: boolean };
    expect(data.valid).toBe(false);
  });
});
