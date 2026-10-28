// One live game: its players, its clock, and every message it sends.
//
// The Room owns all game state and is the only thing that mutates a score, so
// rewinding to an earlier question stays correct: goTo() restores the snapshot
// taken before that question and deletes the answers recorded from it onward,
// which is what stops a replay awarding the same points twice.
//
// socket.io is passed in rather than imported. The Room is the piece worth
// testing directly, and a module-level io would make that impossible.
import { randomUUID } from "node:crypto";
import * as Q from "./questions.js";
import * as store from "./db.js";
import * as uploads from "./uploads.js";
import { rooms } from "./registry.js";
import { STREAK_BONUS, STREAK_BONUS_CAP, HOST_GRACE_MS } from "./config.js";

/** Team names in the order they are handed out. Colours match the answer tiles. */
export const TEAM_NAMES = ["Red", "Blue", "Gold", "Green", "Purple", "Orange"];

/**
 * Peer instruction pays off when opinion is divided. Suggest a re-vote when the
 * class is split, meaning between a third and four fifths got it right.
 */
function splitVote(summary, answerView) {
  if (!answerView || summary.kind !== "counts" || !summary.counts) return false;
  const total = summary.counts.reduce((a, b) => a + b, 0);
  if (total < 3) return false;
  const right = answerView.indexes ?? [answerView.index];
  const got = right.reduce((t, i) => t + (summary.counts[i] ?? 0), 0);
  const rate = got / total;
  return rate >= 0.3 && rate <= 0.8;
}

export class Room {
  /**
   * @param {import("socket.io").Server} io
   * @param {string} pin
   * @param {string} hostId
   * @param {any} quiz
   * @param {any} roster
   * @param {string | null} owner eppn of the instructor running it, if signed in
   * @param {{ scoring?: boolean, adhoc?: boolean, teams?: number }} [opts]
   *   scoring false is lecture mode: answers are graded and reported, but
   *   nobody earns points and there is no leaderboard. adhoc is a game with no
   *   quiz file, where the host composes each question on the spot. teams
   *   splits players into that many teams, scored on the average of their
   *   members so a bigger team is not a better one.
   */
  constructor(io, pin, hostId, quiz, roster, owner = null, opts = {}) {
    this.io = io;
    this.owner = owner;
    this.scoring = opts.scoring !== false;
    this.adhoc = !!opts.adhoc;
    const n = Math.min(Math.max(Number(opts.teams) || 0, 0), TEAM_NAMES.length);
    this.teams = n >= 2 ? TEAM_NAMES.slice(0, n).map((name) => `Team ${name}`) : null;
    this.banned = new Set(); // names and identities the host has removed
    this.id = randomUUID();
    this.pin = pin;
    this.hostId = hostId;
    this.quiz = quiz;
    this.roster = roster;
    this.players = new Map();
    this.state = "lobby"; // lobby | question | results | end
    this.qIndex = -1;
    this.answers = new Map(); // name -> { response, ms }
    this.pres = null; // per-question randomisation, shared by everyone
    this.questionStart = 0;
    this.timer = null;
    this.hostToken = randomUUID();
    this.hostGrace = null; // set while waiting for a dropped host to come back
    this.paused = false;
    this.solo = false; // a rehearsal with no players, which produces no report
    this.pausedAt = 0;
    this.pausedMs = 0; // total time spent paused during the current question
    this.lastResults = null; // replayed to a host that reconnects mid-results
    this.priorVote = null; // first-round result, while a discussion re-vote is running
    // score and streak for every player as of the start of each question, so a
    // question can be replayed without double-counting what it already awarded
    this.snapshots = new Map();
    store.createGame({
      id: this.id, pin, quizId: quiz.id, title: quiz.title, rosterId: roster?.id, startedAt: Date.now(), owner,
      scoring: this.scoring, kind: this.adhoc ? "quick" : "live",
    });
  }

  /** How a game describes itself to the host page, on creation and on resume. */
  describe() {
    return {
      pin: this.pin,
      hostToken: this.hostToken,
      title: this.quiz.title,
      total: this.quiz.questions.length,
      identifier: this.quiz.identifier,
      scoring: this.scoring,
      adhoc: this.adhoc,
      teams: this.teams,
      roster: this.roster ? { title: this.roster.title, count: this.roster.students.length } : null,
      questions: this.quiz.questions.map((q, i) => ({ index: i, type: q.type, text: q.text })),
    };
  }

