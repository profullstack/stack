/**
 * CoinPay module — CoinPayPortal merchant client, webhook verification,
 * and "Log in with CoinPay" OAuth2/OIDC helpers.
 *
 * @example
 *   import {
 *     createCoinPayClient,
 *     verifyCoinPayWebhook,
 *     getCoinPayAuthorizeUrl,
 *     exchangeCoinPayCode,
 *     createCoinPayLoginHandler,
 *     createCoinPayCallbackHandler,
 *   } from "@profullstack/stack/coinpay";
 */

export {
  COINPAY_DEFAULT_BASE_URL,
  CoinPayApiError,
  createCoinPayClient,
} from "./client.js";
export type {
  CoinPayClient,
  CoinPayClientConfig,
  CoinPayCoin,
  CoinPayFetch,
  CoinPayPayment,
  CreateCheckoutInput,
  CreateCheckoutResult,
  GetCheckoutResult,
  ListCoinsOptions,
} from "./client.js";

export {
  COINPAY_WEBHOOK_SIGNATURE_HEADER,
  COINPAY_WEBHOOK_TOLERANCE_SECONDS,
  parseCoinPayWebhookEvent,
  signCoinPayWebhook,
  verifyCoinPayWebhook,
} from "./webhook.js";
export type { CoinPayWebhookEvent, VerifyCoinPayWebhookOptions } from "./webhook.js";

export {
  COINPAY_DEFAULT_ISSUER,
  COINPAY_DEFAULT_SCOPES,
  COINPAY_STATE_COOKIE,
  exchangeCoinPayCode,
  fetchCoinPayUserinfo,
  generateCoinPayPkcePair,
  generateCoinPayState,
  getCoinPayAuthorizeUrl,
  validateCoinPayState,
} from "./oauth.js";
export type {
  CoinPayOAuthTokens,
  CoinPayUserinfoClaims,
  ExchangeCoinPayCodeOptions,
  FetchCoinPayUserinfoOptions,
  GetCoinPayAuthorizeUrlOptions,
} from "./oauth.js";

export { createCoinPayCallbackHandler, createCoinPayLoginHandler } from "./next.js";
export type {
  CoinPayCallbackErrorCode,
  CoinPayCallbackResult,
  CoinPayCallbackSuccess,
  CreateCoinPayCallbackHandlerOptions,
  CreateCoinPayLoginHandlerOptions,
} from "./next.js";
