/**
 * Session policy.
 *
 * Two clocks, both enforced on the server:
 *
 *   idleSeconds       restarts on every visit. Null means no idle timeout.
 *   absoluteSeconds   renewal can never push past it.
 *
 * A staff session can reach every client's data, so it expires in hours while a
 * client's renews silently for a month. No hosted authentication vendor can
 * express this — they configure one inactivity timeout and one maximum lifetime
 * per application, for everybody — which is the main reason this login is ours.
 *
 * These values are COPIED ONTO THE SESSION ROW when it is created. Promoting
 * someone to staff tomorrow must not retroactively stretch a session that is
 * already live, and demoting them must not silently extend one either.
 */

export type SessionRole = "client" | "staff";

export const SESSION_POLICY: Record<
  SessionRole,
  { idleSeconds: number | null; absoluteSeconds: number }
> = {
  client: {
    idleSeconds: null,
    absoluteSeconds: 30 * 24 * 60 * 60, // 30 days
  },
  staff: {
    idleSeconds: 30 * 60, // 30 minutes
    absoluteSeconds: 8 * 60 * 60, // 8 hours
  },
};

/** Sign-in codes are short-lived and few. */
export const SIGN_IN_CODE = {
  ttlSeconds: 10 * 60,
  maxAttempts: 5,
  /** Requests for a new code, per address, per window. */
  maxRequestsPerWindow: 5,
  requestWindowSeconds: 15 * 60,
};

/**
 * The cross-domain ticket is measured in seconds because it only has to survive
 * one redirect. Anything longer is a credential sitting in a browser's history.
 */
export const SSO_TICKET_TTL_SECONDS = 30;

/** A staff grant covers one client for one working stretch, then lapses. */
export const STAFF_GRANT_SECONDS = 30 * 60;

/**
 * What one API key may file, per hour.
 *
 * A client's contact form is the thing on the other end, so this is sized for a
 * busy day rather than for a machine: sixty an hour is far more than any real
 * form produces and far less than a script pointed at the endpoint would. The
 * count comes from the database rather than from memory, because the
 * application runs as more than one instance.
 */
export const API_KEY_RATE = {
  maxJobsPerWindow: 60,
  windowSeconds: 60 * 60,
};

/**
 * Browsers cap every cookie at 400 days regardless of what the server asks for,
 * so no configuration above this is real. It is only a backstop — liveness is
 * decided from the session row, never from the cookie's own expiry, because a
 * browser can keep sending an expired cookie indefinitely.
 */
export const MAX_COOKIE_SECONDS = 400 * 24 * 60 * 60;
