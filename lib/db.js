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
  // the backup job opens this file while the server is writing to it; without a
  // busy timeout a moment's contention is an immediate SQLITE_BUSY throw
  db.exec("PRAGMA busy_timeout = 5000");
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
      correct INTEGER NOT NULL DEFAULT 0,
      scored INTEGER NOT NULL DEFAULT 0,
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
    -- No index beyond the primary key. Every query on this table filters by
    -- game_id, which the key already covers, and answers are inserted far more
    -- often than they are read: an index here is paid for on the hot path.

    -- Everyone who has ever signed in. The eppn comes from Shibboleth by way
    -- of Apache; the app never sees a password and has no way to create a user
    -- other than someone arriving with a session.
    CREATE TABLE IF NOT EXISTS users (
      eppn TEXT PRIMARY KEY,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'instructor',
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );

    -- Who owns a quiz or a class list. Those live as files under quizzes/, so
    -- that they stay hand-editable and git-tracked; this table is the only
    -- thing that knows a file belongs to somebody. A file with no row here is
    -- unowned: every instructor can see and play it, nobody can edit it, and
    -- anyone can claim it.
    CREATE TABLE IF NOT EXISTS owners (
      kind TEXT NOT NULL,          -- 'quiz' | 'roster'
      slug TEXT NOT NULL,          -- the file name without .json
      eppn TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      PRIMARY KEY (kind, slug)
    );
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
    if (columns(table).has(name)) return false;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
    return true;
  };
  add("questions", "choices", "TEXT");        // JSON array, for naming wrong answers
  add("questions", "explanation", "TEXT");
  add("questions", "source_idx", "INTEGER");  // position in the quiz file, before shuffling
  add("questions", "correct_answer", "TEXT"); // JSON, the machine-readable answer

  // How many questions each player got right, kept on the player row so the
  // students list does not have to aggregate every answer ever recorded.
  const a = add("players", "correct", "INTEGER NOT NULL DEFAULT 0");
  const b = add("players", "scored", "INTEGER NOT NULL DEFAULT 0");
  if (a || b) backfillPlayerTotals();

  // Who ran the game. Null on anything recorded before sign-in existed, which
  // reads as unowned: visible to every instructor, deletable by none.
  add("games", "owner", "TEXT");
  // Lecture mode records answers but awards no points; the report says so.
  add("games", "scoring", "INTEGER NOT NULL DEFAULT 1");
  // which team a player was on, when the game was played in teams
  add("players", "team", "TEXT");
  // the point multiplier, so marking a written answer by hand can award the right amount
  add("questions", "weight", "REAL NOT NULL DEFAULT 1");
  // 'live' (a PIN on the projector), 'quick' (questions composed on the spot),
  // or 'assignment' (self-paced, played whenever the student likes)
  add("games", "kind", "TEXT NOT NULL DEFAULT 'live'");

  // Self-paced play. An assignment is a quiz left open under a code; each
  // student who enters the code gets a run, which remembers where they are so
  // a closed tab or a restarted server does not lose their place. Answers go
  // into the ordinary tables, so a report looks the same as a live game's.
  db.exec(`
    CREATE TABLE IF NOT EXISTS assignments (
      code TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      quiz_id TEXT NOT NULL,
      title TEXT NOT NULL,
      roster_id TEXT,
      owner TEXT,
      created_at INTEGER NOT NULL,
      due_at INTEGER,
      closed_at INTEGER,
      quiz_json TEXT NOT NULL
    );
    -- Files handed in for file questions. The bytes live under the data
    -- directory; this is how a report finds them and how the room checks that
    -- a player is answering with their own upload.
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      player TEXT NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      name TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assignment_runs (
      game_id TEXT NOT NULL,
      player TEXT NOT NULL,
      identity TEXT,
      order_json TEXT NOT NULL,
      idx INTEGER NOT NULL DEFAULT 0,
      score INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      served_at INTEGER,
      pres_json TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      PRIMARY KEY (game_id, player)
    );
  `);

  // These served that aggregate and nothing else. Every remaining query on
  // answers filters by game_id, which the primary key already covers.
  db.exec("DROP INDEX IF EXISTS answers_by_game");
  db.exec("DROP INDEX IF EXISTS answers_by_player");
}

