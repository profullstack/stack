/**
 * CONTRACT TEST — packaging: package.json "exports" ↔ dist output.
 *
 * Runs against the real build output (`npx tsup` must have run — the
 * prepublishOnly script builds before tests, and the contract suite builds
 * too). For every declared subpath this asserts:
 *
 *   1. The ESM (.js), CJS (.cjs), and both type files (.d.ts / .d.cts) the
 *      exports map points at actually exist on disk.
 *   2. The CJS build loads via createRequire() and exposes the documented
 *      public API of that subpath.
 *   3. The ESM build loads via dynamic import() and exposes the same API.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
};

/** The documented public API per subpath (mirrors src/<module>/index.ts). */
const EXPECTED_EXPORTS: Record<string, string[]> = {
  ".": ["STACK_VERSION", "STACK_MODULES"],
  "./referrals": [
    "createReferralsClient",
    "createReferralsRouteHandler",
    // re-exported from @profullstack/referrals
    "DEFAULT_SPLIT",
    "generateCode",
    "calculateReferral",
    "validateCode",
    "applyReferral",
    "createCode",
    "buildReferralUrl",
    "extractCode",
    // re-exported from @profullstack/referrals/next
    "makeReferralHandlers",
    "trackReferralCode",
  ],
  "./email": [
    "createContactRoute",
    "escapeHtml",
    "verifyCaptcha",
    // re-exported from @profullstack/emailer
    "Emailer",
    "createEmailer",
  ],
  "./supabase": [
    "createBrowserSupabase",
    "createServerSupabase",
    "updateSession",
    "resolveSupabaseConfig",
  ],
  "./coinpay": [
    "createCoinPayClient",
    "CoinPayApiError",
    "COINPAY_DEFAULT_BASE_URL",
    "verifyCoinPayWebhook",
    "signCoinPayWebhook",
    "parseCoinPayWebhookEvent",
    "COINPAY_WEBHOOK_SIGNATURE_HEADER",
    "COINPAY_WEBHOOK_TOLERANCE_SECONDS",
    "getCoinPayAuthorizeUrl",
    "exchangeCoinPayCode",
    "fetchCoinPayUserinfo",
    "generateCoinPayState",
    "generateCoinPayPkcePair",
    "validateCoinPayState",
    "COINPAY_DEFAULT_ISSUER",
    "COINPAY_DEFAULT_SCOPES",
    "COINPAY_STATE_COOKIE",
    "createCoinPayLoginHandler",
    "createCoinPayCallbackHandler",
  ],
  "./crawlproof": [
    "createCrawlproofClient",
    "CrawlproofApiError",
    "CRAWLPROOF_DEFAULT_BASE_URL",
  ],
};

type ExportCondition = { types?: string; default?: string };
type ExportEntry = { import?: ExportCondition; require?: ExportCondition } | string;

function subpaths(): string[] {
  return Object.keys(pkg.exports).filter((k) => k !== "./package.json");
}

function entryFor(subpath: string): { import?: ExportCondition; require?: ExportCondition } {
  const entry = pkg.exports[subpath] as ExportEntry;
  expect(typeof entry, `exports["${subpath}"] must be a conditions object`).toBe("object");
  return entry as { import?: ExportCondition; require?: ExportCondition };
}

function resolveDist(rel: string | undefined, label: string): string {
  expect(rel, `${label} path must be declared`).toBeTruthy();
  expect(rel!.startsWith("./dist/"), `${label} must point into dist/`).toBe(true);
  return path.join(ROOT, rel!);
}

// ---------------------------------------------------------------------------
// 1. Every declared subpath → dist ESM + CJS + types exist
// ---------------------------------------------------------------------------

