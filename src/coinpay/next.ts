/**
 * Next.js App Router helpers for the "Log in with CoinPay" OAuth flow.
 *
 * Consolidates qrypt.chat's `app/api/auth/coinpay/login/route.js` and
 * `app/api/auth/coinpay/callback/route.js` into two route-handler factories:
 *
 *   // app/api/auth/coinpay/login/route.ts
 *   import { createCoinPayLoginHandler } from "@profullstack/stack/coinpay";
 *   export const GET = createCoinPayLoginHandler({
 *     clientId: process.env.COINPAY_OAUTH_CLIENT_ID!,
 *     redirectUri: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/coinpay/callback`,
 *   });
 *
 *   // app/api/auth/coinpay/callback/route.ts
 *   export const GET = createCoinPayCallbackHandler({
 *     clientId: process.env.COINPAY_OAUTH_CLIENT_ID!,
 *     clientSecret: process.env.COINPAY_OAUTH_CLIENT_SECRET!,
 *     redirectUri: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/coinpay/callback`,
 *     onSuccess: async ({ claims }) => {
 *       await provisionSession(claims);      // app-specific
 *       return "/chat";                       // where to redirect
 *     },
 *   });
 *
 * Handlers return plain Web `Response` objects (never NextResponse), so the
 * module has zero Next dependency and stays bundler-proof — a lazy
 * require()/dynamic import of `next/server` breaks Next's turbopack build
 * when a route handler is evaluated at build time.
 */

import {
  COINPAY_STATE_COOKIE,
  exchangeCoinPayCode,
  fetchCoinPayUserinfo,
  generateCoinPayPkcePair,
  generateCoinPayState,
  getCoinPayAuthorizeUrl,
  validateCoinPayState,
} from "./oauth.js";
import type { CoinPayOAuthTokens, CoinPayUserinfoClaims } from "./oauth.js";
import type { CoinPayFetch } from "./client.js";

/** Structural subset of `next/server`'s NextRequest this module needs. */
type CoinPayNextRequest = {
  url: string;
  cookies: { get(name: string): { value: string } | undefined };
};

/** A Response carrying Next's cookies API (for app-supplied NextResponses). */
type ResponseWithCookies = Response & {
  cookies: { set(name: string, value: string, options?: Record<string, unknown>): void };
};

/**
 * A 307 redirect as a plain Web Response. 307 matches NextResponse.redirect's
 * default status, and the App Router accepts a standard Response from route
 * handlers — no `next/server` import needed.
 */
function redirectResponse(url: string | URL): Response {
  return new Response(null, { status: 307, headers: { Location: String(url) } });
}

/**
 * Serialize a `Set-Cookie` header value with the same wire format as Next's
 * `response.cookies.set()` (the cookie package's defaults): the value is
 * percent-encoded, which Next's RequestCookies decodes symmetrically.
 */
function serializeCookie(name: string, value: string, options: Record<string, unknown>): string {
  let header = `${name}=${encodeURIComponent(value)}; Path=${options["path"] ?? "/"}`;
  if (options["httpOnly"]) header += "; HttpOnly";
  if (options["sameSite"]) {
    header += `; SameSite=${String(options["sameSite"]).replace(/^\w/, (c) => c.toUpperCase())}`;
  }
  if (options["maxAge"] !== undefined) header += `; Max-Age=${options["maxAge"]}`;
  if (options["secure"]) header += "; Secure";
  return header;
}

/** Default lifetime of the state cookie — only needs to survive the round-trip. */
const STATE_COOKIE_MAX_AGE_SECONDS = 600;

function isSecureDefault(): boolean {
  return typeof process !== "undefined" && process.env["NODE_ENV"] === "production";
}

/** Builds the cookie options used for the state cookie. */
function stateCookieOptions(secure: boolean, maxAge: number): Record<string, unknown> {
  return { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge };
}

/** Parses the state-cookie value back into its payload object. */
function parseStateCookie(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    // Tolerate a raw (non-JSON) state value stored by older hand-rolled flows.
    return { state: raw };
  }
}

/** Expires the state cookie on an outgoing response. */
function clearStateCookie(res: Response, name: string, secure: boolean): void {
  const withCookies = res as Partial<ResponseWithCookies>;
  if (withCookies.cookies && typeof withCookies.cookies.set === "function") {
    withCookies.cookies.set(name, "", stateCookieOptions(secure, 0));
    return;
  }
  res.headers.append("set-cookie", serializeCookie(name, "", stateCookieOptions(secure, 0)));
}

