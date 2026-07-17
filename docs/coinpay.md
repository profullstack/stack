# `@profullstack/stack/coinpay`

CoinPay (coinpayportal.com) integration, consolidated from the hand-rolled
clients and OAuth login flows that were copy-pasted across the Profullstack
apps (goldvpn, ringhuman.com, tronbrowsers.dev, qrypt.chat, crawlproof.com,
ugig.net, aiornot.vote, qaaas.dev, …).

Three pieces:

1. **Merchant client** — create checkouts, poll payment status, list accepted
   coins (`createCoinPayClient`).
2. **Webhook verification** — constant-time HMAC-SHA256 verification of
   `X-CoinPay-Signature` (`verifyCoinPayWebhook`).
3. **"Log in with CoinPay" OAuth2/OIDC** — state/PKCE helpers, authorize-URL
   builder, code exchange, userinfo fetch, and drop-in Next.js route handlers
   (`createCoinPayLoginHandler` / `createCoinPayCallbackHandler`).

Zero runtime dependencies (global `fetch`, `node:crypto`). `next` is an
optional peer and is `require`d lazily — importing this module outside a
Next.js app is safe.

## Install / import

```bash
npm install @profullstack/stack
```

```ts
import {
  createCoinPayClient,
  verifyCoinPayWebhook,
  parseCoinPayWebhookEvent,
  getCoinPayAuthorizeUrl,
  exchangeCoinPayCode,
  fetchCoinPayUserinfo,
  createCoinPayLoginHandler,
  createCoinPayCallbackHandler,
} from "@profullstack/stack/coinpay";
```

---

## API reference

### Merchant client

```ts
const coinpay = createCoinPayClient({
  apiKey: process.env.COINPAYPORTAL_API_KEY!, // "cp_live_…"
  baseUrl: "https://coinpayportal.com",       // optional; "/api" suffix and
                                              // trailing slashes are tolerated
  fetch: myFetch,                             // optional injection for tests
});
```

#### `coinpay.createCheckout(input): Promise<CreateCheckoutResult>`

`POST /api/payments/create`, then returns the URL to send the customer to.

```ts
const { paymentId, checkoutUrl, payment } = await coinpay.createCheckout({
  amountUsd: 25,                    // USD dollars
  currency: "usdc_pol",             // crypto coin code (see listCoins)
  paymentMethod: "both",            // "crypto" | "card" | "both" (default "both")
  description: "GoldVPN Plus — Monthly",
  metadata: { plan: "plus", cycle: "monthly" }, // echoed back in webhooks
  redirectUrl: "https://app.example/thanks",    // crypto-leg redirect
  successUrl: "https://app.example/thanks",     // Stripe card-leg return URLs
  cancelUrl: "https://app.example/signup",
  webhookUrl, businessId, expiresIn,            // optional
});
// checkoutUrl = payment.stripe_checkout_url ?? payment.checkout_url
//             ?? `${baseUrl}/pay/${paymentId}`
```

Throws `CoinPayApiError` (`.status`, `.detail`) on non-OK responses,
`success: false` envelopes, or a missing `payment.id`.

#### `coinpay.getCheckout(paymentId): Promise<GetCheckoutResult>`

`GET /api/payments/<id>` → `{ paymentId, status, payment }`.

#### `coinpay.listCoins(options?): Promise<CoinPayCoin[]>`

`GET /api/tokens` (`?active_only=true` by default; pass
`{ activeOnly: false, businessId }` to change). Returns the raw token list —
`[]` means no wallet configured yet:

```ts
const coins = (await coinpay.listCoins())
  .filter((t) => t.has_wallet && t.is_active)
  .map((t) => ({ code: t.code, ticker: t.ticker ?? t.symbol, name: t.name }));
```

### Webhook verification

```ts
import {
  COINPAY_WEBHOOK_SIGNATURE_HEADER,
  verifyCoinPayWebhook,
  parseCoinPayWebhookEvent,
} from "@profullstack/stack/coinpay";

// Next.js route handler — verify over the RAW body:
export async function POST(req: Request) {
  const rawBody = await req.text();
  const ok = verifyCoinPayWebhook({
    signature: req.headers.get(COINPAY_WEBHOOK_SIGNATURE_HEADER),
    rawBody,
    secret: process.env.COINPAYPORTAL_WEBHOOK_SECRET!,
  });
  if (!ok) return Response.json({ error: "invalid_signature" }, { status: 401 });

  const event = parseCoinPayWebhookEvent(rawBody);
  if (event.type !== "payment.confirmed") return Response.json({ ok: true });
  // …fulfill; event.data.metadata is the metadata passed to createCheckout…
  return Response.json({ ok: true });
}
```