describe("exports map ↔ dist files", () => {
  it("declares exactly the documented module set", () => {
    expect([...subpaths()].sort()).toEqual(
      [".", "./coinpay", "./crawlproof", "./email", "./referrals", "./supabase"].sort(),
    );
  });

  for (const subpath of subpaths()) {
    it(`${subpath}: dist ESM/CJS/d.ts/d.cts all exist`, () => {
      const entry = entryFor(subpath);
      const esm = resolveDist(entry.import?.default, `${subpath} import.default`);
      const cjs = resolveDist(entry.require?.default, `${subpath} require.default`);
      const dts = resolveDist(entry.import?.types, `${subpath} import.types`);
      const dcts = resolveDist(entry.require?.types, `${subpath} require.types`);
      expect(esm.endsWith(".js"), `${subpath} ESM file should end in .js`).toBe(true);
      expect(cjs.endsWith(".cjs"), `${subpath} CJS file should end in .cjs`).toBe(true);
      for (const file of [esm, cjs, dts, dcts]) {
        expect(existsSync(file), `${path.relative(ROOT, file)} must exist — run npx tsup`).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. CJS builds load and expose the documented API
// ---------------------------------------------------------------------------

describe("CJS builds load via createRequire()", () => {
  const require = createRequire(import.meta.url);

  for (const subpath of subpaths()) {
    it(`${subpath}: require() exposes the documented exports`, () => {
      const entry = entryFor(subpath);
      const cjs = resolveDist(entry.require?.default, `${subpath} require.default`);
      const mod = require(cjs) as Record<string, unknown>;
      for (const name of EXPECTED_EXPORTS[subpath] ?? []) {
        expect(
          mod[name],
          `${subpath} CJS build is missing export "${name}"`,
        ).toBeDefined();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 3. ESM builds load and expose the documented API
// ---------------------------------------------------------------------------

describe("ESM builds load via import()", () => {
  for (const subpath of subpaths()) {
    it(`${subpath}: import() exposes the documented exports`, async () => {
      const entry = entryFor(subpath);
      const esm = resolveDist(entry.import?.default, `${subpath} import.default`);
      const mod = (await import(esm)) as Record<string, unknown>;
      for (const name of EXPECTED_EXPORTS[subpath] ?? []) {
        expect(
          mod[name],
          `${subpath} ESM build is missing export "${name}"`,
        ).toBeDefined();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Spot-check runtime behavior of the loaded builds (not just key presence)
// ---------------------------------------------------------------------------

describe("loaded builds are functional", () => {
  it("root ESM exposes the module manifest", async () => {
    const entry = entryFor(".");
    const mod = (await import(resolveDist(entry.import?.default, ". import.default"))) as {
      STACK_VERSION: string;
      STACK_MODULES: readonly string[];
    };
    expect(mod.STACK_VERSION).toBe(pkgVersion());
    expect([...mod.STACK_MODULES].sort()).toEqual(
      ["coinpay", "crawlproof", "email", "referrals", "supabase"].sort(),
    );
  });

  it("coinpay CSM/CJS verifyCoinPayWebhook works from the loaded build", () => {
    const require = createRequire(import.meta.url);
    const entry = entryFor("./coinpay");
    const mod = require(resolveDist(entry.require?.default, "./coinpay require.default")) as {
      signCoinPayWebhook: (o: { rawBody: string; secret: string; timestamp?: number }) => string;
      verifyCoinPayWebhook: (o: {
        signature: string;
        rawBody: string;
        secret: string;
        now?: number;
      }) => boolean;
    };
    const rawBody = JSON.stringify({ type: "payment.confirmed", data: {} });
    const sig = mod.signCoinPayWebhook({ rawBody, secret: "whsecret_x", timestamp: 1000 });
    expect(mod.verifyCoinPayWebhook({ signature: sig, rawBody, secret: "whsecret_x", now: 1000 }))
      .toBe(true);
    expect(mod.verifyCoinPayWebhook({ signature: sig, rawBody, secret: "wrong", now: 1000 }))
      .toBe(false);
  });

  it("email ESM escapeHtml works from the loaded build", async () => {
    const entry = entryFor("./email");
    const mod = (await import(resolveDist(entry.import?.default, "./email import.default"))) as {
      escapeHtml: (s: string) => string;
    };
    expect(mod.escapeHtml(`<a>"&'</a>`)).toBe("&lt;a&gt;&quot;&amp;&#39;&lt;/a&gt;");
  });
});

function pkgVersion(): string {
  return (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string })
    .version;
}
