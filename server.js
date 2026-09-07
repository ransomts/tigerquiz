import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import QRCode from "qrcode";
import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Q from "./lib/questions.js";
import * as store from "./lib/db.js";
import * as nick from "./lib/nicknames.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const QUIZ_DIR = path.join(__dirname, "quizzes");
const IMAGE_DIR = path.join(QUIZ_DIR, "images");
const ROSTER_DIR = path.join(QUIZ_DIR, "rosters");
const DATA_DIR = process.env.TIGERQUIZ_DATA || path.join(__dirname, "data");
const STREAK_BONUS = 100; // per consecutive correct answer beyond the first
const STREAK_BONUS_CAP = 500;
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS) || 3 * 60 * 1000;

store.open(DATA_DIR);
// optional extra blocked nicknames, one per line
await nick.loadExtraWords(path.join(QUIZ_DIR, "blocked-words.txt"));

const app = express();
const http = createServer(app);
const io = new Server(http);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/quiz-images", express.static(IMAGE_DIR));

// ---------- quiz files ----------
async function listQuizzes() {
  let files = [];
  try {
    files = (await readdir(QUIZ_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const id = f.replace(/\.json$/, "");
    try {
      const q = await loadQuiz(id);
      out.push({ id, title: q.title, count: q.questions.length });
    } catch (e) {
      out.push({ id, title: `${id} (invalid)`, count: 0, error: e.message });
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

async function loadQuiz(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error("bad quiz id");
  const q = JSON.parse(await readFile(path.join(QUIZ_DIR, `${id}.json`), "utf8"));
  if (!Array.isArray(q.questions) || q.questions.length === 0) throw new Error("quiz has no questions");
  q.title = String(q.title || id);
  q.questions = q.questions.map(Q.normalizeQuestion);
  // identifier: ask each player for a real name or student id alongside their nickname
  q.identifier = typeof q.identifier === "string" && q.identifier.trim() ? q.identifier.trim().slice(0, 40) : null;
  // mirror the question and choices onto phones unless the quiz opts out
  q.phoneText = q.phoneText !== false;
  return q;
}

/** A copy of the quiz with order randomised per the quiz's own flags. */
function prepareQuiz(quiz) {
  // sourceIndex is set during normalisation and survives shuffling, so a review
  // quiz built from a report can find the original question in the file
  let questions = quiz.questions;
  if (quiz.shuffleQuestions) questions = Q.shuffled(questions);
  if (quiz.shuffleAnswers) {
    questions = questions.map((q) => {
      // true/false keeps True first; the other types have no fixed order to protect
      if (q.type !== "choice" && q.type !== "multi" && q.type !== "poll") return q;
      const order = Q.shuffled(q.choices.map((_, i) => i));
      const moved = { ...q, choices: order.map((i) => q.choices[i]) };
      if (q.type === "choice") moved.answer = order.indexOf(q.answer);
      if (q.type === "multi") moved.answers = q.answers.map((a) => order.indexOf(a)).sort((x, y) => x - y);
      return moved;
    });
  }
  return { ...quiz, questions };
}

// ---------- rosters ----------
async function listRosters() {
  let files = [];
  try {
    files = (await readdir(ROSTER_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const id = f.replace(/\.json$/, "");
    try {
      const r = await loadRoster(id);
      out.push({ id, title: r.title, count: r.students.length });
    } catch {
      /* skip unreadable rosters */
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

async function loadRoster(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error("bad roster id");
  const raw = JSON.parse(await readFile(path.join(ROSTER_DIR, `${id}.json`), "utf8"));
  const list = Array.isArray(raw) ? raw : raw.students;
  if (!Array.isArray(list) || !list.length) throw new Error("roster has no students");
  const students = list.map((s) => (typeof s === "string" ? { name: s, id: null } : { name: String(s.name), id: s.id == null ? null : String(s.id) }));
  return { id, title: String(raw.title || id), students };
}

/** Match what a player typed against the roster. Returns the canonical entry or null. */
function matchRoster(roster, typed) {
  const norm = Q.normText(typed);
  if (!norm) return null;
  return (
    roster.students.find((s) => s.id && Q.normText(s.id) === norm) ||
    roster.students.find((s) => Q.normText(s.name) === norm) ||
    null
  );
}

// ---------- api ----------
app.get("/api/quizzes", async (_req, res) => {
  try {
    res.json(await listQuizzes());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/rosters", async (_req, res) => {
  try {
    res.json(await listRosters());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/qr.svg", async (req, res) => {
  const text = String(req.query.text || "").slice(0, 300);
  if (!text) return res.status(400).end();
  try {
    const svg = await QRCode.toString(text, { type: "svg", margin: 1, color: { dark: "#111111", light: "#ffffff" } });
    res.type("image/svg+xml").send(svg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/reports", (_req, res) => res.json(store.listGames()));

app.get("/api/students", (_req, res) => res.json(store.listStudents()));

// the join screen offers players a name rather than letting them invent one
app.get("/api/nickname", (_req, res) => res.json({ name: nick.suggest() }));

/**
 * Creating a game is the one privileged thing that happens over the websocket,
 * and socket.io is a single endpoint shared with players, so a proxy cannot
 * protect it by path the way it protects the rest of /api. Instead the host
 * page fetches a short-lived key over HTTP first, which a proxy *can* put
 * behind a password, and hands it back when it creates the game.
 *
 * With no proxy in front this changes nothing, exactly as before.
 */
const HOST_KEY_TTL_MS = Number(process.env.HOST_KEY_TTL_MS) || 12 * 60 * 60 * 1000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;
const hostKeys = new Map(); // key -> expiry

function issueHostKey() {
  const now = Date.now();
  for (const [k, exp] of hostKeys) if (exp <= now) hostKeys.delete(k);
  const key = randomUUID();
  hostKeys.set(key, now + HOST_KEY_TTL_MS);
  return key;
}

function hostKeyValid(key) {
  const exp = hostKeys.get(key);
  if (exp == null) return false;
  if (exp <= Date.now()) { hostKeys.delete(key); return false; }
  return true;
}

app.get("/api/host-key", (_req, res) => res.json({ key: issueHostKey() }));

app.get("/api/reports/:id", async (req, res) => {
  const report = store.getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "No such game" });
  res.json(await withRoster(report));
});

app.get("/api/reports/:id/csv", (req, res) => {
  const report = store.getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "No such game" });
  res.type("text/csv").set("Content-Disposition", `attachment; filename="${csvName(report.game)}"`).send(toCsv(report));
});

/**
 * Build a new quiz from the questions a class got wrong, for spaced review in a
 * later lesson. Questions are looked up in the original quiz file by the source
 * index recorded at play time, so shuffling does not confuse the mapping.
 */
app.post("/api/reports/:id/review-quiz", async (req, res) => {
  const report = store.getReport(req.params.id);
  if (!report) return res.status(404).json({ error: "No such game" });
  const threshold = clamp(Number(req.body?.threshold ?? 0.6), 0.05, 1);
  try {
    const source = await loadQuiz(report.game.quiz_id);
    const missed = report.questions
      .filter((q) => q.correctRate !== null && q.correctRate < threshold && q.sourceIdx != null)
      .sort((a, b) => a.correctRate - b.correctRate);
    if (!missed.length) return res.status(400).json({ error: "Nothing was missed often enough to review" });

    const picked = [];
    const seen = new Set();
    for (const q of missed) {
      if (seen.has(q.sourceIdx)) continue;
      seen.add(q.sourceIdx);
      const original = source.questions[q.sourceIdx];
      if (original) picked.push(stripInternals(original));
    }
    if (!picked.length) return res.status(400).json({ error: "The original quiz no longer has those questions" });

    const id = await uniqueQuizId(`review-${report.game.quiz_id}`);
    const quiz = {
      title: `Review: ${source.title}`,
      note: `Questions the class missed on ${new Date(report.game.started_at).toISOString().slice(0, 10)}`,
      shuffleQuestions: true,
      shuffleAnswers: !!source.shuffleAnswers,
      questions: picked,
    };
    await writeFile(path.join(QUIZ_DIR, `${id}.json`), JSON.stringify(quiz, null, 2) + "\n", "utf8");
    res.json({ ok: true, id, title: quiz.title, count: picked.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const clamp = (n, lo, hi) => (Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : hi);

/** Drop the fields normalisation added, so the written file reads like a hand-made one. */
function stripInternals(q) {
  const out = { ...q };
  for (const k of ["sourceIndex", "phoneText"]) delete out[k];
  if (out.explanation == null) delete out.explanation;
  if (out.discuss === false) delete out.discuss;
  if (out.type === "choice") delete out.type;
  // images were rewritten to a URL path; put the bare filename back
  if (typeof out.image === "string" && out.image.startsWith("/quiz-images/"))
    out.image = decodeURIComponent(out.image.replace("/quiz-images/", ""));
  return out;
}

async function uniqueQuizId(base) {
  const safe = base.replace(/[^\w-]+/g, "-").slice(0, 40);
  let id = safe;
  let n = 2;
  while (await readFile(path.join(QUIZ_DIR, `${id}.json`), "utf8").then(() => true, () => false)) {
    id = `${safe}-${n++}`;
  }
  return id;
}

app.delete("/api/reports/:id", (req, res) => {
  store.deleteGame(req.params.id);
  res.json({ ok: true });
});

/** Add absentees to a report when the game was played against a roster. */
async function withRoster(report) {
  if (!report.game.roster_id) return report;
  try {
    const roster = await loadRoster(report.game.roster_id);
    // players are stored under their canonical roster name, but match on id too
    // in case the roster file was edited between the game and the report
    const played = new Set(report.players.map((p) => Q.normText(p.identifier || p.name)));
    const didPlay = (s) => played.has(Q.normText(s.name)) || (s.id && played.has(Q.normText(s.id)));
    report.roster = {
      title: roster.title,
      total: roster.students.length,
      absent: roster.students.filter((s) => !didPlay(s)).map((s) => s.name),
    };
  } catch {
    /* roster file has gone away; report is still valid without it */
  }
  return report;
}

const csvName = (g) => `${g.title.replace(/[^\w-]+/g, "_")}_${new Date(g.started_at).toISOString().slice(0, 10)}.csv`;

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(report) {
  const head = ["player", "identifier", "rank", "total_score", "question", "type", "question_text", "correct_answer", "response", "correct", "points", "seconds"];
  const lines = [head.join(",")];
  const qByIdx = new Map(report.questions.map((q) => [q.idx, q]));
  for (const p of report.players) {
    for (const a of p.answers) {
      const q = qByIdx.get(a.idx) || {};
      lines.push([
        p.name, p.identifier, p.rank, p.score,
        a.idx + 1, q.type, q.text, q.answer,
        formatResponse(a.response), a.correct == null ? "" : a.correct ? "yes" : "no",
        a.points, a.ms == null ? "" : (a.ms / 1000).toFixed(1),
      ].map(csvCell).join(","));
    }
  }
  return lines.join("\n") + "\n";
}

const formatResponse = (r) => (Array.isArray(r) ? r.join(" | ") : r == null ? "" : String(r));

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

// ---------- quiz editing ----------
const safeId = (id) => /^[\w-]{1,60}$/.test(id);
const quizPath = (id) => path.join(QUIZ_DIR, `${id}.json`);
const rosterPath = (id) => path.join(ROSTER_DIR, `${id}.json`);

/** Read a quiz exactly as written, without normalising, so editing round-trips. */
async function readRaw(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/** Validate a quiz body the way a game would, and report every problem at once. */
function validateQuiz(body) {
  const problems = [];
  if (!body || typeof body !== "object") return { problems: ["Not an object"] };
  if (!String(body.title || "").trim()) problems.push("Give the quiz a title");
  if (!Array.isArray(body.questions) || !body.questions.length) {
    problems.push("Add at least one question");
    return { problems };
  }
  const questions = [];
  body.questions.forEach((q, i) => {
    try {
      questions.push(Q.normalizeQuestion(q, i));
    } catch (e) {
      problems.push(e.message);
    }
  });
  return { problems, questions };
}

app.get("/api/quiz/:id", async (req, res) => {
  if (!safeId(req.params.id)) return res.status(400).json({ error: "bad quiz id" });
  try {
    res.json(await readRaw(quizPath(req.params.id)));
  } catch (e) {
    res.status(e.code === "ENOENT" ? 404 : 500).json({ error: e.code === "ENOENT" ? "No such quiz" : e.message });
  }
});

app.put("/api/quiz/:id", async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Use letters, digits, dash or underscore for the file name" });
  const { problems } = validateQuiz(req.body);
  if (problems.length) return res.status(400).json({ error: "Fix these first", problems });
  try {
    // only known fields are written, so a stray key cannot end up in the file
    const clean = pickQuizFields(req.body);
    await writeFile(quizPath(id), JSON.stringify(clean, null, 2) + "\n", "utf8");
    res.json({ ok: true, id, count: clean.questions.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/quiz/:id", async (req, res) => {
  if (!safeId(req.params.id)) return res.status(400).json({ error: "bad quiz id" });
  try {
    await unlink(quizPath(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(e.code === "ENOENT" ? 404 : 500).json({ error: e.message });
  }
});

/** Check a draft without saving it, so the editor can show problems as you type. */
app.post("/api/quiz-check", (req, res) => {
  const { problems, questions } = validateQuiz(req.body);
  res.json({ ok: problems.length === 0, problems, count: questions ? questions.length : 0 });
});

const QUIZ_FIELDS = ["title", "note", "identifier", "shuffleQuestions", "shuffleAnswers", "phoneText"];
const QUESTION_FIELDS = [
  "type", "text", "image", "time", "explanation", "discuss",
  "choices", "answer", "answers", "accept", "fuzzy",
  "min", "max", "step", "tolerance", "unit", "items", "maxWords",
];

function pickQuizFields(body) {
  const out = {};
  for (const k of QUIZ_FIELDS) if (body[k] !== undefined && body[k] !== null && body[k] !== "") out[k] = body[k];
  out.questions = body.questions.map((q) => {
    const cleaned = {};
    for (const k of QUESTION_FIELDS) {
      const v = q[k];
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v) && !v.length) continue;
      cleaned[k] = v;
    }
    return cleaned;
  });
  return out;
}

// ---------- roster editing ----------
app.get("/api/roster/:id", async (req, res) => {
  if (!safeId(req.params.id)) return res.status(400).json({ error: "bad roster id" });
  try {
    res.json(await readRaw(rosterPath(req.params.id)));
  } catch (e) {
    res.status(e.code === "ENOENT" ? 404 : 500).json({ error: e.code === "ENOENT" ? "No such class list" : e.message });
  }
});

app.put("/api/roster/:id", async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Use letters, digits, dash or underscore for the file name" });
  const body = req.body || {};
  const students = (Array.isArray(body.students) ? body.students : [])
    .map((s) => (typeof s === "string" ? { name: s } : s))
    .filter((s) => s && String(s.name || "").trim())
    .map((s) => (s.id ? { name: String(s.name).trim(), id: String(s.id).trim() } : { name: String(s.name).trim() }));
  if (!students.length) return res.status(400).json({ error: "Add at least one student" });
  try {
    await mkdirIfNeeded(ROSTER_DIR);
    await writeFile(rosterPath(id), JSON.stringify({ title: String(body.title || id), students }, null, 2) + "\n", "utf8");
    res.json({ ok: true, id, count: students.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/roster/:id", async (req, res) => {
  if (!safeId(req.params.id)) return res.status(400).json({ error: "bad roster id" });
  try {
    await unlink(rosterPath(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(e.code === "ENOENT" ? 404 : 500).json({ error: e.message });
  }
});

async function mkdirIfNeeded(dir) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
}

// ---------- game state ----------
/** @type {Map<string, Room>} */
const rooms = new Map();

function makePin() {
  let pin;
  do pin = String(Math.floor(100000 + Math.random() * 900000));
  while (rooms.has(pin));
  return pin;
}

class Room {
  constructor(pin, hostId, quiz, roster) {
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
    store.createGame({ id: this.id, pin, quizId: quiz.id, title: quiz.title, rosterId: roster?.id, startedAt: Date.now() });
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
    this.timer = setTimeout(() => this.endQuestion(), this.remainingMs + 250);
  }

  publicPlayers() {
    return [...this.players.values()].map((p) => ({ name: p.name, score: p.score, connected: p.connected }));
  }

  leaderboard() {
    return this.publicPlayers()
      .sort((a, b) => b.score - a.score)
      .map((p, i) => ({ ...p, rank: i + 1 }));
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
      for (const [name, was] of snap) {
        const p = this.players.get(name);
        if (!p) continue;
        p.score = was.score;
        p.streak = was.streak;
        p.prevRank = was.prevRank;
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
    io.to(this.hostRoom).emit("game:question", forHost);
    io.to(this.playerRoom).emit("game:question", forPlayer);
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
    io.to(this.hostRoom).emit("game:paused", payload);
    io.to(this.playerRoom).emit("game:paused", payload);
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
    } catch (e) {
      return { ok: false, error: e.message };
    }
    // time spent paused does not count against the player
    this.answers.set(name, { response: value, ms: Date.now() - this.questionStart - this.pausedMs });
    io.to(this.hostRoom).emit("game:answered", { answered: this.answers.size, players: this.players.size });
    const connected = [...this.players.values()].filter((p) => p.connected).length;
    if (this.answers.size >= connected) this.endQuestion();
    return { ok: true };
  }

  endQuestion() {
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
        if (result.ratio > 0) gained = Math.round(Q.speedPoints(a.ms, timeMs) * result.ratio);
      }
      if (!unscored) {
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

    const answerView = Q.answerView(q, this.pres);
    store.recordQuestion(this.id, this.qIndex, {
      type: q.type,
      text: q.text,
      answerLabel: answerView?.label ?? null,
      choices: Q.choiceLabels(q),
      explanation: q.explanation,
      sourceIndex: q.sourceIndex,
      correctAnswer: q.type === "multi" ? q.answers : q.answer,
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
      leaderboard: board.slice(0, 5),
      isLast: this.qIndex === this.quiz.questions.length - 1,
    };
    this.priorVote = null;
    io.to(this.hostRoom).emit("game:results", this.lastResults);

    for (const p of this.players.values()) {
      if (!p.socketId) continue;
      const idx = board.findIndex((b) => b.name === p.name);
      const ahead = idx > 0 ? board[idx - 1] : null;
      io.to(p.socketId).emit("game:results", {
        type: q.type,
        unscored,
        correct: p.last.correct,
        ratio: p.last.ratio,
        gained: p.last.gained,
        bonus: p.last.bonus,
        streak: p.streak || 0,
        score: p.score,
        rank: idx + 1,
        prevRank: p.prevRank ?? idx + 1,
        ahead: ahead ? { name: ahead.name, gap: ahead.score - p.score } : null,
        answer: answerView,
        explanation: q.explanation,
        answered: p.last.response != null,
      });
      p.prevRank = idx + 1;
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
      rosterId: this.roster?.id, startedAt: Date.now(),
    });
    for (const p of this.players.values()) store.upsertPlayer(this.id, p.name, p.identity);
    io.to(this.hostRoom).emit("game:restarted", { players: this.publicPlayers() });
    io.to(this.playerRoom).emit("game:restarted", {});
    io.to(this.hostRoom).emit("lobby:players", this.publicPlayers());
  }

  finish() {
    this.state = "end";
    this.paused = false;
    clearTimeout(this.timer);
    const board = this.leaderboard();
    if (this.solo) {
      // a rehearsal with no players is not worth a report
      store.discardIfUnfinished(this.id);
      this.lastEnd = { leaderboard: board, reportId: null, solo: true };
      io.to(this.hostRoom).emit("game:end", this.lastEnd);
      return;
    }
    store.finishGame(this.id, Date.now(), this.quiz.questions.length, board);
    this.lastEnd = { leaderboard: board, reportId: this.id };
    io.to(this.hostRoom).emit("game:end", this.lastEnd);
    for (const p of this.players.values()) {
      if (!p.socketId) continue;
      const rank = board.find((b) => b.name === p.name)?.rank ?? 0;
      io.to(p.socketId).emit("game:end", { score: p.score, rank, players: board.length });
    }
  }

  /**
   * The host's browser dropped. Pause and hold the room open for a grace period
   * so a sleeping laptop or a wifi blip does not destroy the game and its report.
   */
  hostDropped() {
    clearTimeout(this.hostGrace);
    this.setPaused(true);
    io.to(this.playerRoom).emit("game:hostaway", { away: true });
    this.hostGrace = setTimeout(() => this.destroy(), HOST_GRACE_MS);
  }

  /** Re-attach a returning host and put its screen back where the game is. */
  hostReturned(socket) {
    clearTimeout(this.hostGrace);
    this.hostGrace = null;
    this.hostId = socket.id;
    socket.join(this.hostRoom);
    io.to(this.playerRoom).emit("game:hostaway", { away: false });
    io.to(this.hostRoom).emit("lobby:players", this.publicPlayers());
    if (this.state === "question") this.emitQuestion(socket);
    else if (this.state === "results" && this.lastResults) socket.emit("game:results", this.lastResults);
    else if (this.state === "end" && this.lastEnd) socket.emit("game:end", this.lastEnd);
  }

  destroy() {
    clearTimeout(this.timer);
    clearTimeout(this.hostGrace);
    // a game the host abandoned mid-way is not worth keeping a report for
    if (this.state !== "end") store.discardIfUnfinished(this.id);
    io.to(this.playerRoom).emit("game:closed");
    rooms.delete(this.pin);
  }

  get hostRoom() {
    return `host:${this.pin}`;
  }
  get playerRoom() {
    return `play:${this.pin}`;
  }
}

// ---------- sockets ----------
io.on("connection", (socket) => {
  socket.data.role = null;

  socket.on("host:create", async ({ quizId, rosterId, key } = {}, cb = () => {}) => {
    try {
      if (!hostKeyValid(key)) throw new Error("Reload the host page before creating a game");
      // an unbounded number of rooms is an unbounded amount of memory
      if (rooms.size >= MAX_ROOMS) throw new Error("Too many games are open on this server");
      const quiz = prepareQuiz({ ...(await loadQuiz(quizId)), id: quizId });
      const roster = rosterId ? await loadRoster(rosterId) : null;
      const pin = makePin();
      const room = new Room(pin, socket.id, quiz, roster);
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
    room.endQuestion();
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
    const room = rooms.get(String(pin || "").trim());
    name = String(name || "").trim().slice(0, 20);
    identifier = String(identifier || "").trim().slice(0, 40);
    if (!room) return cb({ ok: false, error: "Game not found" });
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
    const room = rooms.get(String(pin || "").trim());
    if (!room) return cb({ ok: false, error: "Game not found" });
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

function hostRoomFor(socket) {
  if (socket.data.role !== "host") return null;
  return rooms.get(socket.data.pin) || null;
}

http.listen(PORT, () => {
  console.log(`tigerquiz listening on http://localhost:${PORT}`);
  console.log(`  host:    http://localhost:${PORT}/host.html`);
  console.log(`  play:    http://localhost:${PORT}/`);
  console.log(`  reports: http://localhost:${PORT}/reports.html`);
});
