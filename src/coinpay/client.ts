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
 *   const { checkoutUrl } = await coinpay.createCheckout({
 *     amountUsd: 25,
 *     currency: "usdc_pol",
 *     paymentMethod: "both",
 *     description: "GoldVPN Plus — Monthly",
 *     redirectUrl: "https://app.example/thanks",
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

/** Input for {@link CoinPayClient.createCheckout}. */
export interface CreateCheckoutInput {
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
}

/** Result of {@link CoinPayClient.createCheckout}. */
export interface CreateCheckoutResult {
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

/** Result of {@link CoinPayClient.getCheckout}. */
export interface GetCheckoutResult {
  /** The CoinPay payment id. */
  paymentId: string;
  /** Payment status (`pending`, `confirmed`, `forwarded`, `expired`, …). */
  status: string;
  /** The raw payment object returned by the API. */
  payment: CoinPayPayment;
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
   * Create a payment (`POST /api/payments/create`) and return the hosted
   * checkout URL to redirect the customer to.
   */
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  /** Fetch the current state of a payment (`GET /api/payments/<id>`). */
  getCheckout(paymentId: string): Promise<GetCheckoutResult>;
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

    async getCheckout(paymentId) {
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
