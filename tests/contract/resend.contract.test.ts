/**
 * CONTRACT TEST — @profullstack/stack/email ↔ Resend API.
 *
 * The email module sends through the real @profullstack/emailer package
 * (node_modules/@profullstack/emailer/dist/index.js), which posts to Resend:
 *
 *   POST https://api.resend.com/emails
 *   Authorization: Bearer <RESEND_API_KEY>
 *   Content-Type: application/json
 *   { from, to, subject, html, text?, reply_to?, headers?, attachments? }
 *   → 200 { id } | 4xx { error: string | { message } }
 *
 * (emailer/dist/index.js:1-18 resendSend, :41-59 Emailer.send — note the
 * camelCase `replyTo` → snake_case `reply_to` conversion at line 52.)
 *
 * These tests drive createContactRoute end-to-end with a mocked global fetch
 * and pin the exact payload that hits the Resend API, plus the escaping
 * contract: user input is HTML-escaped in `html` but raw in `text`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createContactRoute, type ContactRequest } from "../../src/email/index.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const API_KEY = "re_test_123456789";

type RecordedCall = { url: string; init: RequestInit; json: Record<string, unknown> };

const calls: RecordedCall[] = [];
let handler: (call: RecordedCall) => Response;

function makeReq(body: unknown): ContactRequest {
  return { json: async () => body };
}

beforeEach(() => {
  calls.length = 0;
  handler = () =>
    new Response(JSON.stringify({ id: "resend_msg_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      init: init ?? {},
      json: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    };
    calls.push(call);
    return handler(call);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROUTE_OPTS = {
  to: "hello@example.com",
  from: "Example <noreply@example.com>",
  emailerConfig: { resendApiKey: API_KEY },
} as const;

describe("createContactRoute → Resend POST /emails", () => {
  it("POSTs to https://api.resend.com/emails with Bearer auth and JSON body", async () => {
    const POST = createContactRoute(ROUTE_OPTS);
    const res = await POST(
      makeReq({ name: "Jane Doe", email: "jane@example.com", message: "Hello there" }),
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(RESEND_ENDPOINT);
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends exactly the Resend payload keys: from/to/subject/html/text/reply_to", async () => {
    const POST = createContactRoute(ROUTE_OPTS);
    await POST(
      makeReq({ name: "Jane Doe", email: "jane@example.com", message: "Hello there" }),
    );

    const payload = calls[0]!.json;
    expect(payload["from"]).toBe("Example <noreply@example.com>");
    expect(payload["to"]).toBe("hello@example.com");
    expect(payload["subject"]).toBe("New contact form submission from Jane Doe");
    expect(typeof payload["html"]).toBe("string");
    expect(typeof payload["text"]).toBe("string");
    // The submitter's address becomes the Reply-To — snake_case on the wire
    // (emailer converts opts.replyTo → reply_to).
    expect(payload["reply_to"]).toBe("jane@example.com");
    expect(payload).not.toHaveProperty("replyTo");
    // Only the documented Resend keys (plus the emailer's pass-through
    // optional keys) may be present.
    for (const key of Object.keys(payload)) {
      expect(["from", "to", "subject", "html", "text", "reply_to", "headers", "attachments"])
        .toContain(key);
    }
  });

  it("HTML-escapes user input in html but keeps it raw in text", async () => {
    const evil = `<script>alert("xss")</script> & <b>bold</b>`;
    const POST = createContactRoute(ROUTE_OPTS);
    await POST(makeReq({ name: evil, email: "jane@example.com", message: evil }));

    const payload = calls[0]!.json;
    const html = String(payload["html"]);
    const text = String(payload["text"]);

    // html: no raw markup from the user may survive.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(html).toContain("&amp;");
    // Subject embeds the raw name (it is a plain-text header, not HTML).
    expect(payload["subject"]).toBe(`New contact form submission from ${evil}`);
    // text: the plaintext part carries the input verbatim (no HTML entities).
    expect(text).toContain(evil);
    expect(text).not.toContain("&lt;script&gt;");
  });

  it("escapes extra fields in html and labels them (humanized) in both parts", async () => {
    const POST = createContactRoute(ROUTE_OPTS);
    await POST(
      makeReq({
        name: "Jane",
        email: "jane@example.com",
        message: "hi",
        companyName: `<img src=x onerror=alert(1)>`,
      }),
    );

    const payload = calls[0]!.json;
    const html = String(payload["html"]);
    const text = String(payload["text"]);
    expect(html).toContain(
      "<p><strong>Company Name:</strong> &lt;img src=x onerror=alert(1)&gt;</p>",
    );
    expect(text).toContain("Company Name: <img src=x onerror=alert(1)>");
  });

  it("maps Resend's success { id } to a 200 success response with messageId", async () => {
    const POST = createContactRoute(ROUTE_OPTS);
    const res = await POST(
      makeReq({ name: "Jane", email: "jane@example.com", message: "hi" }),
    );
    expect(res.status).toBe(200);
    // Default "success" style preset echoes the provider message id.
    expect(await res.json()).toEqual({ success: true, messageId: "resend_msg_1" });
  });

  it("maps a Resend 4xx error envelope to a 500 sendFailed response", async () => {
    // emailer accepts both error shapes: { error: string } or
    // { error: { message } } (emailer/dist/index.js:11-15).
    handler = () =>
      new Response(JSON.stringify({ error: { message: "The from address is invalid" } }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    const POST = createContactRoute(ROUTE_OPTS);
    const res = await POST(
      makeReq({ name: "Jane", email: "jane@example.com", message: "hi" }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Failed to send message. Please try again later.",
    });
  });

  it("sends the confirmation email as a second Resend POST to the submitter", async () => {
    const POST = createContactRoute({
      ...ROUTE_OPTS,
      confirmation: {
        subject: "We received your message",
        html: "<p>Thanks for reaching out.</p>",
      },
    });
    const res = await POST(
      makeReq({ name: "Jane", email: "jane@example.com", message: "hi" }),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    const confirmation = calls[1]!;
    expect(confirmation.url).toBe(RESEND_ENDPOINT);
    expect(confirmation.json["to"]).toBe("jane@example.com");
    expect(confirmation.json["from"]).toBe("Example <noreply@example.com>");
    expect(confirmation.json["subject"]).toBe("We received your message");
    // Confirmation html is a trusted template — sent verbatim (no escaping).
    expect(confirmation.json["html"]).toBe("<p>Thanks for reaching out.</p>");
    // No reply_to on the confirmation (nothing to reply to).
    expect(confirmation.json["reply_to"]).toBeUndefined();
  });

  it("never calls Resend when the honeypot is filled (bot)", async () => {
    const POST = createContactRoute(ROUTE_OPTS);
    const res = await POST(
      makeReq({
        name: "Bot",
        email: "bot@example.com",
        message: "spam",
        website: "https://spam.example",
      }),
    );
    // Fake success for the bot, zero emails sent.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(calls).toHaveLength(0);
  });

  it("omits the text part when text:false and reply_to when the email is empty", async () => {
    const POST = createContactRoute({
      ...ROUTE_OPTS,
      text: false,
      requiredFields: ["message"],
    });
    const res = await POST(makeReq({ message: "anonymous note" }));
    expect(res.status).toBe(200);
    const payload = calls[0]!.json;
    expect(payload["text"]).toBeUndefined();
    expect(payload["reply_to"]).toBeUndefined();
    expect(payload["subject"]).toBe("New contact form submission");
  });
});
