/**
 * @profullstack/stack/email — contact-form route handler + emailer re-exports.
 *
 * The contact form now lives in @profullstack/contact-form, which owns the
 * questions, the markup and the route. This module re-exports its
 * route-only API (createContactRoute, createContactGuard) unchanged, so the
 * apps already on it keep working; new code should import
 * createContactForm from "@profullstack/contact-form" directly.
 *
 *   import { createContactRoute } from "@profullstack/stack/email";
 *   export const POST = createContactRoute({
 *     to: "hello@example.com",
 *     from: "Example <noreply@example.com>",
 *   });
 *
 * Everything an app needs for email is re-exported here, so apps only
 * ever depend on "@profullstack/stack/email".
 */

import { Emailer, createEmailer } from "@profullstack/emailer";
import type {
  BulkSendOptions,
  BulkSendResult,
  EmailerConfig,
  SendOptions,
  SendResult,
} from "@profullstack/emailer";
import { createFormGuard, provenanceBlock, tagSubject } from "@profullstack/form-guard";
import type { FormGuard, FormGuardOptions, Verdict } from "@profullstack/form-guard";

export { Emailer, createEmailer };
export type { BulkSendOptions, BulkSendResult, EmailerConfig, SendOptions, SendResult };

export { createFormGuard, provenanceBlock, tagSubject };
export type { FormGuard, FormGuardOptions, Verdict };

export {
  createContactForm,
  createContactGuard,
  createContactRoute,
  escapeHtml,
  verifyCaptcha,
  withQuestions,
  DEFAULT_QUESTIONS,
} from "@profullstack/contact-form";
export type {
  CaptchaOptions,
  CaptchaProvider,
  ContactConfirmation,
  ContactForm,
  ContactFormOptions,
  ContactRequest,
  ContactResponseContext,
  ContactResponseSpec,
  ContactResponseStyle,
  ContactResponseValue,
  ContactRouteOptions,
  ContactRouteResponses,
  ContactSubmission,
  Question,
} from "@profullstack/contact-form";
