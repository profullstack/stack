# @profullstack/stack/feedback

One-line embed of the [feedback.profullstack.com](https://feedback.profullstack.com) widget, replacing the `<script>` snippet that was copy-pasted into ~20 app layouts (plus qrypt.chat's hand-rolled route-hiding wrapper).

```sh
npm install @profullstack/stack
```

```tsx
import { FeedbackWidget } from "@profullstack/stack/feedback";
```

`react` is an optional peer dependency. `next` is optional too — the component auto-detects the current route via `next/navigation` when it is available and works without it (pass `pathname` yourself).

## API

### `<FeedbackWidget />`

Client component (`"use client"`). Renders nothing; injects the embed script into `<body>` once and keeps the widget off any route listed in `hideOnRoutes`. Drop it anywhere in a root layout — before `</body>` is conventional.

```tsx
<FeedbackWidget property="qrypt.chat" hideOnRoutes={["/chat", "/chats", "/u", "/anon"]} />
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `property` | `string` | — | Site key registered at feedback.profullstack.com. Sent as `data-property`. |
| `hideOnRoutes` | `readonly string[]` | `[]` | Route prefixes where the widget is hidden. Exact (`/chat`) or ancestor (`/chat/123`) match. |
| `pathname` | `string \| null` | auto | Current path. Auto-detected via `usePathname()` from `next/navigation` when omitted; pass explicitly outside Next.js. Unknown path ⇒ widget shows. |
| `src` | `string` | `FEEDBACK_SCRIPT_URL` | Embed script URL override. |
| `nonce` | `string` | — | CSP nonce for strict `script-src` policies (pairux.com). |

Behavior on route changes (ported from qrypt.chat's `feedback-widget.jsx`):

- Hidden route: removes `#pf-fab`, `#pf-panel` and this property's `<script data-property>`, and keeps a `<style id="pf-feedback-hide">` `display:none !important` rule in `<head>` so a late-injected FAB never flashes.
- Visible route: drops the hide rule and appends the embed script — at most one script per `property`, so client-side navigations never duplicate it.
- Unmount: script, FAB/panel and hide style are removed.

### `feedbackScriptTag(options): string`

Pure string builder for non-React/plain-HTML layouts. Returns the exact snippet that used to be pasted:

```ts
feedbackScriptTag({ property: "ugig.net" })
// '<script async src="https://feedback.profullstack.com/embed/profullstack-feedback.js" data-property="ugig.net"></script>'
```

Options: `{ property: string; src?: string; nonce?: string }`. Attribute values are HTML-escaped. With `nonce` the attribute is emitted as `<script async nonce="…" src="…" …>`.

### `matchesRoutePrefix(pathname, prefixes): boolean`

Pure route matcher (the logic behind `hideOnRoutes`): `true` when `pathname` equals a prefix or starts with `prefix + "/"`. Trailing slashes on prefixes are ignored, `/` matches only the root, empty prefixes are ignored, and a null/empty pathname never matches. `/chat` does **not** match `/chatroom`.

### `FEEDBACK_SCRIPT_URL`

`"https://feedback.profullstack.com/embed/profullstack-feedback.js"` — the default `src`.

## Migration

Every app below loads the same script with only `data-property` differing. After installing `@profullstack/stack`:

1. Add the import to the layout: `import { FeedbackWidget } from "@profullstack/stack/feedback";`
2. Delete the pasted snippet and render `<FeedbackWidget property="<site-key>" />` in its place (anywhere inside `<body>`).

### Pattern A — raw `<script>` in a Next.js layout

**Before** (e.g. `ugig.net/src/app/layout.tsx:103`):

```tsx
<script async src="https://feedback.profullstack.com/embed/profullstack-feedback.js" data-property="ugig.net"></script>
```

**After**:

```tsx
<FeedbackWidget property="ugig.net" />
```

Identical recipe per app — file and site key:

| App | Layout file | `property` |
| --- | --- | --- |
| ugig.net | `src/app/layout.tsx` | `ugig.net` |
| bittorrented (media-streamer) | `src/app/layout.tsx` | `bittorrented.com` |
| saasrow-web | `app/layout.tsx` | `saasrow.com` |
| brisk.news | `apps/web/src/app/layout.tsx` | `brisk.news` |
| b1dz.com | `apps/web/src/app/layout.tsx` | `b1dz.com` |
| c0mpute | `apps/web/src/app/layout.tsx` | `c0mpute.com` |
| coinpayportal | `src/app/layout.tsx` | `coinpayportal.com` |
| crawlproof.com | `app/layout.tsx` | `crawlproof.com` |
| d0rz | `app/layout.tsx` | `d0rz.com` |
| logicsrc | `apps/logicsrc-web/src/app/layout.tsx` | `logicsrc.com` |
| marksyncr.com | `apps/web/app/layout.jsx` | `marksyncr.com` |
| profullstack-web | `src/app/layout.tsx` | `profullstack.com` |
| profullstack-web-plans | `src/app/layout.tsx` | `profullstack.com` |
| qaaas.dev | `apps/web/app/layout.tsx` | `qaaas.dev` |
| recipepdfs.com | `app/layout.tsx` | `recipepdfs.com` |
| sh1pt.com | `sites/sh1pt.com/app/layout.tsx` | `sh1pt.com` |
| smshub | `src/app/layout.tsx` | `smshub.com` |
| threatcrush | `apps/web/src/app/layout.tsx` | `threatcrush.com` |

(Several of these layouts glue the snippet onto the closing `</body>` line, e.g. `…></script></body>` — delete only the `<script …>` part.)

### Pattern B — `next/script` `<Script>` (aiornot.vote, pairux.com)

**Before** (`aiornot.vote/apps/web/app/layout.tsx`):

```tsx
<Script
  src="https://feedback.profullstack.com/embed/profullstack-feedback.js"
  data-property="aiornot.vote"
  strategy="afterInteractive"
/>
```

**After**: `<FeedbackWidget property="aiornot.vote" />` (the component injects an async script after mount — equivalent timing to `afterInteractive`).

pairux.com additionally passes a CSP nonce (`apps/web/src/app/layout.tsx`): replace

```tsx
<script async nonce={nonce} src="https://feedback.profullstack.com/embed/profullstack-feedback.js" data-property="pairux.com"></script>
```

with `<FeedbackWidget property="pairux.com" nonce={nonce} />`.

### Pattern C — hand-rolled wrapper with hidden routes (qrypt.chat, qryptchat-web)

Both repos contain an identical `src/app/feedback-widget.jsx` that hides the FAB on chat routes (it overlaps the send button). The component above is a direct port of it.

**Before** (`qrypt.chat/src/app/layout.jsx`):

```jsx
import FeedbackWidget from './feedback-widget.jsx';
…
<FeedbackWidget />
```

**After**:

```tsx
import { FeedbackWidget } from "@profullstack/stack/feedback";
…
<FeedbackWidget property="qrypt.chat" hideOnRoutes={["/chat", "/chats", "/u", "/anon"]} />
```

Then delete `src/app/feedback-widget.jsx`. Same recipe in `qryptchat-web`.

### Non-Next / plain-HTML layouts

Use `feedbackScriptTag()` wherever the layout is a string template (the output is the same markup you have today):

```ts
import { feedbackScriptTag } from "@profullstack/stack/feedback";

const html = `<html><body>…${feedbackScriptTag({ property: "example.com" })}</body></html>`;
```
