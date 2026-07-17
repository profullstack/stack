import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "referrals/index": "src/referrals/index.ts",
    "email/index": "src/email/index.ts",
    "supabase/index": "src/supabase/index.ts",
    "feedback/index": "src/feedback/index.tsx",
    "coinpay/index": "src/coinpay/index.ts",
    "crawlproof/index": "src/crawlproof/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  splitting: false,
  external: [
    "react",
    "react-dom",
    "next",
    "@supabase/ssr",
    "@supabase/supabase-js",
  ],
});
