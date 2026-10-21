/**
 * CoinPayPortal webhook signature verification.
 *
 * Consolidates the verifiers copy-pasted across goldvpn
 * `api/coinpay-webhook.js`, crawlproof.com `lib/coinpay.ts`,
 * ugig.net `src/lib/coinpayportal.ts`, and the `@coinpay/sdk` webhooks
 * module. The wire scheme (all four agree):
 *
 *   Header:  X-CoinPay-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256>
 *   Payload: v1 = HMAC-SHA256(secret, `${t}.${rawBody}`)
 *   Replay:  reject timestamps more than 300s (default) from now
 *
 * Multiple `v1=` parts are allowed (secret rotation) — any match passes.
 *
 * IMPORTANT: always verify over the RAW request body. In Next.js route
 * handlers use `await req.text()`; in Vercel/Express serverless disable the
 * JSON body parser (goldvpn exports `config = { api: { bodyParser: false } }`).
 *
 * Uses `node:crypto` only — no runtime dependencies.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Name of the HTTP header carrying the webhook signature (lower-case). */
export const COINPAY_WEBHOOK_SIGNATURE_HEADER = "x-coinpay-signature";

/** Default replay tolerance, in seconds (matches CoinPayPortal's signer). */
export const COINPAY_WEBHOOK_TOLERANCE_SECONDS = 300;

/** Options for {@link verifyCoinPayWebhook}. */
export interface VerifyCoinPayWebhookOptions {
  /** Value of the `X-CoinPay-Signature` header (`t=<unix>,v1=<hex>`). */
  signature: string | null | undefined;
  /** Raw request body, exactly as received (before any JSON parsing). */
  rawBody: string;
  /** Webhook secret from the CoinPayPortal dashboard (`whsecret_…`). */
  secret: string;
  /** Replay tolerance in seconds. Default: {@link COINPAY_WEBHOOK_TOLERANCE_SECONDS}. */
  toleranceSeconds?: number;
  /** Override for "now" in unix seconds (for deterministic tests). */
  now?: number;
}

/**
 * Verify a CoinPayPortal webhook signature in constant time.
 *
 * @param options - Signature header, raw body, secret, and tolerances.
 * @returns `true` only when the timestamp is fresh and one `v1` matches.
 *   Never throws — any malformed input returns `false`.
 */
