/**
 * Unit tests for the coinpay module: merchant client, webhook verification,
 * OAuth helpers, and the Next.js route-handler factories. All network and
 * `next/server` access is mocked — no network, no Next runtime required.
 */

import Module from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import {
  COINPAY_DEFAULT_SCOPES,
  COINPAY_STATE_COOKIE,
  COINPAY_WEBHOOK_SIGNATURE_HEADER,
  CoinPayApiError,
  createCoinPayCallbackHandler,
  createCoinPayClient,
  createCoinPayLoginHandler,
  exchangeCoinPayCode,
  fetchCoinPayUserinfo,
  generateCoinPayPkcePair,
  generateCoinPayState,
  getCoinPayAuthorizeUrl,
  parseCoinPayWebhookEvent,
  signCoinPayWebhook,
  validateCoinPayState,
  verifyCoinPayWebhook,
} from "../src/coinpay/index";

/** Build a JSON Response like the CoinPay API would return. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Grab the (url, init) pair a fetch mock was called with. */
function callOf(mock: ReturnType<typeof vi.fn>, index = 0): [string, RequestInit] {
  return mock.mock.calls[index] as unknown as [string, RequestInit];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (loadersToRestore.length > 0) loadersToRestore.pop()?.();
});

// ─── createCoinPayClient ────────────────────────────────────────────────────