Scheme (identical in goldvpn, the `@coinpay/sdk`, and every app verifier):
header `X-CoinPay-Signature: t=<unix>,v1=<hex>`,
`v1 = HMAC-SHA256(secret, `${t}.${rawBody}`)`, 300 s replay tolerance
(`toleranceSeconds` option to change, `now` option for tests). Multiple `v1=`
parts are supported for secret rotation. `signCoinPayWebhook({ rawBody,
secret, timestamp? })` produces a header value for your own tests.
`parseCoinPayWebhookEvent` throws on invalid JSON / non-object / missing
`type`.

### OAuth helpers ("Log in with CoinPay")

CoinPay is an OAuth2/OIDC provider. Endpoints live under the issuer
(default `https://coinpayportal.com`, override with `issuer` for self-hosted):
`/api/oauth/authorize`, `/api/oauth/token`, `/api/oauth/userinfo`.

```ts
getCoinPayAuthorizeUrl({ clientId, redirectUri, state, codeChallenge?, issuer?, scopes? }): string
generateCoinPayState(): string
generateCoinPayPkcePair(): { codeVerifier, codeChallenge }
validateCoinPayState(received, expected): boolean   // constant-time
exchangeCoinPayCode({ code, redirectUri, clientId, clientSecret, codeVerifier?, issuer?, fetch? }): Promise<CoinPayOAuthTokens>
fetchCoinPayUserinfo({ accessToken, issuer?, fetch? }): Promise<CoinPayUserinfoClaims>
```

Default scopes: `openid profile email` (`COINPAY_DEFAULT_SCOPES`); pass an
array for more (e.g. tronbrowsers.dev's
`["openid", "profile", "email", "did", "wallet:read"]`).

### Next.js route handlers

```ts
// app/api/auth/coinpay/login/route.ts
import { createCoinPayLoginHandler } from "@profullstack/stack/coinpay";

export const GET = createCoinPayLoginHandler({
  clientId: process.env.COINPAY_OAUTH_CLIENT_ID!,
  redirectUri: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/coinpay/callback`,
  // extraState: (req) => ({ popup: new URL(req.url).searchParams.get("popup") === "1" }),
});
```

Generates `state` + a PKCE pair, stores them in a short-lived httpOnly cookie
(`coinpay_oauth_state`, 600 s, `Secure` in production), and 302-redirects to
the CoinPay authorize URL.

```ts
// app/api/auth/coinpay/callback/route.ts
import { createCoinPayCallbackHandler } from "@profullstack/stack/coinpay";

