# @profullstack/stack/referrals

Referral program module: a Supabase-backed server client plus a Next.js App
Router route-handler factory. It consolidates the `lib/referrals.ts`
(Supabase `ReferralStore`) and `app/api/referrals/route.ts` files that were
copy-pasted — and drifted — across ~10 Profullstack apps, and re-exports the
full `@profullstack/referrals` SDK so apps only need one import.

## Install / import

```bash
npm install @profullstack/stack
```

```ts
import {
  createReferralsClient,
  createReferralsRouteHandler,
  trackReferralCode,
} from "@profullstack/stack/referrals";
```

`next` is an optional peer dependency — `createReferralsRouteHandler` returns
plain Web `Response` objects (zero Next imports, bundler-proof), and only the
re-exported `makeReferralHandlers` helper (from `@profullstack/referrals/next`)
touches `next/server` (via a lazy `require`), so
`createReferralsClient` works in any Node context. The client talks to
Supabase through a structural interface; your existing
`@supabase/supabase-js` / `@supabase/ssr` client satisfies it without casts.

## Quick start

```ts
// lib/referrals.ts
import { createReferralsClient } from "@profullstack/stack/referrals";
import { getServerSupabase } from "@/lib/supabase/server";

export const referralStore = createReferralsClient({
  getClient: () => getServerSupabase(),
});
```

```ts
// app/api/referrals/route.ts
import { createReferralsRouteHandler } from "@profullstack/stack/referrals";
import { referralStore } from "@/lib/referrals";
import { getSessionSupabase } from "@/lib/supabase/server-cookies";

export const dynamic = "force-dynamic";

async function getUserId() {
  const supabase = await getSessionSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export const { GET, POST } = createReferralsRouteHandler({ store: referralStore, getUserId });
```

```ts
// middleware.ts
import { NextResponse, type NextRequest } from "next/server";
import { trackReferralCode } from "@profullstack/stack/referrals";

export function middleware(request: NextRequest) {
  return trackReferralCode(request, NextResponse.next() as never);
}
```

## API reference

### `createReferralsClient(config): ReferralsClient`

Creates the Supabase-backed referrals client — the shared replacement for the
vendored `lib/referrals.ts` files. It implements `ReferralStore` (so it is a
drop-in for the old `referralStore` objects and for
`makeReferralHandlers({ store })`) and adds convenience methods bound to that
store.

`ReferralsClientConfig`:

| option | type | default | description |
| --- | --- | --- | --- |
| `getClient` | `() => ReferralsSupabaseClient \| null \| Promise<... \| null>` | — | Factory returning a server-side (service-role/admin) Supabase client, or `null` when unconfigured. Called per operation; may be async. |
| `tables` | `{ codes?: string; usages?: string }` | `referral_codes` / `referral_usages` | Table name overrides. |
| `split` | `ReferralSplit` | `DEFAULT_SPLIT` (60/20/80) | Split used by `client.apply`. |

Null-client behavior (matches the vendored copies): writes throw
`Error("Supabase not configured")`; `getCode` returns `null`;
`getUsagesByAffiliate` returns `[]`. Supabase errors are rethrown as
`Error(error.message)`.

`ReferralsClient` (extends `ReferralStore`):

| method | signature | description |
| --- | --- | --- |
| `saveCode` | `(code: ReferralCode) => Promise<void>` | Insert into `referral_codes` (snake_case mapping). |
| `getCode` | `(code: string) => Promise<ReferralCode \| null>` | Look up a code by exact (already normalized) code. |
| `saveUsage` | `(usage: ReferralUsage) => Promise<void>` | Insert into `referral_usages`. |
| `getUsagesByAffiliate` | `(affiliateId: string) => Promise<ReferralUsage[]>` | Usages for an affiliate, `applied_at` descending. |
| `validate` | `(code: string) => Promise<ReferralCode \| null>` | Case-insensitive; `null` when unknown or expired. |
| `createCode` | `(ownerId: string, opts?: { prefix?; length?; expiresAt? }) => Promise<ReferralCode>` | Generate + persist a code. |
| `apply` | `(opts: { code; newUserId; amountCents }) => Promise<ReferralUsage>` | Validate, split, persist usage. Throws on invalid/expired code. |
| `getUsages` | `(affiliateId: string) => Promise<ReferralUsage[]>` | Alias of `getUsagesByAffiliate`. |
| `buildUrl` | `(baseUrl: string, code: string, param?: string) => string` | Share URL with `?ref=CODE`. |

### `createReferralsRouteHandler(options): { GET, POST }`

Next.js App Router handler factory for `/api/referrals`. Behavior-compatible
with every vendored `route.ts` variant, including exact error wording.

