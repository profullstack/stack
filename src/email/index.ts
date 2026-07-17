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

export { Emailer, createEmailer };
export type { BulkSendOptions, BulkSendResult, EmailerConfig, SendOptions, SendResult };

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

/** The five responses a contact route can return. */
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
  },
  ok: {
    honeypot: { body: { ok: true } },
    invalid: (ctx) => ({ body: { ok: false, error: ctx.error ?? "Invalid submission." }, status: 400 }),
    success: (ctx) => ({ body: { ok: true, ...(ctx.id ? { id: ctx.id } : {}) } }),
    sendFailed: { body: { ok: false, error: "Failed to send email" }, status: 500 },
    error: (ctx) => ({ body: { ok: false, error: ctx.error ?? "Internal server error" }, status: 500 }),
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

        const mail: SendOptions = {
          to,
          from,
          subject: subjectText,
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
