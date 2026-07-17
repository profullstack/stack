/**
 * @profullstack/stack/supabase — shared Supabase SSR client factories.
 *
 * Replaces the hand-copied `lib/supabase/{client,server,middleware}.ts` trio
 * found across the Profullstack Next.js apps:
 *
 * - {@link createBrowserSupabase} — browser client (was `lib/supabase/client.ts`)
 * - {@link createServerSupabase} — server client bound to the Next.js cookie
 *   store (was `lib/supabase/server.ts`)
 * - {@link updateSession} — Next.js middleware helper that refreshes the auth
 *   cookie and returns `{ response, user }` (was `lib/supabase/middleware.ts`)
 *
 * All factories wrap `@supabase/ssr` using the recommended `getAll`/`setAll`
 * cookie methods. `next` is an optional peer: it is only loaded (lazily, via
 * `require`) when {@link updateSession} runs, so importing this module never
 * pulls Next.js into non-Next bundles.
 */

import { createBrowserClient, createServerClient } from "@supabase/ssr";
import type { CookieOptions } from "@supabase/ssr";

/** Default env var holding the Supabase project URL. */
const DEFAULT_URL_ENV = "NEXT_PUBLIC_SUPABASE_URL";
/** Default env var holding the Supabase anon (public) key. */
const DEFAULT_ANON_KEY_ENV = "NEXT_PUBLIC_SUPABASE_ANON_KEY";

/**
 * Configuration shared by every factory in this module.
 *
 * Values resolve in this order: explicit option → custom env name → default
 * `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` env vars.
 */
export interface SupabaseConfigOptions {
  /** Explicit Supabase project URL. Wins over any env var when set. */
  url?: string;
  /** Explicit Supabase anon (public) key. Wins over any env var when set. */
  anonKey?: string;
  /**
   * Env var name to read the project URL from.
   * Default: `"NEXT_PUBLIC_SUPABASE_URL"`.
   */
  urlEnv?: string;
  /**
   * Env var name to read the anon key from.
   * Default: `"NEXT_PUBLIC_SUPABASE_ANON_KEY"`.
   */
  anonKeyEnv?: string;
}

/**
 * Options for {@link createServerSupabase} and {@link updateSession}.
 */
export interface CreateServerSupabaseOptions extends SupabaseConfigOptions {
  /**
   * When true, `client.realtime.disconnect()` is called right after the
   * client is created. Server-side clients (middleware, Server Components,
   * route handlers) only need Auth/REST; each `createServerClient()` call
   * otherwise allocates a `RealtimeClient` with WebSocket state, which leaks
   * memory under high request volume. (Ported from ugig.net's variant.)
   * Default: false.
   */
  disconnectRealtime?: boolean;
}

/**
 * A resolved Supabase URL + anon key pair.
 */
export interface SupabaseConfig {
  /** Supabase project URL. */
  url: string;
  /** Supabase anon (public) key. */
  anonKey: string;
}

/**
 * Resolve the Supabase URL and anon key from options and/or environment.
 *
 * The default branch reads `process.env.NEXT_PUBLIC_SUPABASE_URL` /
 * `process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY` with static property access on
 * purpose: Next.js only inlines env vars into the browser bundle when they
 * are accessed by literal name. Custom `urlEnv`/`anonKeyEnv` names are read
 * dynamically and therefore only work server-side (or with explicit
 * bundler defines).
 *
 * @throws Error naming the missing variable(s) when no URL or key is found.
 */
