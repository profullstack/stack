/**
 * CONTRACT TEST — @profullstack/stack/supabase ↔ @supabase/ssr.
 *
 * Unlike tests/supabase.test.ts (which mocks @supabase/ssr), these tests run
 * the REAL installed @supabase/ssr package with a stubbed global `fetch`, so
 * the actual ssr cookie machinery executes:
 *
 *   - createServerClient (node_modules/@supabase/ssr/dist/main/createServerClient.js)
 *     drives our `cookies.getAll` / `cookies.setAll` adapter through
 *     createStorageFromOptions + applyServerStorage (dist/main/cookies.js).
 *   - Cookie wire format pinned from that source: values are stored as
 *     `base64-<base64url(JSON.stringify(session))>` under the cookie named
 *     `sb-<project-ref>-auth-token`, with DEFAULT_COOKIE_OPTIONS
 *     { path: "/", sameSite: "lax", httpOnly: false, maxAge: 34560000 }
 *     (dist/main/utils/constants.js).
 *   - The session object must contain access_token, refresh_token and
 *     expires_at to be considered valid (@supabase/auth-js _isValidSession).
 *   - An expired session makes auth-js POST /auth/v1/token?grant_type=refresh_token,
 *     persist via setItems, then fire TOKEN_REFRESHED, which is the event that
 *     makes ssr flush our setAll — the exact flow updateSession exists for.
 *
 * `next/server` is not installed (optional peer), so updateSession's dynamic
 * `import("next/server")` resolves to the shared stub in
 * tests/stubs/next-server.ts via the vitest alias. Everything else is real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  createBrowserSupabase,
  createServerSupabase,
  updateSession,
  type SupabaseCookieStore,
  type NextRequestLike,
} from "../../src/supabase/index.js";
import { FakeNextResponse } from "../stubs/next-server.js";

// ---------------------------------------------------------------------------
// Constants pinned from the installed @supabase/ssr + @supabase/supabase-js
// ---------------------------------------------------------------------------

const PROJECT_REF = "testproj";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const ANON_KEY = "anon-key-123";
/** supabase-js derives the storage key from the URL host's first segment. */
const AUTH_COOKIE = `sb-${PROJECT_REF}-auth-token`;
/** ssr DEFAULT_COOKIE_OPTIONS (dist/main/utils/constants.js). */
const SSR_COOKIE_OPTIONS = {
  path: "/",
  sameSite: "lax",
  httpOnly: false,
  maxAge: 400 * 24 * 60 * 60,
};

const TEST_USER = { id: "user-1", email: "ada@example.com", aud: "authenticated" };

// ---------------------------------------------------------------------------
// Session cookie helpers (ssr cookieEncoding: "base64url")
// ---------------------------------------------------------------------------

function makeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: "access-token-old",
    refresh_token: "rt-old",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: TEST_USER,
    ...overrides,
  };
}

function encodeSessionCookie(session: Record<string, unknown>): string {
  return "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
}

