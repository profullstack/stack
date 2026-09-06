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
// Kept in step with package.json by hand; tests/contract asserts they match,
// so a release that bumps one and not the other fails there rather than
// shipping a package that misreports its own version.
export const STACK_VERSION = "0.2.0";
export const STACK_MODULES = [
  "referrals",
  "email",
  "supabase",
  "feedback",
  "coinpay",
  "crawlproof",
] as const;