describe("createCoinPayClient", () => {
  it("requires an apiKey", () => {
    // @ts-expect-error — intentionally missing key
    expect(() => createCoinPayClient({})).toThrow(/apiKey/);
  });

  it("createCheckout posts to /api/payments/create and returns the hosted URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, payment: { id: "pay_123", status: "pending" } }),
    );
    const client = createCoinPayClient({ apiKey: "cp_live_x", fetch: fetchMock });

    const result = await client.createCheckout({
      amountUsd: 25,
      currency: "usdc_pol",
      description: "GoldVPN Plus — Monthly",
      metadata: { plan: "plus" },
      redirectUrl: "https://app.example/thanks",
      successUrl: "https://app.example/thanks",
      cancelUrl: "https://app.example/signup",
    });

    expect(result.paymentId).toBe("pay_123");
    expect(result.checkoutUrl).toBe("https://coinpayportal.com/pay/pay_123");

    const [url, init] = callOf(fetchMock);
    expect(url).toBe("https://coinpayportal.com/api/payments/create");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer cp_live_x");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["amount_usd"]).toBe(25);
    expect(body["currency"]).toBe("usdc_pol");
    expect(body["payment_method"]).toBe("both");
    expect(body["redirect_url"]).toBe("https://app.example/thanks");
    expect(body["success_url"]).toBe("https://app.example/thanks");
    expect(body["cancel_url"]).toBe("https://app.example/signup");
    expect(body["metadata"]).toEqual({ plan: "plus" });
  });

  it("normalizes baseUrl with trailing slash or /api suffix", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ success: true, payment: { id: "p1" } })),
      );
    for (const baseUrl of [
      "https://pay.example.com/",
      "https://pay.example.com/api",
      "https://pay.example.com/api/",
    ]) {
      const client = createCoinPayClient({ apiKey: "k", baseUrl, fetch: fetchMock });
      const r = await client.createCheckout({ amountUsd: 1, currency: "btc" });
      expect(r.checkoutUrl).toBe("https://pay.example.com/pay/p1");
    }
    const [url] = callOf(fetchMock, 2);
    expect(url).toBe("https://pay.example.com/api/payments/create");
  });

  it("prefers stripe_checkout_url when the API returns one (card leg)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        payment: { id: "p9", stripe_checkout_url: "https://checkout.stripe.com/cs_1" },
      }),
    );
    const client = createCoinPayClient({ apiKey: "k", fetch: fetchMock });
    const r = await client.createCheckout({ amountUsd: 5, currency: "usdc_pol" });
    expect(r.checkoutUrl).toBe("https://checkout.stripe.com/cs_1");
  });

  it("throws CoinPayApiError on non-OK responses, with the API detail", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: false, error: "invalid_currency" }, 400));
    const client = createCoinPayClient({ apiKey: "k", fetch: fetchMock });
    const err = await client
      .createCheckout({ amountUsd: 5, currency: "nope" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoinPayApiError);
    expect((err as CoinPayApiError).status).toBe(400);
    expect((err as CoinPayApiError).detail).toBe("invalid_currency");
    expect((err as CoinPayApiError).message).toContain("invalid_currency");
  });

  it("throws when a 200 response has success:false (goldvpn pattern)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: false, message: "no wallet" }, 200));
    const client = createCoinPayClient({ apiKey: "k", fetch: fetchMock });
    await expect(client.createCheckout({ amountUsd: 5, currency: "btc" })).rejects.toThrow(
      /no wallet/,
    );
  });

  it("throws when the response is missing payment.id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }, 200));
    const client = createCoinPayClient({ apiKey: "k", fetch: fetchMock });
    await expect(client.createCheckout({ amountUsd: 5, currency: "btc" })).rejects.toThrow(
      /missing payment\.id/,
    );
  });

  it("getCheckout fetches /api/payments/<id> and returns the status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, payment: { id: "pay_7", status: "confirmed" } }),
    );
    const client = createCoinPayClient({ apiKey: "k", fetch: fetchMock });
    const r = await client.getCheckout("pay_7");
    expect(r).toMatchObject({ paymentId: "pay_7", status: "confirmed" });
    const [url, init] = callOf(fetchMock);
    expect(url).toBe("https://coinpayportal.com/api/payments/pay_7");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
  });

  it("listCoins adds active_only=true by default and returns the tokens", async () => {
    const tokens = [
      { code: "btc", ticker: "BTC", name: "Bitcoin", has_wallet: true, is_active: true },
      { code: "usdc_pol", symbol: "USDC", name: "USDC (Polygon)", has_wallet: true },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, tokens }));
    const client = createCoinPayClient({ apiKey: "k", fetch: fetchMock });
    const coins = await client.listCoins();
    expect(coins).toHaveLength(2);
    expect(coins[0]?.code).toBe("btc");
    const [url] = callOf(fetchMock);
    expect(url).toBe("https://coinpayportal.com/api/tokens?active_only=true");
  });

  it("listCoins honors activeOnly:false and businessId, and tolerates missing tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }));
    const client = createCoinPayClient({ apiKey: "k", fetch: fetchMock });
    const coins = await client.listCoins({ activeOnly: false, businessId: "biz_1" });
    expect(coins).toEqual([]);
    const [url] = callOf(fetchMock);
    expect(url).toBe("https://coinpayportal.com/api/tokens?business_id=biz_1");
  });
});

// ─── verifyCoinPayWebhook ───────────────────────────────────────────────────

