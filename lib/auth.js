// Who is asking, and what they are allowed to touch.
//
// The app never speaks SAML. Apache terminates Shibboleth and passes an
// identity in one request header; everything here reads that header and
// nothing more. Two things make it trustworthy, and it is worth nothing
// without both:
//
//   1. Apache unsets any copy the client sent, then sets it from the session.
//   2. Node binds to loopback, so nothing reaches it around Apache.
//
// See deploy/apache-shibboleth.conf.example. If the app is reachable directly,
// anybody can send this header and be anybody.
//
// With TIGERQUIZ_AUTH unset there are no identities at all and every check
// below passes, which is how a laptop in a classroom keeps working.
import * as store from "./db.js";
import { AUTH_REQUIRED, USER_HEADER, NAME_HEADER, DEV_USER } from "./config.js";

/**
 * The signed-in instructor, or null. Reads the proxy's header, falling back to
 * TIGERQUIZ_DEV_USER outside production so the app can be developed without a
 * proxy in front.
 *
 * @param {{ headers: Record<string, any> }} req
 */
export function identify(req) {
  const raw = req?.headers?.[USER_HEADER];
  const eppn = String(Array.isArray(raw) ? raw[0] : raw || "").trim() || DEV_USER;
  if (!eppn) return null;
  const nameRaw = req?.headers?.[NAME_HEADER];
  const displayName = String(Array.isArray(nameRaw) ? nameRaw[0] : nameRaw || "").trim() || null;
  return store.touchUser(eppn, displayName);
}

/**
 * Attach req.user for every request. Never rejects: the routes that require an
 * instructor say so themselves, so the public join endpoints stay public.
 */
export function attachUser(req, _res, next) {
  req.user = identify(req);
  next();
}

/**
 * Refuse an instructor route without an identity.
 *
 * Apache already decides which paths need a Shibboleth session, so in a correct
 * deployment this never fires. It is here as the second line: a proxy
 * misconfiguration should cost a 401, not the class list.
 */
export function requireInstructor(req, res, next) {
  if (!AUTH_REQUIRED) return next();
  if (!req.user) return res.status(401).json({ error: "Sign in to use this page" });
  next();
}

/** The eppn to scope queries by, or null when sign-in is switched off. */
export const scopeFor = (req) => (AUTH_REQUIRED ? req.user?.eppn ?? null : null);

/**
 * Whether `user` may open something owned by `owner`.
 *
 * Unowned content — the quizzes shipped with the app, anything dropped into
 * quizzes/ by hand, and every report recorded before sign-in existed — is
 * readable by every instructor. Owned content is private to its owner.
 */
export function canRead(user, owner) {
  if (!AUTH_REQUIRED) return true;
  if (owner == null) return true;
  return !!user && (user.eppn === owner || user.role === "admin");
}

/**
 * Whether `user` may change or delete it. Unowned content is deliberately
 * read-only: a file nobody has claimed is not yours to overwrite. Claim it
 * first, which is one click in the editor.
 */
export function canWrite(user, owner) {
  if (!AUTH_REQUIRED) return true;
  if (!user) return false;
  if (owner == null) return false;
  return user.eppn === owner || user.role === "admin";
}

/** True when this is a brand new thing, which the creator owns outright. */
export const canCreate = (user) => !AUTH_REQUIRED || !!user;

/** The 403 body used wherever a write is refused, so the editor can act on it. */
export const forbidden = (owner) =>
  owner == null
    ? { error: "Nobody owns this yet. Claim it before editing.", claimable: true }
    : { error: "This belongs to another instructor." };