export function resolveSupabaseConfig(
  options: SupabaseConfigOptions = {}
): SupabaseConfig {
  const urlEnv = options.urlEnv ?? DEFAULT_URL_ENV;
  const anonKeyEnv = options.anonKeyEnv ?? DEFAULT_ANON_KEY_ENV;
  const url =
    options.url ??
    (options.urlEnv
      ? process.env[options.urlEnv]
      : process.env.NEXT_PUBLIC_SUPABASE_URL);
  const anonKey =
    options.anonKey ??
    (options.anonKeyEnv
      ? process.env[options.anonKeyEnv]
      : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  if (!url || !anonKey) {
    const missing = [!url ? urlEnv : null, !anonKey ? anonKeyEnv : null]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `@profullstack/stack/supabase: missing Supabase configuration (${missing}). ` +
        `Set the environment variable(s) or pass { url, anonKey } explicitly.`
    );
  }
  return { url, anonKey };
}

/**
 * The Supabase browser client returned by {@link createBrowserSupabase}
 * (`SupabaseClient<Database>` from `@supabase/supabase-js`).
 */
export type SupabaseBrowserClient<Database = any> = ReturnType<
  typeof createBrowserClient<Database>
>;

/**
 * The Supabase server client returned by {@link createServerSupabase}
 * (`SupabaseClient<Database>` from `@supabase/supabase-js`).
 */
export type SupabaseServerClient<Database = any> = ReturnType<
  typeof createServerClient<Database>
>;

/**
 * The Supabase `User` type (derived from `auth.getUser()`), re-exported so
 * consumers don't need a direct `@supabase/supabase-js` dependency.
 */
export type SupabaseUser = NonNullable<
  Awaited<ReturnType<SupabaseServerClient["auth"]["getUser"]>>["data"]["user"]
>;

/**
 * Structural type of the Next.js cookie store (`await cookies()` from
 * `next/headers`). Both the sync (Next ≤14) and async (Next 15+) store
 * satisfy this interface; pass either the store or its promise to
 * {@link createServerSupabase}.
 */
export interface SupabaseCookieStore {
  /** Return every cookie visible to this request. */
  getAll(): { name: string; value: string }[];
  /**
   * Set a cookie. Throws when called from a Server Component (read-only
   * store) — {@link createServerSupabase} swallows that case for you.
   */
  set(name: string, value: string, options?: CookieOptions): unknown;
}

/**
 * Create a Supabase browser client (replaces the per-app
 * `lib/supabase/client.ts`).
 *
 * `@supabase/ssr`'s browser client is a singleton by default
 * (`isSingleton: true`), so repeated calls share one client and one
 * WebSocket — no per-app memoization needed.
 *
 * @example
 *   // src/lib/supabase/client.ts
 *   import { createBrowserSupabase } from "@profullstack/stack/supabase";
 *   import type { Database } from "@/types/database";
 *   export const createClient = () => createBrowserSupabase<Database>();
 */
export function createBrowserSupabase<Database = any>(
  options: SupabaseConfigOptions = {}
): SupabaseBrowserClient<Database> {
  const { url, anonKey } = resolveSupabaseConfig(options);
  return createBrowserClient<Database>(url, anonKey);
}

/**
 * Create a Supabase server client bound to the Next.js cookie store
 * (replaces the per-app `lib/supabase/server.ts`).
 *
 * Uses the `@supabase/ssr`-recommended `getAll`/`setAll` cookie methods.
 * `setAll` is wrapped in try/catch: when called from a Server Component the
 * store is read-only and `set()` throws — safe to ignore as long as
 * middleware ({@link updateSession}) refreshes sessions.
 *
 * @param cookieStore The store from `cookies()` in `next/headers` — pass the
 *   promise directly on Next 15+, or the awaited store on any version.
 *
 * @example
 *   // src/lib/supabase/server.ts
 *   import { cookies } from "next/headers";
 *   import { createServerSupabase } from "@profullstack/stack/supabase";
 *   import type { Database } from "@/types/database";
 *   export const createClient = () => createServerSupabase<Database>(cookies());
 */
