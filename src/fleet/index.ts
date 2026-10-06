/**
 * The Profullstack fleet: one catalog of every product we run, for MCP servers,
 * webhooks, CLIs and sites to share instead of each keeping its own list.
 *
 * Every service signs people in with CoinPay OAuth (OIDC at coinpayportal.com,
 * authorization code + PKCE S256), so a client that can talk to one of them can
 * talk to all of them. `surfaces` lists only what answered when the catalog was
 * probed: a null means "not found", not "not planned".
 *
 *   import { listServices, getService, searchServices } from "@profullstack/stack/fleet";
 */
import { createHmac } from "node:crypto";
import data from "./fleet.json";

export interface FleetAuth {
  kind: "oauth";
  provider: "coinpay";
  issuer: string;
}

export interface FleetSurfaces {
  web: string;
  api: string | null;
  openapi: string | null;
  mcp: string | null;
  mcp_tools: number | null;
  openmcp: string | null;
  llms: string | null;
  /** A shell one-liner when the product has a curl installer. */
  install: string | null;
  pwa: boolean;
  openaccess: string | null;
}

export interface FleetService {
  domain: string;
  name: string;
  description: string | null;
  category: string;
  url: string;
  live: boolean;
  auth: FleetAuth;
  surfaces: FleetSurfaces;
  npm: string[];
  /** Its install page on pwamart.com, when it is listed there. */
  pwamart: string | null;
}

export interface FleetCatalog {
  version: number;
  updated: string;
  auth: {
    kind: "oauth";
    provider: "coinpay";
    issuer: string;
    discovery: string;
    scopes: string;
    pkce: "S256";
    callback_path: string;
  };
  services: FleetService[];
}

export const FLEET: FleetCatalog = data as FleetCatalog;

/** How every fleet service signs people in. */
export const FLEET_AUTH = FLEET.auth;

export interface ListOptions {
  category?: string;
  /** Only services with this surface, e.g. "mcp", "api", "install", "pwa". */
  has?: keyof FleetSurfaces;
  liveOnly?: boolean;
}

export function listServices(options: ListOptions = {}): FleetService[] {
  return FLEET.services.filter(
    (s) =>
      (!options.category || s.category === options.category) &&
      (!options.has || Boolean(s.surfaces[options.has])) &&
      (!options.liveOnly || s.live),
  );
}

/** By domain ("hqtui.com", "www.hqtui.com", "https://hqtui.com/x") or name ("HQTUI"). */
export function getService(ref: string): FleetService | null {
  const raw = String(ref ?? "").trim().toLowerCase();
  if (!raw) return null;
  let host = raw;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    // a bare name
  }
  host = host.replace(/^www\./, "");
  return (
    FLEET.services.find((s) => s.domain === host) ??
    FLEET.services.find((s) => s.name.toLowerCase() === raw) ??
    null
  );
}

/** Ranked by where the words land: name, then domain, then category, then description. */
export function searchServices(query: string, limit = 20): FleetService[] {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return listServices().slice(0, limit);
  const scored = FLEET.services
    .map((s) => {
      let score = 0;
      for (const w of words) {
        if (s.name.toLowerCase().includes(w)) score += 5;
        if (s.domain.includes(w)) score += 4;
        if (s.category.includes(w)) score += 3;
        if ((s.description ?? "").toLowerCase().includes(w)) score += 1;
      }
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
  return scored.slice(0, limit).map((x) => x.s);
}

export function categories(): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of FLEET.services) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
  return [...counts].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
}

/* ------------------------------------------------------------- webhooks -- */

/** Event a service sends when its catalog entry changes (new surface, moved, down). */
export const FLEET_EVENT_SERVICE_UPDATED = "fleet.service.updated";
export const FLEET_SIGNATURE_HEADER = "x-fleet-signature";

/**
 * Sign a fleet webhook body with the same `t=<unix>,v1=<hmac>` scheme as CoinPay
 * webhooks, so one verifier (verifyCoinPayWebhook) checks both.
 */
export function signFleetEvent(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

export function fleetServiceUpdatedEvent(service: FleetService, changes: Partial<FleetService> = {}) {
  return {
    type: FLEET_EVENT_SERVICE_UPDATED,
    created_at: new Date().toISOString(),
    data: { domain: service.domain, service: { ...service, ...changes }, changed: Object.keys(changes) },
  };
}
