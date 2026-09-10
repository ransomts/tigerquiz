// Every websocket message, for hosts and players both.
//
// This is one socket.io endpoint shared by the projector and the phones, which
// is why creating a game needs the short-lived key from /api/host-key: a proxy
// can put a password on that HTTP endpoint, but it cannot split this one by
// path. See registry.js.
import * as Q from "./questions.js";
import * as store from "./db.js";
import * as nick from "./nicknames.js";
import { Room } from "./room.js";
import { rooms, makePin, hostKeyValid } from "./registry.js";
import { loadQuiz, loadRoster, prepareQuiz, matchRoster } from "./content.js";
import { identify, canRead } from "./auth.js";
import { createLimiter, clientKey } from "./ratelimit.js";
import { MAX_ROOMS, JOIN_BURST, JOIN_REFILL_MS, TRUST_PROXY } from "./config.js";

/**
 * Wire every handler onto a socket.io server.
 *
 * The annotation is load-bearing: without it io is an implicit any, socket.io
 * stops supplying argument types to the handlers below, and TypeScript falls
 * back to inferring them from their own defaults.
 *
 * @param {import("socket.io").Server} io
 */
export function attachSockets(io) {
  const hostRoomFor = (socket) => (socket.data.role !== "host" ? null : rooms.get(socket.data.pin) || null);

  // Guessing PINs is the one thing an outsider can do here, so it is the one
  // thing that is throttled. Only wrong guesses cost anything.
  const guesses = createLimiter({ capacity: JOIN_BURST, refillMs: JOIN_REFILL_MS });
  const tooManyGuesses = (socket) => {
    const key = clientKey(socket, TRUST_PROXY);
    if (guesses.allow(key)) return null;
    return { ok: false, error: `Too many wrong PINs. Try again in ${guesses.retryAfter(key)} seconds.` };
  };
  const wrongGuess = (socket) => guesses.penalise(clientKey(socket, TRUST_PROXY));

  io.on("connection", (socket) => {
    socket.data.role = null;

    socket.on("host:create", async ({ quizId, rosterId, key } = {}, cb = () => {}) => {
      try {
        if (!hostKeyValid(key)) throw new Error("Reload the host page before creating a game");
        // an unbounded number of rooms is an unbounded amount of memory
        if (rooms.size >= MAX_ROOMS) throw new Error("Too many games are open on this server");
        // The websocket handshake goes through the same proxy as everything
        // else, so it carries the same identity header. Without a proxy this
        // is null and every check below passes, as it always did.
        const user = identify(socket.request);
        if (!canRead(user, store.ownerOf("quiz", quizId))) throw new Error("No such quiz");
        if (rosterId && !canRead(user, store.ownerOf("roster", rosterId))) throw new Error("No such class list");
        const quiz = prepareQuiz({ ...(await loadQuiz(quizId)), id: quizId });
        const roster = rosterId ? await loadRoster(rosterId) : null;
        const pin = makePin();
        const room = new Room(io, pin, socket.id, quiz, roster, user?.eppn ?? null);
        rooms.set(pin, room);
        socket.data.role = "host";
        socket.data.pin = pin;
        socket.join(room.hostRoom);
        console.log(`Room ${pin} created for "${quiz.title}"${roster ? ` (roster: ${roster.title})` : ""}`);
        cb({
          ok: true,
          pin,
          hostToken: room.hostToken,
          title: quiz.title,
          total: quiz.questions.length,
          identifier: quiz.identifier,
          roster: roster ? { title: roster.title, count: roster.students.length } : null,
          questions: quiz.questions.map((q, i) => ({ index: i, type: q.type, text: q.text })),
        });
      } catch (e) {
        cb({ ok: false, error: e.message });
      }
    });

    socket.on("host:start", ({ solo } = {}) => {
      const room = hostRoomFor(socket);
      if (!room || room.state !== "lobby") return;
      // rehearsing alone is allowed, so a quiz can be checked before a lesson
      if (room.players.size === 0 && !solo) return socket.emit("game:error", "No players have joined yet");
      room.solo = !!solo && room.players.size === 0;
      room.startQuestion();
    });

    // run the same quiz again for the people already in the room
    socket.on("host:replay", () => {
      const room = hostRoomFor(socket);
      if (!room || room.state !== "end") return;
      room.restart();
    });

    socket.on("host:next", () => {
      const room = hostRoomFor(socket);
      if (!room) return;
      // slides are advanced straight past, without a results step
      if (room.state === "question" && !Q.isAnswerable(room.question.type)) return room.startQuestion();
      if (room.state !== "results") return;
      room.startQuestion();
    });

    socket.on("host:resume-session", ({ pin, token } = {}, cb = () => {}) => {
      const room = rooms.get(String(pin || "").trim());
      if (!room || room.hostToken !== token) return cb({ ok: false, error: "That game is no longer open" });
      socket.data.role = "host";
      socket.data.pin = room.pin;
      room.hostReturned(socket);
      cb({
        ok: true,
        pin: room.pin,
        hostToken: room.hostToken,
        title: room.quiz.title,
        total: room.quiz.questions.length,
        state: room.state,
        paused: room.paused,
        identifier: room.quiz.identifier,
        roster: room.roster ? { title: room.roster.title, count: room.roster.students.length } : null,
        questions: room.quiz.questions.map((q, i) => ({ index: i, type: q.type, text: q.text })),
      });
    });

    // peer instruction: keep the first vote, ask the same question again,
    // then show both distributions side by side
    socket.on("host:revote", () => {
      const room = hostRoomFor(socket);
      if (!room || room.state !== "results" || !room.lastResults) return;
      room.priorVote = room.lastResults.summary;
      room.revoting = true;
      room.goTo(room.qIndex);
    });

    socket.on("host:pause", (paused) => {
      const room = hostRoomFor(socket);
      if (room) room.setPaused(paused !== false);
    });

    socket.on("host:goto", (index) => {
      const room = hostRoomFor(socket);
      if (!room || room.state === "lobby" || room.state === "end") return;
      if (!Number.isInteger(index)) return;
      room.goTo(index);
    });

    socket.on("host:prev", () => {
      const room = hostRoomFor(socket);
      if (!room || room.state === "lobby" || room.state === "end") return;
      // from a results screen, "back" means replay the question just shown
      const target = room.state === "results" ? room.qIndex : room.qIndex - 1;
      if (target < 0) return;
      room.goTo(target);
    });

    socket.on("host:skip", () => {
      const room = hostRoomFor(socket);
      if (!room) return;
      if (room.state === "question" && !Q.isAnswerable(room.question.type)) return room.startQuestion();
      room.endQuestion("host");
    });

    socket.on("host:kick", (name) => {
      const room = hostRoomFor(socket);
      const p = room?.players.get(name);
      if (!p) return;
      room.players.delete(name);
      if (p.socketId) io.sockets.sockets.get(p.socketId)?.emit("game:kicked");
      io.to(room.hostRoom).emit("lobby:players", room.publicPlayers());
    });

    socket.on("player:join", ({ pin, name, identifier } = {}, cb = () => {}) => {
      const throttled = tooManyGuesses(socket);
      if (throttled) return cb(throttled);
      const room = rooms.get(String(pin || "").trim());
      name = String(name || "").trim().slice(0, 20);
      identifier = String(identifier || "").trim().slice(0, 40);
      if (!room) {
        wrongGuess(socket);
        return cb({ ok: false, error: "Game not found" });
      }
      if (!name) return cb({ ok: false, error: "Enter a nickname" });
      if (nick.isBlocked(name)) return cb({ ok: false, error: "Pick a different nickname" });

      let entry = null;
      if (room.roster) {
        entry = matchRoster(room.roster, identifier);
        if (!entry) return cb({ ok: false, error: "Not on the class list. Check your name or ID." });
      } else if (room.quiz.identifier && !identifier) {
        return cb({ ok: false, error: `Enter your ${room.quiz.identifier}` });
      }
      const identity = entry ? entry.name : identifier || null;

      let p = room.players.get(name);
      if (p && p.connected) return cb({ ok: false, error: "That name is taken" });
      if (!p) {
        if (room.state !== "lobby") return cb({ ok: false, error: "Game already started" });
        p = { name, socketId: socket.id, score: 0, connected: true, streak: 0, identity };
        room.players.set(name, p);
        store.upsertPlayer(room.id, name, identity);
      } else {
        p.socketId = socket.id;
        p.connected = true;
      }
      socket.data.role = "player";
      socket.data.pin = room.pin;
      socket.data.name = name;
      socket.join(room.playerRoom);
      io.to(room.hostRoom).emit("lobby:players", room.publicPlayers());

      cb({
        ok: true,
        name,
        state: room.state,
        score: p.score,
        answered: room.answers.has(name),
        question:
          room.state === "question"
            ? {
                index: room.qIndex,
                total: room.quiz.questions.length,
                endsAt: room.endsAt,
                totalMs: room.question.time * 1000,
                remainingMs: room.remainingMs,
                paused: room.paused,
                ...Q.playerView(room.question, room.pres, { showText: room.quiz.phoneText }),
              }
            : null,
      });
    });

    // what the join screen must ask for before a player can enter
    socket.on("player:lobby", ({ pin } = {}, cb = () => {}) => {
      const throttled = tooManyGuesses(socket);
      if (throttled) return cb(throttled);
      const room = rooms.get(String(pin || "").trim());
      if (!room) {
        wrongGuess(socket);
        return cb({ ok: false, error: "Game not found" });
      }
      cb({
        ok: true,
        title: room.quiz.title,
        identifier: room.roster ? "Your name or student ID" : room.quiz.identifier,
        roster: !!room.roster,
      });
    });

    socket.on("player:answer", (response, cb = () => {}) => {
      const room = rooms.get(socket.data.pin);
      if (!room || socket.data.role !== "player") return cb({ ok: false, error: "Not in a game" });
      cb(room.recordAnswer(socket.data.name, response));
    });

    socket.on("disconnect", () => {
      const room = rooms.get(socket.data.pin);
      if (!room) return;
      if (socket.data.role === "host") {
        if (room.hostId !== socket.id) return; // an older host socket going away
        console.log(`Host left room ${room.pin}; holding it open`);
        room.hostDropped();
      } else if (socket.data.role === "player") {
        const p = room.players.get(socket.data.name);
        if (p && p.socketId === socket.id) {
          p.connected = false;
          p.socketId = null;
          if (room.state === "lobby") room.players.delete(p.name);
          io.to(room.hostRoom).emit("lobby:players", room.publicPlayers());
        }
      }
    });
  });
}
