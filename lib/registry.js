// The live games, and the keys that let a host create one.
//
// Every open game lives in this map, in the memory of one process. That is why
// the server must never be run with more than one worker: a second process
// would serve PINs the first has never heard of. See deploy/tigerquiz.service.
import { randomUUID } from "node:crypto";
import { HOST_KEY_TTL_MS } from "./config.js";

/** @type {Map<string, import("./room.js").Room>} */
export const rooms = new Map();

export function makePin() {
  let pin;
  do pin = String(Math.floor(100000 + Math.random() * 900000));
  while (rooms.has(pin));
  return pin;
}

/**
 * Creating a game is the one privileged thing that happens over the websocket,
 * and socket.io is a single endpoint shared with players, so a proxy cannot
 * protect it by path the way it protects the rest of /api. Instead the host
 * page fetches a short-lived key over HTTP first, which a proxy *can* put
 * behind a password, and hands it back when it creates the game.
 *
 * With no proxy in front this changes nothing, exactly as before.
 */
const hostKeys = new Map(); // key -> expiry

export function issueHostKey() {
  const now = Date.now();
  for (const [k, exp] of hostKeys) if (exp <= now) hostKeys.delete(k);
  const key = randomUUID();
  hostKeys.set(key, now + HOST_KEY_TTL_MS);
  return key;
}

export function hostKeyValid(key) {
  const exp = hostKeys.get(key);
  if (exp == null) return false;
  if (exp <= Date.now()) { hostKeys.delete(key); return false; }
  return true;
}

/**
 * Tell everyone still playing that the server is going away, so phones and
 * projectors show a message instead of hanging on a socket that will never
 * answer. Games live only in this process's memory, so a restart genuinely
 * ends them; the point here is that it ends them visibly.
 */
export function closeAllRooms(io) {
  for (const room of rooms.values()) {
    clearTimeout(room.timer);
    clearTimeout(room.hostGrace);
    io.to(room.hostRoom).emit("game:closed");
    io.to(room.playerRoom).emit("game:closed");
  }
  const n = rooms.size;
  rooms.clear();
  return n;
}
