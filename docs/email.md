# @profullstack/stack/email

Contact-form route handler plus everything an app needs for sending email.
Replaces the hand-rolled Resend contact routes copy-pasted across the
Profullstack apps (naallo, d0rz, libertyhillcoin, communitygardens-web,
trajectory-web, profullstack-web, marksyncr, threatcrush, …).

The route handler validates the payload, ignores bots via a honeypot field,
optionally verifies an hCaptcha/Turnstile token, HTML-escapes all user input
(several of the old routes injected raw form data into HTML emails — a
stored-XSS vector in every inbox), and sends via
[`@profullstack/emailer`](https://www.npmjs.com/package/@profullstack/emailer)
(Resend). The whole `Emailer` API is re-exported, so apps depend only on
`@profullstack/stack/email`.

## Install / import

```bash
npm install @profullstack/stack
```

```ts
import { createContactRoute, createEmailer, Emailer } from "@profullstack/stack/email";
```

`next` is an optional peer: the handler always returns a standard Web
`Response` (no `next/server` import at all), which is a valid return value
for App Router route handlers — and keeps the module bundler-proof.

## Quick start

```ts
// app/api/contact/route.ts
import { createContactRoute } from "@profullstack/stack/email";

export const POST = createContactRoute({
  to: "hello@example.com",
  from: "Example <noreply@example.com>",
});
```

With no `emailer` / `emailerConfig` / `send` option, the handler falls back to
`process.env.RESEND_API_KEY`. If that is also missing it logs the submission
and returns success outside production (`NODE_ENV !== "production"`), or fails
with 500 in production — override with `onMissingEmailer`.

## API reference

### `createContactRoute(options: ContactRouteOptions): (req: ContactRequest) => Promise<Response>`

Returns the `POST` handler to export from `app/api/contact/route.ts`.

Request flow: parse JSON → `mapBody` → honeypot → `verify` hook → captcha →
required-field validation → email-format validation → `persist` → send
notification → send confirmation → success response. Any unexpected throw
(including a `persist` failure) returns the `error` response (500).

#### `ContactRouteOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `to` | `string` | **required** | Address that receives the notification email. |
| `from` | `string` | — | From header, e.g. `"NAALLO <hello@naallo.com>"`. Also used as `defaultFrom` when the emailer is created implicitly. |
| `emailer` | `Emailer` | — | Pre-built emailer instance. |
| `emailerConfig` | `EmailerConfig` | — | Lazily creates an `Emailer` on first request. |
| `send` | `(mail: SendOptions) => Promise<SendResult>` | — | Fully custom transport (e.g. a Mailgun adapter); replaces the Emailer for notification and confirmation. |
| `requiredFields` | `string[]` | `["name","email","message"]` | Fields that must be non-empty strings. First missing field fails with `"{Label} is required"` (400). |
| `honeypot` | `string \| false` | `"website"` | Honeypot field; bots filling it get a fake success. `false` disables. |
| `validateEmail` | `boolean` | `true` | Validate email format (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`), failing with `"Valid email is required"` (400). |
| `mapBody` | `(body) => body` | — | Preprocess the parsed body before all checks (e.g. combine `firstName`/`lastName`). |
| `subject` | `string \| (submission) => string` | `"New contact form submission from {name}"` | Subject of the notification email. |
| `fieldLabels` | `Record<string, string>` | — | Labels for fields in the email body and error messages (`firstName` → `"First Name"` by default). |
| `skipFields` | `string[]` | — | Extra body fields to exclude from the email. Core fields, the honeypot and the captcha token are always excluded. |
| `text` | `boolean` | `true` | Also generate a plaintext body. |
| `confirmation` | `ContactConfirmation` | — | Confirmation email to the submitter: `{ subject, html, from? }`; `html` may be a function of the submission. Failures are logged, never fatal. |
| `captcha` | `CaptchaOptions` | — | Server-side captcha check: `{ provider: "hcaptcha" \| "turnstile", secretKey, tokenField?, verifyUrl? }`. |
| `verify` | `(body, req) => boolean \| string \| Promise<…>` | — | Custom verification hook. `true` accepts; `false` or a string rejects with 400 (string becomes the error message). |
| `persist` | `(submission) => string \| undefined \| Promise<…>` | — | Persist the submission (e.g. Supabase insert). Returned id is included in the success response; a throw fails the request (500). |
| `onSendError` | `"fail" \| "ignore"` | `"fail"` | `"ignore"` logs email-send failures and still returns success. |
| `onMissingEmailer` | `"log" \| "error"` | `"log"` dev / `"error"` prod | Behavior when no transport is configured at all. |
| `style` | `"message" \| "success" \| "ok"` | `"success"` | Response shape preset (see below). |
| `responses` | `Partial<ContactRouteResponses>` | — | Per-response overrides merged over the preset. |

#### `ContactSubmission` (given to `subject`, `persist`, `confirmation.html`, `verify`)

```ts
{
  name: string;
  email: string;
  message: string;
  fields: Record<string, string>; // all other non-empty fields, body order preserved
  raw: Record<string, unknown>;   // parsed body (after mapBody)
}
```

#### Response shapes

The five responses a route can return (`ContactRouteResponses`): `honeypot`,
`invalid`, `success`, `sendFailed`, `error`. Each is either
`{ body, status? }` or `(ctx: { error?, messageId?, id? }) => { body, status? }`.

Presets:

| Response | `message` (naallo, libertyhillcoin) | `success` (default; communitygardens, trajectory, marksyncr, threatcrush) | `ok` (profullstack-web, d0rz) |
| --- | --- | --- | --- |
| honeypot | `{ message: "Message received!" }` 200 | `{ success: true }` 200 | `{ ok: true }` 200 |
| invalid | `{ message: err }` 400 | `{ error: err }` 400 | `{ ok: false, error: err }` 400 |
| success | `{ message: "Message received! We'll be in touch." }` 200 | `{ success: true, messageId?, id? }` 200 | `{ ok: true, id? }` 200 |
| sendFailed | `{ message: "Something went wrong." }` 500 | `{ error: "Failed to send message. Please try again later." }` 500 | `{ ok: false, error: "Failed to send email" }` 500 |
| error | `{ message: "Something went wrong." }` 500 | `{ error: "An unexpected error occurred" }` 500 | `{ ok: false, error: err }` 500 |

### `escapeHtml(value: string): string`

Escapes `& < > " '`. Applied to every user-controlled value embedded in the
HTML email; the plaintext body keeps raw values.

### `verifyCaptcha(token: string, options: CaptchaOptions): Promise<boolean>`

Standalone siteverify helper (used internally by the `captcha` option). Fails
closed: returns `false` on provider rejection, HTTP error, or network
exception. Default endpoints: `https://hcaptcha.com/siteverify`,
`https://challenges.cloudflare.com/turnstile/v0/siteverify`; default token
fields `h-captcha-response` / `cf-turnstile-response`.

### Re-exports from `@profullstack/emailer`

`Emailer`, `createEmailer(config)`, and the types `EmailerConfig`,
`SendOptions`, `BulkSendOptions`, `SendResult`, `BulkSendResult`.

```ts
import { createEmailer } from "@profullstack/stack/email";

const emailer = createEmailer({
  resendApiKey: process.env.RESEND_API_KEY,
  defaultFrom: "Example <noreply@example.com>",
});
await emailer.send({ to: "user@example.com", subject: "Hi", html: "<p>Hi</p>" });
await emailer.sendBulk({ to: list, subject: "News", html: (r) => `<p>Hi ${r}</p>` });
```

## Migration recipes

Every recipe replaces the whole `app/api/contact/route.ts` (or `.js`) file.
Response shapes are preserved, so no frontend changes are needed. All recipes
also gain HTML-escaping of user input (the old routes interpolated raw input).

### naallo — `src/app/api/contact/route.ts`

Before: direct `Resend` client, `{ message }` responses, honeypot `website`,
extra fields phone/service, confirmation email to the customer, env-driven
from/to.

After:

```ts
import { createContactRoute } from "@profullstack/stack/email";

const FROM = process.env.EMAIL_FROM || "hello@naallo.com";
const FROM_NAME = process.env.EMAIL_FROM_NAME || "NAALLO";

export const POST = createContactRoute({
  style: "message",
  from: `${FROM_NAME} <${FROM}>`,
  to: process.env.CONTACT_EMAIL || FROM,
  fieldLabels: { phone: "Phone", service: "Service" },
  subject: (s) => `New Inquiry from ${s.name} — ${s.fields.service ?? "General"}`,
  confirmation: {
    subject: "Got your message — NAALLO",
    html: (s) => `
      <p>Hey ${s.name},</p>
      <p>Thanks for reaching out! I got your message and will get back to you soon.</p>
      <p>Talk soon,<br>NAALLO</p>
    `,
  },
});
```

Note: `s.name` in the confirmation template is safe to interpolate only if you
escape it — wrap with `escapeHtml(s.name)` (exported from the same module) if
the template embeds it in HTML. Differences vs. the old route: missing-field
errors read `"Name is required"` instead of one combined sentence (override
`responses.invalid` if you need the old string verbatim), and a failed
confirmation email no longer turns an already-delivered notification into a
500.

### libertyhillcoin.com — `app/api/contact/route.ts`

Identical drift as naallo. After:

```ts
import { createContactRoute, escapeHtml } from "@profullstack/stack/email";

const FROM = process.env.EMAIL_FROM || "info@libertyhillcoin.com";
const FROM_NAME = process.env.EMAIL_FROM_NAME || "Liberty Hill Coin";

export const POST = createContactRoute({
  style: "message",
  from: `${FROM_NAME} <${FROM}>`,
  to: process.env.CONTACT_EMAIL || FROM,
  fieldLabels: { phone: "Phone" },
  subject: (s) => `New Appraisal Request from ${s.name}`,
  confirmation: {
    subject: "We received your appraisal request — Liberty Hill Coin",
    html: (s) => `
      <p>Hi ${escapeHtml(s.name)},</p>
      <p>Thank you for reaching out to Liberty Hill Coin! We've received your message and will get back to you within 1 business day.</p>
      <p>In the meantime, feel free to call us if you have any urgent questions.</p>
      <p>Best regards,<br>Liberty Hill Coin</p>
    `,
  },
});
```

### d0rz — `app/api/contact/route.ts`

Before: zod validation via `parseJson`, optional Supabase insert, Resend
text-only notification, dev-mode console log when `RESEND_API_KEY` is unset
(500 in production), `{ ok }` responses.

After (zod schema becomes redundant — the route validates; keep
`persist` for the DB insert):

```ts
import { createContactRoute } from "@profullstack/stack/email";
import { getServerSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";

export const POST = createContactRoute({
  style: "ok",
  from: process.env.EMAIL_FROM ?? "noreply@d0rz.com",
  to: "hello@d0rz.com",
  requiredFields: ["email", "name", "topic", "message"],
  subject: (s) => `[d0rz contact – ${s.fields.topic}] ${s.name}`,
  persist: async (s) => {
    const supabase = getServerSupabase();
    if (!supabase) return undefined;
    const { error, data } = await supabase
      .from("contact_inquiries")
      .insert({ email: s.email, name: s.name, topic: s.fields.topic, message: s.message })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data?.id as string | undefined;
  },
  responses: {
    sendFailed: (ctx) => ({ body: { ok: false, error: ctx.error }, status: 500 }),
  },
});
```

Behavior preserved: dev log when unconfigured, 500 `"Email not configured"`
in production, success body `{ ok: true, id }`, send error surfaces the
Resend message. The zod `ContactInput` schema/`parseJson` usage in this route
can be deleted (used nowhere else).

### communitygardens-web — `src/app/api/contact/route.ts` and trajectory-web — `src/app/api/contact/route.ts`

Both currently only honeypot-check and `console.log` — they send no email.
The direct replacement keeps that behavior (log mode is the default outside
production):

```ts
import { createContactRoute } from "@profullstack/stack/email";

export const POST = createContactRoute({ to: "hello@communitygardens.example" });
```

To actually start delivering mail, just set `RESEND_API_KEY` (and `from`) —
no code change needed. Response shape `{ success: true }` is preserved.

### profullstack-web — `src/app/api/contact/route.ts`

Before: Mailgun transport, `{ ok }` responses, honeypot `website`, legacy
`firstName`/`lastName` support, dynamic extra-field rows, no required-field
validation, `h:Reply-To` header.

After — recommended: switch to Resend (set `RESEND_API_KEY`), which also
enables hCaptcha (the README advertises hCaptcha on `/contact`; wire the
secret and the frontend token field):

```ts
import { createContactRoute } from "@profullstack/stack/email";

export const POST = createContactRoute({
  style: "ok",
  from: `Profullstack Contact <${process.env.FROM_EMAIL || "hello@profullstack.com"}>`,
  to: process.env.TO_EMAIL || "anthony@profullstack.com",
  requiredFields: ["email"],
  skipFields: ["type", "firstName", "lastName"],
  mapBody: (b) => ({
    ...b,
    name:
      (typeof b.name === "string" && b.name) ||
      [b.firstName, b.lastName].filter(Boolean).join(" "),
  }),
  subject: (s) => `New ${s.fields.type ?? "Contact Form"} Submission`,
  fieldLabels: {
    company: "Company / Project",
    projectDescription: "Project Description",
    description: "Project Description",
    budget: "Budget",
    projectType: "Project Type",
    timeline: "Timeline",
    existingUrl: "Existing URL",
  },
  captcha: process.env.HCAPTCHA_SECRET
    ? { provider: "hcaptcha", secretKey: process.env.HCAPTCHA_SECRET }
    : undefined,
});
```

If Mailgun must be kept during transition, pass a custom `send` transport
instead of `from`:

```ts
send: async (mail) => {
  const form = new URLSearchParams();
  form.append("from", mail.from ?? "");
  form.append("to", mail.to);
  form.append("subject", mail.subject);
  if (mail.text) form.append("text", mail.text);
  form.append("html", mail.html);
  if (mail.replyTo) form.append("h:Reply-To", mail.replyTo);
  const res = await fetch(`https://api.mailgun.net/v3/${process.env.MAILGUN_DOMAIN}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${process.env.MAILGUN_API_KEY}`).toString("base64")}`,
    },
    body: form,
  });
  return res.ok ? { sent: true } : { sent: false, error: await res.text() };
},
```

Old route never 400'd missing fields; `requiredFields: ["email"]` is the
minimal sensible tightening — use `requiredFields: []` for exact parity.

### marksyncr.com — `apps/web/app/api/contact/route.js`

Before: lazy `Resend` client, four required fields, email regex, `{ success,
messageId }` / `{ error }` responses, subject from the form's `subject` field.

After (can stay `.js`):

```js
import { createContactRoute } from "@profullstack/stack/email";

