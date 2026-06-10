import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

/**
 * Bearer authentication (lessons C-4, M-5).
 *
 *  - Token is read ONLY from the Authorization header, never the query string.
 *  - Comparison is constant-time over fixed-length SHA-256 digests, so neither the value
 *    nor the length leaks via timing, and unequal lengths don't throw.
 *  - A per-IP failure counter triggers a temporary lockout (cheap brute-force defense).
 *  - This middleware runs BEFORE body parsing, so an unauthenticated request never reaches
 *    JSON deserialization (no pre-auth attack surface on the parser).
 */

interface Attempt {
  fails: number;
  lockedUntil: number;
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

function constantTimeEqual(a: string, b: string): boolean {
  // Fixed-length digests make timingSafeEqual safe regardless of input length.
  return timingSafeEqual(digest(a), digest(b));
}

function clientIp(req: Request): string {
  // req.ip honours Express's `trust proxy` setting: X-Forwarded-For counts only when the
  // request actually came through the loopback proxy (Caddy). Reading the header directly
  // would let a directly-connected client spoof its lockout bucket — rotate XFF to dodge
  // the lockout, or set a victim's address to lock them out.
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/** Hard cap on tracked client addresses so an address-rotating client cannot grow the map. */
const MAX_TRACKED_IPS = 10_000;

export function makeAuthMiddleware(config: Config, log: Logger) {
  const expectedDigest = digest(config.token);
  const attempts = new Map<string, Attempt>();
  const { lockoutThreshold, lockoutMs } = config.rateLimit;

  return function auth(req: Request, res: Response, next: NextFunction): void {
    const ip = clientIp(req);
    const now = Date.now();
    const rec = attempts.get(ip);

    if (rec && rec.lockedUntil > now) {
      res.status(429).json({ error: "too many failed attempts; temporarily locked out" });
      return;
    }

    const header = req.headers.authorization;
    const fail = (reason: string) => {
      if (!attempts.has(ip) && attempts.size >= MAX_TRACKED_IPS) {
        // Prefer dropping records whose lockout has expired; fall back to the oldest.
        for (const [k, v] of attempts) {
          if (v.lockedUntil <= now) {
            attempts.delete(k);
            break;
          }
        }
        if (attempts.size >= MAX_TRACKED_IPS) {
          const oldest = attempts.keys().next().value;
          if (oldest !== undefined) attempts.delete(oldest);
        }
      }
      const a = attempts.get(ip) ?? { fails: 0, lockedUntil: 0 };
      a.fails += 1;
      if (a.fails >= lockoutThreshold) {
        a.lockedUntil = now + lockoutMs;
        a.fails = 0;
        log.warn("auth_lockout", { ip, lockoutMs });
      }
      attempts.set(ip, a);
      log.warn("auth_fail", { ip, reason });
      res.status(401).json({ error: "unauthorized" });
    };

    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      fail("missing_bearer");
      return;
    }
    const presented = header.slice("Bearer ".length).trim();
    if (presented.length === 0) {
      fail("empty_token");
      return;
    }

    // Constant-time compare against the expected digest.
    const ok = timingSafeEqual(digest(presented), expectedDigest);
    if (!ok) {
      fail("bad_token");
      return;
    }

    // Success: reset the failure record.
    if (rec) attempts.delete(ip);
    next();
  };
}

// Exported for unit testing.
export const __test = { constantTimeEqual };
