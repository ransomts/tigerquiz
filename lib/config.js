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