export const GET = createCoinPayCallbackHandler({
  clientId: process.env.COINPAY_OAUTH_CLIENT_ID!,
  clientSecret: process.env.COINPAY_OAUTH_CLIENT_SECRET!,
  redirectUri: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/coinpay/callback`,
  onSuccess: async ({ claims, tokens, cookie }) => {
    await provisionSession(claims); // your app logic (supabase, JWT, …)
    return "/chat";                 // path, absolute URL, URL, or Response
  },
  // onError: (code) => `/auth?error=${code}`,   // optional override
});
```

The callback validates `state` against the cookie, exchanges the code, fetches
userinfo, then defers to `onSuccess`. Relative return values resolve against
`appOrigin` (default: request origin); the state cookie is always cleared on
the outgoing response. Errors redirect to
`<appOrigin>/auth?error=<code>` with qrypt.chat-compatible codes:
`coinpay_denied`, `coinpay_missing_code`, `coinpay_state_mismatch`,
`coinpay_login_failed` (customizable via `errorUrl` / `onError`).

---

## Migration recipes

### 1. goldvpn — `api/checkout.js` (Vercel serverless)

**Before:** hand-rolled `fetch("https://coinpayportal.com/api/payments/create")`
with `Authorization: Bearer`, `!r.ok || !cpp.success` checks, then
`` `${CPP_BASE}/pay/${id}` ``.

**After** — keep the price table, plan validation, and WHMCS logic; replace
the fetch block:

```js
const { createCoinPayClient } = require("@profullstack/stack/coinpay");

// inside the handler, replacing the try/catch fetch of CPP_ENDPOINT:
const coinpay = createCoinPayClient({ apiKey: process.env.COINPAYPORTAL_API_KEY });
let checkout;
try {
  checkout = await coinpay.createCheckout({
    amountUsd,
    currency,
    paymentMethod: "both",
    description,
    metadata: { plan, cycle, ...(whmcsInvoiceId ? { whmcs_invoice_id: whmcsInvoiceId } : {}) },
    redirectUrl: `${site}/thanks`,
    successUrl: `${site}/thanks`,
    cancelUrl: `${site}/signup`,
  });
} catch (e) {
  res.status(502).json({ error: "processor_error", detail: e.detail || e.message });
  return;
}
res.status(200).json({ checkout_url: checkout.checkoutUrl });
```

### 2. goldvpn — `api/coins.js`

**Before:** hand-rolled proxy of `GET /api/tokens?active_only=true`.

**After:**

```js
const { createCoinPayClient } = require("@profullstack/stack/coinpay");

module.exports = async (req, res) => {
  if (req.method !== "GET") { res.status(405).json({ error: "method_not_allowed" }); return; }
  const apiKey = process.env.COINPAYPORTAL_API_KEY;
  if (!apiKey) { res.status(503).json({ error: "checkout_unconfigured" }); return; }
  try {
    const tokens = await createCoinPayClient({ apiKey }).listCoins();
    const coins = tokens
      .filter((t) => t.has_wallet && t.is_active)
      .map((t) => ({ code: t.code, ticker: t.ticker || t.symbol, name: t.name }));
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
    res.status(200).json({ coins });
  } catch (e) {
    res.status(502).json({ error: "processor_error", detail: e.detail || e.message });
  }
};
```

### 3. goldvpn — `api/coinpay-webhook.js` (and every other webhook route)

**Before:** local `verifySignature(raw, header, secret)` (lines 111–133).

**After:** delete the local function; keep `bodyParser: false` and the raw
read, then:

```js
const { verifyCoinPayWebhook } = require("@profullstack/stack/coinpay");

if (!verifyCoinPayWebhook({
  signature: req.headers["x-coinpay-signature"],
  rawBody: raw,
  secret: process.env.COINPAYPORTAL_WEBHOOK_SECRET,
})) {
  res.status(401).json({ error: "invalid_signature" }); return;
}
```

Identical replacement applies to crawlproof.com `lib/coinpay.ts`
`verifyWebhookSignature` (the multi-`v1` rotation support is built in — the
"try many secrets/messages" guesswork can go away), ugig.net
`src/lib/coinpayportal.ts`, aiornot.vote, qaaas.dev, moshcoding, pairux.com,
vu1nz.com, bl0ggers, c0upons, recipepdfs.com webhook routes.

### 4. ringhuman.com — `packages/payments/src/coinpayportal.ts`

**Before:** `createInvoice` against a placeholder `/v1/invoices` endpoint;
local `verifyWebhook`.

**After:** the real API is payments, not invoices — switch to the client:

```ts
import { createCoinPayClient, verifyCoinPayWebhook } from "@profullstack/stack/coinpay";

const client = createCoinPayClient({ apiKey: cfg.apiKey });
const { paymentId, checkoutUrl } = await client.createCheckout({
  amountUsd: opts.amountUsdCents / 100,
  currency: "usdc_pol",
  description: opts.memo,
  metadata: { userId: opts.userId },
  webhookUrl: opts.callbackUrl,
});

// and for inbound webhooks:
verifyCoinPayWebhook({ signature, rawBody, secret: cfg.webhookSecret });
```

`merchantId` is no longer required (business API keys are scoped to one
business; pass `businessId` per-call only if you use a merchant JWT).

### 5. tronbrowsers.dev — `packages/auth/src/coinpay-oauth.ts`

**Before:** `CoinPayOAuthProvider` with an implemented `authorizeUrl` and
`exchangeCode`/`refresh` throwing "not implemented (M2)".

**After:** drop the class; the module functions cover the real flow:

```ts
import {
  generateCoinPayState,
  generateCoinPayPkcePair,
  getCoinPayAuthorizeUrl,
  exchangeCoinPayCode,
  fetchCoinPayUserinfo,
} from "@profullstack/stack/coinpay";

const state = generateCoinPayState();
const { codeVerifier, codeChallenge } = generateCoinPayPkcePair();
const url = getCoinPayAuthorizeUrl({
  clientId, redirectUri, state, codeChallenge,
  scopes: ["openid", "profile", "email", "did", "wallet:read"], // tronbrowsers scopes
});
// …back from the redirect:
const tokens = await exchangeCoinPayCode({ code, redirectUri, clientId, clientSecret, codeVerifier });
const claims = await fetchCoinPayUserinfo({ accessToken: tokens.access_token });
```

### 6. qrypt.chat — `src/lib/auth/coinpay.js` + login/callback routes

**Before:** hand-rolled helpers (`generateState`, `generatePkcePair`,
`validateState`, `buildAuthorizeUrl`, `exchangeCodeForToken`, `fetchUserinfo`)
plus two route files.

**After:** the helper mapping is 1:1 —

| qrypt.chat | `@profullstack/stack/coinpay` |
| --- | --- |
| `generateState()` | `generateCoinPayState()` |
| `generatePkcePair()` | `generateCoinPayPkcePair()` |
| `validateState(r, e)` | `validateCoinPayState(r, e)` |
| `buildAuthorizeUrl({…})` | `getCoinPayAuthorizeUrl({…})` |
| `exchangeCodeForToken({…})` | `exchangeCoinPayCode({…})` |
| `fetchUserinfo({…})` | `fetchCoinPayUserinfo({…})` |
| `COINPAY_STATE_COOKIE` | `COINPAY_STATE_COOKIE` |
| `COINPAY_SCOPES` | `COINPAY_DEFAULT_SCOPES` |
| `DEFAULT_COINPAY_ISSUER` | `COINPAY_DEFAULT_ISSUER` |

The routes collapse to the factories (username helpers —
`sanitizeUsernameBase` / `deriveUsernameBase` / `deriveUniqueUsername` — are
qrypt-specific provisioning, keep them in-app):

```ts
// app/api/auth/coinpay/login/route.ts
export const GET = createCoinPayLoginHandler({
  clientId: process.env.COINPAY_OAUTH_CLIENT_ID!,
  redirectUri: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/coinpay/callback`,
  issuer: process.env.COINPAY_OAUTH_ISSUER,
  extraState: (req) => ({ popup: new URL(req.url).searchParams.get("popup") === "1" }),
});

