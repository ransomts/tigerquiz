// Persistent game records, so reports survive a restart.
// One SQLite file, no external dependency. Everything here is synchronous,
// which is fine at classroom scale and keeps the call sites simple.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { mkdirSync } from "node:fs";

let db = null;

export function open(dir) {
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, "tigerquiz.db"));
  db.exec("PRAGMA journal_mode = WAL");
  // WAL leaves synchronous at FULL, which fsyncs on every commit. On a spinning
  // disk that was ~42ms per write, so each player joining stalled the whole
  // server. NORMAL still survives an application crash; only an OS crash or
  // power loss can cost the last transactions, which for saved reports is fine.
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      pin TEXT NOT NULL,
      quiz_id TEXT NOT NULL,
      title TEXT NOT NULL,
      roster_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      question_count INTEGER NOT NULL DEFAULT 0,
      player_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS questions (
      game_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      answer TEXT,
      PRIMARY KEY (game_id, idx)
    );
    CREATE TABLE IF NOT EXISTS players (
      game_id TEXT NOT NULL,
      name TEXT NOT NULL,
      identifier TEXT,
      score INTEGER NOT NULL DEFAULT 0,
      rank INTEGER,
      PRIMARY KEY (game_id, name)
    );
    CREATE TABLE IF NOT EXISTS answers (
      game_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      player TEXT NOT NULL,
      response TEXT,
      ms INTEGER,
      correct INTEGER,
      points INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (game_id, idx, player)
    );
    CREATE INDEX IF NOT EXISTS answers_by_game ON answers(game_id);
  `);
  migrate();
  sweepUnfinished();
  return db;
}

/**
 * Add columns that later versions introduced. CREATE TABLE IF NOT EXISTS leaves
 * an existing table alone, so a database made by an older build needs this.
 */
function migrate() {
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const add = (table, name, decl) => {
    if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  };
  add("questions", "choices", "TEXT");        // JSON array, for naming wrong answers
  add("questions", "explanation", "TEXT");
  add("questions", "source_idx", "INTEGER");  // position in the quiz file, before shuffling
  add("questions", "correct_answer", "TEXT"); // JSON, the machine-readable answer
}

const run = (sql, ...args) => db.prepare(sql).run(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);

export function createGame(g) {
  run(
    `INSERT INTO games (id, pin, quiz_id, title, roster_id, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
    g.id, g.pin, g.quizId, g.title, g.rosterId ?? null, g.startedAt
  );
}

