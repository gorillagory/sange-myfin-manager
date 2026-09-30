import { fail } from "./validation.js";

const hostnamePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeHostname(value = "") {
  const text = String(value).trim().toLowerCase();
  const host = text.startsWith("[")
    ? text.slice(1, text.indexOf("]"))
    : text.replace(/:\d+$/, "");
  if (host === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host;
  if (!host || host.length > 253 || !hostnamePattern.test(host)) return "";
  return host;
}

export function hostAllowed(hostname, patterns = []) {
  return patterns.some(pattern => pattern.startsWith("*.")
    ? hostname.length > pattern.length - 1 && hostname.endsWith(pattern.slice(1))
    : hostname === pattern);
}

export function requestHostname(req) {
  return normalizeHostname(req.headers.host || "");
}

export function requestOrigin(req, options) {
  const hostname = requestHostname(req);
  if (!hostname || !hostAllowed(hostname, options.allowedHosts)) fail(404, "not_found");
  const rawHost = String(req.headers.host || "").toLowerCase();
  return `${options.protocol}//${rawHost}`;
}

export async function tenantForHost(db, hostname) {
  if (!hostname) return null;
  const { rows } = await db.query(
    `SELECT h.hostname,h.canonical,h.redirect_to,h.workspace_id,h.company_id,
            w.name AS workspace_name,w.slug AS workspace_slug,
            c.name AS company_name,c.slug AS company_slug
       FROM myfin.tenant_hosts h
       JOIN myfin.workspaces w ON w.id=h.workspace_id
       JOIN myfin.companies c ON c.id=h.company_id AND c.workspace_id=h.workspace_id
      WHERE h.hostname=$1 AND h.disabled_at IS NULL
        AND w.suspended_at IS NULL AND w.archived_at IS NULL
        AND c.suspended_at IS NULL AND c.archived_at IS NULL`,
    [hostname],
  );
  return rows[0] || null;
}

export async function storefrontForHost(db, hostname) {
  if (!hostname) return null;
  const { rows } = await db.query(
    `SELECT h.hostname,h.company_id,c.workspace_id,c.name AS company_name,c.slug AS company_slug,
            w.name AS workspace_name,w.slug AS workspace_slug
       FROM myfin.storefront_hosts h
       JOIN myfin.companies c ON c.id=h.company_id
       JOIN myfin.workspaces w ON w.id=c.workspace_id
      WHERE h.hostname=$1 AND h.disabled_at IS NULL
        AND w.suspended_at IS NULL AND w.archived_at IS NULL
        AND c.suspended_at IS NULL AND c.archived_at IS NULL`,
    [hostname],
  );
  return rows[0] || null;
}

export async function requestContext(db, req, options) {
  const hostname = requestHostname(req);
  if (!hostname || !hostAllowed(hostname, options.allowedHosts)) return null;
  if (options.controlHosts.includes(hostname)) return { hostname, surface: "control" };
  const tenant = await tenantForHost(db, hostname);
  if (tenant) return { ...tenant, surface: "tenant" };
  const storefront = await storefrontForHost(db, hostname);
  return storefront ? { ...storefront, surface: "storefront" } : null;
}

export function publicTenant(context) {
  if (!context) return null;
  if (context.surface === "control") return { surface: "control", hostname: context.hostname };
  if (context.surface === "storefront") return {
    surface: "storefront", hostname: context.hostname,
    workspace: { id: context.workspace_id, name: context.workspace_name, slug: context.workspace_slug },
    company: { id: context.company_id, name: context.company_name, slug: context.company_slug },
  };
  return {
    surface: "tenant",
    hostname: context.hostname,
    canonical: context.canonical,
    redirectTo: context.redirect_to || "",
    workspace: { id: context.workspace_id, name: context.workspace_name, slug: context.workspace_slug },
    company: { id: context.company_id, name: context.company_name, slug: context.company_slug },
  };
}
