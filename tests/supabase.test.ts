/**
 * Tests for @profullstack/stack/supabase.
 *
 * `@supabase/ssr` is mocked (no network, no DOM). `next/server` resolves to
 * the shared stub in tests/stubs/next-server.ts via the vitest alias — the
 * module under test loads it through a literal dynamic import().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createBrowserSupabase,
  createServerSupabase,
  updateSession,
  resolveSupabaseConfig,
  type SupabaseCookieStore,
  type NextRequestLike,
} from "../src/supabase/index.js";
import { FakeNextResponse } from "./stubs/next-server.js";

const URL_ENV = "NEXT_PUBLIC_SUPABASE_URL";
const KEY_ENV = "NEXT_PUBLIC_SUPABASE_ANON_KEY";
const FAKE_URL = "https://example.supabase.co";
const FAKE_KEY = "anon-key-123";
const FAKE_USER = { id: "user-123", email: "a@b.c" };

// Hoisted spies so the vi.mock factory can reference them.
const h = vi.hoisted(() => ({
  createBrowserClient: vi.fn(),
  createServerClient: vi.fn(),
  getUser: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: h.createBrowserClient,
  createServerClient: h.createServerClient,
}));

/** Shape of the fake browser client returned by the mocked factory. */
type FakeBrowserClient = { kind: "browser"; url: string; key: string };

/** Shape of the fake server client returned by the mocked factory. */
type FakeServerClient = {
  kind: "server";
  url: string;
  key: string;
  cookies: {
    getAll(): { name: string; value: string }[];
    setAll(
      cookies: { name: string; value: string; options?: object }[]
    ): void;
  };
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env[URL_ENV] = FAKE_URL;
  process.env[KEY_ENV] = FAKE_KEY;
  delete process.env.CUSTOM_SUPABASE_URL;
  delete process.env.CUSTOM_SUPABASE_ANON_KEY;

  h.createBrowserClient.mockImplementation(
    (url: string, key: string): FakeBrowserClient => ({ kind: "browser", url, key })
  );
  h.createServerClient.mockImplementation(
    (url: string, key: string, opts: { cookies: FakeServerClient["cookies"] }) => ({
      kind: "server",
      url,
      key,
      cookies: opts.cookies,
      auth: { getUser: h.getUser },
      realtime: { disconnect: h.disconnect },
    })
  );
  h.getUser.mockResolvedValue({ data: { user: FAKE_USER }, error: null });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function makeCookieStore(
  initial: { name: string; value: string }[] = []
): SupabaseCookieStore & {
  jar: { name: string; value: string; options?: object }[];
  getAll: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  const jar: { name: string; value: string; options?: object }[] = [...initial];
  return {
    jar,
    getAll: vi.fn(() => jar.map(({ name, value }) => ({ name, value }))),
    set: vi.fn((name: string, value: string, options?: object) => {
      jar.push({ name, value, options });
    }),
  };
}

describe("resolveSupabaseConfig", () => {
  it("reads the default NEXT_PUBLIC_* env vars", () => {
    expect(resolveSupabaseConfig()).toEqual({ url: FAKE_URL, anonKey: FAKE_KEY });
  });

  it("reads custom env var names", () => {
    process.env.CUSTOM_SUPABASE_URL = "https://custom.supabase.co";
    process.env.CUSTOM_SUPABASE_ANON_KEY = "custom-key";
    expect(
      resolveSupabaseConfig({
        urlEnv: "CUSTOM_SUPABASE_URL",
        anonKeyEnv: "CUSTOM_SUPABASE_ANON_KEY",
      })
    ).toEqual({ url: "https://custom.supabase.co", anonKey: "custom-key" });
  });

  it("prefers explicit url/anonKey over env vars", () => {
    expect(
      resolveSupabaseConfig({ url: "https://explicit.supabase.co", anonKey: "explicit" })
    ).toEqual({ url: "https://explicit.supabase.co", anonKey: "explicit" });
  });

  it("throws naming the missing variables", () => {
    delete process.env[URL_ENV];
    delete process.env[KEY_ENV];
    expect(() => resolveSupabaseConfig()).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL.*NEXT_PUBLIC_SUPABASE_ANON_KEY|NEXT_PUBLIC_SUPABASE_ANON_KEY.*NEXT_PUBLIC_SUPABASE_URL/
    );
  });

  it("throws naming only the missing variable", () => {
    delete process.env[KEY_ENV];
    expect(() => resolveSupabaseConfig()).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    expect(() => resolveSupabaseConfig()).not.toThrow(/NEXT_PUBLIC_SUPABASE_URL\./);
  });
});