/** Options for {@link createCoinPayLoginHandler}. */
export interface CreateCoinPayLoginHandlerOptions {
  clientId: string;
  /** Absolute URL CoinPay must redirect back to (your callback route). */
  redirectUri: string;
  /** Issuer override for self-hosted CoinPay. */
  issuer?: string;
  /** Scopes as an array or space-separated string. */
  scopes?: string | string[];
  /** State cookie name. Default: {@link COINPAY_STATE_COOKIE}. */
  stateCookie?: string;
  /** State cookie lifetime in seconds. Default: 600. */
  stateCookieMaxAgeSeconds?: number;
  /** `Secure` flag on the state cookie. Default: `NODE_ENV === "production"`. */
  secureCookies?: boolean;
  /**
   * Extra fields to stash in the state cookie (e.g. a `popup` flag derived
   * from the request). Returned to `onSuccess` as `cookie` in the callback.
   */
  extraState?:
    | Record<string, unknown>
    | ((request: CoinPayNextRequest) => Record<string, unknown>);
}

/**
 * Factory for the login route handler. Generates `state` + a PKCE pair,
 * stores them in a short-lived httpOnly cookie, and 302-redirects the user
 * to the CoinPay authorize URL.
 *
 * @param options - OAuth client configuration.
 * @returns A `GET` route handler for `app/api/auth/coinpay/login/route.ts`.
 */
export function createCoinPayLoginHandler(
  options: CreateCoinPayLoginHandlerOptions,
): (request: CoinPayNextRequest) => Promise<Response> {
  const {
    clientId,
    redirectUri,
    issuer,
    scopes,
    stateCookie = COINPAY_STATE_COOKIE,
    stateCookieMaxAgeSeconds = STATE_COOKIE_MAX_AGE_SECONDS,
    secureCookies,
    extraState,
  } = options;

  return async function GET(request: CoinPayNextRequest): Promise<Response> {
    const secure = secureCookies ?? isSecureDefault();
    const state = generateCoinPayState();
    const { codeVerifier, codeChallenge } = generateCoinPayPkcePair();
    const extra = typeof extraState === "function" ? extraState(request) : (extraState ?? {});

    const authorizeUrl = getCoinPayAuthorizeUrl({
      clientId,
      redirectUri,
      issuer,
      scopes,
      state,
      codeChallenge,
    });

    const response = redirectResponse(authorizeUrl);
    response.headers.append(
      "set-cookie",
      serializeCookie(
        stateCookie,
        JSON.stringify({ state, codeVerifier, ...extra }),
        stateCookieOptions(secure, stateCookieMaxAgeSeconds),
      ),
    );
    return response;
  };
}

/** Error codes the callback handler can produce (qrypt.chat-compatible). */
export type CoinPayCallbackErrorCode =
  | "coinpay_denied"
  | "coinpay_missing_code"
  | "coinpay_state_mismatch"
  | "coinpay_login_failed";

/** Context passed to {@link CreateCoinPayCallbackHandlerOptions.onSuccess}. */
export interface CoinPayCallbackSuccess {
  /** OIDC claims from the userinfo endpoint. */
  claims: CoinPayUserinfoClaims;
  /** Token-set from the code exchange. */
  tokens: CoinPayOAuthTokens;
  /** The incoming request. */
  request: CoinPayNextRequest;
  /** Parsed state-cookie payload (`state`, `codeVerifier`, plus any `extraState`). */
  cookie: Record<string, unknown>;
}

/**
 * What an `onSuccess`/`onError` callback may return:
 *  - a path or absolute URL string (relative paths resolve against `appOrigin`)
 *    or a `URL` — the handler redirects there,
 *  - a `Response` — returned to the client as-is (state cookie still cleared),
 *  - `void` (success only) — the handler redirects to `successUrl`.
 */
export type CoinPayCallbackResult = string | URL | Response | void;

