# @profullstack/stack

The Profullstack open source stack — shared modules used across all Profullstack apps, published as a single npm package with subpath imports.

```sh
npm install @profullstack/stack
```

```ts
import { createContactRoute } from "@profullstack/stack/email";
import { createServerSupabase, updateSession } from "@profullstack/stack/supabase";
import { createReferralsRouteHandler } from "@profullstack/stack/referrals";
import { FeedbackWidget } from "@profullstack/stack/feedback";
import { createCoinPayClient } from "@profullstack/stack/coinpay";
import { createCrawlproofClient } from "@profullstack/stack/crawlproof";
```

## Modules

| Subpath | Purpose |
| --- | --- |
| `@profullstack/stack/referrals` | Referral-program Next.js glue (route handler, server client, middleware re-exports) |
| `@profullstack/stack/email` | Transactional email + ready-made contact-form route (wraps `@profullstack/emailer`) |
| `@profullstack/stack/supabase` | supabase-ssr client/server/middleware factories |
| `@profullstack/stack/feedback` | Feedback widget React component + script embed helper |
| `@profullstack/stack/coinpay` | CoinPayPortal API client, webhook verification, CoinPay OAuth login helpers |
| `@profullstack/stack/crawlproof` | crawlproof.com audit API client |

Framework peers (`next`, `react`, `@supabase/ssr`) are optional peer dependencies — install only what your app uses.

Per-module API docs live in [`docs/`](docs/).

## Development

```sh
npm install
npm run build   # tsup → dist/ (esm + cjs + dts)
npm test        # vitest
```

MIT © 2026 Profullstack, Inc.