export function recordQuestion(gameId, idx, q) {
  run(
    `INSERT OR REPLACE INTO questions
       (game_id, idx, type, text, answer, choices, explanation, source_idx, correct_answer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    gameId, idx, q.type, q.text, q.answerLabel ?? null,
    q.choices ? JSON.stringify(q.choices) : null,
    q.explanation ?? null,
    q.sourceIndex ?? null,
    q.correctAnswer === undefined ? null : JSON.stringify(q.correctAnswer)
  );
}

export function recordAnswers(gameId, idx, rows) {
  if (!rows.length) return;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO answers (game_id, idx, player, response, ms, correct, points) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // one transaction, not one per row: each implicit commit fsyncs the WAL, so a
  // class of 30 turned a question boundary into a second of blocked event loop
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      stmt.run(gameId, idx, r.player, r.response == null ? null : JSON.stringify(r.response),
        r.ms ?? null, r.correct == null ? null : r.correct ? 1 : 0, r.points ?? 0);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function upsertPlayer(gameId, name, identifier) {
  run(
    `INSERT INTO players (game_id, name, identifier) VALUES (?, ?, ?)
     ON CONFLICT(game_id, name) DO UPDATE SET identifier = excluded.identifier`,
    gameId, name, identifier ?? null
  );
}

export function finishGame(gameId, endedAt, questionCount, board) {
  const stmt = db.prepare(`UPDATE players SET score = ?, rank = ? WHERE game_id = ? AND name = ?`);
  for (const p of board) stmt.run(p.score, p.rank, gameId, p.name);
  run(
    `UPDATE games SET ended_at = ?, question_count = ?, player_count = ? WHERE id = ?`,
    endedAt, questionCount, board.length, gameId
  );
}

// ---------- reports ----------
export function listGames(limit = 100) {
  return all(
    `SELECT id, pin, quiz_id, title, roster_id, started_at, ended_at, question_count, player_count
     FROM games WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ?`, limit
  );
}

export function getReport(gameId) {
  const game = one(`SELECT * FROM games WHERE id = ?`, gameId);
  if (!game) return null;
  const questions = all(`SELECT * FROM questions WHERE game_id = ? ORDER BY idx`, gameId);
  const players = all(
    `SELECT * FROM players WHERE game_id = ? ORDER BY rank IS NULL, rank, score DESC`, gameId
  );
  const answers = all(`SELECT * FROM answers WHERE game_id = ?`, gameId);

  const byQuestion = new Map(questions.map((q) => [q.idx, []]));
  for (const a of answers) byQuestion.get(a.idx)?.push(a);

  const questionStats = questions.map((q) => {
    const rows = byQuestion.get(q.idx) ?? [];
    const scored = rows.filter((r) => r.correct !== null);
    const right = scored.filter((r) => r.correct === 1).length;
    const choices = q.choices ? JSON.parse(q.choices) : null;
    const correctAnswer = q.correct_answer == null ? null : JSON.parse(q.correct_answer);
    const distractors = breakdown(q.type, choices, correctAnswer, rows);
    return {
      idx: q.idx,
      sourceIdx: q.source_idx,
      type: q.type,
      text: q.text,
      answer: q.answer,
      explanation: q.explanation,
      choices,
      responses: rows.length,
      scored: scored.length,
      correct: right,
      // null for polls and word clouds, which have no right answer
      correctRate: scored.length ? right / scored.length : null,
      avgMs: rows.length ? Math.round(rows.reduce((t, r) => t + (r.ms ?? 0), 0) / rows.length) : null,
      distractors,
      // the wrong answer the class landed on, which names the misconception.
      // one lone pick is not a pattern, so it takes at least two to be called out
      topDistractor: distractors.find((d) => d.correct === false && d.n >= 2) ?? null,
    };
  });

  const byPlayer = new Map(players.map((p) => [p.name, []]));
  for (const a of answers) byPlayer.get(a.player)?.push(a);
  const playerStats = players.map((p) => {
    const rows = (byPlayer.get(p.name) ?? []).sort((a, b) => a.idx - b.idx);
    const scored = rows.filter((r) => r.correct !== null);
    return {
      name: p.name,
      identifier: p.identifier,
      score: p.score,
      rank: p.rank,
      answered: rows.length,
      correct: scored.filter((r) => r.correct === 1).length,
      scored: scored.length,
      answers: rows.map((r) => ({
        idx: r.idx,
        response: r.response == null ? null : JSON.parse(r.response),
        correct: r.correct === null ? null : r.correct === 1,
        points: r.points,
        ms: r.ms,
      })),
    };
  });

  // questions most students got wrong, worst first
  const needsReview = questionStats
    .filter((q) => q.correctRate !== null && q.scored > 0 && q.correctRate < 0.5)
    .sort((a, b) => a.correctRate - b.correctRate);

  return { game, questions: questionStats, players: playerStats, needsReview };
}

/** Drop recorded answers from this question onward, for replaying part of a game. */
/**
 * Count what people actually chose, so a report can name the wrong answer the
 * class landed on rather than only how many missed it. Sorted most-picked first.
 */
function breakdown(type, choices, correctAnswer, rows) {
  const responses = rows.filter((r) => r.response != null).map((r) => JSON.parse(r.response));
  if (!responses.length) return [];

  if (choices && ["choice", "truefalse", "poll", "multi"].includes(type)) {
    const isRight = (i) =>
      Array.isArray(correctAnswer) ? correctAnswer.includes(i) : correctAnswer === i;
    const counts = choices.map(() => 0);
    for (const r of responses) for (const i of Array.isArray(r) ? r : [r]) if (counts[i] !== undefined) counts[i] += 1;
    return choices
      .map((label, i) => ({ label, n: counts[i], correct: correctAnswer == null ? null : isRight(i) }))
      .filter((d) => d.n > 0)
      .sort((a, b) => b.n - a.n);
  }

  if (type === "text" || type === "wordcloud") {
    const freq = new Map();
    for (const r of responses) {
      for (const w of Array.isArray(r) ? r : [r]) {
        const label = String(w).trim();
        const key = label.toLowerCase();
        if (!key) continue;
        const cur = freq.get(key) || { label, n: 0, correct: null };
        cur.n += 1;
        freq.set(key, cur);
      }
    }
    // mark which typed answers were accepted, using the graded rows
    const rightText = new Set(
      rows.filter((r) => r.correct === 1 && r.response != null)
        .map((r) => String(JSON.parse(r.response)).trim().toLowerCase())
    );
    return [...freq.entries()]
      .map(([key, v]) => ({ ...v, correct: rightText.size ? rightText.has(key) : null }))
      .sort((a, b) => b.n - a.n);
  }

  if (type === "slider") {
    const freq = new Map();
    for (const v of responses) freq.set(v, (freq.get(v) || 0) + 1);
    return [...freq.entries()]
      .map(([value, n]) => ({ label: String(value), n, correct: correctAnswer === value }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 10);
  }

  return [];
}

export function deleteAnswersFrom(gameId, idx) {
  run(`DELETE FROM answers WHERE game_id = ? AND idx >= ?`, gameId, idx);
  run(`DELETE FROM questions WHERE game_id = ? AND idx >= ?`, gameId, idx);
}

/**
 * Everyone who has ever played, keyed by the identifier when there is one and
 * the nickname otherwise, so a student can be followed across sessions.
 */
export function listStudents() {
  const rows = all(`
    SELECT COALESCE(NULLIF(p.identifier, ''), p.name) AS who,
           p.name AS nickname,
           p.identifier AS identifier,
           g.id AS game_id, g.title AS title, g.started_at AS started_at,
           p.score AS score, p.rank AS rank
    FROM players p
    JOIN games g ON g.id = p.game_id
    WHERE g.ended_at IS NOT NULL
    ORDER BY g.started_at DESC
  `);
  const correctness = new Map();
  for (const r of all(`
    SELECT a.game_id, a.player,
           SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) AS correct,
           SUM(CASE WHEN a.correct IS NOT NULL THEN 1 ELSE 0 END) AS scored
    FROM answers a GROUP BY a.game_id, a.player
  `)) correctness.set(`${r.game_id}\u0000${r.player}`, r);

  const byWho = new Map();
  for (const r of rows) {
    const c = correctness.get(`${r.game_id}\u0000${r.nickname}`) || { correct: 0, scored: 0 };
    const entry = byWho.get(r.who) || { who: r.who, nicknames: new Set(), games: [], correct: 0, scored: 0 };
    entry.nicknames.add(r.nickname);
    entry.games.push({
      gameId: r.game_id, title: r.title, startedAt: r.started_at,
      score: r.score, rank: r.rank, correct: c.correct, scored: c.scored,
    });
    entry.correct += c.correct;
    entry.scored += c.scored;
    byWho.set(r.who, entry);
  }
  return [...byWho.values()]
    .map((e) => ({
      who: e.who,
      nicknames: [...e.nicknames],
      games: e.games,
      gamesPlayed: e.games.length,
      correct: e.correct,
      scored: e.scored,
      correctRate: e.scored ? e.correct / e.scored : null,
      lastPlayed: Math.max(...e.games.map((g) => g.startedAt)),
    }))
    .sort((a, b) => a.who.localeCompare(b.who));
}

export function deleteGame(gameId) {
  run(`DELETE FROM answers WHERE game_id = ?`, gameId);
  run(`DELETE FROM players WHERE game_id = ?`, gameId);
  run(`DELETE FROM questions WHERE game_id = ?`, gameId);
  run(`DELETE FROM games WHERE id = ?`, gameId);
}

/** Abandon a game that never finished, so half-played rooms do not pile up. */
/**
 * A game only reaches the reports once it has finished. Anything still
 * unfinished belonged to a room that lived in memory, and a restart has
 * already destroyed it, so it can never finish or be resumed. Without this
 * those rows accumulate on every restart: invisible in the reports, which
 * filter on ended_at, but still carrying every player and answer.
 */
function sweepUnfinished() {
  for (const g of all(`SELECT id FROM games WHERE ended_at IS NULL`)) deleteGame(g.id);
}

export function discardIfUnfinished(gameId) {
  const g = one(`SELECT ended_at FROM games WHERE id = ?`, gameId);
  if (g && g.ended_at == null) deleteGame(gameId);
}
