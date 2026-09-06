import { describe, expect, it, vi } from "vitest";
import { createContactGuard, createContactRoute } from "../src/email/index.js";
import type { ContactRequest, SendOptions, SendResult } from "../src/email/index.js";

/**
 * The case this exists for: a submission that never rendered the form.
 *
 * A honeypot cannot catch it. The hidden field is absent from the body
 * rather than filled, so "is it empty?" answers yes and the check passes.
 * Only something the page hands out — a token — can tell the difference.
 */

function makeReq(body: unknown, headers: Record<string, string> = {}): ContactRequest {
  return {
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

const VALID = { name: "Jane Doe", email: "jane@example.com", message: "Hello there" };
const SECOND = 1000;
const guardConfig = { secret: "route-test-secret", binding: "contact" };
const okSend = () => vi.fn(async () => ({ sent: true, id: "m1" }) as SendResult);

describe("createContactRoute — proof-of-render guard", () => {
  it("drops a direct POST that carries no token, and never sends", async () => {
    const send = okSend();
    const POST = createContactRoute({ to: "hello@example.com", send, guard: guardConfig });

    const res = await POST(makeReq(VALID));

    // Looks like success to the caller and sent nothing. Telling a bot
    // which check caught it is free tuning information.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends when the form was actually rendered", async () => {
    const send = okSend();
    const guard = createContactGuard(guardConfig);
    const POST = createContactRoute({ to: "hello@example.com", send, guard });

    const token = await guard.issue(Date.now() - 40 * SECOND);
    const res = await POST(makeReq({ ...VALID, fg_token: token }));

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops a token minted for a different form", async () => {
    const send = okSend();
    const other = createContactGuard({ secret: "route-test-secret", binding: "newsletter" });
    const POST = createContactRoute({ to: "hello@example.com", send, guard: guardConfig });

    const token = await other.issue(Date.now() - 40 * SECOND);
    await POST(makeReq({ ...VALID, fg_token: token }));

    expect(send).not.toHaveBeenCalled();
  });

  it("drops a token forged with the wrong secret", async () => {
    const send = okSend();
    const attacker = createContactGuard({ secret: "not-the-secret", binding: "contact" });
    const POST = createContactRoute({ to: "hello@example.com", send, guard: guardConfig });

    const token = await attacker.issue(Date.now() - 40 * SECOND);
    await POST(makeReq({ ...VALID, fg_token: token }));

    expect(send).not.toHaveBeenCalled();
  });

  it("asks a too-fast submitter to resend rather than dropping them", async () => {
    const send = okSend();
    const guard = createContactGuard(guardConfig);
    const POST = createContactRoute({ to: "hello@example.com", send, guard });

    const res = await POST(makeReq({ ...VALID, fg_token: await guard.issue() }));

    // A real person on a fast autofill lands here, so they are told.
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "That took too long. Please send it again.",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 429 once an address exceeds the window", async () => {
    const send = okSend();
    const guard = createContactGuard({
      ...guardConfig,
      minAgeMs: 0,
      rateLimit: { max: 1, windowMs: 60_000 },
    });
    const POST = createContactRoute({ to: "hello@example.com", send, guard });
    const headers = { "x-forwarded-for": "203.0.113.7" };

    const first = await POST(makeReq({ ...VALID, fg_token: await guard.issue() }, headers));
    const second = await POST(makeReq({ ...VALID, fg_token: await guard.issue() }, headers));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("delivers a flagged message, tagged, rather than dropping it", async () => {
    const send = okSend();
    const guard = createContactGuard(guardConfig);
    const POST = createContactRoute({ to: "hello@example.com", send, guard });

    const token = await guard.issue(Date.now() - 40 * SECOND);
    await POST(
      makeReq({
        name: "Isabella Thompson",
        email: "madamtaisia@mail.ru",
        message: "I would like more information. Please contact me by email.",
        fg_token: token,
      }),
    );

    // It had a token, so it goes through — tagged, never eaten.
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0] as SendOptions;
    expect(mail.subject).toMatch(/\[spam\? \d+\]$/);
  });

  it("leaves a genuine subject untagged", async () => {
    const send = okSend();
    const guard = createContactGuard(guardConfig);
    const POST = createContactRoute({ to: "hello@example.com", send, guard });

    const token = await guard.issue(Date.now() - 40 * SECOND);
    await POST(
      makeReq({
        ...VALID,
        message:
          "We run four A100 nodes and want to understand how settlement timing works before we commit more hardware.",
        fg_token: token,
      }),
    );

    const mail = send.mock.calls[0][0] as SendOptions;
    expect(mail.subject).not.toContain("[spam?");
  });

  it("puts the sender's address and signals in the body, where the headers cannot", async () => {
    const send = okSend();
    const guard = createContactGuard(guardConfig);
    const POST = createContactRoute({ to: "hello@example.com", send, guard });

    const token = await guard.issue(Date.now() - 40 * SECOND);
    await POST(makeReq({ ...VALID, fg_token: token }, { "x-forwarded-for": "198.51.100.4" }));

    const mail = send.mock.calls[0][0] as SendOptions;
    expect(mail.text).toContain("ip: 198.51.100.4");
    expect(mail.text).toContain("form-guard:");
  });

  it("keeps guard plumbing out of the email body", async () => {
    const send = okSend();
    const guard = createContactGuard(guardConfig);
    const POST = createContactRoute({ to: "hello@example.com", send, guard });

    const token = await guard.issue(Date.now() - 40 * SECOND);
    await POST(makeReq({ ...VALID, fg_token: token, website: "" }));

    const mail = send.mock.calls[0][0] as SendOptions;
    expect(mail.html).not.toContain(token);
    expect(mail.html).not.toContain("Fg Token");
  });

  it("is inert when no guard is configured", async () => {
    const send = okSend();
    const POST = createContactRoute({ to: "hello@example.com", send });

    const res = await POST(makeReq(VALID));

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("scores without blocking when requireToken is false", async () => {
    const send = okSend();
    const guard = createContactGuard({ ...guardConfig, requireToken: false });
    const POST = createContactRoute({ to: "hello@example.com", send, guard });

    // No token at all, yet it still sends — the soft-rollout mode.
    await POST(makeReq(VALID));

    expect(send).toHaveBeenCalledTimes(1);
  });
});
