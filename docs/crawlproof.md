# crawlproof

Typed, zero-dependency client for the [CrawlProof](https://crawlproof.com) HTTP API.
Replaces the vendored `lib/crawlproof/server.ts` snippet that CrawlProof's
"Audience Hub" generator dropped into several apps.

```bash
npm install @profullstack/stack
```

```ts
import { createCrawlproofClient } from "@profullstack/stack/crawlproof";
```

Uses the global `fetch` (Node ≥ 18 or any modern runtime). No dependencies.

## What the CrawlProof API actually exposes

The client maps 1:1 onto the real endpoints of the crawlproof.com service:

| Method | Endpoint | Auth |
| --- | --- | --- |
| `sendEvent()` | `POST /api/events` | `Authorization: Bearer <project key>` |
| `track()` | `POST /api/track` | none (public beacon, always `204`) |
| `getAudit()` | `GET /api/audits/<id>` | none (public, share-safe fields only) |
| `shareUrl()` | n/a — builds `/r/<shareToken>` URLs | n/a |

**Not covered, on purpose:** starting audits, listing audits, and downloading
reports are not public REST endpoints — audit creation is a server action, the
PDF (`GET /api/audits/<id>/pdf`) and run-status routes are cookie-auth, and the
agent-facing surface is the MCP server at `/api/mcp` (`crp_` tokens). If you
need those, use the CrawlProof dashboard or MCP; do not fake them with this
client.

## Quick start

```ts
import { createCrawlproofClient } from "@profullstack/stack/crawlproof";

const crawlproof = createCrawlproofClient({
  apiKey: process.env.CRAWLPROOF_PROJECT_KEY, // per-project bearer key
  project: "profullstack.com",                // default project slug
});

// Trusted server-side lifecycle event (best-effort — never throws):
await crawlproof.sendEvent({
  event: "user.created",
  email: user.email,
  name: user.name,
  user_id: user.id,
  marketing_consent: Boolean(user.marketingConsent),
});

// Stats-tracker beacon (the same contract as the /stats.js snippet):
await crawlproof.track({
  site: "11111111-2222-3333-4444-555555555555",
  event: "pageview",
  url: "https://example.com/pricing",
});

// Poll a public audit:
const audit = await crawlproof.getAudit(auditId);
if (audit?.status === "complete") {
  console.log(audit.score, crawlproof.shareUrl(audit.share_token!));
}
```

## API reference

### `createCrawlproofClient(options?) → CrawlproofClient`

Options (`CrawlproofClientOptions`):

- `apiKey?: string` — per-project bearer key for `sendEvent` (env `CRAWLPROOF_PROJECT_KEY`). Without it `sendEvent` is a no-op returning `{ ok: false }`.
- `baseUrl?: string` — API origin. Default: `https://crawlproof.com` (`CRAWLPROOF_DEFAULT_BASE_URL`).
- `project?: string` — default `project` slug merged into every `sendEvent` payload (a per-event `project` wins).
- `fetch?: typeof fetch` — custom fetch implementation (tests, proxies).

### `client.sendEvent(event: CrawlproofEvent) → Promise<CrawlproofIngestResult>`

POSTs a trusted lifecycle event to `/api/events`. **Best-effort: never
rejects.** Returns `{ ok, status?, error? }` so callers can log failures.

`CrawlproofEvent`: `event` (required), `project?`, `email?`, `name?`,
`user_id?`, `marketing_consent?`, `plan?`, `metadata?`.

### `client.track(payload: CrawlproofTrackPayload) → Promise<CrawlproofIngestResult>`

POSTs a stats beacon to `/api/track`. Public endpoint; always answered with
`204`, even for bad input. Never rejects.

`CrawlproofTrackPayload`: `site` (project UUID, required), `event?`, `url?`,
`referrer?`, `path?`, `target?`, `language?`, `timezone?`, `visitorId?`,
`sessionId?`, `viewport?`, `screenWidth?`, `screenHeight?`.

### `client.getAudit(id: string) → Promise<CrawlproofAudit | null>`

GETs the public audit status. Returns `null` when the audit does not exist
(404 or a non-`ok` body). Throws `CrawlproofApiError` (with `.status`) on
unexpected non-2xx responses and propagates network errors.

`CrawlproofAudit`: `id`, `status` (`"queued" | "running" | "complete" | "failed"`),
`score`, `summary`, `completed_at`, `share_token`.

### `client.shareUrl(shareToken: string) → string`

Builds the public report URL (`<baseUrl>/r/<token>`) from an audit's
`share_token`.

### Errors

- `CrawlproofApiError extends Error` — `status: number`. Thrown only by read methods.

## Migration

### profullstack-web, coinpayportal, profullstack-web-plans — vendored `lib/crawlproof/server.ts`

All three apps carry the same generated file; they differ only in the
hardcoded project slug (`profullstack.com` vs `coinpayportal.com`) and none of
them call `sendCrawlProofEvent` yet (grep finds only the definition).

**Before** (`lib/crawlproof/server.ts`, ~50 vendored lines):

```ts
export async function sendCrawlProofEvent(event: CrawlProofEvent): Promise<void> {
  const ingestUrl = process.env.CRAWLPROOF_INGEST_URL || "https://crawlproof.com/api/events";
  const projectKey = process.env.CRAWLPROOF_PROJECT_KEY;
  if (!projectKey) { console.warn(...); return; }
  await fetch(ingestUrl, { method: "POST", headers: { Authorization: `Bearer ${projectKey}`, ... },
    body: JSON.stringify({ project: "profullstack.com", ...event }) });
}
```

**After** — replace the whole file with:

```ts
// lib/crawlproof/server.ts
import { createCrawlproofClient } from "@profullstack/stack/crawlproof";

const client = createCrawlproofClient({
  apiKey: process.env.CRAWLPROOF_PROJECT_KEY,
  baseUrl: process.env.CRAWLPROOF_INGEST_URL?.replace(/\/api\/events$/, ""),
  project: "profullstack.com", // "coinpayportal.com" in coinpayportal
});

export const sendCrawlProofEvent = (event: Parameters<typeof client.sendEvent>[0]) =>
  client.sendEvent(event).then(() => undefined);
```

Or drop the wrapper and call `client.sendEvent(...)` directly at call sites.
Behavior is preserved: best-effort, never throws, skips when the key is unset.
`CRAWLPROOF_INGEST_URL` is honored by stripping the `/api/events` suffix into
`baseUrl`; in practice the env var is unset everywhere and the default
`https://crawlproof.com` applies.

One deliberate difference: the vendored file `console.warn`s on failure; the
client instead returns `CrawlproofIngestResult` — log `result.error` yourself
if you want the old noise.

### Sending stats beacons from a server (new capability)

Apps that currently shell out to `/api/track` by hand can use
`client.track(payload)` with the same field names as the public endpoint.
