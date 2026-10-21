/**
 * CoinPayPortal HTTP client — the merchant/payments side of CoinPay.
 *
 * Consolidates the hand-rolled clients that were copy-pasted across the
 * Profullstack apps (goldvpn `api/checkout.js` + `api/coins.js`,
 * ringhuman.com `packages/payments/src/coinpayportal.ts`,
 * crawlproof.com `lib/coinpay.ts`, ugig.net `src/lib/coinpayportal.ts`, …).
 *
 * Zero runtime dependencies: uses the global `fetch` (Node >= 18).
 *
 * @example
 *   import { createCoinPayClient } from "@profullstack/stack/coinpay";
 *
 *   const coinpay = createCoinPayClient({ apiKey: process.env.COINPAY_API_KEY! });
 *   // Hosted checkout session: the buyer picks any coin the business has a
 *   // wallet for, or PayPal.
 *   const { checkoutUrl, sessionId } = await coinpay.createCheckout({
 *     amountUsd: 25,
 *     customerEmail: user.email,
 *     accountId: user.id,
 *     property: "app.example",
 *     description: "GoldVPN Plus, monthly",
 *     successUrl: "https://app.example/thanks?session={CHECKOUT_SESSION_ID}",
 *     cancelUrl: "https://app.example/pricing",
 *   });
 */

/** Default CoinPayPortal site root. The API lives under `<root>/api`. */
export const COINPAY_DEFAULT_BASE_URL = "https://coinpayportal.com";

/**
 * Minimal fetch signature used by this module. Compatible with the global
 * `fetch`; inject a stub in tests or an instrumented fetch in production.
 */
export type CoinPayFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Options accepted by {@link createCoinPayClient}. */
export interface CoinPayClientConfig {
  /** Business API key (`cp_live_…`); sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  /**
   * Site root of the CoinPayPortal deployment. Accepts with or without a
   * trailing `/api` and trailing slashes; defaults to the hosted service
   * (`https://coinpayportal.com`).
   */
  baseUrl?: string;
  /** Injectable fetch implementation (defaults to the global `fetch`). */
  fetch?: CoinPayFetch;
}

