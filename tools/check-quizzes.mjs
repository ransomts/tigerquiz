#!/usr/bin/env node
// Validate every quiz and class list, and warn about things that are legal but
// probably mistakes. Run it before a lesson so a broken file fails here rather
// than in front of a class.
//
//   npm run check              all quizzes and rosters
//   npm run check -- my-quiz   just one, by id or path
import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeQuestion, TYPES, normText } from "../lib/questions.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const QUIZ_DIR = path.join(ROOT, "quizzes");
const IMAGE_DIR = path.join(QUIZ_DIR, "images");
const ROSTER_DIR = path.join(QUIZ_DIR, "rosters");

const C = process.stdout.isTTY
  ? { red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m", dim: "\x1b[2m", bold: "\x1b[1m", off: "\x1b[0m" }
  : { red: "", yellow: "", green: "", dim: "", bold: "", off: "" };

let errors = 0;
let warnings = 0;
const err = (msg) => { errors++; console.log(`  ${C.red}error${C.off}   ${msg}`); };
const warn = (msg) => { warnings++; console.log(`  ${C.yellow}warning${C.off} ${msg}`); };

const exists = (p) => access(p).then(() => true, () => false);

async function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const files = await pickFiles(wanted);
  if (!files.length) {
    console.log("No quiz files found in quizzes/");
    process.exit(1);
  }
  for (const file of files) await checkQuiz(file);
  if (!wanted.length) await checkRosters();

  console.log("");
  if (errors) console.log(`${C.red}${C.bold}${errors} error${errors > 1 ? "s" : ""}${C.off}, ${warnings} warning${warnings === 1 ? "" : "s"}`);
  else if (warnings) console.log(`${C.yellow}No errors, ${warnings} warning${warnings === 1 ? "" : "s"}${C.off}`);
  else console.log(`${C.green}All good${C.off}`);
  process.exit(errors ? 1 : 0);
}

async function pickFiles(wanted) {
  if (wanted.length) {
    return wanted.map((w) => (w.endsWith(".json") ? path.resolve(w) : path.join(QUIZ_DIR, `${w}.json`)));
  }
  try {
    return (await readdir(QUIZ_DIR)).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(QUIZ_DIR, f));
  } catch {
    return [];
  }
}

async function checkQuiz(file) {
  const name = path.relative(ROOT, file);
  console.log(`\n${C.bold}${name}${C.off}`);

  let raw;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return err("file not found");
    return err(`not valid JSON: ${e.message}`);
  }

  const id = path.basename(file, ".json");
  if (!/^[\w-]+$/.test(id)) err(`filename "${id}" must be letters, digits, dash or underscore only`);
  if (!raw.title) warn("no title, the filename will be used instead");
  if (!Array.isArray(raw.questions) || !raw.questions.length) return err("no questions array");

  for (const key of Object.keys(raw)) {
    if (!["title", "questions", "identifier", "shuffleQuestions", "shuffleAnswers", "phoneText"].includes(key))
      warn(`unknown quiz field "${key}", it will be ignored`);
  }

  const seen = new Map();
  let ok = 0;
  for (const [i, rawQ] of raw.questions.entries()) {
    let q;
    try {
      q = normalizeQuestion(rawQ, i);
    } catch (e) {
      err(e.message);
      continue;
    }
    ok++;
    const at = `question ${i + 1}`;

    if (rawQ.type && !TYPES.includes(rawQ.type)) warn(`${at}: unknown type "${rawQ.type}", treated as choice`);

    // a duplicated question stem is usually a copy-paste that was never edited
    const key = normText(q.text);
    if (key && seen.has(key)) warn(`${at}: same text as question ${seen.get(key) + 1}`);
    else if (key) seen.set(key, i);

    if (q.choices) {
      const norm = q.choices.map(normText);
      const dupes = norm.filter((c, j) => c && norm.indexOf(c) !== j);
      if (dupes.length) err(`${at}: duplicate choices (${[...new Set(dupes)].join(", ")})`);
      if (q.choices.some((c) => !c.trim())) err(`${at}: a choice is empty`);
      const longest = Math.max(...q.choices.map((c) => c.length));
      if (longest > 75) warn(`${at}: a choice is ${longest} characters, it may not fit on screen`);
    }

    if (q.time && q.time < 5 && q.type !== "slide") warn(`${at}: only ${q.time}s to answer`);
    if (q.time > 300) warn(`${at}: ${q.time}s is a very long timer`);
    if (q.text.length > 160) warn(`${at}: question text is ${q.text.length} characters, it may not fit on screen`);

    if (q.type === "text") {
      if (q.accept.some((a) => a.length > 40)) warn(`${at}: a long accepted answer is hard to type exactly`);
      if (q.accept.length === 1) warn(`${at}: only one accepted spelling, consider listing alternatives`);
    }
    if (q.type === "slider") {
      if (q.answer < q.min || q.answer > q.max) err(`${at}: answer ${q.answer} is outside ${q.min}-${q.max}`);
      const steps = (q.max - q.min) / q.step;
      if (steps > 1000) warn(`${at}: ${Math.round(steps)} steps is hard to hit on a phone`);
      if (!q.tolerance) warn(`${at}: no tolerance set, defaulting to 5% of the range`);
    }
    if (q.type === "multi" && q.answers.length === q.choices.length)
      warn(`${at}: every choice is correct`);
    if (q.type === "slide" && !q.text && !q.image) warn(`${at}: slide has neither text nor an image`);

    // images are referenced by name, so a typo only shows up at game time
    if (q.image && q.image.startsWith("/quiz-images/")) {
      const fileName = decodeURIComponent(q.image.replace("/quiz-images/", ""));
      if (!(await exists(path.join(IMAGE_DIR, fileName))))
        err(`${at}: image "${fileName}" not found in quizzes/images/`);
    }
  }

  const counts = {};
  for (const q of raw.questions) counts[q.type || "choice"] = (counts[q.type || "choice"] || 0) + 1;
  const shape = Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(", ");
  console.log(`  ${C.dim}${ok}/${raw.questions.length} questions valid · ${shape}${C.off}`);
}

async function checkRosters() {
  let files = [];
  try {
    files = (await readdir(ROSTER_DIR)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return;
  }
  for (const f of files) {
    console.log(`\n${C.bold}quizzes/rosters/${f}${C.off}`);
    let raw;
    try {
      raw = JSON.parse(await readFile(path.join(ROSTER_DIR, f), "utf8"));
    } catch (e) {
      err(`not valid JSON: ${e.message}`);
      continue;
    }
    const list = Array.isArray(raw) ? raw : raw.students;
    if (!Array.isArray(list) || !list.length) { err("no students"); continue; }
    const names = new Map();
    const ids = new Map();
    for (const [i, s] of list.entries()) {
      const student = typeof s === "string" ? { name: s } : s;
      if (!student || !String(student.name || "").trim()) { err(`student ${i + 1} has no name`); continue; }
      // players are matched on a normalised name, so two students who normalise
      // the same would be indistinguishable at the join screen
      const nk = normText(student.name);
      if (names.has(nk)) err(`"${student.name}" cannot be told apart from "${names.get(nk)}"`);
      else names.set(nk, student.name);
      if (student.id != null) {
        const ik = normText(String(student.id));
        if (ids.has(ik)) err(`id "${student.id}" is used by both ${ids.get(ik)} and ${student.name}`);
        else ids.set(ik, student.name);
      }
    }
    const withIds = list.filter((s) => typeof s === "object" && s.id != null).length;
    if (withIds && withIds < list.length) warn(`${list.length - withIds} of ${list.length} students have no id`);
    console.log(`  ${C.dim}${list.length} students${C.off}`);
  }
}

main();
