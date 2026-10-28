// Self-paced play: a quiz left open under a code, played whenever the student
// likes, with feedback after every answer instead of a results screen on a
// projector.
//
// Nothing here lives in memory. Each student's place is a row in
// assignment_runs, so a closed tab, a dead phone battery or a restarted server
// costs nothing; they enter the code again and carry on. Answers land in the
// same tables a live game writes, so the report, the students tab and the
// gradebook do not know the difference.
import { randomUUID } from "node:crypto";
import * as Q from "./questions.js";
import * as store from "./db.js";
import * as uploads from "./uploads.js";
import { makePin } from "./registry.js";
import { loadQuiz, loadRoster, prepareQuiz, matchRoster } from "./content.js";
import { STREAK_BONUS, STREAK_BONUS_CAP } from "./config.js";

/**
 * Open a quiz for self-paced play. The quiz is copied into the assignment as
 * it stands, so editing the file afterwards cannot change a question half the
 * class has already answered. Answer shuffling happens once here, for the same
 * reason: every student must see the choices in the order the report records.
 */
export async function create({ quizId, rosterId = null, dueAt = null, scoring = true, owner = null }) {
  const source = await loadQuiz(quizId);
  const quiz = prepareQuiz({ ...source, id: quizId, shuffleQuestions: false });
  const roster = rosterId ? await loadRoster(rosterId) : null;
  const code = makePin();
  const gameId = randomUUID();
  const now = Date.now();
  store.createGame({
    id: gameId, pin: code, quizId, title: quiz.title, rosterId: roster?.id ?? null,
    startedAt: now, owner, scoring, kind: "assignment",
  });
  // record every question now, so the report reads properly before anyone has played
  quiz.questions.forEach((q, i) => {
    const answerView = Q.answerView(q);
    store.recordQuestion(gameId, i, {
      type: q.type, text: q.text, answerLabel: answerView?.label ?? null, choices: Q.choiceLabels(q),
      explanation: q.explanation, sourceIndex: q.sourceIndex, correctAnswer: q.type === "multi" ? q.answers : q.answer,
      weight: q.weight,
    });
  });
  // an assignment is "finished" from the start as far as the report list is
  // concerned: it is listed straight away and fills in as students play
  store.finishGame(gameId, now, quiz.questions.length, []);
  store.createAssignment({
    code, gameId, quizId, title: quiz.title, rosterId: roster?.id ?? null, owner, createdAt: now, dueAt,
    quizJson: JSON.stringify({ ...quiz, shuffleQuestions: !!source.shuffleQuestions }),
  });
  return { code, gameId, title: quiz.title, dueAt };
}

/** The assignment behind a code, if it is still taking answers. Null otherwise. */
export function open(code) {
  const a = store.getAssignment(String(code || "").trim());
  if (!a) return null;
  if (a.closed_at != null) return { ...a, closed: true };
  if (a.due_at != null && a.due_at < Date.now()) return { ...a, closed: true };
  return { ...a, closed: false };
}

/** What the join screen needs to ask for. */
export function lobbyInfo(a) {
  return {
    title: a.title,
    identifier: a.roster_id ? "Your name or student ID" : a.quiz.identifier,
    roster: !!a.roster_id,
    selfPaced: true,
    dueAt: a.due_at,
  };
}

/**
 * Start or resume a run. A student is recognised by the class list entry or
 * the identifier when the quiz asks for one, and by nickname only when it asks
 * for nothing, which is why an assignment without a class list is on trust.
 */
export async function join(a, { name, identifier }) {
  name = String(name || "").trim().slice(0, 20);
  identifier = String(identifier || "").trim().slice(0, 40);
  if (!name) throw new Error("Enter a nickname");
  let identity = null;
  if (a.roster_id) {
    let roster;
    try { roster = await loadRoster(a.roster_id); } catch { throw new Error("The class list for this assignment is missing"); }
    const entry = matchRoster(roster, identifier);
    if (!entry) throw new Error("Not on the class list. Check your name or ID.");
    identity = entry.name;
  } else if (a.quiz.identifier) {
    if (!identifier) throw new Error(`Enter your ${a.quiz.identifier}`);
    identity = identifier;
  }
  let run = identity ? store.findRunByIdentity(a.game_id, identity) : store.getRun(a.game_id, name);
  const hasFiles = a.quiz.questions.some((q) => q.type === "file");
  if (!run) {
    // a nickname already in use by someone else on this assignment cannot be shared
    if (identity && store.getRun(a.game_id, name)) throw new Error("That nickname is taken on this assignment");
    const n = a.quiz.questions.length;
    const order = a.quiz.shuffleQuestions ? Q.shuffled(Array.from({ length: n }, (_, i) => i)) : Array.from({ length: n }, (_, i) => i);
    run = { game_id: a.game_id, player: name, identity, order, idx: 0, score: 0, streak: 0, served_at: null, pres: null, started_at: Date.now(), finished_at: null };
    store.upsertPlayer(a.game_id, name, identity);
    store.saveRun(run);
  }
  // not persisted: a fresh token on every join is fine, and a restart forces a rejoin anyway
  return { ...run, uploadToken: hasFiles ? uploads.issueToken(a.game_id, run.player) : null };
}