/** Options for {@link createCoinPayCallbackHandler}. */
export interface CreateCoinPayCallbackHandlerOptions {
  clientId: string;
  clientSecret: string;
  /** The exact redirect URI used in the authorize request. */
  redirectUri: string;
  /** Issuer override for self-hosted CoinPay. */
  issuer?: string;
  /** State cookie name. Default: {@link COINPAY_STATE_COOKIE}. */
  stateCookie?: string;
  /** `Secure` flag when clearing the state cookie. Default: `NODE_ENV === "production"`. */
  secureCookies?: boolean;
  /**
   * Public app origin used to resolve relative redirect targets.
   * Default: the incoming request's origin.
   */
  appOrigin?: string;
  /** Where to redirect when `onSuccess` returns void. Default: `<appOrigin>/`. */
  successUrl?: string;
  /**
   * Error redirect target: a template string (`{code}` is replaced with the
   * error code; without a placeholder the code is appended) or a function.
   * Default: `<appOrigin>/auth?error={code}`.
   */
  errorUrl?: string | ((code: CoinPayCallbackErrorCode) => string);
  /** Injectable fetch implementation (defaults to the global `fetch`). */
  fetch?: CoinPayFetch;
  /**
   * Called after a successful code exchange + userinfo fetch. Provision the
   * user/session here, then return where to send the browser.
   */
  onSuccess: (ctx: CoinPayCallbackSuccess) => Promise<CoinPayCallbackResult> | CoinPayCallbackResult;
  /** Override error handling; return a redirect target or a Response. */
  onError?: (
    code: CoinPayCallbackErrorCode,
    request: CoinPayNextRequest,
  ) => Promise<CoinPayCallbackResult> | CoinPayCallbackResult;
}

/**
 * Factory for the OAuth callback route handler. Validates the `state`
 * cookie, exchanges the authorization code for tokens, fetches userinfo,
 * then delegates session provisioning to `onSuccess`.
 *
 * @param options - OAuth client configuration + success/error callbacks.
 * @returns A `GET` route handler for `app/api/auth/coinpay/callback/route.ts`.
 */
export function createCoinPayCallbackHandler(
  options: CreateCoinPayCallbackHandlerOptions,
): (request: CoinPayNextRequest) => Promise<Response> {
  const {
    clientId,
    clientSecret,
    redirectUri,
    issuer,
    stateCookie = COINPAY_STATE_COOKIE,
    secureCookies,
    appOrigin: appOriginOpt,
    successUrl,
    errorUrl,
    onSuccess,
    onError,
  } = options;

  function resolveErrorTarget(code: CoinPayCallbackErrorCode, appOrigin: string): string {
    if (typeof errorUrl === "function") return errorUrl(code);
    const template = errorUrl ?? `${appOrigin}/auth?error={code}`;
    if (template.includes("{code}")) {
      return template.replace(/\{code\}/g, encodeURIComponent(code));
    }
    return `${template}${encodeURIComponent(code)}`;
  }

  return async function GET(request: CoinPayNextRequest): Promise<Response> {
    const secure = secureCookies ?? isSecureDefault();
    const requestUrl = new URL(request.url);
    const appOrigin = (appOriginOpt ?? requestUrl.origin).replace(/\/+$/, "");

    /** Resolve a callback's return value into a Response. */
    function settle(result: CoinPayCallbackResult, fallbackTarget: string): Response {
      if (result instanceof Response) {
        clearStateCookie(result, stateCookie, secure);
        return result;
      }
      const target = result instanceof URL ? result.toString() : (result ?? fallbackTarget);
      const absolute = target.startsWith("/") ? `${appOrigin}${target}` : target;
      const res = redirectResponse(absolute);
      clearStateCookie(res, stateCookie, secure);
      return res;
    }

    async function fail(code: CoinPayCallbackErrorCode): Promise<Response> {
      if (onError) {
        return settle(await onError(code, request), resolveErrorTarget(code, appOrigin));
      }
      return settle(undefined, resolveErrorTarget(code, appOrigin));
    }

    const providerError = requestUrl.searchParams.get("error");
    if (providerError) {
      return fail("coinpay_denied");
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      return fail("coinpay_missing_code");
    }

    const returnedState = requestUrl.searchParams.get("state");
    const cookie = parseStateCookie(request.cookies.get(stateCookie)?.value);
    const storedState = typeof cookie["state"] === "string" ? cookie["state"] : undefined;
    if (!validateCoinPayState(returnedState, storedState)) {
      return fail("coinpay_state_mismatch");
    }

    try {
      const codeVerifier =
        typeof cookie["codeVerifier"] === "string" ? cookie["codeVerifier"] : undefined;
      const tokens = await exchangeCoinPayCode({
        code,
        redirectUri,
        clientId,
        clientSecret,
        codeVerifier,
        issuer,
        fetch: options.fetch,
      });
      const claims = await fetchCoinPayUserinfo({
        accessToken: tokens.access_token,
        issuer,
        fetch: options.fetch,
      });
      const fallback = successUrl ?? `${appOrigin}/`;
      return settle(await onSuccess({ claims, tokens, request, cookie }), fallback);
    } catch {
      return fail("coinpay_login_failed");
    }
  };
}