describe("verifyCoinPayWebhook", () => {
  const secret = "whsecret_test";
  const rawBody = JSON.stringify({ id: "evt_1", type: "payment.confirmed", data: {} });

  it("accepts a correctly signed payload", () => {
    const signature = signCoinPayWebhook({ rawBody, secret });
    expect(verifyCoinPayWebhook({ signature, rawBody, secret })).toBe(true);
  });

  it("rejects a wrong secret and a tampered body", () => {
    const signature = signCoinPayWebhook({ rawBody, secret });
    expect(verifyCoinPayWebhook({ signature, rawBody, secret: "whsecret_other" })).toBe(false);
    expect(
      verifyCoinPayWebhook({ signature, rawBody: rawBody.replace("evt_1", "evt_2"), secret }),
    ).toBe(false);
  });

  it("rejects stale and far-future timestamps (replay protection)", () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = signCoinPayWebhook({ rawBody, secret, timestamp: now - 301 });
    expect(verifyCoinPayWebhook({ signature: stale, rawBody, secret })).toBe(false);
    const future = signCoinPayWebhook({ rawBody, secret, timestamp: now + 301 });
    expect(verifyCoinPayWebhook({ signature: future, rawBody, secret })).toBe(false);
    // A custom tolerance admits the otherwise-stale timestamp.
    expect(
      verifyCoinPayWebhook({ signature: stale, rawBody, secret, toleranceSeconds: 600 }),
    ).toBe(true);
  });

  it("supports the explicit `now` override for deterministic checks", () => {
    const signature = signCoinPayWebhook({ rawBody, secret, timestamp: 1_700_000_000 });
    expect(verifyCoinPayWebhook({ signature, rawBody, secret, now: 1_700_000_100 })).toBe(true);
    expect(verifyCoinPayWebhook({ signature, rawBody, secret, now: 1_700_001_000 })).toBe(false);
  });

  it("accepts when any of several v1 values matches (secret rotation)", () => {
    const now = Math.floor(Date.now() / 1000);
    const good = createHmac("sha256", secret).update(`${now}.${rawBody}`).digest("hex");
    const signature = `t=${now},v1=${"0".repeat(64)},v1=${good}`;
    expect(verifyCoinPayWebhook({ signature, rawBody, secret })).toBe(true);
  });

  it("rejects malformed headers without throwing", () => {
    expect(verifyCoinPayWebhook({ signature: "garbage", rawBody, secret })).toBe(false);
    expect(verifyCoinPayWebhook({ signature: "t=abc,v1=zz", rawBody, secret })).toBe(false);
    expect(verifyCoinPayWebhook({ signature: "v1=abc", rawBody, secret })).toBe(false);
    expect(verifyCoinPayWebhook({ signature: "", rawBody, secret })).toBe(false);
    expect(verifyCoinPayWebhook({ signature: null, rawBody, secret })).toBe(false);
    expect(verifyCoinPayWebhook({ signature: undefined, rawBody, secret })).toBe(false);
  });

  it("verifies the exact goldvpn scheme: HMAC-SHA256(`${t}.${rawBody}`)", () => {
    const now = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", secret).update(`${now}.${rawBody}`).digest("hex");
    expect(
      verifyCoinPayWebhook({ signature: `t=${now},v1=${v1}`, rawBody, secret }),
    ).toBe(true);
  });

  it("exposes the conventional header name", () => {
    expect(COINPAY_WEBHOOK_SIGNATURE_HEADER).toBe("x-coinpay-signature");
  });
});

describe("parseCoinPayWebhookEvent", () => {
  it("parses a valid event", () => {
    const event = parseCoinPayWebhookEvent(
      JSON.stringify({
        id: "evt_1",
        type: "payment.confirmed",
        data: { payment_id: "pay_1", metadata: { plan: "plus" } },
      }),
    );
    expect(event.type).toBe("payment.confirmed");
    expect(event.data.payment_id).toBe("pay_1");
  });

  it("throws on invalid JSON, non-objects, and missing type", () => {
    expect(() => parseCoinPayWebhookEvent("not json")).toThrow(/not valid JSON/);
    expect(() => parseCoinPayWebhookEvent("[1,2]")).toThrow(/not an object/);
    expect(() => parseCoinPayWebhookEvent("{}")).toThrow(/missing a string `type`/);
  });
});

// ─── OAuth helpers ──────────────────────────────────────────────────────────

