import { describe, expect, it } from "vitest";
import { verifyCoinPayWebhook } from "../src/coinpay/webhook";
import {
  FLEET,
  FLEET_AUTH,
  categories,
  fleetServiceUpdatedEvent,
  getService,
  listServices,
  searchServices,
  signFleetEvent,
} from "../src/fleet";

describe("fleet catalog", () => {
  it("covers the 62 services, each unique, each on CoinPay OAuth", () => {
    expect(FLEET.services.length).toBe(62);
    expect(new Set(FLEET.services.map((s) => s.domain)).size).toBe(62);
    for (const s of FLEET.services) {
      expect(s.auth).toEqual({ kind: "oauth", provider: "coinpay", issuer: "https://coinpayportal.com" });
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.name.length).toBeGreaterThan(1);
    }
    expect(FLEET_AUTH).toMatchObject({ issuer: "https://coinpayportal.com", pkce: "S256" });
  });

  it("finds a service by domain, URL, www host or name", () => {
    expect(getService("hqtui.com")?.name).toBe("HQTUI");
    expect(getService("https://www.hqtui.com/apps")?.domain).toBe("hqtui.com");
    expect(getService("PWAMART")?.domain).toBe("pwamart.com");
    expect(getService("nope.example")).toBeNull();
  });

  it("filters and searches", () => {
    expect(listServices({ has: "mcp" }).every((s) => s.surfaces.mcp)).toBe(true);
    expect(listServices({ category: "security" }).length).toBeGreaterThan(0);
    expect(searchServices("terminal ui")[0].domain).toBe("hqtui.com");
    expect(categories().reduce((n, c) => n + c.count, 0)).toBe(62);
  });

  it("signs fleet events so the CoinPay verifier accepts them", () => {
    const body = JSON.stringify(fleetServiceUpdatedEvent(getService("pwamart.com")!, { live: true }));
    const sig = signFleetEvent(body, "whsec_test");
    expect(verifyCoinPayWebhook({ rawBody: body, signature: sig, secret: "whsec_test" })).toBe(true);
  });
});