  /** The team with the fewest members, so joining keeps them balanced. */
  smallestTeam() {
    const counts = this.teams.map(() => 0);
    for (const p of this.players.values()) if (p.team != null) counts[p.team] += 1;
    return counts.indexOf(Math.min(...counts));
  }

  /**
   * Teams ranked by the average score of their members, rounded. A team with
   * nobody on it is listed last with nothing.
   */
  teamBoard() {
    const rows = this.teams.map((name, i) => {
      const members = [...this.players.values()].filter((p) => p.team === i);
      const score = members.length ? Math.round(members.reduce((t, p) => t + p.score, 0) / members.length) : 0;
      return { name, team: i, score, members: members.map((p) => p.name), connected: true };
    });
    if (!this.scoring) return rows.map((r) => ({ ...r, rank: null }));
    let rank = 0, prev = null;
    return rows.sort((a, b) => b.score - a.score).map((r, i) => {
      if (r.score !== prev) { rank = i + 1; prev = r.score; }
      return { ...r, rank };
    });
  }

  /** What a phone is told about its own team: name, colour slot and current standing. */
  teamFor(p) {
    if (!this.teams || p.team == null) return null;
    const row = this.teamBoard().find((t) => t.team === p.team);
    return { name: this.teams[p.team], index: p.team, score: row?.score ?? 0, rank: row?.rank ?? null };
  }

  /**
   * Add a question the host just composed and ask it straight away. Only for
   * ad-hoc games; a quiz file is the list of questions everywhere else.
   */
  ask(raw) {
    if (!this.adhoc) throw new Error("This game plays a quiz file");
    if (this.state === "question") throw new Error("A question is already open");
    const q = Q.normalizeQuestion(raw, this.quiz.questions.length);
    this.quiz.questions.push(q);
    this.goTo(this.quiz.questions.length - 1);
    this.io.to(this.hostRoom).emit("game:questions", this.describe().questions);
  }

  /**
   * Somebody joining after the start. They begin on zero, and from the next
   * question they are just another player. Returns the player record.
   */
  addPlayer(name, socketId, identity) {
    const p = { name, socketId, score: 0, connected: true, streak: 0, identity, team: null, uploadToken: null };
    if (this.teams) p.team = this.smallestTeam();
    // a file question needs somewhere to send the file; the token says who it is from
    if (this.quiz.questions.some((q) => q.type === "file") || this.adhoc) p.uploadToken = uploads.issueToken(this.id, name);
    this.players.set(name, p);
    store.upsertPlayer(this.id, name, identity, p.team == null ? null : this.teams[p.team]);
    // a question is open: the host's "n answered" counter has a new denominator
    if (this.state === "question") {
      this.io.to(this.hostRoom).emit("game:answered", { answered: this.answers.size, players: this.players.size });
    }
    return p;
  }

  get question() {
    return this.quiz.questions[this.qIndex];
  }

  /** Milliseconds left on the clock, ignoring time spent paused. */
  get remainingMs() {
    const q = this.question;
    if (!q || !q.time) return 0;
    const elapsed = (this.paused ? this.pausedAt : Date.now()) - this.questionStart - this.pausedMs;
    return Math.max(q.time * 1000 - elapsed, 0);
  }

  get endsAt() {
    const q = this.question;
    if (!q || !q.time || this.paused) return null;
    return Date.now() + this.remainingMs;
  }

  /** Restart the question timer for whatever is left on the clock. */
  armTimer() {
    clearTimeout(this.timer);
    const q = this.question;
    if (!q || !q.time || this.paused || this.state !== "question") return;
    this.timer = setTimeout(() => this.endQuestion("time"), this.remainingMs + 250);
  }

  publicPlayers() {
    return [...this.players.values()].map((p) => ({ name: p.name, score: p.score, connected: p.connected, team: p.team ?? null }));
  }

  leaderboard() {
    // Lecture mode has no standings at all: everyone is listed, nobody is ranked.
    if (!this.scoring) return this.publicPlayers().map((p) => ({ ...p, rank: null }));
    // Standard competition ranking: equal scores share a rank and the next one
    // skips, so three players tied on top are all 1st and the next is 4th.
    // Ranking by position instead would have handed out 1st, 2nd and 3rd in
    // the order people happened to join the lobby, since Map preserves
    // insertion order and sort is stable.
    let rank = 0;
    let prev = null;
    return this.publicPlayers()
      .sort((a, b) => b.score - a.score)
      .map((p, i) => {
        if (p.score !== prev) { rank = i + 1; prev = p.score; }
        return { ...p, rank };
      });
  }

