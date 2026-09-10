// Everything the server reads from the environment or derives from the checkout
// layout, in one place so no module has to guess at a path.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PUBLIC_DIR = path.join(ROOT, "public");
export const QUIZ_DIR = path.join(ROOT, "quizzes");
export const IMAGE_DIR = path.join(QUIZ_DIR, "images");
export const ROSTER_DIR = path.join(QUIZ_DIR, "rosters");
export const DATA_DIR = process.env.TIGERQUIZ_DATA || path.join(ROOT, "data");
export const BLOCKED_WORDS = path.join(QUIZ_DIR, "blocked-words.txt");

export const PORT = Number(process.env.PORT) || 3000;
// Bind everywhere by default: players reach the host by network address, and a
// container needs 0.0.0.0. Set HOST=127.0.0.1 when a proxy in front supplies
// the identity header, so nothing can reach the app around it (see deploy/).
export const HOST = process.env.HOST || "0.0.0.0";

export const STREAK_BONUS = 100; // per consecutive correct answer beyond the first
export const STREAK_BONUS_CAP = 500;
export const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS) || 3 * 60 * 1000;
export const HOST_KEY_TTL_MS = Number(process.env.HOST_KEY_TTL_MS) || 12 * 60 * 60 * 1000;
export const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;

// ---------- guessing a PIN ----------
// How many wrong PINs a client may try before it has to wait, and how fast that
// budget comes back. The defaults let a whole class fat-finger the PIN a few
// times while turning a sweep of all 900,000 PINs into months rather than the
// four minutes it takes unthrottled. See lib/ratelimit.js.
export const JOIN_BURST = Number(process.env.TIGERQUIZ_JOIN_BURST) || 20;
export const JOIN_REFILL_MS = Number(process.env.TIGERQUIZ_JOIN_REFILL_MS) || 10_000;

// Trust X-Forwarded-For. Only turn this on when a proxy really is in front and
// sets it: behind Apache every socket looks like 127.0.0.1, so without it one
// attacker spends the budget for everybody, and with it wrongly set a client
// can hand itself a fresh budget per request.
export const TRUST_PROXY = process.env.TIGERQUIZ_TRUST_PROXY === "true";

// ---------- identity ----------
// Sign-in is off unless a deployment asks for it, so `npm start` on a laptop
// and the Docker image behave exactly as they always have: one unnamed
// teacher who owns nothing and can see everything.
//
// Set TIGERQUIZ_AUTH=required where Apache terminates Shibboleth. Then every
// instructor route needs an identity, and quizzes, class lists and reports
// belong to whoever made them. See deploy/apache-shibboleth.conf.example.
export const AUTH_REQUIRED = process.env.TIGERQUIZ_AUTH === "required";

// Apache sets these from the Shibboleth session, and unsets any copy the
// client sent. Node reads them and nothing else; it never speaks SAML.
export const USER_HEADER = (process.env.TIGERQUIZ_USER_HEADER || "X-Remote-User").toLowerCase();
export const NAME_HEADER = (process.env.TIGERQUIZ_NAME_HEADER || "X-Remote-Name").toLowerCase();

// Stand in for the header when developing without a proxy in front. Ignored
// when NODE_ENV is production, so a stray value cannot become a way in.
export const DEV_USER = process.env.NODE_ENV === "production" ? null : process.env.TIGERQUIZ_DEV_USER || null;
