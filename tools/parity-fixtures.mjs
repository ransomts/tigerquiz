#!/usr/bin/env node
// Record what the Node implementation does, so the Ruby port can be checked
// against it. The Node code lives on the main branch, so run this from a
// checkout of main and copy the result over:
//
//   git worktree add /tmp/tigerquiz-node main
//   cp tools/parity-fixtures.mjs /tmp/tigerquiz-node/tools/
//   (cd /tmp/tigerquiz-node && npm install && node tools/parity-fixtures.mjs)
//   cp /tmp/tigerquiz-node/test/fixtures/parity.json test/fixtures/
//
// test/lib/parity_test.rb replays the result against the Ruby port.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Q from "../lib/questions.js";
import * as nick from "../lib/nicknames.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "test", "fixtures", "parity.json");

const attempt = (fn) => {
  try {
    return { output: fn() };
  } catch (e) {
    return { error: e.message };
  }
};

// ---------- normText ----------
const NORM_TEXT = [
  "Hello World", "  multiple   spaces  ", "Émilie Brontë", "CAFÉ", "naïve façade",
  "İstanbul", "straße", "ﬁnance", "ＡＢＣ１２３", "①②③", "hello world", "tabs\tand\nnewlines",
  "punctuation, here! (really)?", "it's", "rock & roll", "12.5 kg", "αβγ ΔΕΖ", "日本語 テスト",
  "emoji 🎉 party", "", "   ", null, undefined, 42, 3.5, true, "a-b_c", "O'Neil", "Ångström",
];

// ---------- speedPoints ----------
const SPEED = [];
for (const timeMs of [1000, 20000, 0, 1])
  for (const ms of [-5, 0, 1, 250, 500, 999, 1000, 5000, 10000, 19999, 20000, 25000])
    SPEED.push({ ms, timeMs, points: Q.speedPoints(ms, timeMs) });