describe("getCoinPayAuthorizeUrl", () => {
  it("builds the authorize URL with required params and PKCE", () => {
    const u = new URL(
      getCoinPayAuthorizeUrl({
        clientId: "cid",
        redirectUri: "https://app.test/api/auth/coinpay/callback",
        state: "st8",
        codeChallenge: "chal",
      }),
    );
    expect(u.origin).toBe("https://coinpayportal.com");
    expect(u.pathname).toBe("/api/oauth/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.test/api/auth/coinpay/callback");
    expect(u.searchParams.get("scope")).toBe(COINPAY_DEFAULT_SCOPES);
    expect(u.searchParams.get("state")).toBe("st8");
    expect(u.searchParams.get("code_challenge")).toBe("chal");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("omits PKCE when no challenge is given, honors issuer + scopes overrides", () => {
    const u = new URL(
      getCoinPayAuthorizeUrl({
        clientId: "cid",
        redirectUri: "https://app.test/cb",
        state: "st8",
        issuer: "https://pay.selfhosted.example/",
        scopes: ["openid", "profile", "email", "did", "wallet:read"],
      }),
    );
    expect(u.origin).toBe("https://pay.selfhosted.example");
    expect(u.searchParams.get("code_challenge")).toBeNull();
    expect(u.searchParams.get("scope")).toBe("openid profile email did wallet:read");
  });
});

describe("generateCoinPayState / generateCoinPayPkcePair / validateCoinPayState", () => {
  it("generates distinct base64url state values", () => {
    const a = generateCoinPayState();
    const b = generateCoinPayState();
    expect(a).not.toBe(b);
    expect(/[+/=]/.test(a)).toBe(false);
  });

  it("produces a verifier and its S256 challenge", () => {
    const { codeVerifier, codeChallenge } = generateCoinPayPkcePair();
    expect(codeVerifier).toBeTruthy();
    expect(codeChallenge).not.toBe(codeVerifier);
    // challenge = base64url(sha256(verifier))
    const recomputed = createHash("sha256").update(codeVerifier).digest("base64");
    const asUrl = recomputed.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(codeChallenge).toBe(asUrl);
  });

  it("validates state constant-time style", () => {
    const s = generateCoinPayState();
    expect(validateCoinPayState(s, s)).toBe(true);
    expect(validateCoinPayState("aaaa", "bbbb")).toBe(false);
    expect(validateCoinPayState("abc", "abcd")).toBe(false);
    expect(validateCoinPayState("", "x")).toBe(false);
    expect(validateCoinPayState("x", null)).toBe(false);
    expect(validateCoinPayState(undefined, undefined)).toBe(false);
  });
});

describe("exchangeCoinPayCode", () => {
  it("posts the form-encoded grant and returns tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "at", refresh_token: "rt", id_token: "it" }),
    );
    const tokens = await exchangeCoinPayCode({
      code: "authcode",
      redirectUri: "https://app.test/cb",
      clientId: "cid",
      clientSecret: "secret",
      codeVerifier: "ver",
      fetch: fetchMock,
    });
    expect(tokens.access_token).toBe("at");
    const [url, init] = callOf(fetchMock);
    expect(url).toBe("https://coinpayportal.com/api/oauth/token");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = String(init.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=authcode");
    expect(body).toContain("client_secret=secret");
    expect(body).toContain("code_verifier=ver");
  });

  it("omits code_verifier when PKCE was not used, honors issuer override", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: "at" }));
    await exchangeCoinPayCode({
      code: "c",
      redirectUri: "r",
      clientId: "i",
      clientSecret: "s",
      issuer: "https://pay.selfhosted.example",
      fetch: fetchMock,
    });
    const [url, init] = callOf(fetchMock);
    expect(url).toBe("https://pay.selfhosted.example/api/oauth/token");
    expect(String(init.body)).not.toContain("code_verifier");
  });

  it("throws on non-OK and on a missing access_token", async () => {
    const bad = vi.fn().mockResolvedValue(jsonResponse({}, 400));
    await expect(
      exchangeCoinPayCode({ code: "c", redirectUri: "r", clientId: "i", clientSecret: "s", fetch: bad }),
    ).rejects.toThrow(/token exchange failed \(400\)/i);

    const empty = vi.fn().mockResolvedValue(jsonResponse({}));
    await expect(
      exchangeCoinPayCode({ code: "c", redirectUri: "r", clientId: "i", clientSecret: "s", fetch: empty }),
    ).rejects.toThrow(/missing access_token/i);
  });
});