  startQuestion(index = this.qIndex + 1) {
    if (index >= this.quiz.questions.length) return this.finish();
    this.goTo(index);
  }

  /**
   * Open question `index`, forwards or backwards. Going back rewinds every score
   * and streak to what they were before that question, and forgets the answers
   * recorded from it onward, so replaying cannot award the same points twice.
   */
  goTo(index) {
    index = Math.max(0, Math.min(index, this.quiz.questions.length - 1));
    const snap = this.snapshots.get(index);
    if (snap) {
      for (const p of this.players.values()) {
        const was = snap.get(p.name);
        // somebody who joined after this question was first asked has earned
        // everything they have since it, so rewinding past it means zero
        p.score = was ? was.score : 0;
        p.streak = was ? was.streak : 0;
        p.prevRank = was ? was.prevRank : undefined;
      }
      store.deleteAnswersFrom(this.id, index);
    }
    // anything at or beyond this point is being replayed, so its snapshot is stale
    for (const i of [...this.snapshots.keys()]) if (i > index) this.snapshots.delete(i);
    this.snapshots.set(index, new Map(
      [...this.players.values()].map((p) => [p.name, { score: p.score, streak: p.streak || 0, prevRank: p.prevRank }])
    ));

    if (!this.revoting) this.priorVote = null;
    this.revoting = false;
    this.qIndex = index;
    const q = this.question;
    this.state = "question";
    this.answers.clear();
    this.lastResults = null;
    this.pres = Q.presentation(q);
    this.questionStart = Date.now();
    this.paused = false;
    this.pausedAt = 0;
    this.pausedMs = 0;
    this.emitQuestion();
    this.armTimer();
  }

  /** Send the current question to everyone, or to one socket on reconnect. */
  emitQuestion(target = null) {
    const q = this.question;
    const head = {
      index: this.qIndex,
      total: this.quiz.questions.length,
      endsAt: this.endsAt,
      totalMs: q.time * 1000,
      remainingMs: this.remainingMs,
      paused: this.paused,
      revote: !!this.priorVote,
    };
    const forHost = { ...head, ...Q.hostView(q, this.pres) };
    const forPlayer = { ...head, ...Q.playerView(q, this.pres, { showText: this.quiz.phoneText }) };
    if (target) return target.emit("game:question", target.data.role === "host" ? forHost : forPlayer);
    this.io.to(this.hostRoom).emit("game:question", forHost);
    this.io.to(this.playerRoom).emit("game:question", forPlayer);
  }

  setPaused(paused) {
    if (this.state !== "question" || this.paused === paused) return;
    const q = this.question;
    if (!q.time) return; // slides have no clock to stop
    this.paused = paused;
    if (paused) {
      this.pausedAt = Date.now();
      clearTimeout(this.timer);
    } else {
      this.pausedMs += Date.now() - this.pausedAt;
      this.pausedAt = 0;
      this.armTimer();
    }
    const payload = { paused, endsAt: this.endsAt, remainingMs: this.remainingMs };
    this.io.to(this.hostRoom).emit("game:paused", payload);
    this.io.to(this.playerRoom).emit("game:paused", payload);
  }

  recordAnswer(name, response) {
    if (this.state !== "question") return { ok: false, error: "No question open" };
    if (this.paused) return { ok: false, error: "The host paused the game" };
    const q = this.question;
    if (!Q.isAnswerable(q.type)) return { ok: false, error: "Nothing to answer here" };
    if (this.answers.has(name)) return { ok: false, error: "Already answered" };
    let value;
    try {
      value = Q.parseResponse(q, response);
      if (q.type === "file" && !uploads.owned(value.file, this.id, name)) throw new Error("Upload a file first");
    } catch (e) {
      return { ok: false, error: e.message };
    }
    // time spent paused does not count against the player
    this.answers.set(name, { response: value, ms: Date.now() - this.questionStart - this.pausedMs });
    this.io.to(this.hostRoom).emit("game:answered", { answered: this.answers.size, players: this.players.size });
    const connected = [...this.players.values()].filter((p) => p.connected).length;
    if (this.answers.size >= connected) this.endQuestion("everyone");
    return { ok: true };
  }