export function verifyCoinPayWebhook(options: VerifyCoinPayWebhookOptions): boolean {
  const { signature, rawBody, secret } = options;
  if (!signature || !secret) return false;
  const tolerance = options.toleranceSeconds ?? COINPAY_WEBHOOK_TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  try {
    let timestamp: string | undefined;
    const v1Candidates: string[] = [];
    for (const part of String(signature).split(",")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (key === "t" && timestamp === undefined) timestamp = value;
      else if (key === "v1") v1Candidates.push(value);
    }
    if (!timestamp || v1Candidates.length === 0) return false;

    // Reject stale/future timestamps to block replayed deliveries.
    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > tolerance) return false;

    const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    for (const candidate of v1Candidates) {
      const candidateBuf = Buffer.from(candidate, "hex");
      if (candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Compute a CoinPayPortal signature header value. Useful for tests that
 * exercise a webhook route — the production signer is CoinPayPortal itself.
 *
 * @param options - Raw body, secret, and an optional explicit timestamp.
 * @returns A header value of the form `t=<unix>,v1=<hex>`.
 */
export function signCoinPayWebhook(options: {
  rawBody: string;
  secret: string;
  timestamp?: number;
}): string {
  const ts = options.timestamp ?? Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", options.secret)
    .update(`${ts}.${options.rawBody}`)
    .digest("hex");
  return `t=${ts},v1=${v1}`;
}

/** A parsed CoinPayPortal webhook event. */
export interface CoinPayWebhookEvent {
  /** Event id (fallback for `data.payment_id` when deduplicating). */
  id?: string;
  /** Event type, e.g. `"payment.confirmed"`, `"payment.expired"`. */
  type: string;
  /** Event payload; `payment_id` and `metadata` are echoed from checkout. */
  data: {
    payment_id?: string;
    status?: string;
    amount_usd?: number | string;
    amount_crypto?: number | string;
    currency?: string;
    payment_address?: string;
    tx_hash?: string;
    confirmed_at?: string;
    /** Set when the payment came from a hosted checkout session. */
    checkout_session_id?: string;
    /** Payer email (checkout sessions always carry it). */
    customer_email?: string;
    /** The site's user id or handle for the payer. */
    account_id?: string;
    /** Site hostname the payment is for. */
    property?: string;
    /** `"paypal"` for the PayPal rail; absent for crypto. */
    rail?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
  created_at?: string;
  business_id?: string;
  [key: string]: unknown;
}

/**
 * Parse a (already signature-verified) raw webhook body into a typed event.
 *
 * @param rawBody - The raw request body.
 * @returns The parsed {@link CoinPayWebhookEvent}.
 * @throws {Error} When the body is not valid JSON or not an object.
 */
export function parseCoinPayWebhookEvent(rawBody: string): CoinPayWebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("CoinPay webhook payload is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CoinPay webhook payload is not an object");
  }
  const event = parsed as CoinPayWebhookEvent;
  if (typeof event.type !== "string" || !event.type) {
    throw new Error("CoinPay webhook payload is missing a string `type`");
  }
  if (!event.data || typeof event.data !== "object") {
    event.data = {};
  }
  return event;
}


/** Event types that mean the money arrived (crypto confirmed/forwarded, PayPal capture). */
export const COINPAY_PAID_EVENT_TYPES: readonly string[] = ["payment.confirmed", "payment.forwarded"];

/** Payment statuses that mean paid. PayPal captures report `completed`. */
const PAID_STATUSES = new Set(["confirmed", "forwarded", "completed", "paid"]);

/** A flattened, typed view of a CoinPay webhook, see {@link readCoinPayWebhook}. */
export interface CoinPayWebhookSummary {
  /** Event id (`evt_<paymentId>_<ts>`). NOT the payment id. */
  eventId: string | null;
  /** Event type, e.g. `"payment.confirmed"`. */
  type: string;
  /** Crypto payment id or PayPal transaction id. */
  paymentId: string | null;
  /** Lower-cased payment status (`confirmed`, `forwarded`, `completed`, `expired`, ...). */
  status: string;
  /** True when this event means the payment is paid (confirmed or forwarded). */
  paid: boolean;
  /** Checkout session id (`cs_...`) when the payment came from a session. */
  checkoutSessionId: string | null;
  /** Payer email. */
  customerEmail: string | null;
  /** The site's user id or handle for the payer (the email for guests). */
  accountId: string | null;
  /** Site hostname. */
  property: string | null;
  /** Merchant metadata (plus the customer fields the portal copies in). */
  metadata: Record<string, unknown>;
  /** USD amount when present. */
  amountUsd: number | null;
  /** Coin code or `USD` for PayPal. */
  currency: string | null;
  /** `"paypal"` or `"crypto"`. */
  rail: "paypal" | "crypto";
  /** Business id the event belongs to. */
  businessId: string | null;
  /** The parsed event. */
  event: CoinPayWebhookEvent;
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Read a CoinPay webhook into a flat summary: who paid (`customerEmail`,
 * `accountId`), for which site (`property`), which checkout session, and
 * whether it is paid. Reads the nested `data` first (the live wire shape)
 * and falls back to flat fields (the legacy test sender), then to
 * `metadata`. Never treats the top-level event id as the payment id.
 *
 * @param input - A raw (signature-verified) body or an already parsed event.
 * @throws {Error} When a raw body is not a valid event (see {@link parseCoinPayWebhookEvent}).
 */
export function readCoinPayWebhook(input: string | CoinPayWebhookEvent): CoinPayWebhookSummary {
  const event = typeof input === "string" ? parseCoinPayWebhookEvent(input) : input;
  const raw = event as unknown as Record<string, unknown>;
  const data = (event.data && typeof event.data === "object" ? event.data : {}) as Record<string, unknown>;
  const nested = Object.keys(data).length > 0;
  const metaRaw = data["metadata"] ?? (nested ? undefined : raw["metadata"]);
  const metadata =
    metaRaw && typeof metaRaw === "object" && !Array.isArray(metaRaw)
      ? (metaRaw as Record<string, unknown>)
      : {};
  const pick = (key: string): string | null =>
    str(data[key]) ?? (nested ? null : str(raw[key])) ?? str(metadata[key]);

  const type = event.type;
  const status = (str(data["status"]) ?? (nested ? null : str(raw["status"])) ?? "").toLowerCase();
  const paymentId = str(data["payment_id"]) ?? (nested ? str(data["id"]) : str(raw["payment_id"]));
  const amount = data["amount_usd"] ?? data["amount"] ?? (nested ? undefined : raw["amount_usd"]);
  const amountNum = typeof amount === "number" ? amount : typeof amount === "string" ? Number(amount) : NaN;
  const rail = (str(data["rail"]) ?? str(data["payment_method"]) ?? "").toLowerCase() === "paypal" ? "paypal" : "crypto";
  const paid =
    COINPAY_PAID_EVENT_TYPES.includes(type) ||
    (type.startsWith("payment.") && !type.endsWith("expired") && !type.endsWith("failed") && PAID_STATUSES.has(status));

  return {
    eventId: nested ? str(raw["id"]) : null,
    type,
    paymentId,
    status,
    paid,
    checkoutSessionId: pick("checkout_session_id"),
    customerEmail: pick("customer_email"),
    accountId: pick("account_id"),
    property: pick("property"),
    metadata,
    amountUsd: Number.isFinite(amountNum) ? amountNum : null,
    currency: str(data["currency"]),
    rail,
    businessId: str(raw["business_id"]),
    event,
  };
}

/** Options for {@link verifyAndReadCoinPayWebhook}. */
export type VerifyAndReadCoinPayWebhookOptions = VerifyCoinPayWebhookOptions;

/**
 * Verify the signature, then {@link readCoinPayWebhook}. Returns `null` when
 * the signature is invalid or the body is not a CoinPay event, so a route can
 * answer 401/400 without a try/catch.
 */
export function verifyAndReadCoinPayWebhook(
  options: VerifyAndReadCoinPayWebhookOptions,
): CoinPayWebhookSummary | null {
  if (!verifyCoinPayWebhook(options)) return null;
  try {
    return readCoinPayWebhook(options.rawBody);
  } catch {
    return null;
  }
}