const questionAt = (a, run) => a.quiz.questions[run.order[run.idx]];

/** The question the student is on, served fresh: the clock starts now. */
export function serve(a, run) {
  if (run.finished_at != null) return null;
  const q = questionAt(a, run);
  // slides have nothing to answer; step straight past them
  if (!Q.isAnswerable(q.type)) {
    run.idx += 1;
    if (run.idx >= run.order.length) { finishRun(a, run); return null; }
    store.saveRun(run);
    return serve(a, run);
  }
  if (!run.pres) run.pres = Q.presentation(q);
  if (!run.served_at) run.served_at = Date.now();
  store.saveRun(run);
  return {
    index: run.idx,
    total: run.order.length,
    endsAt: null,
    totalMs: q.time * 1000,
    selfPaced: true,
    ...Q.playerView(q, run.pres, { showText: a.quiz.phoneText !== false }),
  };
}

/**
 * Grade one answer, bank it, and say how it went. Speed still counts, from the
 * moment the question was served, so the scoring matches a live game; but the
 * clock is never enforced, because nobody is waiting on a projector.
 */
export function answer(a, run, response) {
  if (run.finished_at != null) throw new Error("You have finished this one");
  const q = questionAt(a, run);
  if (!Q.isAnswerable(q.type)) throw new Error("Nothing to answer here");
  const value = Q.parseResponse(q, response);
  if (q.type === "file" && !uploads.owned(value.file, a.game_id, run.player)) throw new Error("Upload a file first");
  const ms = Math.max(Date.now() - (run.served_at ?? Date.now()), 0);
  const scoring = !!a.scoring;
  const unscored = Q.isUnscored(q.type);
  const result = Q.grade(q, value, run.pres);
  let gained = 0, bonus = 0;
  if (scoring && result.ratio > 0) gained = Math.round(Q.speedPoints(ms, q.time * 1000) * result.ratio * q.weight);
  if (scoring && !unscored) {
    if (result.correct === true) {
      run.streak += 1;
      bonus = Math.min((run.streak - 1) * STREAK_BONUS, STREAK_BONUS_CAP);
    } else {
      run.streak = 0;
    }
  }
  run.score += gained + bonus;
  store.recordAnswers(a.game_id, run.order[run.idx], [
    // an anonymous question keeps the answer but not whose it was
    { player: q.anonymous ? `anonymous ${randomUUID().slice(0, 8)}` : run.player, response: value, ms, correct: result.correct, points: gained + bonus },
  ]);
  store.updatePlayerProgress(a.game_id, run.player, run.score);
  const answerView = Q.answerView(q);
  const out = {
    type: q.type,
    unscored,
    scoring,
    correct: result.correct,
    ratio: result.ratio,
    gained,
    bonus,
    streak: run.streak,
    score: run.score,
    answer: answerView,
    yourAnswer: Q.responseLabel(q, value, run.pres),
    explanation: q.explanation,
    answered: true,
    endedBy: "you",
    selfPaced: true,
  };
  // move on; the next call to serve() starts the next clock
  run.idx += 1;
  run.pres = null;
  run.served_at = null;
  if (run.idx >= run.order.length) finishRun(a, run);
  else store.saveRun(run);
  out.isLast = run.finished_at != null;
  return out;
}

/** Bank the run and re-rank everyone who has finished so far. */
function finishRun(a, run) {
  run.finished_at = Date.now();
  store.saveRun(run);
  const board = standings(a);
  store.finishGame(a.game_id, run.finished_at, a.quiz.questions.length, board);
}

/** Finished runs ranked by score, the way a live leaderboard is. */
export function standings(a) {
  const done = store.listRuns(a.game_id).filter((r) => r.finished_at != null);
  if (!a.scoring) return done.map((r) => ({ name: r.player, score: r.score, rank: null }));
  let rank = 0, prev = null;
  return done
    .sort((x, y) => y.score - x.score)
    .map((r, i) => {
      if (r.score !== prev) { rank = i + 1; prev = r.score; }
      return { name: r.player, score: r.score, rank };
    });
}

/** What a student sees when they come back to, or reach, the end. */
export function summary(a, run) {
  const board = standings(a);
  const me = board.find((b) => b.name === run.player);
  return {
    score: run.score,
    rank: me?.rank ?? null,
    players: board.length,
    scoring: !!a.scoring,
    total: run.order.length,
    finished: run.finished_at != null,
  };
}
