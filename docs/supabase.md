# @profullstack/stack/supabase

Shared Supabase SSR client factories for Next.js App Router apps. Replaces the
hand-copied `lib/supabase/{client,server,middleware}.ts` trio that drifted
across ~10 Profullstack apps.

All factories wrap [`@supabase/ssr`](https://github.com/supabase/ssr) using its
recommended `getAll`/`setAll` cookie methods, with:

- configurable env var names (default `NEXT_PUBLIC_SUPABASE_URL` /
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`),
- a hard error naming the missing variable(s) instead of a `!` non-null
  assertion or a silent `?? ""`,
- an opt-in `disconnectRealtime` flag for server-side clients (ported from
  ugig.net's memory-leak fix),
- zero hard `next` imports — `next/server` is lazy-required only inside
  `updateSession()`, so importing this module never pulls Next.js into
  non-Next bundles.

## Install / import

```sh
npm install @profullstack/stack @supabase/ssr @supabase/supabase-js
```

(`@supabase/ssr` and `next` are optional peer dependencies of
`@profullstack/stack`; you only need them for this module. `@supabase/ssr`
itself peers on `@supabase/supabase-js`.)

```ts
import {
  createBrowserSupabase,
  createServerSupabase,
  updateSession,
} from "@profullstack/stack/supabase";
```

## API reference

### `createBrowserSupabase<Database = any>(options?) → SupabaseBrowserClient<Database>`

Browser client (replaces each app's `lib/supabase/client.ts`).

`options` (`SupabaseConfigOptions`):

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `url` | `string` | — | Explicit project URL; wins over env vars. |
| `anonKey` | `string` | — | Explicit anon key; wins over env vars. |
| `urlEnv` | `string` | `"NEXT_PUBLIC_SUPABASE_URL"` | Env var to read the URL from. |
| `anonKeyEnv` | `string` | `"NEXT_PUBLIC_SUPABASE_ANON_KEY"` | Env var to read the key from. |

Notes:

- `@supabase/ssr`'s browser client is already a singleton
  (`isSingleton: true`), so **no per-app memoization is needed** — repeated
  calls share one client and one WebSocket.
- The default env vars are read via static `process.env.NEXT_PUBLIC_*` access
  so Next.js still inlines them into the browser bundle. Custom `urlEnv` /
  `anonKeyEnv` names are read dynamically and therefore only work server-side
  (or with your own bundler defines).

```ts
// src/lib/supabase/client.ts
import { createBrowserSupabase } from "@profullstack/stack/supabase";
import type { Database } from "@/types/database";

export const createClient = () => createBrowserSupabase<Database>();
```

### `createServerSupabase<Database = any>(cookieStore, options?) → Promise<SupabaseServerClient<Database>>`

Server client bound to the Next.js cookie store (replaces each app's
`lib/supabase/server.ts`).

- `cookieStore`: the store from `cookies()` (`next/headers`). Pass the promise
  directly on Next 15+ (`createServerSupabase(cookies())`) or the awaited /
  sync store on any version — both are accepted.
- `options`: everything from `SupabaseConfigOptions`, plus:

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `disconnectRealtime` | `boolean` | `false` | Call `client.realtime.disconnect()` immediately. Server clients only need Auth/REST; each `createServerClient()` otherwise allocates a `RealtimeClient` with WebSocket state, which leaks memory under high request volume. Recommended for middleware/route-heavy apps. |

Cookie semantics (the `@supabase/ssr`-recommended pattern): `getAll` delegates
to the store; `setAll` writes each cookie via `store.set(name, value, options)`
inside a try/catch — when called from a Server Component the store is
read-only and `set()` throws, which is safe to ignore as long as middleware
refreshes sessions (see `updateSession`).

```ts
// src/lib/supabase/server.ts
import { cookies } from "next/headers";
import { createServerSupabase } from "@profullstack/stack/supabase";
import type { Database } from "@/types/database";

export const createClient = () => createServerSupabase<Database>(cookies());
```

### `updateSession<Database = any>(request, options?) → Promise<SupabaseSessionUpdate>`

Next.js middleware helper (replaces each app's `lib/supabase/middleware.ts`).
Refreshes the auth cookie and returns:

```ts
interface SupabaseSessionUpdate {
  response: NextResponseLike; // carries any refreshed auth cookies
  user: SupabaseUser | null;  // null when the request has no session
}
```

- `request`: the `NextRequest` from your middleware (structurally typed — pass
  it directly).
- `options`: same as `createServerSupabase` (`url`, `anonKey`, `urlEnv`,
  `anonKeyEnv`, `disconnectRealtime`).

Cookie semantics (verbatim from the per-app variants, which match the
`@supabase/ssr` docs): cookies are read from `request.cookies`; on refresh,
each cookie is mirrored onto `request.cookies` (so downstream Server
Components see it) **and** onto a re-created `NextResponse.next({ request })`
with its full options.

**Route protection is intentionally not baked in** — every app's variant
differs (protected-path lists, public-route lists, auth-page redirects,
`?redirect=` sanitization). Use the returned `user` to apply your own rules:

```ts
// middleware.ts
import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@profullstack/stack/supabase";

export async function middleware(request: NextRequest) {
  const { response, user } = await updateSession(request);

  if (!user && request.nextUrl.pathname.startsWith("/dashboard")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", request.nextUrl.pathname.replace(/[<>"']/g, ""));
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
```

`response` is typed structurally (`NextResponseLike`); at runtime it is a real
`NextResponse`, so `return response;` from middleware works as-is. Cast to
`NextResponse` only if you annotate the middleware's return type.

### `resolveSupabaseConfig(options?) → SupabaseConfig`

Resolves `{ url, anonKey }` from explicit options → custom env names → default
env vars. Throws an `Error` naming the missing variable(s) when resolution
fails. Used internally by all three factories; exported for tests and for apps
that need the raw values (e.g. building a service-role client themselves).

### Exported types

| Type | Meaning |
| --- | --- |
| `SupabaseConfigOptions` | `{ url?, anonKey?, urlEnv?, anonKeyEnv? }` |
| `CreateServerSupabaseOptions` | `SupabaseConfigOptions & { disconnectRealtime? }` |
| `SupabaseConfig` | `{ url: string; anonKey: string }` |
| `SupabaseBrowserClient<Database>` | Return type of `createBrowserSupabase` (the ssr `SupabaseClient`) |
| `SupabaseServerClient<Database>` | Return type of `createServerSupabase` |
| `SupabaseUser` | The `User` type from `auth.getUser()` (no direct `@supabase/supabase-js` import needed) |
| `SupabaseCookieStore` | Structural type of the Next.js cookie store |
| `NextRequestLike` / `NextResponseLike` | Structural `next/server` types used by `updateSession` |
| `SupabaseSessionUpdate` | `{ response, user }` returned by `updateSession` |

## Migration guide

Every migration below deletes `lib/supabase/client.ts` and
`lib/supabase/server.ts` (or reduces them to two-line re-export shims if you
prefer to keep import paths stable) and rewrites the middleware. Cookie
semantics are unchanged: all variants already used `getAll`/`setAll`, and the
try/catch around `setAll` (Server Component case) is preserved.

### ugig.net (`src/lib/supabase/`)

Before — `client.ts`:

```ts
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
```

After:

```ts
import { createBrowserSupabase } from "@profullstack/stack/supabase";
import type { Database } from "@/types/database";
export const createClient = () => createBrowserSupabase<Database>();
```

Before — `server.ts` (had the eager `realtime.disconnect()` fix). After:

```ts
import { cookies } from "next/headers";
import { createServerSupabase } from "@profullstack/stack/supabase";
import type { Database } from "@/types/database";
export const createClient = () =>
  createServerSupabase<Database>(cookies(), { disconnectRealtime: true });
```

Before — `middleware.ts`: `updateSession(request)` returned a bare
`NextResponse` and contained the redirect logic. After — keep ugig's
`protectedPaths`/`authPaths` logic in `src/middleware.ts`, but drive it off
the returned `user`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@profullstack/stack/supabase";

export async function middleware(request: NextRequest) {
  const { response, user } = await updateSession(request, { disconnectRealtime: true });

  const protectedPaths = ["/dashboard", "/profile", "/settings", "/messages"];
  if (protectedPaths.some((p) => request.nextUrl.pathname.startsWith(p)) && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", request.nextUrl.pathname.replace(/[<>"']/g, ""));
    return NextResponse.redirect(url);
  }

  const authPaths = ["/login", "/signup"];
  if (authPaths.some((p) => request.nextUrl.pathname === p) && user) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return response;
}
```

Deviation to be aware of: the return type changed from `NextResponse` to
`{ response, user }` — update the two call sites (the middleware wrapper and
any test mocks) accordingly.

### smshub (`src/lib/supabase/`)

`client.ts` already threw on missing env vars — the factory now does that for
you, naming the missing variable:

```ts
import { createBrowserSupabase } from "@profullstack/stack/supabase";
export const createClient = () => createBrowserSupabase();
```

`server.ts` → `createServerSupabase(cookies())`. **Keep `createServiceClient`
where it is** (or move it to a small local util): it is a service-role client
built on `@supabase/supabase-js` directly, not an SSR cookie client, and is
out of this module's scope.

`middleware.ts`: keep smshub's `PUBLIC_ROUTES` / `isPublicRoute` table in
`src/middleware.ts` and drive it off `{ response, user }`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@profullstack/stack/supabase";

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  // Skip Supabase entirely for public pages (smshub-specific optimization).
  if (isPublicRoute(pathname)) return NextResponse.next({ request });

  const { response, user } = await updateSession(request);
  const isAuth = pathname.startsWith("/login") || pathname.startsWith("/register");
  if (user && isAuth) {
    const url = request.nextUrl.clone();
    url.pathname = "/inbox";
    return NextResponse.redirect(url);
  }
  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return response;
}
```

Deviation: smshub's old `updateSession` also short-circuited public routes
*before* refreshing cookies. With the consolidated helper, either keep the
short-circuit in your own middleware as shown above (public pages then never
refresh auth cookies — acceptable for smshub since login/register are the
only auth cookie writers), or drop it and let every request refresh.

### giv1-web (`src/lib/supabase/`)

Identical shape to ugig minus the realtime fix and with a `?ref=` redirect
param. Replace `client.ts` / `server.ts` with the two-line factories
(`createBrowserSupabase()`, `createServerSupabase(cookies())`), and in
`src/middleware.ts`:

```ts
const { response, user } = await updateSession(request);
const protectedPaths = ["/dashboard", "/settings", "/subscribers"];
if (protectedPaths.some((p) => request.nextUrl.pathname.startsWith(p)) && !user) {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("ref", request.nextUrl.pathname);
  return NextResponse.redirect(url);
}
return response;
```

### crawlproof.com (`lib/supabase/`)

Before — `client.ts` memoized a module-level `cached` client and fell back to
`?? ""` on missing env. After:

```ts
import { createBrowserSupabase } from "@profullstack/stack/supabase";
export const createClient = () => createBrowserSupabase();
```

Deviations (both deliberate):

1. **Drop the manual memoization** — the ssr browser client is a singleton by
   default, so repeated `createClient()` calls already share one client and
   one WebSocket.
2. **Missing env now throws** instead of constructing a client with empty
   strings (which failed later with confusing network errors).

Before — `server.ts` read `env.supabaseUrl` / `env.supabaseAnonKey` from
`@/lib/env`. After — pass them explicitly:

```ts
import { cookies } from "next/headers";
import { createServerSupabase } from "@profullstack/stack/supabase";
import { env } from "@/lib/env";
export const createClient = () =>
  createServerSupabase(cookies(), { url: env.supabaseUrl, anonKey: env.supabaseAnonKey });
```

### bl0ggers (`lib/supabase/server.ts`)

**Not migrated.** bl0ggers' `server.ts` is a service-role client built on
`@supabase/supabase-js` (`SUPABASE_SERVICE_ROLE_KEY`, `persistSession: false`,
graceful `null` on missing env) — not an `@supabase/ssr` cookie client. Keep
`getServerSupabase()` as-is. (If bl0ggers later adds a per-request SSR
client, use `createServerSupabase(cookies())`.)

## Notes / deviations summary

- All read variants already used the recommended `getAll`/`setAll` cookie
  methods; the deprecated `get`/`set`/`remove` cookie methods are not
  supported by this module. If an older app still uses them, rewrite to the
  factories above rather than porting the deprecated shape.
- Env validation is now a thrown `Error` naming the missing variable(s)
  (smshub/giv1 behavior) — replaces ugig's `!` assertions and crawlproof's
  `?? ""`.
- `disconnectRealtime` (ugig's always-on fix) is opt-in to keep the default
  client fully featured; enable it for middleware and high-traffic server
  usage.
- `updateSession` returns `{ response, user }` and performs **no** redirects;
  per-app route tables stay in each app's `middleware.ts`.
