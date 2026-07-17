/**
 * Test stub for `next/server`, resolved via the `resolve.alias` in
 * vitest.config.ts. `next` is an optional peer dependency and is not
 * installed in this package; the modules under test load `next/server`
 * through a literal dynamic `import()`, which vitest resolves through this
 * alias. Both the module under test and the test file import the same
 * module instance, so `FakeNextResponse.instances` is observable.
 */

import { vi } from "vitest";

/** Minimal NextResponse stand-in recording `next()` constructions. */
export class FakeNextResponse {
  static instances: FakeNextResponse[] = [];
  cookies = { set: vi.fn() };
  init: unknown;
  static next(init?: unknown): FakeNextResponse {
    const r = new FakeNextResponse();
    r.init = init;
    FakeNextResponse.instances.push(r);
    return r;
  }
  static reset(): void {
    FakeNextResponse.instances = [];
  }
}

export const NextResponse = FakeNextResponse;
