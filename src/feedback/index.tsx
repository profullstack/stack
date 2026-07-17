"use client";

import { useEffect } from "react";
import { FEEDBACK_SCRIPT_URL, matchesRoutePrefix } from "./core.js";

export {
  FEEDBACK_SCRIPT_URL,
  feedbackScriptTag,
  matchesRoutePrefix,
} from "./core.js";
export type { FeedbackScriptTagOptions } from "./core.js";

/** Props for {@link FeedbackWidget}. */
export interface FeedbackWidgetProps {
  /** Site key registered at feedback.profullstack.com — sent as `data-property`. */
  property: string;
  /**
   * Route prefixes where the widget is hidden (exact match or path ancestor),
   * e.g. `["/chat", "/u"]`. Useful when the floating button overlaps UI on
   * specific pages. Default: show everywhere.
   */
  hideOnRoutes?: readonly string[];
  /**
   * Current pathname. Auto-detected via `next/navigation` when omitted;
   * pass it explicitly in non-Next apps (or to override detection).
   */
  pathname?: string | null;
  /** Embed script URL. Default: {@link FEEDBACK_SCRIPT_URL}. */
  src?: string;
  /** CSP nonce for apps with a strict script-src policy (e.g. pairux.com). */
  nonce?: string;
}

/** Selector for the elements the embed injects (floating button + panel). */
const WIDGET_ELEMENT_SELECTOR = "#pf-fab, #pf-panel";
/** Id of the `<style>` tag that keeps the widget hidden on excluded routes. */
const HIDE_STYLE_ID = "pf-feedback-hide";
/** CSS rule written into the hide style tag. */
const HIDE_STYLE_RULE = "#pf-fab,#pf-panel{display:none !important;}";

/** Removes the injected FAB/panel and this property's embed script tag. */
function removeFeedbackWidget(property: string): void {
  document.querySelectorAll(WIDGET_ELEMENT_SELECTOR).forEach((el) => el.remove());
  document.querySelectorAll("script[data-property]").forEach((el) => {
    if (el.getAttribute("data-property") === property) el.remove();
  });
}

/**
 * Adds a `display:none` rule for #pf-fab/#pf-panel so the widget stays hidden
 * even if the embed (loaded on a previous page) injects the FAB late.
 */
function addFeedbackHideStyle(): void {
  if (document.getElementById(HIDE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HIDE_STYLE_ID;
  style.textContent = HIDE_STYLE_RULE;
  document.head.appendChild(style);
}

/** Removes the hide rule added by {@link addFeedbackHideStyle}, if present. */
function removeFeedbackHideStyle(): void {
  document.getElementById(HIDE_STYLE_ID)?.remove();
}

/**
 * Appends the embed script to `<body>`, unless a script for this property is
 * already present (the embed is not SPA-aware, but one tag per page is enough).
 * Returns the script element so callers can remove it on cleanup.
 */
function injectFeedbackScript(
  property: string,
  src: string,
  nonce?: string
): HTMLScriptElement {
  const existing = Array.from(
    document.querySelectorAll("script[data-property]")
  ).find((el) => el.getAttribute("data-property") === property);
  if (existing) return existing as HTMLScriptElement;

  const script = document.createElement("script");
  script.async = true;
  script.src = src;
  if (nonce) script.nonce = nonce;
  script.dataset["property"] = property;
  document.body.appendChild(script);
  return script;
}

/**
 * Best-effort current pathname with no Next dependency: reads `window.location`
 * on the client. NOT reactive to SPA navigation — for `hideOnRoutes` to update
 * on client-side route changes, pass the `pathname` prop explicitly (e.g. from
 * `next/navigation`'s `usePathname`).
 */
function useClientPathname(): string | null {
  return typeof window !== "undefined" ? window.location.pathname : null;
}

/**
 * Loads the feedback.profullstack.com widget and keeps it off the routes
 * listed in `hideOnRoutes`. Renders nothing — drop it anywhere in a layout:
 *
 * ```tsx
 * import { FeedbackWidget } from "@profullstack/stack/feedback";
 *
 * <FeedbackWidget property="qrypt.chat" hideOnRoutes={["/chat", "/chats", "/u", "/anon"]} />
 * ```
 *
 * On hidden routes the FAB/panel are removed and a `display:none` rule is
 * kept in `<head>` so a late-injected FAB never flashes. The embed script is
 * injected at most once per property and cleaned up on unmount.
 */
export function FeedbackWidget({
  property,
  hideOnRoutes = [],
  pathname,
  src = FEEDBACK_SCRIPT_URL,
  nonce,
}: FeedbackWidgetProps): null {
  const detectedPathname = useClientPathname();
  const currentPathname = pathname !== undefined ? pathname : detectedPathname;
  const hidden = matchesRoutePrefix(currentPathname, hideOnRoutes);

  useEffect(() => {
    if (hidden) {
      removeFeedbackWidget(property);
      addFeedbackHideStyle();
      return () => removeFeedbackHideStyle();
    }

    removeFeedbackHideStyle();
    const script = injectFeedbackScript(property, src, nonce);
    return () => {
      script.remove();
      removeFeedbackWidget(property);
    };
  }, [hidden, property, src, nonce]);

  return null;
}
