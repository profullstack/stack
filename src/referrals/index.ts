/**
 * @profullstack/stack/referrals — referral program module.
 *
 * Consolidates the `lib/referrals.ts` (Supabase-backed ReferralStore) and
 * `app/api/referrals/route.ts` copies that drifted across the Profullstack
 * apps into one configurable module:
 *
 *   import { createReferralsClient, createReferralsRouteHandler } from "@profullstack/stack/referrals";
 *
 *   // lib/referrals.ts
 *   export const referralStore = createReferralsClient({ getClient: () => getServerSupabase() });
 *
 *   // app/api/referrals/route.ts
 *   export const { GET, POST } = createReferralsRouteHandler({ store: referralStore, getUserId });
 *
 * The full core SDK (`validateCode`, `applyReferral`, …) and the Next.js
 * helpers (`trackReferralCode`, `makeReferralHandlers`) from
 * `@profullstack/referrals` are re-exported so apps only need this subpath.
 */

import {
  DEFAULT_SPLIT,
  applyReferral,
  buildReferralUrl,
  createCode,
  validateCode,
} from "@profullstack/referrals";
import type {
  ReferralCode,
  ReferralSplit,
  ReferralStore,
  ReferralUsage,
} from "@profullstack/referrals";

/* -------------------------------------------------------------------------- */
/* Supabase structural types                                                   */
/* -------------------------------------------------------------------------- */

/** Error shape returned by supabase-js queries. */
export interface ReferralsSupabaseError {
  message: string;
}

/** Result shape returned by supabase-js queries. */
export interface ReferralsSupabaseResult<T> {
  data: T | null;
  error: ReferralsSupabaseError | null;
}

/**
 * Minimal subset of the supabase-js query builder the referral store relies
 * on. Any object exposing these methods (e.g. the builders returned by a real
 * `@supabase/supabase-js` client) satisfies this interface.
 */
export interface ReferralsSupabaseQuery {
  insert(values: Record<string, unknown>): PromiseLike<ReferralsSupabaseResult<unknown>>;
  select(columns?: string): ReferralsSupabaseQuery;
  eq(column: string, value: string): ReferralsSupabaseQuery;
  maybeSingle(): PromiseLike<ReferralsSupabaseResult<Record<string, unknown>>>;
  order(
    column: string,
    options: { ascending: boolean }
  ): PromiseLike<ReferralsSupabaseResult<Array<Record<string, unknown>>>>;
}

/**
 * Minimal structural subset of a `@supabase/supabase-js` client: anything with
 * a `.from(table)` method. Typed loosely at the boundary so real
 * `SupabaseClient` instances (whose builders are generic-heavy) assign
 * without casts; the store narrows the chain to {@link ReferralsSupabaseQuery}
 * internally.
 */
export interface ReferralsSupabaseClient {
  from(table: string): unknown;
}

/** Row shape of the `referral_codes` table. */
type ReferralCodeRow = {
  code: string;
  owner_id: string;
  created_at: string;
  expires_at: string | null;
};

/** Row shape of the `referral_usages` table. */
type ReferralUsageRow = {
  code: string;
  affiliate_id: string;
  new_user_id: string;
  amount_cents: number;
  commission_cents: number;
  discount_cents: number;
  applied_at: string;
};

/* -------------------------------------------------------------------------- */
/* createReferralsClient                                                       */
/* -------------------------------------------------------------------------- */

/** Configuration for {@link createReferralsClient}. */
export interface ReferralsClientConfig {
  /**
   * Factory returning a server-side (service-role / admin) Supabase client,
   * or `null` when Supabase is not configured. May be async. Called on every
   * operation so per-request clients work too.
   *
   * Behavior when it returns `null` (matches the vendored copies):
   * writes throw `Error("Supabase not configured")`, reads return `null`/`[]`.
   */
  getClient: () =>
    | ReferralsSupabaseClient
    | null
    | Promise<ReferralsSupabaseClient | null>;
  /** Table names. Defaults: `referral_codes` / `referral_usages`. */
  tables?: { codes?: string; usages?: string };
  /** Revenue split used by {@link ReferralsClient.apply}. Default: `DEFAULT_SPLIT`. */
  split?: ReferralSplit;
}

/**
 * Server-side referrals client. Implements {@link ReferralStore} (drop-in for
 * the vendored `referralStore` objects and for `makeReferralHandlers({ store })`)
 * and adds convenience methods bound to that store.
 */
export interface ReferralsClient extends ReferralStore {
  /** Validate that a code exists and hasn't expired. */
  validate(code: string): Promise<ReferralCode | null>;
  /** Create and persist a new referral code for an owner. */
  createCode(
    ownerId: string,
    opts?: { prefix?: string; length?: number; expiresAt?: Date | null }
  ): Promise<ReferralCode>;
  /** Apply a code to a purchase; persists the usage record. Throws on invalid/expired codes. */
  apply(opts: {
    code: string;
    newUserId: string;
    amountCents: number;
  }): Promise<ReferralUsage>;
  /** All usages for an affiliate, newest first. */
  getUsages(affiliateId: string): Promise<ReferralUsage[]>;
  /** Build the full referral URL for sharing. */
  buildUrl(baseUrl: string, code: string, param?: string): string;
}