describe("fetchCoinPayUserinfo", () => {
  it("sends the bearer token and returns claims", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ sub: "u1", email: "a@b.com", name: "Alice" }));
    const claims = await fetchCoinPayUserinfo({ accessToken: "at", fetch: fetchMock });
    expect(claims.email).toBe("a@b.com");
    const [url, init] = callOf(fetchMock);
    expect(url).toBe("https://coinpayportal.com/api/oauth/userinfo");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer at");
  });

  it("throws on non-OK and when neither sub nor email is present", async () => {
    const bad = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    await expect(fetchCoinPayUserinfo({ accessToken: "at", fetch: bad })).rejects.toThrow(
      /userinfo request failed \(401\)/i,
    );
    const empty = vi.fn().mockResolvedValue(jsonResponse({}));
    await expect(fetchCoinPayUserinfo({ accessToken: "at", fetch: empty })).rejects.toThrow(
      /missing sub\/email/i,
    );
  });
});

// ─── Next.js route handlers ─────────────────────────────────────────────────

type CookieSet = { name: string; value: string; options?: Record<string, unknown> };

/**
 * `createCoinPayLoginHandler` / `createCoinPayCallbackHandler` lazily call
 * `require("next/server")`. `next` is an optional peer and is not installed
 * here, and vitest injects a real createRequire-based `require` into
 * transformed src files — so patch Node's loader (`Module._load`, the same
 * approach as tests/referrals.test.ts) to resolve `next/server` to a stub.
 */
function stubNextServer() {
  const redirects: Array<{ target: string; cookieSets: CookieSet[] }> = [];
  const fakeNextServer = {
    NextResponse: {
      redirect(url: string | URL) {
        const target = String(url);
        const cookieSets: CookieSet[] = [];
        const res = new Response(null, { status: 302 });
        res.headers.set("location", target);
        const withCookies = res as Response & {
          cookies: { set(name: string, value: string, options?: Record<string, unknown>): void };
        };
        withCookies.cookies = {
          set(name: string, value: string, options?: Record<string, unknown>) {
            cookieSets.push({ name, value, options });
          },
        };
        redirects.push({ target, cookieSets });
        return withCookies;
      },
    },
  };

  const mod = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = mod._load;
  mod._load = function (this: unknown, ...args: unknown[]): unknown {
    if (args[0] === "next/server") return fakeNextServer;
    return original.apply(this, args);
  };
  loadersToRestore.push(() => {
    mod._load = original;
  });
  return { redirects };
}

const loadersToRestore: Array<() => void> = [];

/** A minimal structural NextRequest. */
function makeRequest(url: string, cookies: Record<string, string> = {}) {
  return {
    url,
    cookies: {
      get: (name: string) => (name in cookies ? { value: cookies[name] as string } : undefined),
    },
  };
}

describe("createCoinPayLoginHandler", () => {
  it("redirects to the authorize URL and sets the state cookie", async () => {
    const { redirects } = stubNextServer();
    const GET = createCoinPayLoginHandler({
      clientId: "cid",
      redirectUri: "https://app.test/api/auth/coinpay/callback",
    });
    const res = await GET(makeRequest("https://app.test/api/auth/coinpay/login"));
    expect(res.status).toBe(302);

    expect(redirects).toHaveLength(1);
    const target = new URL(redirects[0]!.target);
    expect(target.origin).toBe("https://coinpayportal.com");
    expect(target.pathname).toBe("/api/oauth/authorize");
    expect(target.searchParams.get("client_id")).toBe("cid");
    expect(target.searchParams.get("code_challenge")).toBeTruthy();
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");

    const cookieSets = redirects[0]!.cookieSets;
    expect(cookieSets).toHaveLength(1);
    const set = cookieSets[0]!;
    expect(set.name).toBe(COINPAY_STATE_COOKIE);
    expect(set.options).toMatchObject({ httpOnly: true, maxAge: 600, path: "/" });
    const payload = JSON.parse(set.value) as { state: string; codeVerifier: string };
    expect(payload.state).toBe(target.searchParams.get("state"));
    expect(payload.codeVerifier).toBeTruthy();
  });

  it("merges extraState (object or function) into the state cookie", async () => {
    const { redirects } = stubNextServer();
    const GET = createCoinPayLoginHandler({
      clientId: "cid",
      redirectUri: "https://app.test/cb",
      stateCookie: "my_state",
      extraState: (req) => ({ popup: new URL(req.url).searchParams.get("popup") === "1" }),
    });
    await GET(makeRequest("https://app.test/api/auth/coinpay/login?popup=1"));
    const set = redirects[0]!.cookieSets[0]!;
    expect(set.name).toBe("my_state");
    expect(JSON.parse(set.value)).toMatchObject({ popup: true });
  });
});