/** Error thrown for any non-successful CoinPay API response. */
export class CoinPayApiError extends Error {
  /** HTTP status of the failed response. */
  readonly status: number;
  /** `error`/`message` field returned by the API, when present. */
  readonly detail: string | undefined;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = "CoinPayApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** A CoinPay payment object as returned by the API (snake_case fields). */
export interface CoinPayPayment {
  id: string;
  status?: string;
  currency?: string;
  amount_usd?: number | string;
  amount_crypto?: number | string;
  crypto_amount?: number | string;
  payment_address?: string;
  tx_hash?: string | null;
  expires_at?: string | null;
  checkout_url?: string;
  stripe_checkout_url?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Input for {@link CoinPayClient.createPayment}: a single-coin payment
 * (`POST /api/payments/create`). Prefer {@link CoinPayClient.createCheckout}.
 */
export interface CreatePaymentInput {
  /** Amount in USD dollars (e.g. `25` = $25.00). */
  amountUsd: number;
  /** Lower-case coin code for the crypto leg, e.g. `"btc"`, `"usdc_pol"`. */
  currency: string;
  /**
   * Rails offered on the hosted pay page: `"crypto"`, `"card"`, or `"both"`.
   * Defaults to `"both"` (crypto QR/address plus a Stripe card tab).
   */
  paymentMethod?: "crypto" | "card" | "both";
  /** Description shown to the customer on the hosted page. */
  description?: string;
  /** Custom metadata, echoed back verbatim in webhook events. */
  metadata?: Record<string, unknown>;
  /** Where the hosted page redirects after confirmation (crypto leg). */
  redirectUrl?: string;
  /** Stripe Checkout return URL after a successful card payment. */
  successUrl?: string;
  /** Stripe Checkout return URL when the customer cancels the card leg. */
  cancelUrl?: string;
  /** Per-payment webhook URL override. */
  webhookUrl?: string;
  /** Business ID; optional for business-scoped API keys. */
  businessId?: string;
  /** Seconds until the payment expires. */
  expiresIn?: number;
  /** Payer email; stored on the payment and echoed in its webhooks. */
  customerEmail?: string;
  /** Your site's user id or handle for the payer. */
  accountId?: string;
  /** Site hostname this payment is for. */
  property?: string;
}

/** Result of {@link CoinPayClient.createPayment}. */
export interface CreatePaymentResult {
  /** The CoinPay payment id. */
  paymentId: string;
  /**
   * URL to send the customer to: the Stripe checkout URL for card payments
   * when the API returns one, otherwise the hosted pay page
   * (`<root>/pay/<paymentId>`).
   */
  checkoutUrl: string;
  /** The raw payment object returned by the API. */
  payment: CoinPayPayment;
}

/** Result of {@link CoinPayClient.getPayment}. */
export interface GetPaymentResult {
  /** The CoinPay payment id. */
  paymentId: string;
  /** Payment status (`pending`, `confirmed`, `forwarded`, `expired`, …). */
  status: string;
  /** The raw payment object returned by the API. */
  payment: CoinPayPayment;
}

/** Checkout-session status: `open` until paid or expired. */
export type CoinPayCheckoutSessionStatus = "open" | "paid" | "expired" | (string & {});

/** A checkout session as returned by `/api/checkout/sessions` (snake_case). */
export interface CoinPayCheckoutSession {
  id: string;
  url?: string;
  status?: CoinPayCheckoutSessionStatus;
  amount?: number | string;
  currency?: string;
  description?: string | null;
  customer_email?: string;
  account_id?: string;
  property?: string;
  metadata?: Record<string, unknown>;
  success_url?: string | null;
  cancel_url?: string | null;
  expires_at?: string;
  /** Method codes offered on create (`"BTC"`, `"USDC_POL"`, `"PAYPAL"`, ...). */
  methods?: unknown[];
  payment_id?: string | null;
  paypal_transaction_id?: string | null;
  paid_at?: string | null;
  paid_method?: string | null;
  paid_reference?: string | null;
  [key: string]: unknown;
}

/**
 * Input for {@link CoinPayClient.createCheckout}: a hosted checkout session
 * (`POST /api/checkout/sessions`). The buyer chooses any coin the business
 * has a wallet for, or PayPal when connected.
 */
export interface CreateCheckoutInput {
  /** Amount in USD dollars (e.g. `25` = $25.00). */
  amountUsd: number;
  /** Email of the person paying. Required. */
  customerEmail: string;
  /**
   * Your site's user id or handle for the payer. Required. For a guest
   * checkout pass the email.
   */
  accountId: string;
  /**
   * Site hostname this payment is for (a URL is reduced to its hostname by
   * the portal). Defaults server-side to the business name; always send it.
   */
  property: string;
  /** Description shown on the hosted page (max 500 chars). */
  description?: string;
  /** Merchant metadata, echoed inside every payment webhook's `data.metadata`. */
  metadata?: Record<string, unknown>;
  /**
   * Where the buyer lands after paying. `{CHECKOUT_SESSION_ID}` (and
   * `{PAYMENT_ID}`) are filled in by the portal.
   */
  successUrl?: string;
  /** Where the "cancel" link on the hosted page goes. */
  cancelUrl?: string;
  /** Session lifetime in minutes, 15 to 120. Default 60. */
  expiresInMinutes?: number;
  /**
   * Restrict the methods offered: coin codes (`"BTC"`, `"USDC_POL"`, ...),
   * `"CRYPTO"` for every coin, `"PAYPAL"`. Default: everything available.
   */
  allowedMethods?: string[];
  /** Business ID; only needed with a merchant (non business-scoped) token. */
  businessId?: string;
}

/** Result of {@link CoinPayClient.createCheckout}. */
export interface CreateCheckoutResult {
  /** The checkout session id (`cs_...`). */
  sessionId: string;
  /** Hosted checkout page to redirect the buyer to (`<root>/checkout/<id>`). */
  checkoutUrl: string;
  /** Method codes the buyer will be offered. */
  methods: string[];
  /** When the session expires (ISO 8601), when returned. */
  expiresAt: string | undefined;
  /** The raw session object returned by the API. */
  session: CoinPayCheckoutSession;
}

/** Result of {@link CoinPayClient.getCheckout}. */
export interface GetCheckoutResult {
  /** The checkout session id (`cs_...`). */
  sessionId: string;
  /** `open`, `paid` or `expired`. */
  status: CoinPayCheckoutSessionStatus;
  /** True once the session is paid (any rail). */
  paid: boolean;
  /** Underlying crypto payment id, once the buyer picked a coin. */
  paymentId: string | null;
  /** Underlying PayPal transaction id, once the buyer picked PayPal. */
  paypalTransactionId: string | null;
  /** The raw session object (owner view when called with the business key). */
  session: CoinPayCheckoutSession;
}

/** A coin/token as returned by `GET /api/tokens` (snake_case fields). */
export interface CoinPayCoin {
  /** Lower-case code accepted by checkout creation, e.g. `"usdc_pol"`. */
  code: string;
  ticker?: string;
  symbol?: string;
  name?: string;
  /** True when the business has a wallet configured for this coin. */
  has_wallet?: boolean;
  is_active?: boolean;
  [key: string]: unknown;
}

/** Options for {@link CoinPayClient.listCoins}. */
export interface ListCoinsOptions {
  /** Only return active coins (adds `active_only=true`). Default: true. */
  activeOnly?: boolean;
  /** Business ID; optional for business-scoped API keys. */
  businessId?: string;
}

/** The merchant-side CoinPay client returned by {@link createCoinPayClient}. */
export interface CoinPayClient {
  /**
   * Create a hosted checkout session (`POST /api/checkout/sessions`) and
   * return the URL to redirect the buyer to. Requires `customerEmail`,
   * `accountId` and `property`.
   */
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  /** Fetch a checkout session (`GET /api/checkout/sessions/<id>`). */
  getCheckout(sessionId: string): Promise<GetCheckoutResult>;
  /**
   * Create a single-coin payment (`POST /api/payments/create`). Lower level
   * than {@link CoinPayClient.createCheckout}; the buyer cannot pick a coin.
   */
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  /** Fetch the current state of a payment (`GET /api/payments/<id>`). */
  getPayment(paymentId: string): Promise<GetPaymentResult>;
  /**
   * List the coins this business can accept (`GET /api/tokens`). An empty
   * array means no wallet is configured yet.
   */
  listCoins(options?: ListCoinsOptions): Promise<CoinPayCoin[]>;
}

/** Splits a user-supplied base URL into site root + API root. */
function normalizeBaseUrl(baseUrl?: string): { root: string; api: string } {
  const raw = (baseUrl ?? COINPAY_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const root = raw.endsWith("/api") ? raw.slice(0, -"/api".length) : raw;
  return { root, api: `${root}/api` };
}

/** Extracts a human-readable detail from an API error envelope. */
function errorDetail(data: Record<string, unknown>): string | undefined {
  const error = data["error"];
  if (typeof error === "string" && error) return error;
  const message = data["message"];
  if (typeof message === "string" && message) return message;
  return undefined;
}

/**
 * Create a CoinPayPortal merchant client.
 *
 * @param config - API key, optional base URL override, optional fetch.
 * @returns A {@link CoinPayClient} with checkout + coin-listing methods.
 */
export function createCoinPayClient(config: CoinPayClientConfig): CoinPayClient {
  const { apiKey } = config;
  if (!apiKey) {
    throw new Error("createCoinPayClient: apiKey is required");
  }
  const fetchImpl = config.fetch ?? fetch;
  const { root, api } = normalizeBaseUrl(config.baseUrl);

  async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetchImpl(`${api}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data["success"] === false) {
      const detail = errorDetail(data);
      throw new CoinPayApiError(
        `CoinPay request failed (${res.status})${detail ? `: ${detail}` : ""}`,
        res.status,
        detail,
      );
    }
    return data;
  }

  return {
    async createCheckout(input) {
      const customerEmail = typeof input.customerEmail === "string" ? input.customerEmail.trim() : "";
      const accountId =
        input.accountId === undefined || input.accountId === null ? "" : String(input.accountId).trim();
      const property = typeof input.property === "string" ? input.property.trim() : "";
      if (!customerEmail) {
        throw new CoinPayApiError("createCheckout: customerEmail is required", 400, "MISSING_CUSTOMER_EMAIL");
      }
      if (!accountId) {
        throw new CoinPayApiError("createCheckout: accountId is required", 400, "MISSING_ACCOUNT_ID");
      }
      if (!property) {
        throw new CoinPayApiError("createCheckout: property is required", 400, "MISSING_PROPERTY");
      }
      const body: Record<string, unknown> = {
        amount: input.amountUsd,
        currency: "USD",
        customer_email: customerEmail,
        account_id: accountId,
        property,
      };
      if (input.description !== undefined) body["description"] = input.description;
      if (input.metadata !== undefined) body["metadata"] = input.metadata;
      if (input.successUrl !== undefined) body["success_url"] = input.successUrl;
      if (input.cancelUrl !== undefined) body["cancel_url"] = input.cancelUrl;
      body["expires_in_minutes"] = input.expiresInMinutes ?? 60;
      if (input.allowedMethods !== undefined) body["allowed_methods"] = input.allowedMethods;
      if (input.businessId !== undefined) body["business_id"] = input.businessId;

      const data = await request("/checkout/sessions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const id = data["id"];
      if (typeof id !== "string" || !id) {
        throw new CoinPayApiError("CoinPay response missing session id", 200, undefined);
      }
      const { success: _success, ...rest } = data;
      const session = rest as unknown as CoinPayCheckoutSession;
      const checkoutUrl =
        typeof data["url"] === "string" && data["url"] ? (data["url"] as string) : `${root}/checkout/${id}`;
      const methods = Array.isArray(data["methods"])
        ? (data["methods"] as unknown[]).filter((m): m is string => typeof m === "string")
        : [];
      const expiresAt = typeof data["expires_at"] === "string" ? (data["expires_at"] as string) : undefined;
      return { sessionId: id, checkoutUrl, methods, expiresAt, session };
    },

    async getCheckout(sessionId) {
      const data = await request(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
      const session = data["session"] as CoinPayCheckoutSession | undefined;
      if (!session || typeof session.id !== "string" || !session.id) {
        throw new CoinPayApiError("CoinPay response missing session.id", 200, undefined);
      }
      const status = typeof session.status === "string" ? session.status : "open";
      return {
        sessionId: session.id,
        status,
        paid: status === "paid",
        paymentId: typeof session.payment_id === "string" ? session.payment_id : null,
        paypalTransactionId:
          typeof session.paypal_transaction_id === "string" ? session.paypal_transaction_id : null,
        session,
      };
    },

    async createPayment(input) {
      const body: Record<string, unknown> = {
        amount_usd: input.amountUsd,
        currency: input.currency,
        payment_method: input.paymentMethod ?? "both",
      };
      if (input.description !== undefined) body["description"] = input.description;
      if (input.metadata !== undefined) body["metadata"] = input.metadata;
      if (input.redirectUrl !== undefined) body["redirect_url"] = input.redirectUrl;
      if (input.successUrl !== undefined) body["success_url"] = input.successUrl;
      if (input.cancelUrl !== undefined) body["cancel_url"] = input.cancelUrl;
      if (input.webhookUrl !== undefined) body["webhook_url"] = input.webhookUrl;
      if (input.businessId !== undefined) body["business_id"] = input.businessId;
      if (input.expiresIn !== undefined) body["expires_in"] = input.expiresIn;
      if (input.customerEmail !== undefined) body["customer_email"] = input.customerEmail;
      if (input.accountId !== undefined) body["account_id"] = input.accountId;
      if (input.property !== undefined) body["property"] = input.property;

      const data = await request("/payments/create", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const payment = data["payment"] as CoinPayPayment | undefined;
      if (!payment || typeof payment.id !== "string" || !payment.id) {
        throw new CoinPayApiError("CoinPay response missing payment.id", 200, undefined);
      }
      const checkoutUrl =
        payment.stripe_checkout_url ?? payment.checkout_url ?? `${root}/pay/${payment.id}`;
      return { paymentId: payment.id, checkoutUrl, payment };
    },

    async getPayment(paymentId) {
      const data = await request(`/payments/${encodeURIComponent(paymentId)}`);
      const payment = data["payment"] as CoinPayPayment | undefined;
      if (!payment || typeof payment.id !== "string" || !payment.id) {
        throw new CoinPayApiError("CoinPay response missing payment.id", 200, undefined);
      }
      return {
        paymentId: payment.id,
        status: typeof payment.status === "string" ? payment.status : "pending",
        payment,
      };
    },

    async listCoins(options = {}) {
      const { activeOnly = true, businessId } = options;
      const params = new URLSearchParams();
      if (activeOnly) params.set("active_only", "true");
      if (businessId) params.set("business_id", businessId);
      const query = params.toString();
      const data = await request(`/tokens${query ? `?${query}` : ""}`);
      const tokens = data["tokens"];
      return Array.isArray(tokens) ? (tokens as CoinPayCoin[]) : [];
    },
  };
}