`ReferralsRouteHandlerOptions`:

| option | type | default | description |
| --- | --- | --- | --- |
| `store` | `ReferralStore` | — | Pass the `ReferralsClient` (it implements `ReferralStore`). |
| `getUserId` | `(req: ReferralsRouteRequest) => Promise<string \| null> \| string \| null` | — | Auth resolver. Omit for legacy unauthenticated mode. |
| `split` | `ReferralSplit` | `DEFAULT_SPLIT` | Split for `apply`. |
| `param` | `string` | `"ref"` | Query param for `validate`. |

`ReferralsRouteRequest` is a structural subset of both the web `Request` and
Next's `NextRequest` (`url`, `headers.get`, `json()`), so the exported
handlers accept either. If your auth helper is typed against `NextRequest`,
cast inside the wrapper: `getUserId: async (req) => (await getAuthenticatedUser(req as NextRequest))?.id ?? null` — at runtime the object is the real `NextRequest`.

Routes (with `getUserId` configured):

| request | response |
| --- | --- |
| `GET ?action=validate&ref=CODE` | `{ valid, code }`; `400 { error: "Missing ref" }` without the param |
| `GET ?action=myusages` | `{ usages }`; `401 { error: "Unauthorized" }` when unauthenticated |
| `POST { action: "create" }` | `{ code }`; `401` when unauthenticated |
| `POST { action: "apply", code, amount }` | `{ usage }`; `400 { error: "Missing code or amount" }` |
| anything else | `400 { error: "Unknown action" }` |

Without `getUserId` (legacy saasrow-web / phonenumbers.bot variant):
`myusages` and `apply` return `400 Unknown action`, and
`POST { action: "create", ownerId }` creates a code for the body-supplied
`ownerId` (`400 { error: "Missing ownerId" }` without it). Like the vendored
handlers, errors from the store (e.g. invalid code in `apply`) are not
caught and surface as a 500.

### Supabase structural types

- `ReferralsSupabaseClient` — anything with `.from(table: string)`; every supabase-js client qualifies.
- `ReferralsSupabaseQuery` — the query-builder subset the store uses.
- `ReferralsSupabaseResult<T>`, `ReferralsSupabaseError` — result/error shapes.

### Re-exports

Everything from `@profullstack/referrals` and `@profullstack/referrals/next`
is re-exported so apps need only `@profullstack/stack/referrals`:

- Core: `DEFAULT_SPLIT`, `generateCode`, `calculateReferral`, `validateCode`, `applyReferral`, `createCode`, `buildReferralUrl`, `extractCode`
- Types: `ReferralSplit`, `ReferralCode`, `ReferralUsage`, `ReferralCalculation`, `ReferralStore`, `ReferralHandlerOptions`
- Next: `makeReferralHandlers`, `trackReferralCode`

Note: the React bindings (`ReferralProvider` etc.) live in
`@profullstack/referrals/react` and are **not** re-exported here; apps using
them keep that import.

## Database schema

Both tables match what the vendored stores already used:

```sql
create table referral_codes (
  code text primary key,
  owner_id text not null,
  created_at timestamptz not null,
  expires_at timestamptz
);

create table referral_usages (
  id bigint generated always as identity primary key,
  code text not null,
  affiliate_id text not null,
  new_user_id text not null,
  amount_cents integer not null,
  commission_cents integer not null,
  discount_cents integer not null,
  applied_at timestamptz not null
);
```

## Migration guide

Every migration is import-compatible: keep exporting the name `referralStore`
from the app's existing `lib/referrals.ts` path and no other file changes are
forced. Only the route files imported `referralStore` in every app surveyed,
so the lib can also be inlined into the route file.

### Step 1 — replace the vendored `lib/referrals.ts`

Before: a 33–63 line hand-written `ReferralStore` over Supabase. After, one
`createReferralsClient` call. The only per-app difference is `getClient`:

```ts
import { createReferralsClient } from "@profullstack/stack/referrals";
// keep the app's existing client factory import, e.g.:
import { getServerSupabase } from "@/lib/supabase/server";

export const referralStore = createReferralsClient({
  getClient: () => getServerSupabase(),
});
```