export const POST = createContactRoute({
  from: "MarkSyncr Contact <noreply@marksyncr.com>",
  to: "support@marksyncr.com",
  requiredFields: ["name", "email", "subject", "message"],
  subject: (s) => `[Contact Form] ${s.fields.subject}`,
});
```

`{ success: true, messageId }` is emitted automatically. Old error strings
("All fields are required", "Invalid email format") become per-field
messages — the frontend renders `data.error`, so no change needed; pin exact
strings via `responses.invalid` if desired.

### threatcrush — `apps/web/src/app/api/contact/route.ts`

Before: per-field validation messages, Supabase insert into
`contact_requests`, best-effort Resend notification (failures logged, not
fatal), `{ success, id }` responses.

After:

```ts
import { createContactRoute } from "@profullstack/stack/email";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let supabase: SupabaseClient | undefined;
function getSupabase() {
  if (supabase) return supabase;
  supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return supabase;
}

export const POST = createContactRoute({
  from: "ThreatCrush <hello@threatcrush.com>",
  to: "hello@threatcrush.com",
  honeypot: false,
  fieldLabels: { email: "Valid email" },
  subject: (s) => `[ThreatCrush] New ${s.fields.topic ?? "general"} inquiry from ${s.name}`,
  onSendError: "ignore",
  persist: async (s) => {
    const { data, error } = await getSupabase()
      .from("contact_requests")
      .insert({
        name: s.name,
        email: s.email.toLowerCase(),
        company: s.fields.company ?? null,
        message: s.message,
        topic: s.fields.topic ?? "general",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  },
  responses: {
    error: { body: { error: "Failed to submit request" }, status: 500 },
  },
});
```

Behavior preserved: per-field 400s (`email: "Valid email is required"` via
`fieldLabels`), success `{ success: true, id }`, insert failure → 500
`"Failed to submit request"`, email failure logged not fatal. (The old route
had no honeypot, hence `honeypot: false`.)