  // "time" the clock ran out, "host" the host moved on, "everyone" all answered
  endQuestion(endedBy = "time") {
    if (this.state !== "question") return;
    clearTimeout(this.timer);
    this.paused = false;
    this.state = "results";
    const q = this.question;
    const timeMs = q.time * 1000;
    const unscored = Q.isUnscored(q.type);
    const rows = [];

    for (const p of this.players.values()) {
      const a = this.answers.get(p.name);
      let gained = 0;
      let bonus = 0;
      let result = { correct: null, ratio: 0 };
      if (a) {
        result = Q.grade(q, a.response, this.pres);
        if (result.ratio > 0 && this.scoring) gained = Math.round(Q.speedPoints(a.ms, timeMs) * result.ratio * q.weight);
      }
      if (!unscored && this.scoring) {
        if (result.correct === true) {
          p.streak = (p.streak || 0) + 1;
          bonus = Math.min((p.streak - 1) * STREAK_BONUS, STREAK_BONUS_CAP);
        } else {
          p.streak = 0;
        }
      }
      p.score += gained + bonus;
      p.last = { gained, bonus, correct: result.correct, ratio: result.ratio, response: a ? a.response : null };
      if (a || !unscored) {
        rows.push({ player: p.name, response: a ? a.response : null, ms: a ? a.ms : null, correct: result.correct, points: gained + bonus });
      }
    }
    // an anonymous question is recorded without names: the rows are shuffled
    // and relabelled so neither order nor label gives anyone away
    if (q.anonymous) {
      Q.shuffled(rows.filter((r) => r.response != null)).forEach((r, i) => { r.player = `anonymous ${i + 1}`; });
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].response == null) rows.splice(i, 1);
    }

    const answerView = Q.answerView(q);
    store.recordQuestion(this.id, this.qIndex, {
      type: q.type,
      text: q.text,
      answerLabel: answerView?.label ?? null,
      choices: Q.choiceLabels(q),
      explanation: q.explanation,
      sourceIndex: q.sourceIndex,
      correctAnswer: q.type === "multi" ? q.answers : q.answer,
      weight: q.weight,
    });
    store.recordAnswers(this.id, this.qIndex, rows);

    const responses = [...this.answers.values()].map((a) => a.response);
    const board = this.leaderboard();
    for (const b of board) this.players.get(b.name).prevRank = this.players.get(b.name).prevRank ?? b.rank;

    const summary = Q.summarize(q, this.pres, responses);
    this.lastResults = {
      index: this.qIndex,
      text: q.text,
      type: q.type,
      image: q.image,
      answer: answerView,
      explanation: q.explanation,
      // a re-vote is worth offering whenever opinion was split, and the quiz can ask for it
      suggestDiscussion: q.discuss || splitVote(summary, answerView),
      summary,
      priorSummary: this.priorVote,
      answered: responses.length,
      players: this.players.size,
      leaderboard: this.scoring ? (this.teams ? this.teamBoard() : board.slice(0, 5)) : [],
      scoring: this.scoring,
      adhoc: this.adhoc,
      teams: !!this.teams,
      // an ad-hoc game has no last question: the host asks another or finishes
      isLast: !this.adhoc && this.qIndex === this.quiz.questions.length - 1,
    };
    this.priorVote = null;
    this.io.to(this.hostRoom).emit("game:results", this.lastResults);

    for (const p of this.players.values()) {
      if (!p.socketId) continue;
      const idx = board.findIndex((b) => b.name === p.name);
      // the nearest player actually ahead, not merely listed above: anyone on
      // the same score is level, and "0 points behind" is not a gap to close
      let a = idx - 1;
      while (a >= 0 && board[a].score === p.score) a--;
      const ahead = a >= 0 ? board[a] : null;
      const level = board.filter((b) => b.score === p.score && b.name !== p.name);
      this.io.to(p.socketId).emit("game:results", {
        type: q.type,
        unscored,
        scoring: this.scoring,
        team: this.teamFor(p),
        correct: p.last.correct,
        ratio: p.last.ratio,
        gained: p.last.gained,
        bonus: p.last.bonus,
        streak: p.streak || 0,
        score: p.score,
        rank: board[idx].rank,
        prevRank: p.prevRank ?? board[idx].rank,
        ahead: ahead ? { name: ahead.name, gap: ahead.score - p.score } : null,
        answer: answerView,
        // read the player's own answer back to them: without it the phone shows
        // the right answer with no reminder of what they actually picked, and
        // quizzes with phoneText off never showed them the question either
        yourAnswer: Q.responseLabel(q, p.last.response, this.pres),
        explanation: q.explanation,
        answered: p.last.response != null,
        // being level with someone is worth knowing, and the gap above cannot
        // say so any more now that it skips players on the same score
        levelWith: level.map((b) => b.name),
        endedBy,
      });
      p.prevRank = board[idx].rank;
    }
  }

  /** Play the same quiz again with whoever is still here, scores back to zero. */
  restart() {
    clearTimeout(this.timer);
    this.state = "lobby";
    this.qIndex = -1;
    this.answers.clear();
    this.snapshots.clear();
    this.lastResults = null;
    this.lastEnd = null;
    this.priorVote = null;
    this.paused = false;
    for (const p of this.players.values()) {
      p.score = 0;
      p.streak = 0;
      p.prevRank = undefined;
      p.last = undefined;
    }
    // a fresh game record, so the two runs are reported separately
    this.id = randomUUID();
    store.createGame({
      id: this.id, pin: this.pin, quizId: this.quiz.id, title: this.quiz.title,
      rosterId: this.roster?.id, startedAt: Date.now(), owner: this.owner,
    });
    for (const p of this.players.values()) store.upsertPlayer(this.id, p.name, p.identity);
    this.io.to(this.hostRoom).emit("game:restarted", { players: this.publicPlayers() });
    this.io.to(this.playerRoom).emit("game:restarted", {});
    this.io.to(this.hostRoom).emit("lobby:players", this.publicPlayers());
  }

  finish() {
    this.state = "end";
    this.paused = false;
    clearTimeout(this.timer);
    const board = this.leaderboard();
    if (this.solo) {
      // a rehearsal with no players is not worth a report
      store.discardIfUnfinished(this.id);
      this.lastEnd = { leaderboard: board, players: board, reportId: null, solo: true, scoring: this.scoring };
      this.io.to(this.hostRoom).emit("game:end", this.lastEnd);
      return;
    }
    store.finishGame(this.id, Date.now(), this.quiz.questions.length, board);
    // in a team game the standings are the teams'; the individual board still goes along for the report
    this.lastEnd = { leaderboard: this.teams ? this.teamBoard() : board, players: board, teams: !!this.teams, reportId: this.id, scoring: this.scoring };
    this.io.to(this.hostRoom).emit("game:end", this.lastEnd);
    for (const p of this.players.values()) {
      if (!p.socketId) continue;
      const rank = board.find((b) => b.name === p.name)?.rank ?? null;
      this.io.to(p.socketId).emit("game:end", { score: p.score, rank, players: board.length, scoring: this.scoring, team: this.teamFor(p) });
    }
  }

  /**
   * The host's browser dropped. Pause and hold the room open for a grace period
   * so a sleeping laptop or a wifi blip does not destroy the game and its report.
   */
  hostDropped() {
    clearTimeout(this.hostGrace);
    this.setPaused(true);
    this.io.to(this.playerRoom).emit("game:hostaway", { away: true });
    this.hostGrace = setTimeout(() => this.destroy(), HOST_GRACE_MS);
  }

  /** Re-attach a returning host and put its screen back where the game is. */
  hostReturned(socket) {
    clearTimeout(this.hostGrace);
    this.hostGrace = null;
    this.hostId = socket.id;
    socket.join(this.hostRoom);
    this.io.to(this.playerRoom).emit("game:hostaway", { away: false });
    this.io.to(this.hostRoom).emit("lobby:players", this.publicPlayers());
    if (this.state === "question") this.emitQuestion(socket);
    else if (this.state === "results" && this.lastResults) socket.emit("game:results", this.lastResults);
    else if (this.state === "end" && this.lastEnd) socket.emit("game:end", this.lastEnd);
  }

  destroy() {
    clearTimeout(this.timer);
    clearTimeout(this.hostGrace);
    // a game the host abandoned mid-way is not worth keeping a report for
    if (this.state !== "end") store.discardIfUnfinished(this.id);
    this.io.to(this.playerRoom).emit("game:closed");
    rooms.delete(this.pin);
  }

  get hostRoom() {
    return `host:${this.pin}`;
  }
  get playerRoom() {
    return `play:${this.pin}`;
  }
}
