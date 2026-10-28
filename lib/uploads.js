// Files students hand in for a "file" question: a photo of worked paper, a PDF.
//
// The phone cannot send a file over the websocket sensibly and has no HTTP
// session, so each player is issued an upload token at join time and POSTs
// the file to /uploads/<token>. The file lands under the data directory, its
// id goes back to the phone, and the phone answers the question with that id.
// The room then checks the id was uploaded by that player for that game, so
// nobody can answer with somebody else's file.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import * as store from "./db.js";
import { FILE_TYPES } from "./questions.js";
import { UPLOAD_DIR, UPLOAD_MAX_BYTES } from "./config.js";

/** token -> who may upload with it. In memory: a restart ends live games anyway, and homework re-issues on rejoin. */
const tokens = new Map();

export function issueToken(gameId, player) {
  const token = randomUUID();
  tokens.set(token, { gameId, player });
  return token;
}

export const forToken = (token) => tokens.get(String(token || "")) ?? null;

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf" };

/** Accept a file body for a token. Returns the stored file's id. */
export async function save(token, body, mime, originalName = "") {
  const who = forToken(token);
  if (!who) throw new Error("Join the game again before uploading");
  const type = String(mime || "").split(";")[0].trim().toLowerCase();
  if (!FILE_TYPES.includes(type)) throw new Error("Only photos (JPEG, PNG, GIF, WebP, HEIC) and PDFs can be uploaded");
  if (!body || !body.length) throw new Error("The file was empty");
  if (body.length > UPLOAD_MAX_BYTES) throw new Error(`Files are limited to ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)} MB`);
  const id = randomUUID().replace(/-/g, "");
  const dir = path.join(UPLOAD_DIR, who.gameId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.${EXT[type]}`);
  await writeFile(file, body);
  const name = String(originalName || "").replace(/[\r\n]/g, " ").slice(0, 80) || `${who.player}.${EXT[type]}`;
  store.recordUpload({ id, gameId: who.gameId, player: who.player, path: file, type, size: body.length, name, createdAt: Date.now() });
  return { id, name, type, size: body.length };
}

/** The stored file, if this player uploaded it for this game. */
export function owned(id, gameId, player) {
  const u = store.getUpload(id);
  return u && u.game_id === gameId && u.player === player ? u : null;
}

/** The file behind an id, for the reports page, or null. */
export async function locate(id) {
  const u = store.getUpload(id);
  if (!u) return null;
  try { await stat(u.path); } catch { return null; }
  return u;
}