// ---------- normalizeQuestion ----------
const q = (o) => ({ text: "Which?", choices: ["A", "B", "C"], answer: 1, ...o });
const NORMALIZE_INPUTS = [
  null, "str", 5, [], {},
  { text: "x" },
  q({ choices: ["a"] }),
  q({ choices: ["a", "b", "c", "d", "e"] }),
  q({ choices: ["a", 2, true, null] }),
  q({ answer: 5 }), q({ answer: -1 }), q({ answer: "1" }), q({ answer: 1.0 }), q({ answer: 1.5 }), q({ answer: null }),
  q({ type: "truefalse", answer: "True" }), q({ type: "truefalse", answer: " false " }),
  q({ type: "truefalse", answer: true }), q({ type: "truefalse", answer: false }),
  q({ type: "truefalse", answer: 0 }), q({ type: "truefalse", answer: 1 }), q({ type: "truefalse", answer: 2 }),
  q({ type: "truefalse", answer: "yes" }), q({ type: "truefalse" , answer: undefined }),
  q({ type: "poll" }), q({ type: "poll", answer: 2 }),
  q({ type: "multi", answers: [0, 2] }), q({ type: "multi", answers: "1" }), q({ type: "multi", answers: [1, "0", 0] }),
  q({ type: "multi", answers: [] }), q({ type: "multi", answer: 1 }), q({ type: "multi", answers: [3] }),
  q({ type: "multi", answers: [2, 0, 2] }), q({ type: "multi", answers: ["x"] }), q({ type: "multi" }),
  { type: "slider", text: "How many?", answer: 50 },
  { type: "slider", text: "How many?", min: 10, max: 10, answer: 10 },
  { type: "slider", text: "How many?", min: 0, max: 100, step: "2", answer: "50", tolerance: "5", unit: "kg" },
  { type: "slider", text: "How many?", min: 0, max: 100, step: 0, answer: 50, tolerance: -1, unit: 3 },
  { type: "slider", text: "How many?", min: 0, max: 100, answer: "abc" },
  { type: "slider", text: "How many?", min: "a", max: 100, answer: 5 },
  { type: "slider", text: "How many?", min: 0.5, max: 2.5, step: 0.25, answer: 1.75, tolerance: 0.1 },
  { type: "text", text: "Name it", accept: "x" },
  { type: "text", text: "Name it", accept: ["a", 5, null] },
  { type: "text", text: "Name it", accept: [] },
  { type: "text", text: "Name it", answer: "x" },
  { type: "text", text: "Name it", answers: ["a", "b"] },
  { type: "text", text: "Name it", accept: ["a"], fuzzy: false },
  { type: "text", text: "Name it", accept: ["a"], fuzzy: "no" },
  { type: "text", text: "Name it" },
  { type: "wordcloud", text: "One word" }, { type: "wordcloud", text: "One word", maxWords: 0 },
  { type: "wordcloud", text: "One word", maxWords: 3 }, { type: "wordcloud", text: "One word", maxWords: 9 },
  { type: "wordcloud", text: "One word", maxWords: "2" }, { type: "wordcloud", text: "One word", maxWords: 2.5 },
  { type: "order", text: "Sort", items: ["a", "b", "c"] }, { type: "order", text: "Sort", items: "a" },
  { type: "order", text: "Sort", items: ["a", "b", "c", "d", "e", "f", "g"] }, { type: "order", text: "Sort", items: ["a", 1] },
  { type: "order", text: "Sort" },
  { type: "slide" }, { type: "slide", text: "Hi", time: 30 }, { type: "slide", image: "pic.png" },
  q({ image: " pic.png " }), q({ image: "dir/sub/pic name.png" }), q({ image: "back\\slash.png" }),
  q({ image: "http://x/y.png" }), q({ image: "https://x" }), q({ image: "" }), q({ image: 5 }),
  q({ image: "weird (1)!*'.png" }), q({ image: "ümlaut.png" }),
  q({ time: "15" }), q({ time: 0 }), q({ time: -3 }), q({ time: "abc" }), q({ time: 2.5 }), q({ time: null }), q({ time: true }),
  q({ explanation: "  " }), q({ explanation: " why " }), q({ explanation: 5 }),
  q({ discuss: true }), q({ discuss: "true" }), q({ discuss: 1 }),
  q({ type: "unknown" }), q({ type: null }), q({ note: "kept", extra: [1, 2] }),
  q({ text: "  padded  " }), q({ text: "" }), q({ text: 42 }),
];

const quizzes = {};
for (const f of (await readdir(path.join(ROOT, "quizzes"))).filter((f) => f.endsWith(".json")).sort()) {
  quizzes[f] = JSON.parse(await readFile(path.join(ROOT, "quizzes", f), "utf8"));
  for (const raw of quizzes[f].questions) NORMALIZE_INPUTS.push(raw);
}

const NORMALIZE = NORMALIZE_INPUTS.map((input, i) => ({ input, i, ...attempt(() => Q.normalizeQuestion(input, i)) }));

// ---------- per-type behaviour on every valid question ----------
const valid = NORMALIZE.filter((c) => c.output).map((c) => c.output);

function fixedPres(q) {
  if (q.type !== "order") return null;
  const n = q.items.length;
  return { shown: Array.from({ length: n }, (_, i) => n - 1 - i) }; // reversed, deterministic
}

