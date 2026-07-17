/**
 * CONTRACT TEST — @profullstack/stack/coinpay ↔ CoinPayPortal.
 *
 * Pins the client/webhook/oauth modules against the REAL upstream contracts,
 * read from the CoinPayPortal source (not from docs):
 *
 *   coinpayportal/src/app/api/payments/create/route.ts   (POST /api/payments/create)
 *   coinpayportal/src/app/api/payments/[id]/route.ts     (GET  /api/payments/<id>)
 *   coinpayportal/src/app/api/tokens/route.ts            (GET  /api/tokens)
 *   coinpayportal/src/app/api/oauth/authorize/route.ts   (GET  /api/oauth/authorize)
 *   coinpayportal/src/app/api/oauth/token/route.ts       (POST /api/oauth/token)
 *   coinpayportal/src/app/api/oauth/userinfo/route.ts    (GET  /api/oauth/userinfo)
 *   coinpayportal/src/lib/webhooks/service.ts            (X-CoinPay-Signature sender)
 *   coinpayportal/src/lib/wallets/supported-coins.ts     (token shape)
 *
 * All network is mocked; the expectations below are frozen snapshots of the
 * request/response shapes those handlers actually read and write. If a
 * refactor of src/coinpay drifts from the portal, these tests fail.
 */
import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  createCoinPayClient,
  CoinPayApiError,
  COINPAY_DEFAULT_BASE_URL,
  verifyCoinPayWebhook,
  signCoinPayWebhook,
  parseCoinPayWebhookEvent,
  COINPAY_WEBHOOK_SIGNATURE_HEADER,
  COINPAY_WEBHOOK_TOLERANCE_SECONDS,
  getCoinPayAuthorizeUrl,
  exchangeCoinPayCode,
  fetchCoinPayUserinfo,
  COINPAY_DEFAULT_ISSUER,
  COINPAY_DEFAULT_SCOPES,
  type CoinPayFetch,
} from "../../src/coinpay/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type RecordedCall = { url: string; init: RequestInit };

