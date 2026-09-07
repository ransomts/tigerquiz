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
  return db;
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

export function recordQuestion(gameId, idx, type, text, answerLabel) {
  run(
    `INSERT OR REPLACE INTO questions (game_id, idx, type, text, answer) VALUES (?, ?, ?, ?, ?)`,
    gameId, idx, type, text, answerLabel ?? null
  );
}

export function recordAnswers(gameId, idx, rows) {
  if (!rows.length) return;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO answers (game_id, idx, player, response, ms, correct, points) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    stmt.run(gameId, idx, r.player, r.response == null ? null : JSON.stringify(r.response),
      r.ms ?? null, r.correct == null ? null : r.correct ? 1 : 0, r.points ?? 0);
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
    return {
      idx: q.idx,
      type: q.type,
      text: q.text,
      answer: q.answer,
      responses: rows.length,
      scored: scored.length,
      correct: right,
      // null for polls and word clouds, which have no right answer
      correctRate: scored.length ? right / scored.length : null,
      avgMs: rows.length ? Math.round(rows.reduce((t, r) => t + (r.ms ?? 0), 0) / rows.length) : null,
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
export function deleteAnswersFrom(gameId, idx) {
  run(`DELETE FROM answers WHERE game_id = ? AND idx >= ?`, gameId, idx);
  run(`DELETE FROM questions WHERE game_id = ? AND idx >= ?`, gameId, idx);
}

export function deleteGame(gameId) {
  run(`DELETE FROM answers WHERE game_id = ?`, gameId);
  run(`DELETE FROM players WHERE game_id = ?`, gameId);
  run(`DELETE FROM questions WHERE game_id = ?`, gameId);
  run(`DELETE FROM games WHERE id = ?`, gameId);
}

/** Abandon a game that never finished, so half-played rooms do not pile up. */
export function discardIfUnfinished(gameId) {
  const g = one(`SELECT ended_at FROM games WHERE id = ?`, gameId);
  if (g && g.ended_at == null) deleteGame(gameId);
}