/**
 * Create a Supabase-backed referrals client — the shared replacement for the
 * vendored `lib/referrals.ts` files. Persists referral codes and usages in the
 * `referral_codes` / `referral_usages` tables using the exact column mapping
 * the vendored copies used.
 */
export function createReferralsClient(config: ReferralsClientConfig): ReferralsClient {
  const { getClient, split = DEFAULT_SPLIT } = config;
  const codesTable = config.tables?.codes ?? "referral_codes";
  const usagesTable = config.tables?.usages ?? "referral_usages";

  const client: ReferralsClient = {
    async saveCode(code: ReferralCode): Promise<void> {
      const svc = await getClient();
      if (!svc) throw new Error("Supabase not configured");
      const { error } = await (svc.from(codesTable) as ReferralsSupabaseQuery).insert({
        code: code.code,
        owner_id: code.ownerId,
        created_at: code.createdAt.toISOString(),
        expires_at: code.expiresAt?.toISOString() ?? null,
      });
      if (error) throw new Error(error.message);
    },

    async getCode(code: string): Promise<ReferralCode | null> {
      const svc = await getClient();
      if (!svc) return null;
      const { data } = await (svc.from(codesTable) as ReferralsSupabaseQuery)
        .select("*")
        .eq("code", code)
        .maybeSingle();
      if (!data) return null;
      const row = data as unknown as ReferralCodeRow;
      return {
        code: row.code,
        ownerId: row.owner_id,
        createdAt: new Date(row.created_at),
        expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      };
    },

    async saveUsage(usage: ReferralUsage): Promise<void> {
      const svc = await getClient();
      if (!svc) throw new Error("Supabase not configured");
      const { error } = await (svc.from(usagesTable) as ReferralsSupabaseQuery).insert({
        code: usage.code,
        affiliate_id: usage.affiliateId,
        new_user_id: usage.newUserId,
        amount_cents: usage.amountCents,
        commission_cents: usage.commissionCents,
        discount_cents: usage.discountCents,
        applied_at: usage.appliedAt.toISOString(),
      });
      if (error) throw new Error(error.message);
    },

    async getUsagesByAffiliate(affiliateId: string): Promise<ReferralUsage[]> {
      const svc = await getClient();
      if (!svc) return [];
      const { data } = await (svc.from(usagesTable) as ReferralsSupabaseQuery)
        .select("*")
        .eq("affiliate_id", affiliateId)
        .order("applied_at", { ascending: false });
      return ((data ?? []) as unknown as ReferralUsageRow[]).map((row) => ({
        code: row.code,
        affiliateId: row.affiliate_id,
        newUserId: row.new_user_id,
        amountCents: row.amount_cents,
        commissionCents: row.commission_cents,
        discountCents: row.discount_cents,
        appliedAt: new Date(row.applied_at),
      }));
    },

    validate(code: string): Promise<ReferralCode | null> {
      return validateCode(code, client);
    },

    createCode(
      ownerId: string,
      opts: { prefix?: string; length?: number; expiresAt?: Date | null } = {}
    ): Promise<ReferralCode> {
      return createCode(ownerId, client, opts);
    },

    apply(opts: { code: string; newUserId: string; amountCents: number }): Promise<ReferralUsage> {
      return applyReferral({ ...opts, store: client, split });
    },

    getUsages(affiliateId: string): Promise<ReferralUsage[]> {
      return client.getUsagesByAffiliate(affiliateId);
    },

    buildUrl(baseUrl: string, code: string, param?: string): string {
      return buildReferralUrl(baseUrl, code, param);
    },
  };

  return client;
}

/* -------------------------------------------------------------------------- */
/* createReferralsRouteHandler                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Minimal structural subset of `Request`/`NextRequest` the route handlers
 * need. Both the web `Request` and Next's `NextRequest` satisfy this.
 */
