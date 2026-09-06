/**
 * @profullstack/stack/email — contact-form route handler + emailer re-exports.
 *
 * Replaces the hand-rolled Resend contact routes copy-pasted across the
 * Profullstack apps. Usage in app/api/contact/route.ts:
 *
 *   import { createContactRoute } from "@profullstack/stack/email";
 *   export const POST = createContactRoute({
 *     to: "hello@example.com",
 *     from: "Example <noreply@example.com>",
 *   });
 *
 * The handler validates the payload, ignores bots via a honeypot field,
 * optionally verifies an hCaptcha/Turnstile token, HTML-escapes all user
 * input, sends the notification through @profullstack/emailer (Resend),
 * and returns the JSON response shape your frontend already expects.
 *
 * A honeypot only catches a bot that renders your page, and most
 * contact-form spam does not — it POSTs straight at the handler, so the
 * hidden field is absent from the body rather than filled and the check
 * passes. Pass `guard` to require a signed proof-of-render token that a
 * request which never loaded the form cannot have. See
 * {@link createContactGuard}.
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
import {
  createFormGuard,
  provenanceBlock,
  tagSubject,
} from "@profullstack/form-guard";
import type { FormGuard, FormGuardOptions, Verdict } from "@profullstack/form-guard";

export { Emailer, createEmailer };
export type { BulkSendOptions, BulkSendResult, EmailerConfig, SendOptions, SendResult };

export { createFormGuard, provenanceBlock, tagSubject };
export type { FormGuard, FormGuardOptions, Verdict };

// ---------------------------------------------------------------------------
// Next.js interop (structural types + lazy require, so importing this module
// never forces a hard dependency on next).
// ---------------------------------------------------------------------------

/**
 * Structural subset of NextRequest used by the contact route. Any object
 * with a `json()` method works — including NextRequest and plain Request.
 */
export interface ContactRequest {
  json(): Promise<unknown>;
  /**
   * Present on NextRequest and plain Request. Optional so existing
   * callers still typecheck; without it the guard cannot read the
   * submitter's address and simply skips rate limiting.
   */
  headers?: { get(name: string): string | null };
}