describe("createCoinPayCallbackHandler", () => {
  const baseOpts = {
    clientId: "cid",
    clientSecret: "secret",
    redirectUri: "https://app.test/api/auth/coinpay/callback",
  };
  const callbackUrl = "https://app.test/api/auth/coinpay/callback";

  it("redirects to the error target when the provider returns an error", async () => {
    const { redirects } = stubNextServer();
    const GET = createCoinPayCallbackHandler({ ...baseOpts, onSuccess: vi.fn() });
    await GET(makeRequest(`${callbackUrl}?error=access_denied`));
    expect(redirects[0]!.target).toBe("https://app.test/auth?error=coinpay_denied");
  });

  it("redirects with coinpay_missing_code when no code is present", async () => {
    const { redirects } = stubNextServer();
    const GET = createCoinPayCallbackHandler({ ...baseOpts, onSuccess: vi.fn() });
    await GET(makeRequest(callbackUrl));
    expect(redirects[0]!.target).toBe("https://app.test/auth?error=coinpay_missing_code");
  });

  it("redirects with coinpay_state_mismatch on bad or missing state", async () => {
    const { redirects } = stubNextServer();
    const GET = createCoinPayCallbackHandler({ ...baseOpts, onSuccess: vi.fn() });
    const cookie = JSON.stringify({ state: "stored", codeVerifier: "v" });
    await GET(
      makeRequest(`${callbackUrl}?code=abc&state=other`, { [COINPAY_STATE_COOKIE]: cookie }),
    );
    expect(redirects[0]!.target).toBe("https://app.test/auth?error=coinpay_state_mismatch");

    // No cookie at all → same failure.
    await GET(makeRequest(`${callbackUrl}?code=abc&state=stored`));
    expect(redirects[1]!.target).toBe("https://app.test/auth?error=coinpay_state_mismatch");
  });

  it("exchanges the code, fetches userinfo, and redirects via onSuccess", async () => {
    const { redirects } = stubNextServer();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "at", refresh_token: "rt" }))
      .mockResolvedValueOnce(jsonResponse({ sub: "u1", email: "a@b.com", name: "Alice" }));
    const onSuccess = vi.fn().mockResolvedValue("/chat");
    const GET = createCoinPayCallbackHandler({ ...baseOpts, fetch: fetchMock, onSuccess });

    const cookie = JSON.stringify({ state: "s1", codeVerifier: "v1", popup: true });
    const res = await GET(
      makeRequest(`${callbackUrl}?code=abc&state=s1`, { [COINPAY_STATE_COOKIE]: cookie }),
    );
    expect(res.status).toBe(302);
    expect(redirects[0]!.target).toBe("https://app.test/chat");

    // Token exchange carried the PKCE verifier + client secret.
    const [tokenUrl, tokenInit] = callOf(fetchMock, 0);
    expect(tokenUrl).toBe("https://coinpayportal.com/api/oauth/token");
    expect(String(tokenInit.body)).toContain("code_verifier=v1");
    expect(String(tokenInit.body)).toContain("client_secret=secret");
    expect(callOf(fetchMock, 1)[0]).toBe("https://coinpayportal.com/api/oauth/userinfo");

    // onSuccess got claims, tokens, and the parsed cookie payload.
    expect(onSuccess).toHaveBeenCalledOnce();
    const ctx = onSuccess.mock.calls[0]![0] as {
      claims: { email: string };
      tokens: { access_token: string };
      cookie: Record<string, unknown>;
    };
    expect(ctx.claims.email).toBe("a@b.com");
    expect(ctx.tokens.access_token).toBe("at");
    expect(ctx.cookie["popup"]).toBe(true);

    // The state cookie was consumed (cleared on the redirect response).
    const cleared = redirects[0]!.cookieSets.find((c) => c.name === COINPAY_STATE_COOKIE);
    expect(cleared?.options?.["maxAge"]).toBe(0);
  });

  it("redirects to successUrl when onSuccess returns void", async () => {
    const { redirects } = stubNextServer();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "at" }))
      .mockResolvedValueOnce(jsonResponse({ sub: "u1" }));
    const GET = createCoinPayCallbackHandler({
      ...baseOpts,
      fetch: fetchMock,
      successUrl: "https://app.test/dashboard",
      onSuccess: () => undefined,
    });
    const cookie = JSON.stringify({ state: "s1" });
    await GET(makeRequest(`${callbackUrl}?code=abc&state=s1`, { [COINPAY_STATE_COOKIE]: cookie }));
    expect(redirects[0]!.target).toBe("https://app.test/dashboard");
  });

  it("returns an onSuccess-provided Response as-is and clears the cookie on it", async () => {
    stubNextServer();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "at" }))
      .mockResolvedValueOnce(jsonResponse({ sub: "u1" }));
    const popup = new Response("<html>ok</html>", {
      headers: { "content-type": "text/html" },
    });
    const GET = createCoinPayCallbackHandler({
      ...baseOpts,
      fetch: fetchMock,
      onSuccess: () => popup,
    });
    const cookie = JSON.stringify({ state: "s1" });
    const res = await GET(
      makeRequest(`${callbackUrl}?code=abc&state=s1`, { [COINPAY_STATE_COOKIE]: cookie }),
    );
    expect(res).toBe(popup);
    expect(res.headers.get("set-cookie")).toContain(`${COINPAY_STATE_COOKIE}=;`);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("redirects with coinpay_login_failed when the exchange or onSuccess throws", async () => {
    const { redirects } = stubNextServer();
    const badExchange = vi.fn().mockResolvedValue(jsonResponse({}, 400));
    const GET = createCoinPayCallbackHandler({
      ...baseOpts,
      fetch: badExchange,
      onSuccess: vi.fn(),
    });
    const cookie = JSON.stringify({ state: "s1" });
    await GET(makeRequest(`${callbackUrl}?code=abc&state=s1`, { [COINPAY_STATE_COOKIE]: cookie }));
    expect(redirects[0]!.target).toBe("https://app.test/auth?error=coinpay_login_failed");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "at" }))
      .mockResolvedValueOnce(jsonResponse({ sub: "u1" }));
    const GET2 = createCoinPayCallbackHandler({
      ...baseOpts,
      fetch: fetchMock,
      onSuccess: () => {
        throw new Error("db down");
      },
    });
    await GET2(
      makeRequest(`${callbackUrl}?code=abc&state=s1`, { [COINPAY_STATE_COOKIE]: cookie }),
    );
    expect(redirects[1]!.target).toBe("https://app.test/auth?error=coinpay_login_failed");
  });

  it("honors a custom errorUrl template and an onError override", async () => {
    const { redirects } = stubNextServer();
    const GET = createCoinPayCallbackHandler({
      ...baseOpts,
      errorUrl: "https://app.test/login?err={code}",
      onSuccess: vi.fn(),
    });
    await GET(makeRequest(callbackUrl));
    expect(redirects[0]!.target).toBe("https://app.test/login?err=coinpay_missing_code");

    const GET2 = createCoinPayCallbackHandler({
      ...baseOpts,
      onSuccess: vi.fn(),
      onError: (code) => `/oops/${code}`,
    });
    await GET2(makeRequest(callbackUrl));
    expect(redirects[1]!.target).toBe("https://app.test/oops/coinpay_missing_code");
  });
});