/** Fill in correct/scored for games recorded before the columns existed. */
function backfillPlayerTotals() {
  db.exec("BEGIN");
  try {
    db.exec(PLAYER_TOTALS_SQL);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Recompute correct/scored from the answers table. Written once and used both
 * for the backfill and at the end of every game, so the two cannot drift.
 * Appending a WHERE narrows it to a single game.
 */
const PLAYER_TOTALS_SQL = `
  UPDATE players SET
    correct = COALESCE((SELECT SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END)
                        FROM answers a WHERE a.game_id = players.game_id AND a.player = players.name), 0),
    scored  = COALESCE((SELECT SUM(CASE WHEN a.correct IS NOT NULL THEN 1 ELSE 0 END)
                        FROM answers a WHERE a.game_id = players.game_id AND a.player = players.name), 0)
`;

const run = (sql, ...args) => db.prepare(sql).run(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);

export function createGame(g) {
  run(
    `INSERT INTO games (id, pin, quiz_id, title, roster_id, started_at, owner, scoring, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    g.id, g.pin, g.quizId, g.title, g.rosterId ?? null, g.startedAt, g.owner ?? null,
    g.scoring === false ? 0 : 1, g.kind ?? "live"
  );
}

export function recordQuestion(gameId, idx, q) {
  run(
    `INSERT OR REPLACE INTO questions
       (game_id, idx, type, text, answer, choices, explanation, source_idx, correct_answer, weight)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    gameId, idx, q.type, q.text, q.answerLabel ?? null,
    q.choices ? JSON.stringify(q.choices) : null,
    q.explanation ?? null,
    q.sourceIndex ?? null,
    q.correctAnswer === undefined ? null : JSON.stringify(q.correctAnswer),
    q.weight ?? 1
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

export function upsertPlayer(gameId, name, identifier, team = null) {
  run(
    `INSERT INTO players (game_id, name, identifier, team) VALUES (?, ?, ?, ?)
     ON CONFLICT(game_id, name) DO UPDATE SET identifier = excluded.identifier, team = excluded.team`,
    gameId, name, identifier ?? null, team
  );
}

export function finishGame(gameId, endedAt, questionCount, board) {
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(`UPDATE players SET score = ?, rank = ? WHERE game_id = ? AND name = ?`);
    for (const p of board) stmt.run(p.score, p.rank, gameId, p.name);
    // Computed here rather than tallied as the game runs, so replaying a
    // question cannot leave the totals disagreeing with the answers themselves.
    db.prepare(`${PLAYER_TOTALS_SQL} WHERE game_id = ?`).run(gameId);
    db.prepare(
      `UPDATE games SET ended_at = ?, question_count = ?, player_count = ? WHERE id = ?`
    ).run(endedAt, questionCount, board.length, gameId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Keep one player's row current while a self-paced run is under way, so the
 * students tab and the gradebook show partial progress rather than 0/0 until
 * they finish. Live games do this once at the end instead.
 */
export function updatePlayerProgress(gameId, name, score) {
  run(`UPDATE players SET score = ? WHERE game_id = ? AND name = ?`, score, gameId, name);
  db.prepare(`${PLAYER_TOTALS_SQL} WHERE game_id = ? AND name = ?`).run(gameId, name);
}

// ---------- reports ----------
/**
 * Finished games, newest first.
 *
 * The scope is `{ all: true }` when there is nothing to hide -- sign-in off, or
 * an admin -- and `{ all: false, eppn }` for one instructor, who sees only
 * their own. Unlike quizzes, an unowned report is *not* shared: it holds
 * student names, identifiers and every answer they gave. See lib/auth.js.
 */
export function listGames(limit = 100, scope = { all: true }) {
  const cols = `id, pin, quiz_id, title, roster_id, started_at, ended_at, question_count, player_count, owner, scoring, kind`;
  if (scope?.all) {
    return all(
      `SELECT ${cols} FROM games WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ?`, limit
    );
  }
  return all(
    `SELECT ${cols} FROM games
     WHERE ended_at IS NOT NULL AND owner = ?
     ORDER BY started_at DESC LIMIT ?`, scope?.eppn ?? "", limit
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
      weight: q.weight ?? 1,
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
      team: p.team ?? null,
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

  if (type === "slider" || type === "numeric") {
    const freq = new Map();
    for (const v of responses) freq.set(v, (freq.get(v) || 0) + 1);
    // the graded rows know about tolerance; an equality test here would not
    const rightValues = new Set(rows.filter((r) => r.correct === 1 && r.response != null).map((r) => JSON.parse(r.response)));
    return [...freq.entries()]
      .map(([value, n]) => ({ label: String(value), n, correct: correctAnswer === value || rightValues.has(value) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 10);
  }

  return [];
}

/** Drop recorded answers from this question onward, for replaying part of a game. */
export function deleteAnswersFrom(gameId, idx) {
  run(`DELETE FROM answers WHERE game_id = ? AND idx >= ?`, gameId, idx);
  run(`DELETE FROM questions WHERE game_id = ? AND idx >= ?`, gameId, idx);
}

/**
 * Everyone who has ever played, keyed by the identifier when there is one and
 * the nickname otherwise, so a student can be followed across sessions. The
 * listing is narrowed the same way as listGames().
 */
export function listStudents(scope = { all: true }) {
  const clause = scope?.all ? `` : `AND g.owner = ?`;
  const args = scope?.all ? [] : [scope?.eppn ?? ""];
  const rows = all(`
    SELECT COALESCE(NULLIF(p.identifier, ''), p.name) AS who,
           p.name AS nickname,
           p.identifier AS identifier,
           g.id AS game_id, g.title AS title, g.started_at AS started_at,
           p.score AS score, p.rank AS rank,
           p.correct AS correct, p.scored AS scored
    FROM players p
    JOIN games g ON g.id = p.game_id
    WHERE g.ended_at IS NOT NULL ${clause}
    ORDER BY g.started_at DESC
  `, ...args);
  const byWho = new Map();
  for (const r of rows) {
    const c = { correct: r.correct, scored: r.scored };
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
  run(`DELETE FROM uploads WHERE game_id = ?`, gameId);
  run(`DELETE FROM assignment_runs WHERE game_id = ?`, gameId);
  run(`DELETE FROM assignments WHERE game_id = ?`, gameId);
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
  for (const g of all(`SELECT id FROM games WHERE ended_at IS NULL AND kind != 'assignment'`)) deleteGame(g.id);
}

export function discardIfUnfinished(gameId) {
  const g = one(`SELECT ended_at FROM games WHERE id = ?`, gameId);
  if (g && g.ended_at == null) deleteGame(gameId);
}

// ---------- users and ownership ----------

/**
 * Record whoever Apache says is here. There is no sign-up: a row appears the
 * first time an identity arrives with a Shibboleth session, and last_seen is
 * refreshed on every request so an admin can tell who is still teaching.
 */
export function touchUser(eppn, displayName = null) {
  const now = Date.now();
  run(
    `INSERT INTO users (eppn, display_name, first_seen, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(eppn) DO UPDATE SET
       last_seen = excluded.last_seen,
       display_name = COALESCE(excluded.display_name, users.display_name)`,
    eppn, displayName, now, now
  );
  return one(`SELECT * FROM users WHERE eppn = ?`, eppn);
}

export function getUser(eppn) {
  return one(`SELECT * FROM users WHERE eppn = ?`, eppn) ?? null;
}

export function listUsers() {
  return all(`SELECT * FROM users ORDER BY last_seen DESC`);
}

/** The eppn that owns this quiz or class list, or null if nobody has claimed it. */
export function ownerOf(kind, slug) {
  return one(`SELECT eppn FROM owners WHERE kind = ? AND slug = ?`, kind, slug)?.eppn ?? null;
}

/** Every slug of one kind owned by one instructor. */
export function slugsOwnedBy(kind, eppn) {
  return new Set(all(`SELECT slug FROM owners WHERE kind = ? AND eppn = ?`, kind, eppn).map((r) => r.slug));
}

/** All ownership rows of one kind, as slug -> eppn. */
export function ownerMap(kind) {
  return new Map(all(`SELECT slug, eppn FROM owners WHERE kind = ?`, kind).map((r) => [r.slug, r.eppn]));
}

export function setOwner(kind, slug, eppn) {
  run(
    `INSERT INTO owners (kind, slug, eppn, claimed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(kind, slug) DO UPDATE SET eppn = excluded.eppn, claimed_at = excluded.claimed_at`,
    kind, slug, eppn, Date.now()
  );
}

export function clearOwner(kind, slug) {
  run(`DELETE FROM owners WHERE kind = ? AND slug = ?`, kind, slug);
}

/** Assign a finished game to an instructor, for claiming an unowned report. */
export function setGameOwner(gameId, eppn) {
  run(`UPDATE games SET owner = ? WHERE id = ?`, eppn, gameId);
}

export function gameOwner(gameId) {
  const g = one(`SELECT owner FROM games WHERE id = ?`, gameId);
  return g ? g.owner : undefined; // undefined means no such game
}

/**
 * Close the database on the way out. Committed data is already durable in WAL
 * mode, so this is not about losing reports; it checkpoints the -wal file back
 * into the database so the next start, and any backup taken in between, sees a
 * tidy single file.
 */
export function close() {
  if (!db) return;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* a checkpoint we cannot take is not worth failing a shutdown over */
  }
  db.close();
  db = null;
}

/** Promote or demote an instructor. There is no UI for this by design. */
export function setRole(eppn, role) {
  run(`UPDATE users SET role = ? WHERE eppn = ?`, role, eppn);
  return getUser(eppn);
}

/** Hand every report nobody owns to one instructor. Returns how many moved. */
export function assignUnownedGames(eppn) {
  const before = one(`SELECT COUNT(*) AS n FROM games WHERE owner IS NULL`).n;
  run(`UPDATE games SET owner = ? WHERE owner IS NULL`, eppn);
  return before;
}

export function countUnownedGames() {
  return one(`SELECT COUNT(*) AS n FROM games WHERE owner IS NULL`).n;
}

// ---------- marking by hand ----------
/**
 * Mark one written or uploaded answer after the game. "right" and "partial"
 * earn full and half marks scaled by the question's weight, "wrong" earns
 * nothing, and null takes the mark back. The player's score, totals and rank
 * follow, so the report and the gradebook agree with the mark. In lecture
 * mode points stay at zero; only correct/scored move.
 */
export function gradeAnswer(gameId, idx, player, mark) {
  const game = one(`SELECT scoring FROM games WHERE id = ?`, gameId);
  const q = one(`SELECT weight FROM questions WHERE game_id = ? AND idx = ?`, gameId, idx);
  const row = one(`SELECT 1 FROM answers WHERE game_id = ? AND idx = ? AND player = ?`, gameId, idx, player);
  if (!game || !q || !row) return false;
  const weight = q.weight ?? 1;
  const correct = mark === "right" ? 1 : mark === "partial" || mark === "wrong" ? 0 : null;
  const ratio = mark === "right" ? 1 : mark === "partial" ? 0.5 : 0;
  const points = game.scoring ? Math.round(1000 * weight * ratio) : 0;
  db.exec("BEGIN");
  try {
    run(`UPDATE answers SET correct = ?, points = ? WHERE game_id = ? AND idx = ? AND player = ?`, correct, points, gameId, idx, player);
    run(`UPDATE players SET score = COALESCE((SELECT SUM(points) FROM answers a WHERE a.game_id = players.game_id AND a.player = players.name), 0)
         WHERE game_id = ? AND name = ?`, gameId, player);
    run(`UPDATE assignment_runs SET score = (SELECT score FROM players p WHERE p.game_id = assignment_runs.game_id AND p.name = assignment_runs.player)
         WHERE game_id = ? AND player = ?`, gameId, player);
    db.prepare(`${PLAYER_TOTALS_SQL} WHERE game_id = ? AND name = ?`).run(gameId, player);
    if (game.scoring) rerank(gameId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return true;
}

/** Competition ranking over a game's players, from their stored scores. */
function rerank(gameId) {
  const players = all(`SELECT name, score, rank FROM players WHERE game_id = ? AND rank IS NOT NULL ORDER BY score DESC`, gameId);
  let rank = 0, prev = null;
  const stmt = db.prepare(`UPDATE players SET rank = ? WHERE game_id = ? AND name = ?`);
  players.forEach((p, i) => {
    if (p.score !== prev) { rank = i + 1; prev = p.score; }
    stmt.run(rank, gameId, p.name);
  });
}

// ---------- uploads ----------
export function recordUpload(u) {
  run(`INSERT INTO uploads (id, game_id, player, path, type, size, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    u.id, u.gameId, u.player, u.path, u.type, u.size, u.name ?? null, u.createdAt);
}
export const getUpload = (id) => one(`SELECT * FROM uploads WHERE id = ?`, String(id || "")) ?? null;

// ---------- gradebook ----------
/**
 * One row per student, one column per finished game, for pasting into a
 * gradebook. Students are keyed the way listStudents() keys them. Each cell is
 * `{ score, correct, scored }` or null when they did not play that game.
 */
export function gradebook(scope = { all: true }) {
  const games = listGames(1000, scope).sort((a, b) => a.started_at - b.started_at);
  const students = listStudents(scope);
  const rows = students.map((s) => {
    const cells = new Map(s.games.map((g) => [g.gameId, { score: g.score, correct: g.correct, scored: g.scored }]));
    return { who: s.who, nicknames: s.nicknames, cells: games.map((g) => cells.get(g.id) ?? null), correct: s.correct, scored: s.scored };
  });
  return { games, rows };
}

// ---------- assignments ----------
export function createAssignment(a) {
  run(
    `INSERT INTO assignments (code, game_id, quiz_id, title, roster_id, owner, created_at, due_at, quiz_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.code, a.gameId, a.quizId, a.title, a.rosterId ?? null, a.owner ?? null, a.createdAt, a.dueAt ?? null, a.quizJson
  );
}

export function getAssignment(code) {
  // scoring lives on the game row, where the report reads it
  const a = one(`SELECT a.*, g.scoring AS scoring FROM assignments a JOIN games g ON g.id = a.game_id WHERE a.code = ?`, code);
  if (!a) return null;
  return { ...a, scoring: a.scoring !== 0, quiz: JSON.parse(a.quiz_json), quiz_json: undefined };
}

export const assignmentExists = (code) => !!one(`SELECT 1 FROM assignments WHERE code = ?`, code);

/** Open and closed assignments, newest first, with how many have started and finished. */
export function listAssignments(scope = { all: true }) {
  const clause = scope?.all ? `` : `WHERE a.owner = ?`;
  const args = scope?.all ? [] : [scope?.eppn ?? ""];
  return all(`
    SELECT a.code, a.game_id, a.quiz_id, a.title, a.roster_id, a.owner, a.created_at, a.due_at, a.closed_at,
           g.scoring AS scoring,
           (SELECT COUNT(*) FROM assignment_runs r WHERE r.game_id = a.game_id) AS started,
           (SELECT COUNT(*) FROM assignment_runs r WHERE r.game_id = a.game_id AND r.finished_at IS NOT NULL) AS finished
    FROM assignments a JOIN games g ON g.id = a.game_id
    ${clause}
    ORDER BY a.created_at DESC
  `, ...args);
}

export function closeAssignment(code, when = Date.now()) {
  run(`UPDATE assignments SET closed_at = ? WHERE code = ? AND closed_at IS NULL`, when, code);
}

export function getRun(gameId, player) {
  const r = one(`SELECT * FROM assignment_runs WHERE game_id = ? AND player = ?`, gameId, player);
  return r ? inflateRun(r) : null;
}

export function findRunByIdentity(gameId, identity) {
  const r = one(`SELECT * FROM assignment_runs WHERE game_id = ? AND identity = ?`, gameId, identity);
  return r ? inflateRun(r) : null;
}

const inflateRun = (r) => ({
  ...r,
  order: JSON.parse(r.order_json),
  pres: r.pres_json ? JSON.parse(r.pres_json) : null,
  order_json: undefined,
  pres_json: undefined,
});

export function saveRun(r) {
  run(
    `INSERT INTO assignment_runs (game_id, player, identity, order_json, idx, score, streak, served_at, pres_json, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(game_id, player) DO UPDATE SET
       idx = excluded.idx, score = excluded.score, streak = excluded.streak, served_at = excluded.served_at,
       pres_json = excluded.pres_json, finished_at = excluded.finished_at`,
    r.game_id, r.player, r.identity ?? null, JSON.stringify(r.order), r.idx, r.score, r.streak,
    r.served_at ?? null, r.pres ? JSON.stringify(r.pres) : null, r.started_at, r.finished_at ?? null
  );
}

/** Every run of one assignment, finished ones ranked by score. */
export function listRuns(gameId) {
  return all(`SELECT * FROM assignment_runs WHERE game_id = ? ORDER BY finished_at IS NULL, score DESC, finished_at`, gameId).map(inflateRun);
}