// app/api/auth/coinpay/callback/route.ts
export const GET = createCoinPayCallbackHandler({
  clientId: process.env.COINPAY_OAUTH_CLIENT_ID!,
  clientSecret: process.env.COINPAY_OAUTH_CLIENT_SECRET!,
  redirectUri: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/coinpay/callback`,
  issuer: process.env.COINPAY_OAUTH_ISSUER,
  appOrigin: process.env.NEXT_PUBLIC_APP_URL,
  onSuccess: async ({ claims, cookie }) => {
    // …existing find-or-create + magic-link session bridge…
    if (cookie["popup"]) return popupSessionResponse; // a Response
    return "/chat";
  },
});
```

### 7. Next.js app lib clients (crawlproof.com, ugig.net, aiornot.vote, qaaas.dev, moshcoding, pairux.com, vu1nz.com)

**Before:** each app has a `lib/coinpay.ts` with `createCheckout` /
`createPayment` / `getPaymentStatus` reading `COINPAY_API_KEY` /
`COINPAY_API_URL` / `COINPAY_MERCHANT_ID` from env per call.

**After:** construct one client at module scope and keep the app's thin
wrappers around it (price tables, descriptions, metadata conventions stay):

```ts
import { createCoinPayClient } from "@profullstack/stack/coinpay";

const coinpay = createCoinPayClient({
  apiKey: env.coinpayApiKey,
  baseUrl: env.coinpayApiUrl, // with or without "/api"
});

// crawlproof createCheckout → coinpay.createCheckout({ amountUsd: amountCents / 100, … })
// crawlproof getPaymentStatus → coinpay.getCheckout(paymentId)
```

Escrow, payout, invoice, and global-wallet helpers in those libs are **not**
covered by this module (this is the checkout/webhook/OAuth surface only) —
keep them until a future version of this package.
