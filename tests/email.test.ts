import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createContactRoute,
  createEmailer,
  escapeHtml,
  verifyCaptcha,
  Emailer,
} from "../src/email/index.js";
import type { ContactRequest, SendOptions, SendResult } from "../src/email/index.js";

function makeReq(body: unknown): ContactRequest {
  return {
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

function jsonFetch(result: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => result,
  }));
}

const VALID = { name: "Jane Doe", email: "jane@example.com", message: "Hello there" };

let savedKey: string | undefined;
let savedEnv: string | undefined;

beforeEach(() => {
  savedKey = process.env.RESEND_API_KEY;
  savedEnv = process.env.NODE_ENV;
  delete process.env.RESEND_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = savedKey;
  if (savedEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedEnv;
});

describe("escapeHtml", () => {
  it("escapes all HTML special characters", () => {
    expect(escapeHtml(`<script>"alert"&'x'</script>`)).toBe(
      "&lt;script&gt;&quot;alert&quot;&amp;&#39;x&#39;&lt;/script&gt;",
    );
  });
});

describe("re-exports", () => {
  it("re-exports Emailer and createEmailer", () => {
    expect(typeof createEmailer).toBe("function");
    const emailer = createEmailer({ resendApiKey: "re_test" });
    expect(emailer).toBeInstanceOf(Emailer);
  });
});

describe("createContactRoute — validation", () => {
  it("rejects invalid JSON with 400", async () => {
    const POST = createContactRoute({ to: "hello@example.com" });
    const res = await POST(makeReq(new SyntaxError("bad json")));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });

  it("rejects non-object bodies with 400", async () => {
    const POST = createContactRoute({ to: "hello@example.com" });
    const res = await POST(makeReq(["not", "an", "object"]));
    expect(res.status).toBe(400);
  });

  it("rejects missing required fields with per-field message", async () => {
    const POST = createContactRoute({ to: "hello@example.com" });
    const res = await POST(makeReq({ email: "jane@example.com", message: "hi" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Name is required" });
  });

  it("honors configurable requiredFields", async () => {
    const POST = createContactRoute({
      to: "hello@example.com",
      requiredFields: ["name", "email", "subject", "message"],
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Subject is required" });
  });

  it("uses fieldLabels in required-field errors", async () => {
    const POST = createContactRoute({
      to: "hello@example.com",
      requiredFields: ["name", "email", "topic", "message"],
      fieldLabels: { topic: "Topic" },
    });
    const res = await POST(makeReq(VALID));
    expect(await res.json()).toEqual({ error: "Topic is required" });
  });

  it("rejects invalid email format", async () => {
    const POST = createContactRoute({ to: "hello@example.com" });
    const res = await POST(makeReq({ ...VALID, email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Valid email is required" });
  });

  it("can disable email validation", async () => {
    const send = vi.fn(async (): Promise<SendResult> => ({ sent: true, id: "x" }));
    const POST = createContactRoute({ to: "hello@example.com", send, validateEmail: false });
    const res = await POST(makeReq({ ...VALID, email: "not-an-email" }));
    expect(res.status).toBe(200);
  });
});

describe("createContactRoute — honeypot", () => {
  it("returns fake success when the honeypot is filled and never sends", async () => {
    const send = vi.fn();
    const POST = createContactRoute({ to: "hello@example.com", send });
    const res = await POST(makeReq({ ...VALID, website: "http://spam.example" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns the message-style honeypot response", async () => {
    const POST = createContactRoute({ to: "hello@example.com", style: "message", send: vi.fn() });
    const res = await POST(makeReq({ ...VALID, website: "spam" }));
    expect(await res.json()).toEqual({ message: "Message received!" });
  });

  it("supports a custom honeypot field name and disabling", async () => {
    const send = vi.fn(async (): Promise<SendResult> => ({ sent: true }));
    const POST = createContactRoute({ to: "hello@example.com", send, honeypot: "fax" });
    const res = await POST(makeReq({ ...VALID, fax: "555-1234" }));
    expect(await res.json()).toEqual({ success: true });
    expect(send).not.toHaveBeenCalled();

    const send2 = vi.fn(async (): Promise<SendResult> => ({ sent: true }));
    const POST2 = createContactRoute({ to: "hello@example.com", send: send2, honeypot: false });
    const res2 = await POST2(makeReq({ ...VALID, website: "spam" }));
    expect(res2.status).toBe(200);
    expect(send2).toHaveBeenCalledTimes(1);
  });
});

describe("createContactRoute — sending", () => {
  it("sends via RESEND_API_KEY from env and returns messageId", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const fetchMock = jsonFetch({ id: "msg_123" });
    vi.stubGlobal("fetch", fetchMock);

    const POST = createContactRoute({
      to: "hello@example.com",
      from: "Example <noreply@example.com>",
    });
    const res = await POST(
      makeReq({ ...VALID, message: "Line1\nLine2 <script>", phone: "555" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, messageId: "msg_123" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload.from).toBe("Example <noreply@example.com>");
    expect(payload.to).toBe("hello@example.com");
    expect(payload.reply_to).toBe("jane@example.com");
    expect(payload.subject).toBe("New contact form submission from Jane Doe");
    const html = payload.html as string;
    expect(html).toContain("<strong>Name:</strong> Jane Doe");
    expect(html).toContain("<strong>Phone:</strong> 555");
    expect(html).toContain("Line1<br />Line2 &lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(payload.text).toContain("Phone: 555");
  });

  it("escapes every user-controlled value embedded in the HTML", async () => {
    let captured: SendOptions | undefined;
    const POST = createContactRoute({
      to: "hello@example.com",
      send: async (mail) => {
        captured = mail;
        return { sent: true };
      },
      subject: (s) => `From ${s.name}`,
    });
    await POST(
      makeReq({
        name: '<img src=x onerror="alert(1)">',
        email: "jane@example.com",
        message: "<b>bold</b>",
        company: 'ACME "quoted" & <co>',
      }),
    );
    expect(captured).toBeDefined();
    const html = captured!.html;
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("ACME &quot;quoted&quot; &amp; &lt;co&gt;");
    expect(html).toContain("From &lt;img");
    expect(captured!.text).toContain('<img src=x onerror="alert(1)">'); // text stays raw
  });

  it("builds the subject via function with access to extra fields", async () => {
    let captured: SendOptions | undefined;
    const POST = createContactRoute({
      to: "hello@example.com",
      send: async (mail) => {
        captured = mail;
        return { sent: true };
      },
      subject: (s) => `New Inquiry from ${s.name} — ${s.fields.service ?? "General"}`,
    });
    await POST(makeReq({ ...VALID, service: "Appraisal" }));
    expect(captured!.subject).toBe("New Inquiry from Jane Doe — Appraisal");
  });

  it("excludes skipFields, honeypot and captcha-token fields from the email body", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => (url.includes("siteverify") ? { success: true } : { id: "m1" }),
      })),
    );
    let captured: SendOptions | undefined;
    const POST = createContactRoute({
      to: "hello@example.com",
      skipFields: ["type"],
      captcha: { provider: "hcaptcha", secretKey: "secret" },
      send: async (mail) => {
        captured = mail;
        return { sent: true };
      },
    });
    await POST(makeReq({ ...VALID, type: "Contact Form", website: "", "h-captcha-response": "tok" }));
    expect(captured!.text).not.toContain("Contact Form");
    expect(captured!.text).not.toContain("tok");
  });

  it("returns sendFailed (500) when the send fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const POST = createContactRoute({
      to: "hello@example.com",
      send: async () => ({ sent: false, error: "boom" }),
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to send message. Please try again later." });
  });

  it("ignores send failures when onSendError is 'ignore'", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const POST = createContactRoute({
      to: "hello@example.com",
      send: async () => ({ sent: false, error: "boom" }),
      onSendError: "ignore",
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it("sends a confirmation email to the submitter", async () => {
    const sent: SendOptions[] = [];
    const POST = createContactRoute({
      to: "hello@example.com",
      from: "Example <noreply@example.com>",
      send: async (mail) => {
        sent.push(mail);
        return { sent: true, id: `id_${sent.length}` };
      },
      confirmation: {
        subject: "Got your message — Example",
        html: (s) => `<p>Hey ${escapeHtml(s.name)},</p>`,
      },
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.to).toBe("jane@example.com");
    expect(sent[1]!.subject).toBe("Got your message — Example");
    expect(sent[1]!.html).toBe("<p>Hey Jane Doe,</p>");
  });

  it("does not fail the request when the confirmation email fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const POST = createContactRoute({
      to: "hello@example.com",
      send: async (): Promise<SendResult> => {
        calls++;
        return calls === 1 ? { sent: true, id: "m1" } : { sent: false, error: "boom" };
      },
      confirmation: { subject: "hi", html: "<p>hi</p>" },
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, messageId: "m1" });
  });
});

describe("createContactRoute — missing emailer", () => {
  it("logs and succeeds outside production when nothing is configured", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const POST = createContactRoute({ to: "hello@example.com" });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it("fails in production when nothing is configured", async () => {
    process.env.NODE_ENV = "production";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const POST = createContactRoute({ to: "hello@example.com" });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(500);
  });

  it("honors onMissingEmailer overrides", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = createContactRoute({ to: "hello@example.com", onMissingEmailer: "error" });
    expect((await err(makeReq(VALID))).status).toBe(500);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.NODE_ENV = "production";
    const log = createContactRoute({ to: "hello@example.com", onMissingEmailer: "log" });
    expect((await log(makeReq(VALID))).status).toBe(200);
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it("uses a provided emailerConfig to create the Emailer lazily", async () => {
    const fetchMock = jsonFetch({ id: "cfg_1" });
    vi.stubGlobal("fetch", fetchMock);
    const POST = createContactRoute({
      to: "hello@example.com",
      from: "Cfg <cfg@example.com>",
      emailerConfig: { resendApiKey: "re_cfg" },
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, messageId: "cfg_1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createContactRoute — captcha and verify hook", () => {
  it("rejects when the captcha token is missing", async () => {
    const send = vi.fn();
    const POST = createContactRoute({
      to: "hello@example.com",
      send,
      captcha: { provider: "hcaptcha", secretKey: "secret" },
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Captcha verification failed" });
    expect(send).not.toHaveBeenCalled();
  });

  it("verifies hCaptcha tokens against siteverify", async () => {
    const fetchMock = jsonFetch({ success: true });
    vi.stubGlobal("fetch", fetchMock);
    const send = vi.fn(async (): Promise<SendResult> => ({ sent: true, id: "m" }));
    const POST = createContactRoute({
      to: "hello@example.com",
      send,
      captcha: { provider: "hcaptcha", secretKey: "0xSecret" },
    });
    const res = await POST(makeReq({ ...VALID, "h-captcha-response": "token123" }));
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hcaptcha.com/siteverify");
    expect(String(init.body)).toBe("secret=0xSecret&response=token123");
  });

  it("rejects when siteverify says no", async () => {
    vi.stubGlobal("fetch", jsonFetch({ success: false }));
    const POST = createContactRoute({
      to: "hello@example.com",
      send: vi.fn(),
      captcha: { provider: "turnstile", secretKey: "secret" },
    });
    const res = await POST(makeReq({ ...VALID, "cf-turnstile-response": "bad" }));
    expect(res.status).toBe(400);
  });

  it("supports a custom verify hook (false and string verdicts)", async () => {
    const POST = createContactRoute({
      to: "hello@example.com",
      send: vi.fn(),
      verify: async () => false,
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Verification failed" });

    const POST2 = createContactRoute({
      to: "hello@example.com",
      send: vi.fn(),
      verify: (body) => (body.email === "spam@bot.com" ? "Spam detected" : true),
    });
    const res2 = await POST2(makeReq({ ...VALID, email: "spam@bot.com" }));
    expect(await res2.json()).toEqual({ error: "Spam detected" });
  });
});

describe("verifyCaptcha", () => {
  it("returns true on provider success", async () => {
    vi.stubGlobal("fetch", jsonFetch({ success: true }));
    expect(await verifyCaptcha("tok", { provider: "turnstile", secretKey: "s" })).toBe(true);
  });

  it("fails closed on HTTP errors and network exceptions", async () => {
    vi.stubGlobal("fetch", jsonFetch({}, false, 500));
    expect(await verifyCaptcha("tok", { provider: "hcaptcha", secretKey: "s" })).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await verifyCaptcha("tok", { provider: "hcaptcha", secretKey: "s" })).toBe(false);
  });
});

describe("createContactRoute — persist, mapBody, response styles", () => {
  it("includes the persist id in ok-style success responses", async () => {
    const POST = createContactRoute({
      to: "hello@example.com",
      style: "ok",
      send: async () => ({ sent: true, id: "m1" }),
      persist: async (s) => {
        expect(s.name).toBe("Jane Doe");
        return "row_42";
      },
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "row_42" });
  });

  it("returns the error response when persist throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const POST = createContactRoute({
      to: "hello@example.com",
      send: vi.fn(),
      persist: async () => {
        throw new Error("db down");
      },
      responses: { error: { body: { error: "Failed to submit request" }, status: 500 } },
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to submit request" });
  });

  it("applies mapBody before validation (firstName/lastName → name)", async () => {
    let captured: SendOptions | undefined;
    const POST = createContactRoute({
      to: "hello@example.com",
      requiredFields: ["email"],
      skipFields: ["firstName", "lastName"],
      mapBody: (b) => ({
        ...b,
        name:
          (typeof b.name === "string" && b.name) ||
          [b.firstName, b.lastName].filter(Boolean).join(" "),
      }),
      send: async (mail) => {
        captured = mail;
        return { sent: true };
      },
    });
    const res = await POST(
      makeReq({ firstName: "Jane", lastName: "Doe", email: "jane@example.com" }),
    );
    expect(res.status).toBe(200);
    expect(captured!.html).toContain("<strong>Name:</strong> Jane Doe");
    expect(captured!.html).not.toContain("First Name");
  });

  it("matches the message style end-to-end", async () => {
    const POST = createContactRoute({
      to: "hello@example.com",
      style: "message",
      send: async () => ({ sent: true, id: "m" }),
    });
    const res = await POST(makeReq(VALID));
    expect(await res.json()).toEqual({ message: "Message received! We'll be in touch." });

    const bad = await POST(makeReq({}));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ message: "Name is required" });
  });

  it("matches the ok style end-to-end including sendFailed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const POST = createContactRoute({
      to: "hello@example.com",
      style: "ok",
      send: async () => ({ sent: false, error: "boom" }),
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "Failed to send email" });
  });

  it("lets responses overrides win over the preset", async () => {
    const POST = createContactRoute({
      to: "hello@example.com",
      style: "success",
      send: async () => ({ sent: true, id: "m" }),
      responses: {
        invalid: { body: { error: "All fields are required" }, status: 400 },
        success: (ctx) => ({ body: { success: true, messageId: ctx.messageId }, status: 200 }),
      },
    });
    const bad = await POST(makeReq({}));
    expect(await bad.json()).toEqual({ error: "All fields are required" });
    const good = await POST(makeReq(VALID));
    expect(await good.json()).toEqual({ success: true, messageId: "m" });
  });

  it("returns the error response on unexpected exceptions", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // No from anywhere and a resend key → Emailer.send throws "No from address configured".
    process.env.RESEND_API_KEY = "re_test";
    const POST = createContactRoute({ to: "hello@example.com" });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "An unexpected error occurred" });
  });
});