/** A CoinPayFetch stub that records calls and replays a canned response. */
function recordFetch(respond: (call: RecordedCall) => Response): {
  fetch: CoinPayFetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: CoinPayFetch = async (input, init) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  };
  return { fetch: fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const API_KEY = "cp_live_testkey123";

// ---------------------------------------------------------------------------
// POST /api/payments/create — createCheckout
// Route: coinpayportal/src/app/api/payments/create/route.ts
// ---------------------------------------------------------------------------

describe("createCheckout ↔ POST /api/payments/create", () => {
  it("POSTs to <root>/api/payments/create with Bearer auth and JSON content type", async () => {
    const { fetch, calls } = recordFetch(() =>
      json({ success: true, payment: { id: "pay_1" } }, 201),
    );
    const client = createCoinPayClient({ apiKey: API_KEY, fetch });
    await client.createCheckout({ amountUsd: 25, currency: "usdc_pol" });

    expect(calls).toHaveLength(1);
    // Default site root is the hosted portal; API lives under <root>/api.
    expect(COINPAY_DEFAULT_BASE_URL).toBe("https://coinpayportal.com");
    expect(calls[0]!.url).toBe("https://coinpayportal.com/api/payments/create");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    // The route reads the `authorization` header via authenticateRequest
    // (payments/create/route.ts:166); business API keys are Bearer tokens.
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends the exact snake_case field names the route destructures", async () => {
    const { fetch, calls } = recordFetch(() =>
      json({ success: true, payment: { id: "pay_1" } }, 201),
    );
    const client = createCoinPayClient({ apiKey: API_KEY, fetch });
    await client.createCheckout({
      amountUsd: 25,
      currency: "usdc_pol",
      paymentMethod: "card",
      description: "GoldVPN Plus — Monthly",
      metadata: { orderId: "ord_9" },
      redirectUrl: "https://app.example/thanks",
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
      webhookUrl: "https://app.example/api/webhooks/coinpay",
      businessId: "biz_1",
      expiresIn: 900,
    });

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    // Route body destructure (payments/create/route.ts:222-235):
    //   business_id, amount_usd, amount, currency, blockchain, description,
    //   metadata, redirect_url, payment_method, success_url, cancel_url,
    //   merchant_wallet_address
    // The route prefers amount_usd over amount (line 269) — the client must
    // send amount_usd, never amount.
    expect(body["amount_usd"]).toBe(25);
    expect(body).not.toHaveProperty("amount");
    expect(body["currency"]).toBe("usdc_pol");
    expect(body["payment_method"]).toBe("card"); // one of crypto|card|both (line 237)
    expect(body["description"]).toBe("GoldVPN Plus — Monthly");
    expect(body["metadata"]).toEqual({ orderId: "ord_9" });
    expect(body["redirect_url"]).toBe("https://app.example/thanks");
    expect(body["success_url"]).toBe("https://app.example/success");
    expect(body["cancel_url"]).toBe("https://app.example/cancel");
    expect(body["business_id"]).toBe("biz_1");
    // Sent by the client for forward compatibility. NOTE: the current portal
    // route does NOT destructure webhook_url or expires_in — they are silently
    // ignored server-side (verified against payments/create/route.ts:222-235).
    expect(body["webhook_url"]).toBe("https://app.example/api/webhooks/coinpay");
    expect(body["expires_in"]).toBe(900);
    // No camelCase keys may leak onto the wire.
    for (const key of Object.keys(body)) {
      expect(key, `wire key ${key} must be snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("defaults payment_method to 'both' so the route's 'crypto' default never applies", async () => {
    const { fetch, calls } = recordFetch(() =>
      json({ success: true, payment: { id: "pay_1" } }, 201),
    );
    const client = createCoinPayClient({ apiKey: API_KEY, fetch });
    await client.createCheckout({ amountUsd: 10, currency: "btc" });
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    // The route falls back to 'crypto' when payment_method is missing/invalid
    // (payments/create/route.ts:237-239); the client's contract is "both".
    expect(body["payment_method"]).toBe("both");
  });

  it("parses the route's 201 success envelope; prefers stripe_checkout_url", async () => {
    // Envelope shape from payments/create/route.ts:492-503 — status 201 with
    // { success: true, payment: {..., amount_usd, amount_crypto, currency,
    //   stripe_checkout_url?, stripe_session_id? }, usage: {...} }.
    const portalResponse = {
      success: true,
      payment: {
        id: "8f7b9c2d-aaaa-bbbb-cccc-ddddeeeeffff",
        status: "pending",
        amount: "25.00",
        amount_usd: "25.00",
        crypto_amount: "0.00042",
        amount_crypto: "0.00042",
        blockchain: "BTC",
        currency: "btc", // route lowercases the blockchain (line 485)
        payment_address: "bc1qexampleaddress",
        expires_at: "2026-01-01T00:15:00.000Z",
        stripe_checkout_url: "https://checkout.stripe.com/c/pay/cs_test_123",
        stripe_session_id: "cs_test_123",
        metadata: { orderId: "ord_9" },
      },
      usage: { current: 3, limit: 100, remaining: 97 },
    };
    const { fetch, calls } = recordFetch(() => json(portalResponse, 201));
    const client = createCoinPayClient({ apiKey: API_KEY, fetch });
    const result = await client.createCheckout({ amountUsd: 25, currency: "btc" });

    expect(calls).toHaveLength(1);
    expect(result.paymentId).toBe("8f7b9c2d-aaaa-bbbb-cccc-ddddeeeeffff");
    // Card rail wins when the portal returns a Stripe Checkout URL.
    expect(result.checkoutUrl).toBe("https://checkout.stripe.com/c/pay/cs_test_123");
    expect(result.payment).toEqual(portalResponse.payment);
  });

  it("falls back to checkout_url, then to the hosted <root>/pay/<id> page", async () => {
    const withCheckoutUrl = recordFetch(() =>
      json(
        { success: true, payment: { id: "pay_2", checkout_url: "https://coinpayportal.com/pay/pay_2" } },
        201,
      ),
    );
    const clientA = createCoinPayClient({ apiKey: API_KEY, fetch: withCheckoutUrl.fetch });
    const a = await clientA.createCheckout({ amountUsd: 5, currency: "eth" });
    expect(a.checkoutUrl).toBe("https://coinpayportal.com/pay/pay_2");

    const bare = recordFetch(() => json({ success: true, payment: { id: "pay_3" } }, 201));
    const clientB = createCoinPayClient({
      apiKey: API_KEY,
      baseUrl: "https://pay.example.com",
      fetch: bare.fetch,
    });
    const b = await clientB.createCheckout({ amountUsd: 5, currency: "eth" });
    expect(b.checkoutUrl).toBe("https://pay.example.com/pay/pay_3");
  });

  it("normalizes baseUrl with trailing slashes and a trailing /api", async () => {
    const { fetch, calls } = recordFetch(() =>
      json({ success: true, payment: { id: "pay_4" } }, 201),
    );
    const client = createCoinPayClient({
      apiKey: API_KEY,
      baseUrl: "https://pay.example.com/api/",
      fetch,
    });
    const result = await client.createCheckout({ amountUsd: 1, currency: "sol" });
    expect(calls[0]!.url).toBe("https://pay.example.com/api/payments/create");
    expect(result.checkoutUrl).toBe("https://pay.example.com/pay/pay_4");
  });

  it("maps the route's { success: false, error } envelope to CoinPayApiError", async () => {
    // Failure envelope (payments/create/route.ts:270-275 and siblings):
    // { success: false, error: '...' } with a 4xx/5xx status.
    const { fetch } = recordFetch(() =>
      json({ success: false, error: "Invalid or missing payment amount" }, 400),
    );
    const client = createCoinPayClient({ apiKey: API_KEY, fetch });
    const err = await client
      .createCheckout({ amountUsd: 0, currency: "btc" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoinPayApiError);
    const apiErr = err as CoinPayApiError;
    expect(apiErr.status).toBe(400);
    expect(apiErr.detail).toBe("Invalid or missing payment amount");
    expect(apiErr.message).toContain("Invalid or missing payment amount");
  });

  it("throws when the success envelope is missing payment.id", async () => {
    const { fetch } = recordFetch(() => json({ success: true, payment: {} }, 201));
    const client = createCoinPayClient({ apiKey: API_KEY, fetch });
    await expect(
      client.createCheckout({ amountUsd: 1, currency: "btc" }),
    ).rejects.toThrow(/missing payment\.id/);
  });

  it("treats a 2xx body with success:false as an error (portal envelope convention)", async () => {
    const { fetch } = recordFetch(() => json({ success: false, error: "weird" }, 200));
    const client = createCoinPayClient({ apiKey: API_KEY, fetch });
    await expect(
      client.createCheckout({ amountUsd: 1, currency: "btc" }),
    ).rejects.toThrow(CoinPayApiError);
  });
});

// ---------------------------------------------------------------------------
// GET /api/payments/<id> — getCheckout
// Route: coinpayportal/src/app/api/payments/[id]/route.ts
// ---------------------------------------------------------------------------

describe("getCheckout ↔ GET /api/payments/<id>", () => {
  it("GETs the payment with Bearer auth and parses { success, payment }", async () => {
    // Route returns { success: true, payment } with status 200
    // (payments/[id]/route.ts:36-39).
    const portalPayment = {
      id: "pay_123",
      status: "confirmed",
      amount: "25.00",
      amount_usd: "25.00",
      currency: "btc",
      tx_hash: "deadbeef",
    };
    const { fetch, calls } = recordFetch(() => json({ success: true, payment: portalPayment }));
    const client = createCoinPayClient({ apiKey: API_KEY, fetch });
    const result = await client.getCheckout("pay_123");

    expect(calls[0]!.url).toBe("https://coinpayportal.com/api/payments/pay_123");
    expect(calls[0]!.init.method ?? "GET").toBe("GET");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(result).toEqual({ paymentId: "pay_123", status: "confirmed", payment: portalPayment });
  });

  it("URL-encodes the payment id path segment", async () => {
    const { fetch, calls } = recordFetch(() =>
      json({ success: true, payment: { id: "pay/x y", status: "pending" } }),
    );
    const client = createCoinPayClient({ apiKey: API_KEY, fetch });
    await client.getCheckout("pay/x y");
    expect(calls[0]!.url).toBe("https://coinpayportal.com/api/payments/pay%2Fx%20y");
  });

  it("defaults status to 'pending' when the payment object omits it", async () => {
    const { fetch } = recordFetch(() => json({ success: true, payment: { id: "pay_1" } }));
    const client = createCoinPayClient({ apiKey: API_KEY, fetch });
    const result = await client.getCheckout("pay_1");
    expect(result.status).toBe("pending");
  });

  it("maps the route's 404 envelope to CoinPayApiError", async () => {
    // Unknown payment → 404 { success: false, error } (payments/[id]/route.ts:29-34).
    const { fetch } = recordFetch(() => json({ success: false, error: "Payment not found" }, 404));
    const client = createCoinPayClient({ apiKey: API_KEY, fetch });
    const err = await client.getCheckout("nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoinPayApiError);
    expect((err as CoinPayApiError).status).toBe(404);
    expect((err as CoinPayApiError).detail).toBe("Payment not found");
  });
});

// ---------------------------------------------------------------------------
// GET /api/tokens — listCoins
// Route: coinpayportal/src/app/api/tokens/route.ts
// Shape: coinpayportal/src/lib/wallets/supported-coins.ts (SupportedToken)
// ---------------------------------------------------------------------------

describe("listCoins ↔ GET /api/tokens", () => {
  it("sends active_only=true by default (the query flag the route reads)", async () => {
    // Route reads searchParams active_only === 'true' and business_id
    // (tokens/route.ts:42-44).
    const { fetch, calls } = recordFetch(() =>
      json({ success: true, tokens: [], coins: [], business_id: "biz_1", merchant_id: "m_1", total: 0 }),
    );
    const client = createCoinPayClient({ apiKey: API_KEY, fetch });
    await client.listCoins();
    expect(calls[0]!.url).toBe("https://coinpayportal.com/api/tokens?active_only=true");
  });

  it("omits active_only when activeOnly is false and passes business_id", async () => {
    const { fetch, calls } = recordFetch(() =>
      json({ success: true, tokens: [], coins: [], total: 0 }),
    );
    const client = createCoinPayClient({ apiKey: API_KEY, fetch });
    await client.listCoins({ activeOnly: false, businessId: "biz_1" });
    expect(calls[0]!.url).toBe("https://coinpayportal.com/api/tokens?business_id=biz_1");
  });

  it("returns the tokens array in the route's SupportedToken shape", async () => {
    // Shape from supported-coins.ts:42-96 — SupportedCoin fields plus
    // code (symbol.toLowerCase()), ticker, chain.
    const portalTokens = [
      {
        symbol: "USDC_POL",
        name: "USD Coin (Polygon)",
        is_active: true,
        has_wallet: true,
        wallet_source: "business",
        code: "usdc_pol",
        ticker: "USDC",
        chain: "Polygon",
      },
      {
        symbol: "BTC",
        name: "Bitcoin",
        is_active: true,
        has_wallet: true,
        wallet_source: "merchant",
        code: "btc",
        ticker: "BTC",
        chain: undefined,
      },
    ];
    const { fetch } = recordFetch(() =>
      json({
        success: true,
        tokens: portalTokens,
        coins: portalTokens,
        business_id: "biz_1",
        merchant_id: "m_1",
        total: 2,
      }),
    );
    const client = createCoinPayClient({ apiKey: API_KEY, fetch });
    const coins = await client.listCoins();
    expect(coins).toHaveLength(2);
    expect(coins[0]).toMatchObject({ code: "usdc_pol", ticker: "USDC", has_wallet: true });
    expect(coins[1]).toMatchObject({ code: "btc" });
  });

  it("returns [] when the envelope carries no tokens array", async () => {
    const { fetch } = recordFetch(() => json({ success: true }));
    const client = createCoinPayClient({ apiKey: API_KEY, fetch });
    await expect(client.listCoins()).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Webhooks — X-CoinPay-Signature
// Sender: coinpayportal/src/lib/webhooks/service.ts
//   signWebhookPayload  (lines 133-147)
//   deliverWebhookDirect headers (lines 328-336)
//   sendPaymentWebhook payload    (lines 507-531)
// ---------------------------------------------------------------------------

/**
 * EXACT reimplementation of the portal's signer
 * (coinpayportal/src/lib/webhooks/service.ts:133-147):
 *
 *   const ts = timestamp ?? Math.floor(Date.now() / 1000);
 *   const payloadString = JSON.stringify(payload);
 *   const signedPayload = `${ts}.${payloadString}`;
 *   const signature = createHmac('sha256', secret).update(signedPayload).digest('hex');
 *   return `t=${ts},v1=${signature}`;
 *
 * The delivered body is exactly `payloadString` (deliverWebhookDirect posts
 * the pre-computed string it signed — service.ts:533-548).
 */
function portalSign(
  payload: Record<string, unknown>,
  secret: string,
  timestamp?: number,
): { header: string; rawBody: string; ts: number } {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify(payload);
  const v1 = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  return { header: `t=${ts},v1=${v1}`, rawBody, ts };
}

/**
 * EXACT reimplementation of the portal's verifier
 * (coinpayportal/src/lib/webhooks/service.ts:155-204) — used to cross-check
 * that the stack's own signer is portal-compatible.
 */
function portalVerify(
  payload: Record<string, unknown>,
  signature: string,
  secret: string,
  tolerance = 300,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const parts: Record<string, string> = {};
  for (const part of signature.split(",")) {
    const idx = part.indexOf("=");
    if (idx > 0) parts[part.slice(0, idx)] = part.slice(idx + 1);
  }
  const timestamp = parts["t"];
  const receivedSig = parts["v1"];
  if (!timestamp || !receivedSig) return false;
  if (Math.abs(now - parseInt(timestamp, 10)) > tolerance) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${JSON.stringify(payload)}`)
    .digest("hex");
  return expected === receivedSig;
}

/** Payload builder mirroring sendPaymentWebhook (service.ts:507-531). */
function portalPaymentEvent(
  paymentId: string,
  businessId: string,
  type: string,
  paymentData: Record<string, unknown>,
  ts: number,
): Record<string, unknown> {
  return {
    id: `evt_${paymentId}_${ts}`,
    type,
    data: {
      payment_id: paymentId,
      status: paymentData["status"],
      amount_crypto: paymentData["amount_crypto"],
      amount_usd: paymentData["amount_usd"],
      currency: paymentData["currency"],
      ...(paymentData["metadata"] ? { metadata: paymentData["metadata"] } : {}),
    },
    created_at: new Date(ts * 1000).toISOString(),
    business_id: businessId,
  };
}

describe("verifyCoinPayWebhook ↔ portal signWebhookPayload", () => {
  const SECRET = "whsecret_test_123456";
  const NOW = 1_800_000_000;

  it("accepts a delivery signed exactly the way the portal signs it", () => {
    const payload = portalPaymentEvent("pay_1", "biz_1", "payment.confirmed", {
      status: "confirmed",
      amount_crypto: "0.00042",
      amount_usd: "25.00",
      currency: "btc",
      metadata: { orderId: "ord_9" },
    }, NOW);
    const { header, rawBody, ts } = portalSign(payload, SECRET);

    expect(
      verifyCoinPayWebhook({ signature: header, rawBody, secret: SECRET, now: ts }),
    ).toBe(true);
    // Sanity: the header format matches the portal's documented wire format.
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(COINPAY_WEBHOOK_SIGNATURE_HEADER).toBe("x-coinpay-signature");
    expect(COINPAY_WEBHOOK_TOLERANCE_SECONDS).toBe(300); // portal default (service.ts:159)
  });

  it("rejects a signature computed with the wrong secret", () => {
    const payload = { type: "payment.confirmed", data: { payment_id: "pay_1" } };
    const { header, rawBody, ts } = portalSign(payload, "whsecret_other", NOW);
    expect(
      verifyCoinPayWebhook({ signature: header, rawBody, secret: SECRET, now: ts }),
    ).toBe(false);
  });

  it("rejects a stale timestamp beyond the 300s tolerance", () => {
    const payload = { type: "payment.expired", data: { payment_id: "pay_1" } };
    const { header, rawBody, ts } = portalSign(payload, SECRET, NOW - 301);
    expect(
      verifyCoinPayWebhook({ signature: header, rawBody, secret: SECRET, now: NOW }),
    ).toBe(false);
    // Edge: exactly at the tolerance boundary the portal accepts
    // (Math.abs(now - ts) > tolerance → reject).
    const atBoundary = portalSign(payload, SECRET, NOW - 300);
    expect(
      verifyCoinPayWebhook({
        signature: atBoundary.header,
        rawBody: atBoundary.rawBody,
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("rejects a timestamp too far in the future (clock-skew replay guard)", () => {
    const payload = { type: "payment.confirmed", data: { payment_id: "pay_1" } };
    const { header, rawBody } = portalSign(payload, SECRET, NOW + 301);
    expect(
      verifyCoinPayWebhook({ signature: header, rawBody, secret: SECRET, now: NOW }),
    ).toBe(false);
  });

  it("rejects a tampered body (signature no longer matches the raw bytes)", () => {
    const payload = portalPaymentEvent("pay_1", "biz_1", "payment.confirmed", {
      status: "confirmed",
      amount_usd: "25.00",
      currency: "btc",
    }, NOW);
    const { header, rawBody, ts } = portalSign(payload, SECRET);
    const tampered = rawBody.replace("25.00", "2500.00");
    expect(tampered).not.toBe(rawBody);
    expect(
      verifyCoinPayWebhook({ signature: header, rawBody: tampered, secret: SECRET, now: ts }),
    ).toBe(false);
  });

  it("rejects malformed headers (missing t, missing v1, garbage)", () => {
    const rawBody = JSON.stringify({ type: "payment.confirmed", data: {} });
    const base = { rawBody, secret: SECRET, now: NOW };
    expect(verifyCoinPayWebhook({ ...base, signature: `v1=${"a".repeat(64)}` })).toBe(false);
    expect(verifyCoinPayWebhook({ ...base, signature: `t=${NOW}` })).toBe(false);
    expect(verifyCoinPayWebhook({ ...base, signature: "not-a-signature" })).toBe(false);
    expect(verifyCoinPayWebhook({ ...base, signature: null })).toBe(false);
    expect(verifyCoinPayWebhook({ ...base, signature: undefined })).toBe(false);
  });

  it("accepts when any v1 candidate matches (portal secret rotation)", () => {
    const payload = { type: "payment.confirmed", data: { payment_id: "pay_1" } };
    const { rawBody, ts } = portalSign(payload, SECRET, NOW);
    const good = createHmac("sha256", SECRET).update(`${ts}.${rawBody}`).digest("hex");
    const stale = createHmac("sha256", "whsecret_old").update(`${ts}.${rawBody}`).digest("hex");
    const header = `t=${ts},v1=${stale},v1=${good}`;
    expect(verifyCoinPayWebhook({ signature: header, rawBody, secret: SECRET, now: ts })).toBe(true);
  });

  it("stack's own signCoinPayWebhook is accepted by the portal's verifier", () => {
    // Cross-check the other direction: a test/dev harness using the stack's
    // signer produces headers the portal's verifyWebhookSignature accepts.
    const payload = portalPaymentEvent("pay_2", "biz_1", "payment.expired", {
      status: "expired",
      amount_usd: "10.00",
      currency: "eth",
    }, NOW);
    const rawBody = JSON.stringify(payload);
    const header = signCoinPayWebhook({ rawBody, secret: SECRET, timestamp: NOW });
    expect(portalVerify(payload, header, SECRET, 300, NOW)).toBe(true);
  });

  it("parses the portal's SDK-compliant event payload", () => {
    // Shape from sendPaymentWebhook (service.ts:507-531):
    // { id: evt_<paymentId>_<ts>, type, data: {...}, created_at, business_id }.
    const payload = portalPaymentEvent("pay_1", "biz_1", "payment.confirmed", {
      status: "confirmed",
      amount_crypto: "0.00042",
      amount_usd: "25.00",
      currency: "btc",
      metadata: { orderId: "ord_9" },
    }, NOW);
    const { rawBody } = portalSign(payload, SECRET, NOW);
    const event = parseCoinPayWebhookEvent(rawBody);
    expect(event.id).toBe(`evt_pay_1_${NOW}`);
    expect(event.type).toBe("payment.confirmed");
    expect(event.business_id).toBe("biz_1");
    expect(event.created_at).toBe(new Date(NOW * 1000).toISOString());
    expect(event.data).toMatchObject({
      payment_id: "pay_1",
      status: "confirmed",
      amount_usd: "25.00",
      currency: "btc",
      metadata: { orderId: "ord_9" },
    });
  });
});

// ---------------------------------------------------------------------------
// OAuth2/OIDC — "Log in with CoinPay"
// Routes: coinpayportal/src/app/api/oauth/{authorize,token,userinfo}/route.ts
// ---------------------------------------------------------------------------

describe("getCoinPayAuthorizeUrl ↔ GET /api/oauth/authorize", () => {
  it("builds the authorize URL with the exact params the route reads", () => {
    // Route reads: response_type (must be 'code'), client_id, redirect_uri,
    // scope, state, code_challenge, code_challenge_method, nonce
    // (oauth/authorize/route.ts:79-87).
    const url = new URL(
      getCoinPayAuthorizeUrl({
        clientId: "cp_client_1",
        redirectUri: "https://app.example/api/auth/coinpay/callback",
        state: "state-abc",
      }),
    );
    expect(COINPAY_DEFAULT_ISSUER).toBe("https://coinpayportal.com");
    expect(url.origin).toBe("https://coinpayportal.com");
    expect(url.pathname).toBe("/api/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cp_client_1");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example/api/auth/coinpay/callback",
    );
    expect(url.searchParams.get("scope")).toBe(COINPAY_DEFAULT_SCOPES);
    expect(COINPAY_DEFAULT_SCOPES).toBe("openid profile email");
    expect(url.searchParams.get("state")).toBe("state-abc");
  });

  it("appends PKCE params as code_challenge + code_challenge_method=S256", () => {
    const url = new URL(
      getCoinPayAuthorizeUrl({
        clientId: "cp_client_1",
        redirectUri: "https://app.example/cb",
        state: "s",
        codeChallenge: "challenge-xyz",
        scopes: ["openid", "email"],
      }),
    );
    expect(url.searchParams.get("code_challenge")).toBe("challenge-xyz");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid email");
  });

  it("honours an issuer override (self-hosted portal)", () => {
    const url = new URL(
      getCoinPayAuthorizeUrl({
        clientId: "c",
        redirectUri: "https://app.example/cb",
        state: "s",
        issuer: "https://pay.example.com/",
      }),
    );
    expect(url.origin).toBe("https://pay.example.com");
    expect(url.pathname).toBe("/api/oauth/authorize");
  });
});

describe("exchangeCoinPayCode ↔ POST /api/oauth/token", () => {
  it("POSTs form-encoded grant params the route parses", async () => {
    // The route's parseBody handles application/x-www-form-urlencoded
    // (oauth/token/route.ts:22-41) and reads grant_type, code, redirect_uri,
    // client_id, client_secret, code_verifier (line 100).
    const { fetch, calls } = recordFetch(() =>
      json({
        access_token: "at_123",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "rt_456",
        scope: "openid profile email",
        id_token: "idjwt",
      }),
    );
    const tokens = await exchangeCoinPayCode({
      code: "code_abc",
      redirectUri: "https://app.example/cb",
      clientId: "cp_client_1",
      clientSecret: "cp_secret_1",
      codeVerifier: "verifier-1",
      fetch,
    });

    expect(calls[0]!.url).toBe("https://coinpayportal.com/api/oauth/token");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(String(calls[0]!.init.body));
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("code_abc");
    expect(params.get("redirect_uri")).toBe("https://app.example/cb");
    expect(params.get("client_id")).toBe("cp_client_1");
    expect(params.get("client_secret")).toBe("cp_secret_1");
    expect(params.get("code_verifier")).toBe("verifier-1");

    // Success envelope (oauth/token/route.ts:206-216).
    expect(tokens).toMatchObject({
      access_token: "at_123",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rt_456",
      scope: "openid profile email",
      id_token: "idjwt",
    });
  });

  it("omits code_verifier when no PKCE challenge was sent", async () => {
    const { fetch, calls } = recordFetch(() => json({ access_token: "at_1" }));
    await exchangeCoinPayCode({
      code: "c",
      redirectUri: "https://app.example/cb",
      clientId: "id",
      clientSecret: "secret",
      fetch,
    });
    const params = new URLSearchParams(String(calls[0]!.init.body));
    expect(params.has("code_verifier")).toBe(false);
  });

  it("throws on the route's RFC 6749 error envelope", async () => {
    // Error shape: { error, error_description } (oauth/token/route.ts:43-51).
    const { fetch } = recordFetch(() =>
      json({ error: "invalid_grant", error_description: "Invalid authorization code" }, 400),
    );
    await expect(
      exchangeCoinPayCode({
        code: "bad",
        redirectUri: "https://app.example/cb",
        clientId: "id",
        clientSecret: "secret",
        fetch,
      }),
    ).rejects.toThrow(/400/);
  });

  it("throws when the token response lacks access_token", async () => {
    const { fetch } = recordFetch(() => json({ token_type: "Bearer" }));
    await expect(
      exchangeCoinPayCode({
        code: "c",
        redirectUri: "https://app.example/cb",
        clientId: "id",
        clientSecret: "secret",
        fetch,
      }),
    ).rejects.toThrow(/missing access_token/);
  });
});

describe("fetchCoinPayUserinfo ↔ GET /api/oauth/userinfo", () => {
  it("sends the Bearer token and returns the route's claims", async () => {
    // Route: Bearer auth (oauth/userinfo/route.ts:17-25); claims built at
    // lines 48-62 — sub always, name/updated_at for profile scope,
    // email/email_verified for email scope.
    const portalClaims = {
      sub: "merchant-uuid-1",
      name: "Ada Lovelace",
      updated_at: 1_799_000_000,
      email: "ada@example.com",
      email_verified: true,
    };
    const { fetch, calls } = recordFetch(() => json(portalClaims));
    const claims = await fetchCoinPayUserinfo({ accessToken: "at_123", fetch });

    expect(calls[0]!.url).toBe("https://coinpayportal.com/api/oauth/userinfo");
    expect(calls[0]!.init.method ?? "GET").toBe("GET");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer at_123");
    expect(claims).toEqual(portalClaims);
  });

  it("throws on the route's 401 invalid_token envelope", async () => {
    const { fetch } = recordFetch(() =>
      json({ error: "invalid_token", error_description: "Token expired" }, 401),
    );
    await expect(fetchCoinPayUserinfo({ accessToken: "dead", fetch })).rejects.toThrow(/401/);
  });

  it("throws when claims carry neither sub nor email", async () => {
    const { fetch } = recordFetch(() => json({ name: "no-identity" }));
    await expect(fetchCoinPayUserinfo({ accessToken: "at", fetch })).rejects.toThrow(
      /missing sub\/email/,
    );
  });
});
