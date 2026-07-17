/**
 * Pure helpers for the feedback.profullstack.com embed — no React, no DOM.
 * Safe to import from any environment (Node, edge, browser, tests).
 */

/** URL of the feedback.profullstack.com embed script. */
export const FEEDBACK_SCRIPT_URL =
  "https://feedback.profullstack.com/embed/profullstack-feedback.js";

/** Options for {@link feedbackScriptTag}. */
export interface FeedbackScriptTagOptions {
  /** Site key registered at feedback.profullstack.com — sent as `data-property`. */
  property: string;
  /** Embed script URL. Default: {@link FEEDBACK_SCRIPT_URL}. */
  src?: string;
  /** CSP nonce for apps with a strict script-src policy (e.g. pairux.com). */
  nonce?: string;
}

/** Escapes a string for use inside a double-quoted HTML attribute. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Builds the plain `<script>` tag that loads the feedback widget — the exact
 * snippet previously copy-pasted into app layouts. Use in non-React templates
 * (plain HTML, Svelte, server-side string composition); Next.js apps should
 * prefer `<FeedbackWidget />` instead.
 *
 * @example
 * feedbackScriptTag({ property: "ugig.net" })
 * // '<script async src="https://feedback.profullstack.com/embed/profullstack-feedback.js" data-property="ugig.net"></script>'
 */
export function feedbackScriptTag({
  property,
  src = FEEDBACK_SCRIPT_URL,
  nonce,
}: FeedbackScriptTagOptions): string {
  const nonceAttr = nonce ? ` nonce="${escapeAttribute(nonce)}"` : "";
  return `<script async${nonceAttr} src="${escapeAttribute(src)}" data-property="${escapeAttribute(
    property
  )}"></script>`;
}

/**
 * Returns true when `pathname` matches any of the given route prefixes —
 * either exactly (`/chat`) or as a path ancestor (`/chat/123`). A trailing
 * slash on a prefix is ignored (`/chat/` behaves like `/chat`), the prefix
 * `/` matches only the root path, and empty prefixes are ignored.
 *
 * A null/undefined/empty pathname never matches — the widget stays visible
 * when the current route is unknown (e.g. outside Next.js).
 */
export function matchesRoutePrefix(
  pathname: string | null | undefined,
  prefixes: readonly string[]
): boolean {
  if (!pathname) return false;
  return prefixes.some((raw) => {
    const prefix = raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (!prefix) return false;
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  });
}