| app | file | `getClient` replacement |
| --- | --- | --- |
| bl0ggers | `lib/referrals.ts` | `() => getServerSupabase()` (from `@/lib/supabase/server`) |
| d0rz | `lib/referrals.ts` | `() => getServerSupabase()` (from `@/lib/supabase/server`) |
| weedforcrypto | `src/lib/referrals.ts` | `() => createSupabaseAdminClient()` (from `@/lib/supabase/admin`) |
| crawlproof.com | `lib/referrals.ts` | `() => serviceClient()` (from `@/lib/supabase/service`) |
| saasrow-web | `src/lib/referrals.ts` | `() => getSupabaseAdmin()` (from `@/lib/supabaseAdmin`) |
| phonenumbers.bot | `src/lib/referrals.ts` | `() => getSupabaseClient()` (from `@/lib/supabase-server`) |
| media-streamer | `src/lib/referrals.ts` | `() => getServerClient()` (from `@/lib/supabase`) |
| coinpayportal | `src/lib/referrals.ts` | inline factory, see below |
| smshub | `src/lib/referrals.ts` | inline factory, see below |
| giv1-web | `src/lib/referrals.ts` | inline factory, see below |

coinpayportal / smshub / giv1-web build the admin client inline; keep that,
moved into `getClient`:

```ts
import { createReferralsClient } from "@profullstack/stack/referrals";
import { createClient } from "@supabase/supabase-js";

export const referralStore = createReferralsClient({
  getClient: () =>
    createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    ),
});
```

### Step 2 — replace `app/api/referrals/route.ts`

**bl0ggers, smshub, coinpayportal, weedforcrypto, d0rz, crawlproof.com,
giv1-web, media-streamer** (full authenticated variant). Before: 45–59 lines
handling `validate` / `myusages` / `create` / `apply`. After: the factory plus
the app's existing auth resolver:

```ts
import { createReferralsRouteHandler } from "@profullstack/stack/referrals";
import { referralStore } from "@/lib/referrals";
// app-specific auth import (unchanged), e.g. bl0ggers/d0rz:
import { getSessionSupabase } from "@/lib/supabase/server-cookies";

export const dynamic = "force-dynamic";
// bl0ggers/d0rz also keep: export const runtime = "nodejs";

async function getUserId() {
  const supabase = await getSessionSupabase();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export const { GET, POST } = createReferralsRouteHandler({ store: referralStore, getUserId });
```

Per-app `getUserId` sources (only the import/helper changes, the last line
never does):

- bl0ggers, d0rz — `getSessionSupabase()` from `@/lib/supabase/server-cookies`
- smshub — `createServerSupabaseClient()` from `@/lib/supabase/server`
- weedforcrypto — `createSupabaseServerClient()` from `@/lib/supabase/server`
- crawlproof.com, giv1-web — `createClient()` from `@/lib/supabase/server`
- coinpayportal — JWT bearer:
  `getUserId: (req) => { const auth = req.headers.get("authorization"); ... return decoded?.userId ?? decoded?.sub ?? null; }`
  (keep the existing `verifyToken`/`getJwtSecret` body verbatim; the structural request exposes `headers.get`)
- media-streamer — `getUserId: async (req) => (await getAuthenticatedUser(req as NextRequest))?.id ?? null`
  (`getAuthenticatedUser` from `@/lib/auth` is typed against `NextRequest`; cast is runtime-safe)

**saasrow-web, phonenumbers.bot** (legacy unauthenticated variant). Before:
`validate` + body-`ownerId` `create` only. After — delete both
`src/lib/referrals.ts` and the old route and ship 5 lines:

```ts
import { createReferralsClient, createReferralsRouteHandler } from "@profullstack/stack/referrals";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin"; // phonenumbers.bot: getSupabaseClient from "@/lib/supabase-server"

export const dynamic = "force-dynamic";
export const { GET, POST } = createReferralsRouteHandler({
  store: createReferralsClient({ getClient: () => getSupabaseAdmin() }),
});
```

### Step 3 — middleware (`trackReferralCode`)

Apps importing `@profullstack/referrals/next` (smshub, weedforcrypto, giv1-web,
crawlproof.com `proxy.ts`, bl0ggers `proxy.ts`, naallo, trajectory-web,
communitygardens-web, avenasea-web, d0rz, phonenumbers.bot, libertyhillcoin.com,
coinpayportal, saasrow-web, …) can switch the import to
`@profullstack/stack/referrals` — the function is a re-export, no behavior
change:

```diff
-import { trackReferralCode } from "@profullstack/referrals/next";
+import { trackReferralCode } from "@profullstack/stack/referrals";
```

**profullstack-web, profullstack-web-plans** vendor the helper at
`src/lib/referrals/next.ts` (a verbatim copy of `trackReferralCode`). Delete
the file and import from `@profullstack/stack/referrals` instead.

### Step 4 — anything importing core functions

Route files (and any other code) importing `createCode`, `validateCode`,
`applyReferral`, types, etc. from `@profullstack/referrals` can switch to
`@profullstack/stack/referrals`; everything is re-exported. Keep
`@profullstack/referrals/react` imports (`ReferralProvider`) as-is — those are
not part of this module.
