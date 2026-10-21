/**
 * Checkout sessions (POST/GET /api/checkout/sessions) and the webhook
 * summary helper. Wire shapes follow coinpayportal PR #494:
 *   src/app/api/checkout/sessions/route.ts, src/lib/checkout/sessions.ts,
 *   src/lib/checkout/customer.ts (webhookCustomerFields), src/lib/paypal/settle.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CoinPayApiError,
  createCoinPayClient,
  readCoinPayWebhook,
  signCoinPayWebhook,
  verifyAndReadCoinPayWebhook,
} from "../src/coinpay/index";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const created = {
  success: true,
  id: "cs_abcdefghijklmnopqrstuvwx",
  url: "https://coinpayportal.com/checkout/cs_abcdefghijklmnopqrstuvwx",
  status: "open",
  amount: 299,
  currency: "USD",
  customer_email: "buyer@example.com",
  account_id: "user_1",
  property: "profullstack.com",
  expires_at: "2026-10-21T13:00:00.000Z",
  methods: ["BTC", "ETH", "USDC_POL", "PAYPAL"],
};

describe("createCheckout -> POST /api/checkout/sessions", () => {
  it("sends the session contract and returns the hosted URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(created, 201));
    const client = createCoinPayClient({ apiKey: "cp_live_x", fetch: fetchMock });
    const r = await client.createCheckout({
      amountUsd: 299,
      customerEmail: "buyer@example.com",
      accountId: "user_1",
      property: "profullstack.com",
      description: "Power Key",
      metadata: { sku: "power-key" },
      successUrl: "https://profullstack.com/shop/success?session={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://profullstack.com/shop",
    });
    expect(r.sessionId).toBe(created.id);
    expect(r.checkoutUrl).toBe(created.url);
    expect(r.methods).toEqual(["BTC", "ETH", "USDC_POL", "PAYPAL"]);
    expect(r.expiresAt).toBe(created.expires_at);
    expect(r.session).not.toHaveProperty("success");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://coinpayportal.com/api/checkout/sessions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer cp_live_x");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      amount: 299,
      currency: "USD",
      customer_email: "buyer@example.com",
      account_id: "user_1",
      property: "profullstack.com",
      description: "Power Key",
      metadata: { sku: "power-key" },
      success_url: "https://profullstack.com/shop/success?session={CHECKOUT_SESSION_ID}",
      cancel_url: "https://profullstack.com/shop",
      expires_in_minutes: 60,
    });
  });

  it("passes allowed_methods, expires_in_minutes and business_id through", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(created, 201));
    const client = createCoinPayClient({ apiKey: "k", fetch: fetchMock });
    await client.createCheckout({
      amountUsd: 5,
      customerEmail: "a@b.co",
      accountId: "a@b.co",
      property: "c0upons.com",
      allowedMethods: ["CRYPTO"],
      expiresInMinutes: 30,
      businessId: "biz_1",
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.allowed_methods).toEqual(["CRYPTO"]);
    expect(body.expires_in_minutes).toBe(30);
    expect(body.business_id).toBe("biz_1");
  });

  it("falls back to <root>/checkout/<id> when url is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ success: true, id: "cs_1234567890abcdef" }, 201));
    const client = createCoinPayClient({ apiKey: "k", baseUrl: "https://pay.example/api/", fetch: fetchMock });
    const r = await client.createCheckout({ amountUsd: 1, customerEmail: "a@b.co", accountId: "1", property: "x.dev" });
    expect(r.checkoutUrl).toBe("https://pay.example/checkout/cs_1234567890abcdef");
    expect(r.methods).toEqual([]);
  });

  it.each([
    [{ customerEmail: "" }, "MISSING_CUSTOMER_EMAIL"],
    [{ accountId: "" }, "MISSING_ACCOUNT_ID"],
    [{ property: " " }, "MISSING_PROPERTY"],
  ])("rejects %o before any request (%s)", async (override, code) => {
    const fetchMock = vi.fn();
    const client = createCoinPayClient({ apiKey: "k", fetch: fetchMock });
    const err = await client
      .createCheckout({ amountUsd: 1, customerEmail: "a@b.co", accountId: "1", property: "x.dev", ...override })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoinPayApiError);
    expect((err as CoinPayApiError).detail).toBe(code);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces portal 400s (NO_PAYMENT_METHODS) as CoinPayApiError", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ success: false, error: "No payment method is available", code: "NO_PAYMENT_METHODS" }, 400));
    const client = createCoinPayClient({ apiKey: "k", fetch: fetchMock });
    await expect(
      client.createCheckout({ amountUsd: 1, customerEmail: "a@b.co", accountId: "1", property: "x.dev" }),
    ).rejects.toMatchObject({ status: 400, detail: "No payment method is available" });
  });
});

describe("getCheckout -> GET /api/checkout/sessions/<id>", () => {
  it("returns status, paid and the payment references", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        success: true,
        session: { id: "cs_1", object: "checkout.session", status: "paid", payment_id: "pay_9", paypal_transaction_id: null },
      }),
    );
    const client = createCoinPayClient({ apiKey: "k", fetch: fetchMock });
    const r = await client.getCheckout("cs_1");
    expect(r).toMatchObject({ sessionId: "cs_1", status: "paid", paid: true, paymentId: "pay_9", paypalTransactionId: null });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("https://coinpayportal.com/api/checkout/sessions/cs_1");
  });

  it("an open session is not paid", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ success: true, session: { id: "cs_2", status: "open" } }));
    const r = await createCoinPayClient({ apiKey: "k", fetch: fetchMock }).getCheckout("cs_2");
    expect(r.paid).toBe(false);
    expect(r.paymentId).toBeNull();
  });
});

describe("readCoinPayWebhook", () => {
  const cryptoEvent = {
    id: "evt_pay_1_1700000000",
    type: "payment.confirmed",
    data: {
      payment_id: "pay_1",
      status: "confirmed",
      amount: 25,
      amount_usd: 25,
      currency: "USDC_POL",
      checkout_session_id: "cs_abc",
      customer_email: "buyer@example.com",
      account_id: "user_1",
      property: "c0upons.com",
      metadata: { bounty_id: "b1", checkout_session_id: "cs_abc" },
    },
    created_at: "2026-10-21T12:00:00Z",
    business_id: "biz_1",
  };

  it("reads the nested shape and never uses the event id as the payment id", () => {
    const s = readCoinPayWebhook(JSON.stringify(cryptoEvent));
    expect(s).toMatchObject({
      eventId: "evt_pay_1_1700000000",
      type: "payment.confirmed",
      paymentId: "pay_1",
      status: "confirmed",
      paid: true,
      checkoutSessionId: "cs_abc",
      customerEmail: "buyer@example.com",
      accountId: "user_1",
      property: "c0upons.com",
      amountUsd: 25,
      currency: "USDC_POL",
      rail: "crypto",
      businessId: "biz_1",
    });
    expect(s.metadata).toEqual({ bounty_id: "b1", checkout_session_id: "cs_abc" });
  });

  it("PayPal capture (status completed, rail paypal) is paid", () => {
    const s = readCoinPayWebhook({
      id: "evt_tx_1",
      type: "payment.confirmed",
      data: { payment_id: "tx_1", status: "completed", rail: "paypal", amount: 299, metadata: { customer_email: "p@x.co", account_id: "p@x.co", property: "profullstack.com" } },
    });
    expect(s).toMatchObject({ paid: true, rail: "paypal", customerEmail: "p@x.co", accountId: "p@x.co", property: "profullstack.com" });
  });

  it("forwarded is paid; expired and pending are not", () => {
    const base = { id: "e", data: { payment_id: "p" } };
    expect(readCoinPayWebhook({ ...base, type: "payment.forwarded" }).paid).toBe(true);
    expect(readCoinPayWebhook({ ...base, type: "payment.expired", data: { payment_id: "p", status: "expired" } }).paid).toBe(false);
    expect(readCoinPayWebhook({ ...base, type: "payment.pending", data: { payment_id: "p", status: "pending" } }).paid).toBe(false);
  });

  it("falls back to the legacy flat shape", () => {
    const s = readCoinPayWebhook(
      JSON.stringify({ type: "payment.confirmed", payment_id: "pay_flat", status: "confirmed", metadata: { account_id: "u9" } }),
    );
    expect(s).toMatchObject({ paymentId: "pay_flat", status: "confirmed", accountId: "u9", eventId: null, paid: true });
  });
});

describe("verifyAndReadCoinPayWebhook", () => {
  it("returns the summary for a valid signature and null otherwise", () => {
    const rawBody = JSON.stringify({ id: "evt_1", type: "payment.confirmed", data: { payment_id: "p1", account_id: "u1" } });
    const secret = "whsecret_test";
    const signature = signCoinPayWebhook({ rawBody, secret });
    expect(verifyAndReadCoinPayWebhook({ rawBody, secret, signature })?.accountId).toBe("u1");
    expect(verifyAndReadCoinPayWebhook({ rawBody, secret: "other", signature })).toBeNull();
    const bad = "not json";
    expect(verifyAndReadCoinPayWebhook({ rawBody: bad, secret, signature: signCoinPayWebhook({ rawBody: bad, secret }) })).toBeNull();
  });
});
