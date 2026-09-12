/**
 * Request guard for the local FLYTOWN server.
 *
 * The server can start model runs that spend the user's API budget, read
 * files into memory, and change the provider's base URL and API key. It is a
 * local tool, so every request must come from this machine's own browser tab:
 *
 *  - Host must be a loopback name (or the host the user explicitly chose with
 *    `serve --host`). This defeats DNS rebinding, where a malicious page
 *    points its own hostname at 127.0.0.1 and then talks to the server under
 *    its own origin.
 *  - State-changing requests must be same-origin: an Origin header, when
 *    present, has to match the Host; `Sec-Fetch-Site: cross-site` is refused.
 *    This defeats cross-site request forgery from any page the user visits.
 *  - State-changing requests with a body must be JSON, so the "simple"
 *    cross-origin request types browsers send without a preflight
 *    (form posts, text/plain) never reach a handler.
 */
import type { NextFunction, Request, Response } from "express";

export const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface LocalGuardOptions {
  /** Extra hostnames allowed in the Host header (the user's explicit `--host`). */
  allowHosts?: string[];
}

/** Hostname part of a Host header value, lower-cased, without the port. */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(0, end + 1) : null;
  }
  const colon = value.lastIndexOf(":");
  return colon > 0 && value.indexOf(":") === colon ? value.slice(0, colon) : value;
}

export function localGuard(opts: LocalGuardOptions = {}) {
  const allowed = new Set([...LOOPBACK_HOSTNAMES, ...(opts.allowHosts ?? []).map((h) => h.toLowerCase())]);
  return (req: Request, res: Response, next: NextFunction): void => {
    const hostHeader = req.headers.host;
    const hostname = hostnameOf(hostHeader);
    if (!hostname || !allowed.has(hostname)) {
      res.status(403).json({ error: "forbidden host" });
      return;
    }
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    if (req.headers["sec-fetch-site"] === "cross-site") {
      res.status(403).json({ error: "cross-site request refused" });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        originHost = null;
      }
      if (originHost === null || originHost !== String(hostHeader).toLowerCase()) {
        res.status(403).json({ error: "cross-origin request refused" });
        return;
      }
    }
    const length = Number(req.headers["content-length"] ?? 0);
    const hasBody = length > 0 || req.headers["transfer-encoding"] !== undefined;
    if (hasBody && !req.is("application/json")) {
      res.status(415).json({ error: "request body must be application/json" });
      return;
    }
    next();
  };
}