export async function createServerSupabase<Database = any>(
  cookieStore: SupabaseCookieStore | Promise<SupabaseCookieStore>,
  options: CreateServerSupabaseOptions = {}
): Promise<SupabaseServerClient<Database>> {
  const store = await cookieStore;
  const { url, anonKey } = resolveSupabaseConfig(options);
  const client = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options: cookieOptions }) =>
            store.set(name, value, cookieOptions)
          );
        } catch {
          // `setAll` was called from a Server Component where the cookie
          // store is read-only. Safe to ignore when middleware refreshes
          // sessions — see updateSession().
        }
      },
    },
  });
  if (options.disconnectRealtime) client.realtime.disconnect();
  return client;
}

/**
 * Structural type of the `next/server` `NextResponse` — only the surface
 * this module uses. The real `NextResponse` satisfies it.
 */
export interface NextResponseLike {
  /** Response cookie jar; refreshed auth cookies are written here. */
  cookies: {
    set(name: string, value: string, options?: CookieOptions): unknown;
  };
}

/**
 * Structural type of the `next/server` `NextRequest` — only the surface
 * this module uses. The real `NextRequest` satisfies it.
 */
export interface NextRequestLike {
  /** Request cookie jar read from (and mirrored into on refresh). */
  cookies: {
    getAll(): { name: string; value: string }[];
    set(name: string, value: string): unknown;
  };
}

/**
 * Result of {@link updateSession}.
 */
export interface SupabaseSessionUpdate {
  /**
   * The `NextResponse` carrying any refreshed auth cookies. Return it from
   * your middleware when no redirect applies.
   */
  response: NextResponseLike;
  /** The authenticated user, or `null` when the request has no session. */
  user: SupabaseUser | null;
}

type NextServerModule = {
  NextResponse: {
    next(init?: { request?: unknown }): NextResponseLike;
  };
};

/**
 * Lazily load `next/server` via dynamic import so importing this module never
 * pulls in `next` (and so it works in ESM builds — a bundled require() shim
 * breaks Next's build). Only loaded when `updateSession` actually runs.
 */
async function loadNextServer(): Promise<NextServerModule> {
  // Typed as `string` so tsc/dts doesn't resolve next/server's types (next is
  // an optional peer dep, not installed here); the runtime import still works.
  const specifier: string = "next/server";
  return (await import(specifier)) as NextServerModule;
}

/**
 * Next.js middleware helper: refresh the Supabase auth cookie and report the
 * current user (replaces the per-app `lib/supabase/middleware.ts`).
 *
 * Follows the `@supabase/ssr`-recommended pattern: cookies are read from the
 * request, refreshed cookies are mirrored onto both the request (so
 * downstream Server Components see them) and a re-created `NextResponse`.
 *
 * Route protection is intentionally NOT baked in — the per-app variants all
 * differ (protected-path lists, public-route lists, auth-page redirects).
 * Use the returned `user` to apply your own rules.
 *
 * @example
 *   // middleware.ts
 *   import type { NextRequest } from "next/server";
 *   import { NextResponse } from "next/server";
 *   import { updateSession } from "@profullstack/stack/supabase";
 *
 *   export async function middleware(request: NextRequest) {
 *     const { response, user } = await updateSession(request);
 *     if (!user && request.nextUrl.pathname.startsWith("/dashboard")) {
 *       const url = request.nextUrl.clone();
 *       url.pathname = "/login";
 *       return NextResponse.redirect(url);
 *     }
 *     return response;
 *   }
 */
export async function updateSession<Database = any>(
  request: NextRequestLike,
  options: CreateServerSupabaseOptions = {}
): Promise<SupabaseSessionUpdate> {
  const { NextResponse } = await loadNextServer();
  let response = NextResponse.next({ request });
  const { url, anonKey } = resolveSupabaseConfig(options);
  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        // Re-create the response so it picks up the mutated request cookies.
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options: cookieOptions }) =>
          response.cookies.set(name, value, cookieOptions)
        );
      },
    },
  });
  if (options.disconnectRealtime) supabase.realtime.disconnect();
  // Refresh the session if expired — required for Server Components.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { response, user };
}
