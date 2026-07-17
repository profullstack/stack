/**
 * @profullstack/stack — root entry.
 *
 * Import modules via subpaths, e.g.:
 *   import { createContactRoute } from "@profullstack/stack/email";
 *   import { createServerSupabase } from "@profullstack/stack/supabase";
 *
 * The root entry intentionally exports almost nothing so importing it never
 * pulls framework code (next/react/supabase) into your bundle.
 */
export const STACK_VERSION = "0.1.0";
export const STACK_MODULES = [
  "referrals",
  "email",
  "supabase",
  "feedback",
  "coinpay",
  "crawlproof",
] as const;
