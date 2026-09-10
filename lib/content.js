// Reading and writing the quiz and class-list files under quizzes/.
//
// Two ways in, deliberately. loadQuiz/loadRoster normalise as a game needs
// them; readRaw returns a file exactly as written so the editor round-trips
// without rewriting a hand-made file into normalised form.
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import * as Q from "./questions.js";
import { QUIZ_DIR, ROSTER_DIR } from "./config.js";

export const safeId = (id) => /^[\w-]{1,60}$/.test(id);
export const quizPath = (id) => path.join(QUIZ_DIR, `${id}.json`);
export const rosterPath = (id) => path.join(ROSTER_DIR, `${id}.json`);

// ---------- quiz files ----------
export async function listQuizzes() {
  let files;
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

export async function loadQuiz(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error("bad quiz id");
  const q = JSON.parse(await readFile(quizPath(id), "utf8"));
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
export function prepareQuiz(quiz) {
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
export async function listRosters() {
  let files;
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

export async function loadRoster(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error("bad roster id");
  const raw = JSON.parse(await readFile(rosterPath(id), "utf8"));
  const list = Array.isArray(raw) ? raw : raw.students;
  if (!Array.isArray(list) || !list.length) throw new Error("roster has no students");
  const students = list.map((s) => (typeof s === "string" ? { name: s, id: null } : { name: String(s.name), id: s.id == null ? null : String(s.id) }));
  return { id, title: String(raw.title || id), students };
}

/** Match what a player typed against the roster. Returns the canonical entry or null. */
export function matchRoster(roster, typed) {
  const norm = Q.normText(typed);
  if (!norm) return null;
  return (
    roster.students.find((s) => s.id && Q.normText(s.id) === norm) ||
    roster.students.find((s) => Q.normText(s.name) === norm) ||
    null
  );
}

// ---------- editing ----------
/** Read a quiz exactly as written, without normalising, so editing round-trips. */
export async function readRaw(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/** Validate a quiz body the way a game would, and report every problem at once. */
export function validateQuiz(body) {
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

const QUIZ_FIELDS = ["title", "note", "identifier", "shuffleQuestions", "shuffleAnswers", "phoneText"];
const QUESTION_FIELDS = [
  "type", "text", "image", "time", "explanation", "discuss",
  "choices", "answer", "answers", "accept", "fuzzy",
  "min", "max", "step", "tolerance", "unit", "items", "maxWords",
];

export function pickQuizFields(body) {
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

/** Drop the fields normalisation added, so the written file reads like a hand-made one. */
export function stripInternals(q) {
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

export async function uniqueQuizId(base) {
  const safe = base.replace(/[^\w-]+/g, "-").slice(0, 40);
  let id = safe;
  let n = 2;
  while (await readFile(quizPath(id), "utf8").then(() => true, () => false)) {
    id = `${safe}-${n++}`;
  }
  return id;
}

/** Whether a quiz or roster file is there, without reading it. */
export async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function writeQuiz(id, quiz) {
  await writeFile(quizPath(id), JSON.stringify(quiz, null, 2) + "\n", "utf8");
}

export async function writeRoster(id, roster) {
  await mkdir(ROSTER_DIR, { recursive: true });
  await writeFile(rosterPath(id), JSON.stringify(roster, null, 2) + "\n", "utf8");
}