function decodeSessionCookie(value: string): Record<string, unknown> {
  expect(value.startsWith("base64-")).toBe(true);
  return JSON.parse(
    Buffer.from(value.slice("base64-".length), "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fetch stub — the only network seam auth-js uses
// ---------------------------------------------------------------------------

type FetchCall = { url: string; init: RequestInit };
const fetchCalls: FetchCall[] = [];
let fetchHandler: (call: FetchCall) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(handler: (call: FetchCall) => Response): void {
  fetchHandler = handler;
}

beforeEach(() => {
  fetchCalls.length = 0;
  fetchHandler = () => {
    throw new Error("no fetch handler installed");
  };
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    fetchCalls.push(call);
    return fetchHandler(call);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Cookie store fakes (Next.js `cookies()` shape)
// ---------------------------------------------------------------------------

type JarEntry = { name: string; value: string; options?: Record<string, unknown> };

function makeCookieStore(initial: { name: string; value: string }[] = []): SupabaseCookieStore & {
  jar: JarEntry[];
  getAll: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  const jar: JarEntry[] = [...initial];
  return {
    jar,
    getAll: vi.fn(() => jar.map(({ name, value }) => ({ name, value }))),
    set: vi.fn((name: string, value: string, options?: Record<string, unknown>) => {
      jar.push({ name, value, options });
    }),
  };
}

// ---------------------------------------------------------------------------
// next/server stub (shared; resolved via the vitest alias)
// ---------------------------------------------------------------------------

/** Reset the shared stub before exercising updateSession. */
function stubNextServer(): void {
  FakeNextResponse.reset();
}

function makeRequest(initial: { name: string; value: string }[] = []): NextRequestLike & {
  cookies: { getAll: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
} {
  const jar = [...initial];
  return {
    cookies: {
      getAll: vi.fn(() => jar.map(({ name, value }) => ({ name, value }))),
      set: vi.fn((name: string, value: string) => {
        jar.push({ name, value });
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Version pin — this contract is written against the installed ssr version
// ---------------------------------------------------------------------------

describe("@supabase/ssr version contract", () => {
  it("installed version satisfies the peer range this contract was written against", () => {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@supabase/ssr/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    // Peer range in package.json: "@supabase/ssr": ">=0.5.0".
    // Contract encoded from 0.7.0 sources (createServerClient.js, cookies.js).
    const [major, minor] = pkg.version.split(".").map(Number);
    expect(major).toBe(0);
    expect(minor!).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// createServerSupabase — real createServerClient + our getAll/setAll adapter
// ---------------------------------------------------------------------------

describe("createServerSupabase with real @supabase/ssr", () => {
  it("getAll adapter feeds ssr's chunk decoding so the stored JWT reaches GoTrue", async () => {
    const session = makeSession();
    const store = makeCookieStore([{ name: AUTH_COOKIE, value: encodeSessionCookie(session) }]);

    installFetch((call) => {
      if (call.url === `${SUPABASE_URL}/auth/v1/user`) return json(TEST_USER);
      throw new Error(`unexpected fetch: ${call.url}`);
    });

    const client = await createServerSupabase(store, { url: SUPABASE_URL, anonKey: ANON_KEY });
    const { data, error } = await client.auth.getUser();

    expect(error).toBeNull();
    expect(data.user?.email).toBe("ada@example.com");
    // The real ssr storage read our getAll, re-assembled the chunks, decoded
    // the base64- value and handed auth-js the session — proven by the exact
    // access token arriving as the Bearer credential at /auth/v1/user.
    const userCall = fetchCalls.find((c) => c.url.endsWith("/auth/v1/user"))!;
    const headers = userCall.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${session["access_token"]}`);
    expect(headers["apikey"]).toBe(ANON_KEY);
    expect(store.getAll).toHaveBeenCalled();
  });

  it("setAll adapter receives ssr's applyServerStorage shape on token refresh", async () => {
    const expired = makeSession({ expires_at: Math.floor(Date.now() / 1000) - 3600 });
    const store = makeCookieStore([{ name: AUTH_COOKIE, value: encodeSessionCookie(expired) }]);

    const refreshed = {
      access_token: "new-access-token",
      refresh_token: "rt-new",
      token_type: "bearer",
      expires_in: 3600,
      user: TEST_USER,
    };
    installFetch((call) => {
      if (call.url === `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`) {
        return json(refreshed);
      }
      if (call.url === `${SUPABASE_URL}/auth/v1/user`) return json(TEST_USER);
      throw new Error(`unexpected fetch: ${call.url}`);
    });

    const client = await createServerSupabase(store, { url: SUPABASE_URL, anonKey: ANON_KEY });
    const { data, error } = await client.auth.getUser();
    expect(error).toBeNull();
    expect(data.user?.email).toBe("ada@example.com");

    // auth-js asked GoTrue to refresh using the refresh_token our getAll supplied.
    const refreshCall = fetchCalls.find((c) => c.url.includes("grant_type=refresh_token"))!;
    expect(refreshCall.init.method).toBe("POST");
    expect(JSON.parse(String(refreshCall.init.body))).toEqual({ refresh_token: "rt-old" });

    // TOKEN_REFRESHED → ssr applyServerStorage → our setAll — the adapter
    // contract is (name, value, options) per cookie, value base64- prefixed,
    // options = ssr DEFAULT_COOKIE_OPTIONS.
    expect(store.set).toHaveBeenCalledTimes(1);
    const [name, value, options] = store.set.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe(AUTH_COOKIE);
    expect(options).toMatchObject(SSR_COOKIE_OPTIONS);
    expect(options).not.toHaveProperty("name"); // ssr deletes `name` before setAll
    const persisted = decodeSessionCookie(value);
    expect(persisted["access_token"]).toBe("new-access-token");
    expect(persisted["refresh_token"]).toBe("rt-new");

    // ...and the refreshed access token is what gets sent to GoTrue afterwards.
    const userCall = fetchCalls.find((c) => c.url.endsWith("/auth/v1/user"))!;
    expect((userCall.init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer new-access-token",
    );
  });

  it("swallows setAll writes against a read-only (Server Component) cookie store", async () => {
    const expired = makeSession({ expires_at: Math.floor(Date.now() / 1000) - 3600 });
    const store = makeCookieStore([{ name: AUTH_COOKIE, value: encodeSessionCookie(expired) }]);
    store.set.mockImplementation(() => {
      throw new Error("Cookies can only be modified in a Server Action or Route Handler");
    });

    installFetch((call) => {
      if (call.url.includes("grant_type=refresh_token")) {
        return json({
          access_token: "new-access-token",
          refresh_token: "rt-new",
          token_type: "bearer",
          expires_in: 3600,
          user: TEST_USER,
        });
      }
      if (call.url.endsWith("/auth/v1/user")) return json(TEST_USER);
      throw new Error(`unexpected fetch: ${call.url}`);
    });

    const client = await createServerSupabase(store, { url: SUPABASE_URL, anonKey: ANON_KEY });
    // The refresh still completes; the write failure is contained by the adapter.
    const { data, error } = await client.auth.getUser();
    expect(error).toBeNull();
    expect(data.user?.email).toBe("ada@example.com");
    expect(store.set).toHaveBeenCalled();
  });

  it("accepts the promise-wrapped Next 15 cookie store", async () => {
    const store = makeCookieStore([
      { name: AUTH_COOKIE, value: encodeSessionCookie(makeSession()) },
    ]);
    installFetch((call) => {
      if (call.url.endsWith("/auth/v1/user")) return json(TEST_USER);
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = await createServerSupabase(Promise.resolve(store), {
      url: SUPABASE_URL,
      anonKey: ANON_KEY,
    });
    const { data } = await client.auth.getUser();
    expect(data.user?.email).toBe("ada@example.com");
  });
});

// ---------------------------------------------------------------------------
// createBrowserSupabase — real createBrowserClient in a non-browser runtime
// ---------------------------------------------------------------------------

describe("createBrowserSupabase with real @supabase/ssr", () => {
  it("builds a real SupabaseClient whose session reads hit ssr's empty non-browser storage", async () => {
    const client = createBrowserSupabase({
      url: "https://browserproj.supabase.co",
      anonKey: ANON_KEY,
    });
    expect(typeof client.auth.getUser).toBe("function");
    expect(typeof client.from).toBe("function");

    // In a non-browser runtime ssr's cookie storage returns [] (cookies.js
    // non-browser branch), so there is never a persisted session — and no
    // network traffic is needed to determine that.
    const { data, error } = await client.auth.getSession();
    expect(error).toBeNull();
    expect(data.session).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateSession — the SSR middleware cookie-mirroring spec, end to end
// ---------------------------------------------------------------------------

describe("updateSession with real @supabase/ssr", () => {
  it("mirrors a real token refresh onto the request AND a re-created response", async () => {
    stubNextServer();
    const expired = makeSession({ expires_at: Math.floor(Date.now() / 1000) - 3600 });
    const request = makeRequest([{ name: AUTH_COOKIE, value: encodeSessionCookie(expired) }]);

    installFetch((call) => {
      if (call.url === `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`) {
        return json({
          access_token: "new-access-token",
          refresh_token: "rt-new",
          token_type: "bearer",
          expires_in: 3600,
          user: TEST_USER,
        });
      }
      if (call.url === `${SUPABASE_URL}/auth/v1/user`) return json(TEST_USER);
      throw new Error(`unexpected fetch: ${call.url}`);
    });

    const { response, user } = await updateSession(request, {
      url: SUPABASE_URL,
      anonKey: ANON_KEY,
    });

    expect(user?.email).toBe("ada@example.com");

    // SSR spec, step 1: refreshed cookies are written onto the REQUEST first
    // (so downstream Server Components render with the fresh session). The
    // request cookie jar only takes (name, value) — no options.
    expect(request.cookies.set).toHaveBeenCalledTimes(1);
    const [reqName, reqValue] = request.cookies.set.mock.calls[0] as [string, string];
    expect(reqName).toBe(AUTH_COOKIE);
    expect(decodeSessionCookie(reqValue)["access_token"]).toBe("new-access-token");

    // SSR spec, step 2: the response is RE-CREATED from the mutated request…
    expect(FakeNextResponse.instances).toHaveLength(2);
    expect(FakeNextResponse.instances[1]!.init).toEqual({ request });
    expect(response).toBe(FakeNextResponse.instances[1]);

    // …and step 3: the refreshed cookies are written to the response WITH
    // their cookie options (this is what the browser actually receives).
    const res = response as FakeNextResponse;
    expect(res.cookies.set).toHaveBeenCalledTimes(1);
    const [resName, resValue, resOptions] = res.cookies.set.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(resName).toBe(AUTH_COOKIE);
    expect(decodeSessionCookie(resValue)["access_token"]).toBe("new-access-token");
    expect(resOptions).toMatchObject(SSR_COOKIE_OPTIONS);

    // Ordering: request jar write happens before the response jar write.
    const reqOrder = request.cookies.set.mock.invocationCallOrder[0]!;
    const resOrder = res.cookies.set.mock.invocationCallOrder[0]!;
    expect(reqOrder).toBeLessThan(resOrder);
  });

  it("returns the untouched response and null user when the request has no session", async () => {
    stubNextServer();
    const request = makeRequest();
    installFetch(() => {
      throw new Error("no network expected without a session");
    });

    const { response, user } = await updateSession(request, {
      url: SUPABASE_URL,
      anonKey: ANON_KEY,
    });

    expect(user).toBeNull();
    // No refresh happened → setAll never fired → no cookie writes anywhere,
    // and the original NextResponse.next() result is the one returned.
    expect(FakeNextResponse.instances).toHaveLength(1);
    expect(response).toBe(FakeNextResponse.instances[0]);
    expect(request.cookies.set).not.toHaveBeenCalled();
    expect((response as FakeNextResponse).cookies.set).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });

  it("reads cookies from the request through the real ssr getAll path", async () => {
    stubNextServer();
    const session = makeSession();
    const request = makeRequest([{ name: AUTH_COOKIE, value: encodeSessionCookie(session) }]);
    installFetch((call) => {
      if (call.url.endsWith("/auth/v1/user")) return json(TEST_USER);
      throw new Error(`unexpected fetch: ${call.url}`);
    });

    const { user } = await updateSession(request, { url: SUPABASE_URL, anonKey: ANON_KEY });
    expect(user?.email).toBe("ada@example.com");
    expect(request.cookies.getAll).toHaveBeenCalled();
    // A still-valid session means no refresh, so nothing is written back.
    expect(request.cookies.set).not.toHaveBeenCalled();
  });
});