describe("createBrowserSupabase", () => {
  it("creates a browser client with the default env vars", () => {
    const client = createBrowserSupabase();
    expect(h.createBrowserClient).toHaveBeenCalledWith(FAKE_URL, FAKE_KEY);
    expect(client).toMatchObject({ kind: "browser", url: FAKE_URL, key: FAKE_KEY });
  });

  it("honours custom env names", () => {
    process.env.CUSTOM_SUPABASE_URL = "https://custom.supabase.co";
    process.env.CUSTOM_SUPABASE_ANON_KEY = "custom-key";
    createBrowserSupabase({
      urlEnv: "CUSTOM_SUPABASE_URL",
      anonKeyEnv: "CUSTOM_SUPABASE_ANON_KEY",
    });
    expect(h.createBrowserClient).toHaveBeenCalledWith(
      "https://custom.supabase.co",
      "custom-key"
    );
  });

  it("throws when env vars are missing", () => {
    delete process.env[URL_ENV];
    expect(() => createBrowserSupabase()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(h.createBrowserClient).not.toHaveBeenCalled();
  });
});

describe("createServerSupabase", () => {
  it("creates a server client wired to the cookie store", async () => {
    const store = makeCookieStore([{ name: "sb-token", value: "abc" }]);
    const client = (await createServerSupabase(store)) as unknown as FakeServerClient;
    expect(h.createServerClient).toHaveBeenCalledWith(
      FAKE_URL,
      FAKE_KEY,
      expect.objectContaining({ cookies: expect.any(Object) })
    );
    expect(client.cookies.getAll()).toEqual([{ name: "sb-token", value: "abc" }]);
    expect(store.getAll).toHaveBeenCalled();
  });

  it("accepts a promise cookie store (Next 15 `cookies()`)", async () => {
    const store = makeCookieStore();
    const client = (await createServerSupabase(
      Promise.resolve(store)
    )) as unknown as FakeServerClient;
    client.cookies.getAll();
    expect(store.getAll).toHaveBeenCalled();
  });

  it("setAll writes every cookie to the store with its options", async () => {
    const store = makeCookieStore();
    const client = (await createServerSupabase(store)) as unknown as FakeServerClient;
    client.cookies.setAll([
      { name: "sb-a", value: "1", options: { path: "/", httpOnly: true } },
      { name: "sb-b", value: "2", options: { path: "/" } },
    ]);
    expect(store.set).toHaveBeenCalledTimes(2);
    expect(store.set).toHaveBeenNthCalledWith(1, "sb-a", "1", {
      path: "/",
      httpOnly: true,
    });
    expect(store.set).toHaveBeenNthCalledWith(2, "sb-b", "2", { path: "/" });
  });

  it("swallows store.set throws (read-only Server Component store)", async () => {
    const store = makeCookieStore();
    store.set.mockImplementation(() => {
      throw new Error("Cookies can only be modified in a Server Action or Route Handler");
    });
    const client = (await createServerSupabase(store)) as unknown as FakeServerClient;
    expect(() =>
      client.cookies.setAll([{ name: "sb-a", value: "1", options: {} }])
    ).not.toThrow();
  });

  it("does not disconnect realtime by default", async () => {
    await createServerSupabase(makeCookieStore());
    expect(h.disconnect).not.toHaveBeenCalled();
  });

  it("disconnects realtime when disconnectRealtime is set", async () => {
    await createServerSupabase(makeCookieStore(), { disconnectRealtime: true });
    expect(h.disconnect).toHaveBeenCalledTimes(1);
  });
});

/** Reset the shared next/server stub before exercising updateSession. */
function stubNextServer() {
  FakeNextResponse.reset();
}

function makeRequest(
  initial: { name: string; value: string }[] = []
): NextRequestLike & {
  cookies: {
    getAll: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
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

describe("updateSession", () => {
  it("returns the response and the current user", async () => {
    stubNextServer();
    const request = makeRequest([{ name: "sb-token", value: "abc" }]);
    const { response, user } = await updateSession(request);
    expect(user).toEqual(FAKE_USER);
    expect(h.getUser).toHaveBeenCalledTimes(1);
    expect(response).toBeInstanceOf(FakeNextResponse);
    // Initial response created from the request.
    expect(FakeNextResponse.instances[0]?.init).toEqual({ request });
  });

  it("reads cookies from the request", async () => {
    stubNextServer();
    const request = makeRequest([{ name: "sb-token", value: "abc" }]);
    await updateSession(request);
    const cookies = h.createServerClient.mock.calls[0]?.[2].cookies;
    expect(cookies.getAll()).toEqual([{ name: "sb-token", value: "abc" }]);
    expect(request.cookies.getAll).toHaveBeenCalled();
  });

  it("mirrors refreshed cookies onto request and a re-created response", async () => {
    stubNextServer();
    const request = makeRequest();
    await updateSession(request);
    const cookies = h.createServerClient.mock.calls[0]?.[2].cookies;

    const refreshed = [
      { name: "sb-access", value: "new-access", options: { path: "/", httpOnly: true } },
      { name: "sb-refresh", value: "new-refresh", options: { path: "/" } },
    ];
    cookies.setAll(refreshed);

    // 1. request cookies updated (downstream Server Components see them)
    expect(request.cookies.set).toHaveBeenCalledTimes(2);
    expect(request.cookies.set).toHaveBeenNthCalledWith(1, "sb-access", "new-access");
    expect(request.cookies.set).toHaveBeenNthCalledWith(2, "sb-refresh", "new-refresh");
    // 2. response re-created so it carries the mutated request
    expect(FakeNextResponse.instances).toHaveLength(2);
    const refreshedResponse = FakeNextResponse.instances[1]!;
    expect(refreshedResponse.init).toEqual({ request });
    // 3. refreshed cookies written to the new response with their options
    expect(refreshedResponse.cookies.set).toHaveBeenNthCalledWith(
      1,
      "sb-access",
      "new-access",
      { path: "/", httpOnly: true }
    );
    expect(refreshedResponse.cookies.set).toHaveBeenNthCalledWith(
      2,
      "sb-refresh",
      "new-refresh",
      { path: "/" }
    );
  });

  it("returns the re-created response after a cookie refresh", async () => {
    stubNextServer();
    const request = makeRequest();
    // Trigger setAll during getUser by making the mock call it.
    h.getUser.mockImplementation(async () => {
      const cookies = h.createServerClient.mock.calls[0]?.[2].cookies;
      cookies.setAll([{ name: "sb-access", value: "new", options: { path: "/" } }]);
      return { data: { user: FAKE_USER }, error: null };
    });
    const { response } = await updateSession(request);
    const res = response as FakeNextResponse;
    expect(res.cookies.set).toHaveBeenCalledWith("sb-access", "new", { path: "/" });
  });

  it("returns null user when no session exists", async () => {
    stubNextServer();
    h.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const { user } = await updateSession(makeRequest());
    expect(user).toBeNull();
  });

  it("disconnects realtime only when requested", async () => {
    stubNextServer();
    await updateSession(makeRequest());
    expect(h.disconnect).not.toHaveBeenCalled();
    await updateSession(makeRequest(), { disconnectRealtime: true });
    expect(h.disconnect).toHaveBeenCalledTimes(1);
  });

  it("throws when env vars are missing", async () => {
    stubNextServer();
    delete process.env[URL_ENV];
    await expect(updateSession(makeRequest())).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});