export interface ReferralsRouteRequest {
  url: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

type NextResponseFactory = {
  json(data: unknown, init?: ResponseInit): Response;
};

// We load NextResponse lazily via dynamic import (NOT require) so the module
// works in ESM builds — bundlers like Next reject a require() shim with
// "dynamic usage of require is not supported" — and still doesn't pull in Next
// for non-Next consumers: it's only imported when a route handler actually runs.
let _nextResponse: NextResponseFactory | undefined;
async function nextResponse(): Promise<NextResponseFactory> {
  if (!_nextResponse) {
    // `next` is an optional peer dep and isn't installed in this package, so type
    // the specifier as `string` — that stops tsc/dts from resolving next/server's
    // types while the runtime import still works wherever Next is present.
    const specifier: string = "next/server";
    const mod = (await import(specifier)) as { NextResponse: NextResponseFactory };
    _nextResponse = mod.NextResponse;
  }
  return _nextResponse;
}

/** Configuration for {@link createReferralsRouteHandler}. */
export interface ReferralsRouteHandlerOptions {
  /**
   * Referral store — pass the client returned by {@link createReferralsClient}
   * (it implements `ReferralStore`), or any custom `ReferralStore`.
   */
  store: ReferralStore;
  /**
   * Resolve the authenticated user id for the request, or `null` when
   * unauthenticated. Required for the `myusages` and `apply` actions and for
   * authenticated `create`. May be sync or async.
   *
   * When omitted, the handler runs in unauthenticated mode (the legacy
   * saasrow/phonenumbers.bot variant): `myusages`/`apply` return
   * `400 Unknown action` and `create` takes `ownerId` from the request body.
   */
  getUserId?: (req: ReferralsRouteRequest) => Promise<string | null> | string | null;
  /** Revenue split for `apply`. Default: `DEFAULT_SPLIT`. */
  split?: ReferralSplit;
  /** Query param carrying the code for `validate`. Default: `"ref"`. */
  param?: string;
}

/**
 * Factory that returns Next.js App Router handler exports for a single
 * `/api/referrals` route, behavior-compatible with the vendored
 * `app/api/referrals/route.ts` copies. Mount as:
 *
 *   export const { GET, POST } = createReferralsRouteHandler({ store, getUserId });
 *
 * Routes (kept identical to the vendored handlers, including error wording):
 *   GET  ?action=validate&ref=CODE        → { valid, code }        (400 "Missing ref")
 *   GET  ?action=myusages                 → { usages }             (401 when unauthenticated)
 *   POST { action:"create" }              → { code }               (401 when unauthenticated;
 *                                                                   body "ownerId" in unauthenticated mode)
 *   POST { action:"apply", code, amount } → { usage }              (400 "Missing code or amount")
 *   anything else                         → 400 { error: "Unknown action" }
 */
export function createReferralsRouteHandler(options: ReferralsRouteHandlerOptions): {
  GET: (req: ReferralsRouteRequest) => Promise<Response>;
  POST: (req: ReferralsRouteRequest) => Promise<Response>;
} {
  const { store, getUserId, split = DEFAULT_SPLIT, param = "ref" } = options;

  async function GET(req: ReferralsRouteRequest): Promise<Response> {
    const NR = await nextResponse();
    const { searchParams } = new URL(req.url);
    const action = searchParams.get("action");

    if (action === "validate") {
      const code = searchParams.get(param);
      if (!code) return NR.json({ error: "Missing ref" }, { status: 400 });
      const record = await validateCode(code, store);
      return NR.json({ valid: !!record, code: record ?? null });
    }

    if (action === "myusages" && getUserId) {
      const userId = await getUserId(req);
      if (!userId) return NR.json({ error: "Unauthorized" }, { status: 401 });
      const usages = await store.getUsagesByAffiliate(userId);
      return NR.json({ usages });
    }

    return NR.json({ error: "Unknown action" }, { status: 400 });
  }

  async function POST(req: ReferralsRouteRequest): Promise<Response> {
    const NR = await nextResponse();
    const body = (await req.json()) as Record<string, unknown>;
    const action = body["action"];

    if (action === "create") {
      if (getUserId) {
        const userId = await getUserId(req);
        if (!userId) return NR.json({ error: "Unauthorized" }, { status: 401 });
        const code = await createCode(userId, store);
        return NR.json({ code });
      }
      const ownerId = typeof body["ownerId"] === "string" ? body["ownerId"] : null;
      if (!ownerId) return NR.json({ error: "Missing ownerId" }, { status: 400 });
      const code = await createCode(ownerId, store);
      return NR.json({ code });
    }

    if (action === "apply" && getUserId) {
      const userId = await getUserId(req);
      if (!userId) return NR.json({ error: "Unauthorized" }, { status: 401 });
      const code = typeof body["code"] === "string" ? body["code"] : null;
      const amount = typeof body["amount"] === "number" ? body["amount"] : null;
      if (!code || !amount) return NR.json({ error: "Missing code or amount" }, { status: 400 });
      const usage = await applyReferral({
        code,
        newUserId: userId,
        amountCents: amount,
        store,
        split,
      });
      return NR.json({ usage });
    }

    return NR.json({ error: "Unknown action" }, { status: 400 });
  }

  return { GET, POST };
}

/* -------------------------------------------------------------------------- */
/* Re-exports — apps should only need @profullstack/stack/referrals            */
/* -------------------------------------------------------------------------- */

export {
  DEFAULT_SPLIT,
  generateCode,
  calculateReferral,
  validateCode,
  applyReferral,
  createCode,
  buildReferralUrl,
  extractCode,
} from "@profullstack/referrals";
export type {
  ReferralSplit,
  ReferralCode,
  ReferralUsage,
  ReferralCalculation,
  ReferralStore,
} from "@profullstack/referrals";
export { makeReferralHandlers, trackReferralCode } from "@profullstack/referrals/next";
export type { ReferralHandlerOptions } from "@profullstack/referrals/next";
