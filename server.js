// tigerquiz — a self-hosted live quiz game.
//
// This file is wiring only. The parts are:
//
//   lib/config.js    paths and tunables read from the environment
//   lib/auth.js      who is asking, and what they may touch
//   lib/content.js   reading and writing quizzes and class lists on disk
//   lib/routes.js    the HTTP API the teacher's browser calls
//   lib/room.js      one live game: players, clock, scoring, rewind
//   lib/registry.js  every open game, and the host keys that create them
//   lib/sockets.js   the websocket messages for hosts and players
//   lib/questions.js question types: validation, presentation, grading
//   lib/db.js        the SQLite report store
//
// Live games are held in memory, so this must run as exactly one process.
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import * as store from "./lib/db.js";
import * as nick from "./lib/nicknames.js";
import { attachUser } from "./lib/auth.js";
import { apiRouter } from "./lib/routes.js";
import { attachSockets } from "./lib/sockets.js";
import { closeAllRooms } from "./lib/registry.js";
import { PORT, HOST, PUBLIC_DIR, IMAGE_DIR, DATA_DIR, BLOCKED_WORDS } from "./lib/config.js";

store.open(DATA_DIR);
// optional extra blocked nicknames, one per line
await nick.loadExtraWords(BLOCKED_WORDS);

const app = express();
const http = createServer(app);
const io = new Server(http);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/quiz-images", express.static(IMAGE_DIR));
// Identity first: the API needs req.user, and /api/me answers for the pages.
app.use(attachUser);
app.use("/api", apiRouter());

attachSockets(io);

http.listen(PORT, HOST, () => {
  console.log(`tigerquiz listening on http://localhost:${PORT} (bound to ${HOST})`);
  console.log(`  host:    http://localhost:${PORT}/host.html`);
  console.log(`  play:    http://localhost:${PORT}/`);
  console.log(`  reports: http://localhost:${PORT}/reports.html`);
});

// ---------- going away ----------
// Every live game is in this process's memory, so anything that ends the
// process ends every lesson running on it. That is by design and the README
// says so; what follows only makes it visible instead of silent, and leaves the
// database tidy behind it.
let closing = false;

function shutdown(reason, code = 0) {
  if (closing) return;
  closing = true;
  console.log(`shutting down: ${reason}`);
  try {
    const n = closeAllRooms(io);
    if (n) console.log(`  told ${n} open game${n === 1 ? "" : "s"} the server is going away`);
  } catch (e) {
    console.error("  could not close rooms:", e);
  }
  try {
    store.close();
  } catch (e) {
    console.error("  could not close the database:", e);
  }
  // Stop accepting connections, but do not wait forever for a websocket that a
  // sleeping phone is still holding open.
  const done = () => process.exit(code);
  const forced = setTimeout(done, 5000).unref();
  io.close(() => http.close(() => { clearTimeout(forced); done(); }));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// A crash would otherwise take every game with it and say nothing. Log it, shut
// down the same way as a signal, and exit non-zero so systemd restarts us.
process.on("uncaughtException", (err) => {
  console.error("uncaught exception:", err);
  shutdown("uncaught exception", 1);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason);
  shutdown("unhandled rejection", 1);
});
