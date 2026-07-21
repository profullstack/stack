/**
 * CoinPay OAuth2/OIDC login helpers ("Log in with CoinPay").
 *
 * Consolidates qrypt.chat `src/lib/auth/coinpay.js` and tronbrowsers.dev
 * `packages/auth/src/coinpay-oauth.ts`. CoinPay (coinpayportal.com) is an
 * OAuth2/OIDC identity provider; these helpers cover the relying-party side:
 * state + PKCE generation, authorize-URL construction, the authorization-code
 * exchange, and the userinfo fetch. They are side-effect free and take an
 * injectable `fetch` so they can be unit-tested without network.
 *
 * Endpoints (relative to the issuer):
 *   GET  /api/oauth/authorize — consent screen (browser redirect)
 *   POST /api/oauth/token     — code exchange (form-encoded)
 *   GET  /api/oauth/userinfo  — OIDC claims (bearer token)
 *
 * Uses `node:crypto` and the global `fetch` only — no runtime dependencies.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CoinPayFetch } from "./client.js";

/** Default CoinPay OIDC issuer (hosted CoinPayPortal). */
export const COINPAY_DEFAULT_ISSUER = "https://coinpayportal.com";

/** Default OIDC scopes requested when none are supplied. */
export const COINPAY_DEFAULT_SCOPES = "openid profile email";

/**
 * Conventional name of the short-lived httpOnly cookie that carries the
 * OAuth `state` + PKCE verifier through the authorize round-trip.
 */
export const COINPAY_STATE_COOKIE = "coinpay_oauth_state";

/** Token-set returned by the CoinPay token endpoint. */
export interface CoinPayOAuthTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  [key: string]: unknown;
}

/** OIDC claims returned by the CoinPay userinfo endpoint. */
export interface CoinPayUserinfoClaims {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  [key: string]: unknown;
}

/** Strips trailing slashes so endpoint paths can be appended safely. */
function normalizeIssuer(issuer?: string): string {
  return (issuer ?? COINPAY_DEFAULT_ISSUER).replace(/\/+$/, "");
}

/** Base64url-encode a Buffer (no padding). */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate a random opaque OAuth `state` value (CSRF protection).
 *
 * @returns A base64url string of 32 random bytes.
 */
export function generateCoinPayState(): string {
  return base64url(randomBytes(32));
}

/**
 * Generate a PKCE `code_verifier` and its S256 `code_challenge`.
 *
 * @returns `{ codeVerifier, codeChallenge }` — store the verifier (e.g. in
 *   the state cookie) and send the challenge to the authorize endpoint.
 */
export function generateCoinPayPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

/**
 * Constant-time comparison of the returned `state` against the stored value.
 *
 * @param received - State from the callback query string.
 * @param expected - State previously stored (e.g. in the state cookie).
 * @returns `true` only when both are non-empty equal strings.
 */
export function validateCoinPayState(
  received: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!received || !expected || typeof received !== "string" || typeof expected !== "string") {
    return false;
  }
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return (
    receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes)
  );
}

/** Options for {@link getCoinPayAuthorizeUrl}. */
export interface GetCoinPayAuthorizeUrlOptions {
  clientId: string;
  /** Absolute URL CoinPay must redirect back to after consent. */
  redirectUri: string;
  /** CSRF state value (see {@link generateCoinPayState}). */
  state: string;
  /** Optional PKCE S256 challenge (see {@link generateCoinPayPkcePair}). */
  codeChallenge?: string;
  /** Issuer override for self-hosted CoinPay; defaults to the hosted service. */
  issuer?: string;
  /** Scopes as an array or space-separated string. Default: {@link COINPAY_DEFAULT_SCOPES}. */
  scopes?: string | string[];
}

/**
 * Build the full CoinPay authorize URL to redirect the user's browser to.
 *
 * @param options - Client id, redirect URI, state, and optional PKCE/scopes.
 * @returns The absolute authorize URL (`<issuer>/api/oauth/authorize?…`).
 */
export function getCoinPayAuthorizeUrl(options: GetCoinPayAuthorizeUrlOptions): string {
  const { clientId, redirectUri, state, codeChallenge } = options;
  const scopes = Array.isArray(options.scopes)
    ? options.scopes.join(" ")
    : (options.scopes ?? COINPAY_DEFAULT_SCOPES);
  const url = new URL(`${normalizeIssuer(options.issuer)}/api/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", state);
  if (codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/** Options for {@link exchangeCoinPayCode}. */
export interface ExchangeCoinPayCodeOptions {
  /** Authorization code from the callback query string. */
  code: string;
  /** The exact redirect URI used in the authorize request. */
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  /** PKCE verifier, when a challenge was sent in the authorize request. */
  codeVerifier?: string;
  /** Issuer override for self-hosted CoinPay. */
  issuer?: string;
  /** Injectable fetch implementation (defaults to the global `fetch`). */
  fetch?: CoinPayFetch;
}

/**
 * Exchange an authorization code for tokens at the CoinPay token endpoint.
 *
 * @param options - Code, redirect URI, client credentials, optional PKCE.
 * @returns The token-set ({@link CoinPayOAuthTokens}).
 * @throws {Error} On a non-OK response or a payload missing `access_token`.
 */
export async function exchangeCoinPayCode(
  options: ExchangeCoinPayCodeOptions,
): Promise<CoinPayOAuthTokens> {
  const fetchImpl = options.fetch ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    client_secret: options.clientSecret,
  });
  if (options.codeVerifier) {
    body.set("code_verifier", options.codeVerifier);
  }

  const res = await fetchImpl(`${normalizeIssuer(options.issuer)}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`CoinPay token exchange failed (${res.status})`);
  }
  const data = (await res.json()) as CoinPayOAuthTokens;
  if (!data || typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("CoinPay token response missing access_token");
  }
  return data;
}

/** Options for {@link fetchCoinPayUserinfo}. */
export interface FetchCoinPayUserinfoOptions {
  /** OAuth access token from {@link exchangeCoinPayCode}. */
  accessToken: string;
  /** Issuer override for self-hosted CoinPay. */
  issuer?: string;
  /** Injectable fetch implementation (defaults to the global `fetch`). */
  fetch?: CoinPayFetch;
}

/**
 * Fetch OIDC userinfo claims using a bearer access token.
 *
 * @param options - Access token and optional issuer/fetch overrides.
 * @returns The userinfo claims ({@link CoinPayUserinfoClaims}).
 * @throws {Error} On a non-OK response or claims missing both `sub` and `email`.
 */
export async function fetchCoinPayUserinfo(
  options: FetchCoinPayUserinfoOptions,
): Promise<CoinPayUserinfoClaims> {
  const fetchImpl = options.fetch ?? fetch;
  const res = await fetchImpl(`${normalizeIssuer(options.issuer)}/api/oauth/userinfo`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`CoinPay userinfo request failed (${res.status})`);
  }
  const claims = (await res.json()) as CoinPayUserinfoClaims;
  if (!claims || (!claims.sub && !claims.email)) {
    throw new Error("CoinPay userinfo missing sub/email");
  }
  return claims;
}