// A plain `Response` — never NextResponse — so this module has zero Next
// dependency (usable from tests, scripts, plain Node). Next.js App Router
// accepts a standard Response interchangeably with NextResponse.json() for JSON.
function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Escape HTML special characters in user input before embedding in emails. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "firstName" → "First Name" (used for row labels and error messages). */
function humanizeField(field: string): string {
  return field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function isProduction(): boolean {
  return typeof process !== "undefined" && process.env.NODE_ENV === "production";
}

// ---------------------------------------------------------------------------
// Captcha
// ---------------------------------------------------------------------------

/** Supported captcha providers. */
export type CaptchaProvider = "hcaptcha" | "turnstile";

/** Server-side captcha verification options. */
export interface CaptchaOptions {
  provider: CaptchaProvider;
  /** Provider secret key (e.g. process.env.HCAPTCHA_SECRET). */
  secretKey: string;
  /**
   * Body field carrying the token. Defaults to "h-captcha-response" for
   * hCaptcha and "cf-turnstile-response" for Turnstile.
   */
  tokenField?: string;
  /** Override the provider's siteverify endpoint. */
  verifyUrl?: string;
}

const CAPTCHA_VERIFY_URLS: Record<CaptchaProvider, string> = {
  hcaptcha: "https://hcaptcha.com/siteverify",
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
};

const CAPTCHA_TOKEN_FIELDS: Record<CaptchaProvider, string> = {
  hcaptcha: "h-captcha-response",
  turnstile: "cf-turnstile-response",
};

/**
 * Verify a captcha token against the provider's siteverify endpoint.
 * Returns false on any failure (network error included) — fail closed.
 */
export async function verifyCaptcha(token: string, options: CaptchaOptions): Promise<boolean> {
  const verifyUrl = options.verifyUrl ?? CAPTCHA_VERIFY_URLS[options.provider];
  try {
    const res = await fetch(verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: options.secretKey, response: token }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/** Context handed to dynamic response factories. */
export interface ContactResponseContext {
  /** Validation/captcha/send error message, when applicable. */
  error?: string;
  /** Provider message id of the notification email, when sent. */
  messageId?: string;
  /** Id returned by the `persist` hook, when it returned one. */
  id?: string;
}

/** A concrete JSON response: body plus optional HTTP status (default 200). */
export interface ContactResponseSpec {
  body: unknown;
  status?: number;
}

/** A response either fixed or computed from the request outcome. */
export type ContactResponseValue =
  | ContactResponseSpec
  | ((ctx: ContactResponseContext) => ContactResponseSpec);

/** The responses a contact route can return. */
export interface ContactRouteResponses {
  /** Bot filled the honeypot — fake success so bots think it worked. */
  honeypot: ContactResponseValue;
  /** Validation, verify hook, or captcha failed (status 400). */
  invalid: ContactResponseValue;
  /** Submission accepted and processed. */
  success: ContactResponseValue;
  /** Notification email failed and `onSendError` is "fail" (status 500). */
  sendFailed: ContactResponseValue;
  /** Unhandled error: exception, persist failure, missing config (status 500). */
  error: ContactResponseValue;
  /**
   * The guard's token was stale or the form came back faster than a
   * person can type. Both happen to real senders, so this asks them to
   * send it again rather than losing the message (status 400).
   */
  retry?: ContactResponseValue;
  /** Too many submissions from one address (status 429). */
  limited?: ContactResponseValue;
}

/**
 * Response shape preset matching the variants found in the wild:
 * - "message": `{ message }` bodies (naallo, libertyhillcoin)
 * - "success": `{ success: true }` / `{ error }` (communitygardens, marksyncr, threatcrush) — default
 * - "ok":      `{ ok: true }` / `{ ok: false, error }` (profullstack-web, d0rz)
 */
export type ContactResponseStyle = "message" | "success" | "ok";

const STYLE_PRESETS: Record<ContactResponseStyle, ContactRouteResponses> = {
  message: {
    honeypot: { body: { message: "Message received!" } },
    invalid: (ctx) => ({ body: { message: ctx.error ?? "Invalid submission." }, status: 400 }),
    success: { body: { message: "Message received! We'll be in touch." } },
    sendFailed: { body: { message: "Something went wrong." }, status: 500 },
    error: { body: { message: "Something went wrong." }, status: 500 },
    retry: { body: { message: "That took too long. Please send it again." }, status: 400 },
    limited: { body: { message: "Too many messages. Please try again later." }, status: 429 },
  },
  success: {
    honeypot: { body: { success: true } },
    invalid: (ctx) => ({ body: { error: ctx.error ?? "Invalid submission." }, status: 400 }),
    success: (ctx) => ({
      body: {
        success: true,
        ...(ctx.messageId ? { messageId: ctx.messageId } : {}),
        ...(ctx.id ? { id: ctx.id } : {}),
      },
    }),
    sendFailed: {
      body: { error: "Failed to send message. Please try again later." },
      status: 500,
    },
    error: { body: { error: "An unexpected error occurred" }, status: 500 },
    retry: { body: { error: "That took too long. Please send it again." }, status: 400 },
    limited: { body: { error: "Too many messages. Please try again later." }, status: 429 },
  },
  ok: {
    honeypot: { body: { ok: true } },
    invalid: (ctx) => ({ body: { ok: false, error: ctx.error ?? "Invalid submission." }, status: 400 }),
    success: (ctx) => ({ body: { ok: true, ...(ctx.id ? { id: ctx.id } : {}) } }),
    sendFailed: { body: { ok: false, error: "Failed to send email" }, status: 500 },
    error: (ctx) => ({ body: { ok: false, error: ctx.error ?? "Internal server error" }, status: 500 }),
    retry: { body: { ok: false, error: "That took too long. Please send it again." }, status: 400 },
    limited: { body: { ok: false, error: "Too many messages. Please try again later." }, status: 429 },
  },
};

function respond(value: ContactResponseValue, ctx: ContactResponseContext): Response {
  const spec = typeof value === "function" ? value(ctx) : value;
  return jsonResponse(spec.body, { status: spec.status ?? 200 });
}

// ---------------------------------------------------------------------------
// Contact route
// ---------------------------------------------------------------------------

/** Normalized contact-form submission passed to hooks. */
export interface ContactSubmission {
  name: string;
  email: string;
  message: string;
  /**
   * All remaining non-empty submitted fields (stringified), minus core,
   * honeypot, captcha-token and `skipFields` entries. Insertion order of
   * the submitted JSON body is preserved.
   */
  fields: Record<string, string>;
  /** Raw parsed body (after `mapBody`, when configured). */
  raw: Record<string, unknown>;
}

/** Confirmation email sent to the submitter after a successful notification. */
export interface ContactConfirmation {
  subject: string;
  /** Static HTML or a template receiving the normalized submission. */
  html: string | ((submission: ContactSubmission) => string);
  /** Overrides the route-level `from` for the confirmation email. */
  from?: string;
}

/** Options for {@link createContactRoute}. */
export interface ContactRouteOptions {
  /** Address that receives the notification email. */
  to: string;
  /**
   * From header, e.g. "NAALLO <hello@naallo.com>". Also used as the
   * emailer's defaultFrom when the emailer is created implicitly.
   */
  from?: string;

  /** Pre-built Emailer instance. */
  emailer?: Emailer;
  /** Config used to lazily create an Emailer on the first request. */
  emailerConfig?: EmailerConfig;
  /**
   * Fully custom transport (e.g. a Mailgun adapter). When given, it
   * replaces the Emailer for both notification and confirmation emails.
   */
  send?: (mail: SendOptions) => Promise<SendResult>;

  /** Fields that must be non-empty strings. Default: ["name", "email", "message"]. */
  requiredFields?: string[];
  /**
   * Honeypot field name. Bots that fill it get a fake success response.
   * Default: "website". Pass false to disable.
   */
  honeypot?: string | false;
  /** Validate the email field format. Default: true. */
  validateEmail?: boolean;
  /** Preprocess the parsed body before any checks (e.g. combine firstName/lastName). */
  mapBody?: (body: Record<string, unknown>) => Record<string, unknown>;

  /**
   * Subject of the notification email. String or function of the
   * submission. Default: "New contact form submission from {name}".
   */
  subject?: string | ((submission: ContactSubmission) => string);
  /** Labels for extra fields, used in the email body and error messages. */
  fieldLabels?: Record<string, string>;
  /** Additional body fields to exclude from the email body. */
  skipFields?: string[];
  /** Also generate a plaintext body. Default: true. */
  text?: boolean;

  /** Send a confirmation email to the submitter. Failures are logged, not fatal. */
  confirmation?: ContactConfirmation;

  /**
   * Proof-of-render guard.
   *
   * A honeypot only catches a bot that renders your page. Most
   * contact-form spam POSTs straight at the handler, so the hidden field
   * is absent from the body rather than filled and the honeypot check
   * passes. The guard requires a signed token minted when the form
   * renders, which a request that never loaded the page cannot have.
   *
   * Pass the options and the route builds the guard, or pass a guard you
   * already built so the page rendering the form can share it — see
   * {@link createContactGuard}. The two must agree on `binding` and the
   * field names or every real submission is rejected.
   */
  guard?: FormGuardOptions | FormGuard;

  /** Server-side captcha verification (hCaptcha/Turnstile). */
  captcha?: CaptchaOptions;
  /**
   * Custom verification hook. Return true to accept, false or an error
   * message string to reject with a 400.
   */
  verify?: (
    body: Record<string, unknown>,
    req: ContactRequest,
  ) => Promise<boolean | string> | boolean | string;

  /**
   * Persist the submission (e.g. a Supabase insert). Return an id to
   * include it in the success response. A thrown error fails the request
   * with the "error" response (500).
   */
  persist?: (submission: ContactSubmission) => Promise<string | undefined> | string | undefined;

  /**
   * What to do when the notification email fails: "fail" returns the
   * sendFailed response (500), "ignore" logs and still returns success.
   * Default: "fail".
   */
  onSendError?: "fail" | "ignore";
  /**
   * Behavior when no emailer/send is configured (and RESEND_API_KEY is
   * unset): "log" prints the submission and succeeds, "error" fails 500.
   * Default: "error" in production, "log" otherwise.
   */
  onMissingEmailer?: "log" | "error";

  /** Response shape preset. Default: "success". */
  style?: ContactResponseStyle;
  /** Per-response overrides merged over the chosen style preset. */
  responses?: Partial<ContactRouteResponses>;
}

/**
 * Build a guard the form page and the route can share.
 *
 * The page needs it to mint a token at render time; the route needs the
 * identical configuration to verify one. Export a single guard from a
 * module both import, rather than configuring it twice — a `binding` or
 * field-name mismatch rejects every genuine submission, silently.
 *
 *   // lib/contact-guard.ts
 *   export const contactGuard = createContactGuard({
 *     secret: process.env.RESEND_API_KEY!,
 *     binding: "contact",
 *   });
 *
 *   // app/contact/page.tsx (a server component)
 *   const token = await contactGuard.issue();
 *   return <ContactForm token={token} fields={contactGuard.fields(token)} />;
 *
 *   // app/api/contact/route.ts
 *   export const POST = createContactRoute({ to: "…", guard: contactGuard });
 */
export function createContactGuard(options: FormGuardOptions): FormGuard {
  return createFormGuard(options);
}

/**
 * Create a Next.js App Router POST handler for a contact form.
 *
 *   export const POST = createContactRoute({ to: "hello@example.com" });
 *
 * With no `emailer`/`emailerConfig`/`send`, the handler falls back to
 * process.env.RESEND_API_KEY, and if that is also missing it logs the
 * submission (or fails in production — see `onMissingEmailer`).
 */
export function createContactRoute(
  options: ContactRouteOptions,
): (req: ContactRequest) => Promise<Response> {
  const {
    to,
    from,
    requiredFields = ["name", "email", "message"],
    honeypot = "website",
    validateEmail = true,
  } = options;
  const responses: ContactRouteResponses = {
    ...STYLE_PRESETS[options.style ?? "success"],
    ...options.responses,
  };
  const labelFor = (field: string): string =>
    options.fieldLabels?.[field] ?? humanizeField(field);

  // Accept either a pre-built guard (shared with the page that renders
  // the form) or the options to build one here.
  const guard: FormGuard | null = options.guard
    ? "check" in options.guard
      ? options.guard
      : createFormGuard(options.guard)
    : null;

  let cachedEmailer: Emailer | undefined;

  function configFromEnv(): EmailerConfig | null {
    const key = typeof process !== "undefined" ? process.env.RESEND_API_KEY : undefined;
    return key ? { resendApiKey: key, defaultFrom: from } : null;
  }

  function resolveSender(): ((mail: SendOptions) => Promise<SendResult>) | null {
    if (options.send) return options.send;
    if (options.emailer) {
      const emailer = options.emailer;
      return (mail) => emailer.send(mail);
    }
    if (!cachedEmailer) {
      const config = options.emailerConfig ?? configFromEnv();
      if (!config) return null;
      cachedEmailer = createEmailer(config);
    }
    const emailer = cachedEmailer;
    return (mail) => emailer.send(mail);
  }

  async function POST(req: ContactRequest): Promise<Response> {
    try {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return respond(responses.invalid, { error: "Invalid JSON body" });
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return respond(responses.invalid, { error: "Invalid JSON body" });
      }
      let body = raw as Record<string, unknown>;
      if (options.mapBody) body = options.mapBody(body);

      // Honeypot check — real users never fill this hidden field.
      if (honeypot !== false) {
        const trap = body[honeypot];
        if (typeof trap === "string" && trap.trim() !== "") {
          return respond(responses.honeypot, {});
        }
      }

      // Proof-of-render guard. Runs before validation on purpose: a bot
      // that gets "Name is required" back has learned what to send next
      // time, where one that gets a plain success has learned nothing.
      let verdict: Verdict | null = null;
      if (guard) {
        verdict = await guard.check({ fields: body, headers: req.headers ?? null });
        if (!verdict.allow) {
          if (verdict.action === "drop") {
            console.warn(
              `[contact] dropped submission (${verdict.reason}) ip=${verdict.ip ?? "?"}`,
            );
            // Reported as success so the sender cannot tell which check
            // caught it — the same answer the honeypot gives.
            return respond(responses.honeypot, {});
          }
          if (verdict.action === "limited") {
            return respond(responses.limited ?? responses.invalid, {
              error: "Too many messages. Please try again later.",
            });
          }
          return respond(responses.retry ?? responses.invalid, {
            error: "That took too long. Please send it again.",
          });
        }
      }

      // Custom verification hook.
      if (options.verify) {
        const verdict = await options.verify(body, req);
        if (verdict !== true) {
          return respond(responses.invalid, {
            error: typeof verdict === "string" ? verdict : "Verification failed",
          });
        }
      }

      // Captcha verification.
      if (options.captcha) {
        const tokenField =
          options.captcha.tokenField ?? CAPTCHA_TOKEN_FIELDS[options.captcha.provider];
        const token = body[tokenField];
        const passed =
          typeof token === "string" && token !== ""
            ? await verifyCaptcha(token, options.captcha)
            : false;
        if (!passed) {
          return respond(responses.invalid, { error: "Captcha verification failed" });
        }
      }

      const str = (key: string): string => {
        const value = body[key];
        return typeof value === "string" ? value.trim() : "";
      };
      const name = str("name");
      const email = str("email");
      const message = str("message");

      // Required field validation.
      for (const field of requiredFields) {
        if (str(field) === "") {
          return respond(responses.invalid, { error: `${labelFor(field)} is required` });
        }
      }

      // Email format validation.
      if (validateEmail && email !== "" && !EMAIL_RE.test(email)) {
        return respond(responses.invalid, { error: "Valid email is required" });
      }

      // Collect extra fields for the email body.
      const skip = new Set(["name", "email", "message", ...(options.skipFields ?? [])]);
      if (honeypot !== false) skip.add(honeypot);
      if (guard) {
        // Plumbing, not content — neither belongs in the email body.
        skip.add(guard.config.tokenField);
        skip.add(guard.config.honeypotField);
      }
      if (options.captcha) {
        skip.add(options.captcha.tokenField ?? CAPTCHA_TOKEN_FIELDS[options.captcha.provider]);
      }
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(body)) {
        if (skip.has(key) || value === undefined || value === null) continue;
        const s = typeof value === "string" ? value.trim() : String(value);
        if (s === "") continue;
        fields[key] = s;
      }

      const submission: ContactSubmission = { name, email, message, fields, raw: body };

      // Optional persistence (Supabase insert etc.).
      let id: string | undefined;
      if (options.persist) id = (await options.persist(submission)) ?? undefined;

      // Send the notification email.
      const sender = resolveSender();
      let messageId: string | undefined;
      if (!sender) {
        const mode = options.onMissingEmailer ?? (isProduction() ? "error" : "log");
        if (mode === "error") {
          return respond(responses.error, { error: "Email not configured" });
        }
        console.log(`[contact] Submission from ${name} <${email}>:`, fields, message);
      } else {
        const subjectText =
          typeof options.subject === "function"
            ? options.subject(submission)
            : (options.subject ??
              (name ? `New contact form submission from ${name}` : "New contact form submission"));
        // A flagged message is still delivered; the tag is there so an
        // inbox rule can sort it. The heading stays clean — the score and
        // the signals behind it go in the provenance block below.
        const mailSubject = verdict ? tagSubject(subjectText, verdict) : subjectText;

        const htmlRows: string[] = [];
        if (name) htmlRows.push(`<p><strong>Name:</strong> ${escapeHtml(name)}</p>`);
        if (email) htmlRows.push(`<p><strong>Email:</strong> ${escapeHtml(email)}</p>`);
        const textLines: string[] = [];
        if (name) textLines.push(`Name: ${name}`);
        if (email) textLines.push(`Email: ${email}`);
        for (const [key, value] of Object.entries(fields)) {
          htmlRows.push(`<p><strong>${escapeHtml(labelFor(key))}:</strong> ${escapeHtml(value)}</p>`);
          textLines.push(`${labelFor(key)}: ${value}`);
        }
        const htmlParts = [`<h2>${escapeHtml(subjectText)}</h2>`, ...htmlRows];
        if (message) {
          htmlParts.push(
            "<hr />",
            "<p><strong>Message:</strong></p>",
            `<p>${escapeHtml(message).replace(/\n/g, "<br />")}</p>`,
          );
          textLines.push("", "Message:", message);
        }

        // Where it came from and why it scored as it did. None of this is
        // in the mail headers: the notification is sent by us to us, so it
        // authenticates perfectly whoever filled the form in.
        if (verdict) {
          const provenance = provenanceBlock({
            ip: verdict.ip,
            userAgent: verdict.userAgent,
            verdict,
          });
          htmlParts.push(
            "<hr />",
            `<pre style="font:12px/1.5 monospace;color:#666">${escapeHtml(provenance)}</pre>`,
          );
          textLines.push("", provenance);
        }

        const mail: SendOptions = {
          to,
          from,
          subject: mailSubject,
          html: htmlParts.join("\n"),
          text: options.text === false ? undefined : textLines.join("\n"),
          replyTo: email !== "" ? email : undefined,
        };

        const result = await sender(mail);
        if (!result.sent) {
          if ((options.onSendError ?? "fail") === "fail") {
            console.error("Contact form send error:", result.error);
            return respond(responses.sendFailed, { error: result.error });
          }
          console.error("Contact form send error (ignored):", result.error);
        } else {
          messageId = result.id;
        }

        // Confirmation email to the submitter (non-fatal on failure).
        if (options.confirmation && email !== "") {
          try {
            const confirmation = options.confirmation;
            const confirmResult = await sender({
              to: email,
              from: confirmation.from ?? from,
              subject: confirmation.subject,
              html:
                typeof confirmation.html === "function"
                  ? confirmation.html(submission)
                  : confirmation.html,
            });
            if (!confirmResult.sent) {
              console.error("Contact confirmation send error:", confirmResult.error);
            }
          } catch (err) {
            console.error("Contact confirmation error:", err);
          }
        }
      }

      return respond(responses.success, { messageId, id });
    } catch (err) {
      console.error("Contact form error:", err);
      return respond(responses.error, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return POST;
}