function candidates(q) {
  const len = q.choices ? q.choices.length : 0;
  switch (q.type) {
    case "choice":
    case "truefalse":
    case "poll":
      return [...Array(len).keys(), -1, len, 1.5, "1", null, [0], true, 1.0];
    case "multi": {
      const all = [...Array(len).keys()];
      const wrong = all.filter((i) => !q.answers.includes(i));
      return [[], [0], [0, 1], [1, 0, 0], all, [len], [-1], "0", [0.5], q.answers, wrong, [...q.answers, ...wrong].slice(0, len), [q.answers[0], ...wrong.slice(0, 1)], 0];
    }
    case "slider": {
      const tol = q.tolerance || (q.max - q.min) * 0.05;
      const a = q.answer;
      return [q.min, q.max, a, a + tol, a - tol, a + tol * 1.5, a - tol * 1.5, a + tol * 2, a + tol * 3, a + tol * 0.1,
        q.min - 1, q.max + 1, String(a), "", null, "abc", true, [a], undefined];
    }
    case "text": {
      const out = [];
      for (const a of q.accept) {
        out.push(a, a.toUpperCase(), ` ${a} `, a + "x", a + "xy", a + "xyz", "x" + a.slice(1), a.slice(1), a.split("").reverse().join(""), a.replace(/e/g, "é"));
      }
      out.push("", "   ", null, undefined, 42, "z".repeat(100), ["a"], "totally wrong");
      return out;
    }
    case "wordcloud":
      return ["hello", ["a", "b", "c", "d", "e", "f", "g"], ["", " x "], [], "", 12, [" Hello ", "hello", "HELLO", "world"], "w".repeat(50), null];
    case "order": {
      const n = q.items.length;
      const id = [...Array(n).keys()];
      const rev = [...id].reverse();
      const swap = [...id]; [swap[0], swap[1]] = [swap[1], swap[0]];
      return [id, rev, swap, id.slice(1), [...id, 0], id.map(() => 0), id.map(String), id.map((i) => i + 0.5), "abc", null, id.map((i) => (i + 1) % n)];
    }
    default:
      return [0, null, "x"];
  }
}

const RESPONSES = [];
for (const [qi, question] of valid.entries()) {
  const pres = fixedPres(question);
  const cases = [];
  const parsed = [];
  for (const raw of candidates(question)) {
    const r = attempt(() => Q.parseResponse(question, raw));
    const c = { raw: raw === undefined ? { undefined: true } : raw, ...r };
    if (r.output !== undefined) {
      c.grade = Q.grade(question, r.output, pres);
      parsed.push(r.output);
    }
    cases.push(c);
  }
  RESPONSES.push({
    qi,
    pres,
    hostView: Q.hostView(question, pres),
    playerView: Q.playerView(question, pres),
    playerViewText: Q.playerView(question, pres, { showText: true }),
    answerView: Q.answerView(question, pres),
    choiceLabels: Q.choiceLabels(question),
    summary: Q.summarize(question, pres, parsed),
    emptySummary: Q.summarize(question, pres, []),
    cases,
  });
}

// ---------- nicknames ----------
const NAMES = [
  "Cassidy", "classic", "Scunthorpe", "sh1t", "a$$", "A S S", "Assassin", "Bass Master", "Tim", "Sh!thead", "p00p",
  "Dickens", "dick", "grape", "raper", "ok", "", "!!!", "Émilie", "h0m0", "Titanic", "tit", "Sextant", "sexy",
  "cumulative", "cum", "wank3r", "Pen15", "Middlesex", "buttress", "butt", "peacock", "cockburn", "Hancock",
  "N4Z1", "f.u.c.k", "F|_|ck", "Scunthorpe United", "assess", "Ass Ess", "Passport", "harass", "pass", "ARSENAL", "arse",
  "🦊 Fox", "ＳＨＩＴ", "shît", "hoedown", "hoe", "shoe", "Wise Otter", "Lightwater", "nuts", "chestnut",
];
const NICKNAMES = NAMES.map((name) => ({ name, flat: nick.flatten(name), blocked: nick.isBlocked(name) }));

await writeFile(OUT, JSON.stringify({
  normText: NORM_TEXT.map((s) => ({ input: s === undefined ? { undefined: true } : s, output: Q.normText(s) })),
  speedPoints: SPEED,
  normalize: NORMALIZE,
  responses: RESPONSES,
  nicknames: NICKNAMES,
  types: Q.TYPES,
}, null, 1));
console.log(`wrote ${path.relative(ROOT, OUT)}: ${NORMALIZE.length} normalize cases, ${RESPONSES.reduce((t, r) => t + r.cases.length, 0)} response cases, ${NICKNAMES.length} nicknames`);
