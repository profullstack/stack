import { describe, expect, it, vi } from "vitest";
import {
  CRAWLPROOF_DEFAULT_BASE_URL,
  CrawlproofApiError,
  createCrawlproofClient,
  type CrawlproofAudit,
} from "../src/crawlproof/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(impl(String(url), init)),
  );
}

const AUDIT: CrawlproofAudit = {
  id: "a1b2c3d4",
  status: "complete",
  score: 87,
  summary: { engines: 3 },
  completed_at: "2026-07-01T00:00:00.000Z",
  share_token: "tok_123",
};

describe("createCrawlproofClient", () => {
  it("defaults the base URL to https://crawlproof.com", () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: true, audit: AUDIT }));
    const client = createCrawlproofClient({ fetch: fetchMock as unknown as typeof fetch });

    void client.getAudit("a1b2c3d4");

    expect(fetchMock).toHaveBeenCalledWith(
      `${CRAWLPROOF_DEFAULT_BASE_URL}/api/audits/a1b2c3d4`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("strips trailing slashes from a custom base URL", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: true, audit: AUDIT }));
    const client = createCrawlproofClient({
      baseUrl: "https://crawlproof.example.com/",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.getAudit("x");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://crawlproof.example.com/api/audits/x",
      expect.anything(),
    );
  });
});

describe("sendEvent", () => {
  it("short-circuits without an apiKey and never calls fetch", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = createCrawlproofClient({ fetch: fetchMock as unknown as typeof fetch });

    const result = await client.sendEvent({ event: "user.created" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/apiKey/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the event to /api/events with a bearer header and default project", async () => {
    const fetchMock = mockFetch(() => new Response(null, { status: 202 }));
    const client = createCrawlproofClient({
      apiKey: "pk_test",
      project: "profullstack.com",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.sendEvent({
      event: "user.created",
      email: "a@b.c",
      user_id: "u1",
      marketing_consent: true,
    });

    expect(result).toEqual({ ok: true, status: 202 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://crawlproof.com/api/events");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer pk_test");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      project: "profullstack.com",
      event: "user.created",
      email: "a@b.c",
      user_id: "u1",
      marketing_consent: true,
    });
  });

  it("lets the event payload override the client's default project", async () => {
    const fetchMock = mockFetch(() => new Response(null, { status: 200 }));
    const client = createCrawlproofClient({
      apiKey: "pk_test",
      project: "profullstack.com",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.sendEvent({ event: "user.created", project: "other.app" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).project).toBe("other.app");
  });

  it("returns ok:false with status and body on HTTP errors instead of throwing", async () => {
    const fetchMock = mockFetch(() => new Response("nope", { status: 401 }));
    const client = createCrawlproofClient({
      apiKey: "bad",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.sendEvent({ event: "user.created" });

    expect(result).toEqual({ ok: false, status: 401, error: "nope" });
  });

  it("returns ok:false on network failure instead of throwing", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("ECONNREFUSED")));
    const client = createCrawlproofClient({
      apiKey: "pk_test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.sendEvent({ event: "user.created" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("ECONNREFUSED");
  });
});

describe("track", () => {
  it("posts the beacon to /api/track without auth and treats 204 as ok", async () => {
    const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
    const client = createCrawlproofClient({ fetch: fetchMock as unknown as typeof fetch });

    const result = await client.track({
      site: "11111111-2222-3333-4444-555555555555",
      event: "pageview",
      url: "https://example.com/pricing",
      referrer: "https://google.com/",
      sessionId: "s1",
      viewport: { width: 1440, height: 900 },
    });

    expect(result).toEqual({ ok: true, status: 204 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://crawlproof.com/api/track");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(JSON.parse(String(init.body)).event).toBe("pageview");
  });

  it("never rejects on network failure", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("socket hangup")));
    const client = createCrawlproofClient({ fetch: fetchMock as unknown as typeof fetch });

    const result = await client.track({ site: "s" });

    expect(result).toEqual({ ok: false, error: "socket hangup" });
  });
});

describe("getAudit", () => {
  it("returns the audit record for a 200 { ok: true } response", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: true, audit: AUDIT }));
    const client = createCrawlproofClient({ fetch: fetchMock as unknown as typeof fetch });

    const audit = await client.getAudit("a1b2c3d4");

    expect(audit).toEqual(AUDIT);
  });

  it("returns null for a 404", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: false }, 404));
    const client = createCrawlproofClient({ fetch: fetchMock as unknown as typeof fetch });

    expect(await client.getAudit("missing")).toBeNull();
  });

  it("returns null for a 200 without an ok audit payload", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: false }));
    const client = createCrawlproofClient({ fetch: fetchMock as unknown as typeof fetch });

    expect(await client.getAudit("weird")).toBeNull();
  });

  it("throws CrawlproofApiError on unexpected non-2xx statuses", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}, 500));
    const client = createCrawlproofClient({ fetch: fetchMock as unknown as typeof fetch });

    const err = await client.getAudit("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrawlproofApiError);
    expect((err as CrawlproofApiError).status).toBe(500);
  });

  it("URL-encodes the audit id and sends the bearer header when configured", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: true, audit: AUDIT }));
    const client = createCrawlproofClient({
      apiKey: "pk_test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.getAudit("id/with spaces");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://crawlproof.com/api/audits/id%2Fwith%20spaces");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer pk_test");
  });

  it("propagates network errors", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("offline")));
    const client = createCrawlproofClient({ fetch: fetchMock as unknown as typeof fetch });

    await expect(client.getAudit("x")).rejects.toThrow("offline");
  });
});

describe("shareUrl", () => {
  it("builds the public report URL for a share token", () => {
    const client = createCrawlproofClient();
    expect(client.shareUrl("tok_123")).toBe("https://crawlproof.com/r/tok_123");
  });

  it("encodes unsafe characters and honors a custom base URL", () => {
    const client = createCrawlproofClient({ baseUrl: "https://cp.example.com/" });
    expect(client.shareUrl("a/b c")).toBe("https://cp.example.com/r/a%2Fb%20c");
  });
});
