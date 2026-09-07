// Question type definitions: validation, presentation and grading.
// Every question is normalized to one internal shape by normalizeQuestion(),
// then graded by grade(). Adding a type means touching only this file plus
// the two renderers in public/.

export const TYPES = ["choice", "truefalse", "multi", "poll", "slider", "text", "wordcloud", "order", "slide"];

/** Types that do not produce a score: no points, no streak effect, no correct answer. */
const UNSCORED = new Set(["poll", "wordcloud", "slide"]);
/** Types nobody answers at all. */
const NO_ANSWER = new Set(["slide"]);

export const isUnscored = (type) => UNSCORED.has(type);
export const isAnswerable = (type) => !NO_ANSWER.has(type);

const MAX_POINTS = 1000;

/** Points for a fully correct answer given how fast it arrived. */
export function speedPoints(ms, timeMs) {
  const frac = Math.min(Math.max(ms, 0) / Math.max(timeMs, 1), 1);
  return Math.round(MAX_POINTS * (1 - frac / 2));
}

// ---------- text matching ----------
export function normText(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // combining accents
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** How many typos to forgive in a word of this length. */
function fuzzTolerance(s) {
  if (s.length <= 4) return 0;
  if (s.length <= 8) return 1;
  return 2;
}

// ---------- normalization ----------
const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

export function normalizeQuestion(raw, i) {
  const where = `question ${i + 1}`;
  if (!raw || typeof raw !== "object") throw new Error(`${where}: not an object`);
  const q = { ...raw };
  q.type = TYPES.includes(q.type) ? q.type : "choice";
  q.text = String(q.text ?? "").trim();
  if (!q.text && q.type !== "slide") throw new Error(`${where}: needs text`);
  q.time = Number(q.time) > 0 ? Number(q.time) : 20;
  if (q.type === "slide") q.time = 0;

  // shown to everyone once the answer is revealed, so a wrong answer teaches something
  q.explanation = typeof q.explanation === "string" && q.explanation.trim() ? q.explanation.trim() : null;
  // suggests a peer-instruction round: answer, discuss, answer again
  q.discuss = q.discuss === true;
  // position in the quiz file, kept through shuffling so reviews can find it again
  q.sourceIndex = i;

  // image: a filename under quizzes/images/, or an absolute http(s) URL
  if (typeof q.image === "string" && q.image.trim()) {
    const img = q.image.trim();
    q.image = /^https?:\/\//.test(img) ? img : `/quiz-images/${encodeURIComponent(img.replace(/^.*[\\/]/, ""))}`;
  } else {
    delete q.image;
  }

  switch (q.type) {
    case "truefalse": {
      q.choices = ["True", "False"];
      let a = q.answer;
      if (typeof a === "string") a = a.trim().toLowerCase() === "true";
      if (typeof a === "boolean") a = a ? 0 : 1;
      q.answer = a;
      requireIndex(q.answer, 2, where);
      break;
    }
    case "choice": {
      requireChoices(q, where);
      requireIndex(q.answer, q.choices.length, where);
      break;
    }
    case "poll": {
      requireChoices(q, where);
      delete q.answer;
      break;
    }
    case "multi": {
      requireChoices(q, where);
      const answers = [...new Set(asArray(q.answers ?? q.answer).map(Number))].sort((x, y) => x - y);
      if (!answers.length) throw new Error(`${where}: multi needs at least one correct answer`);
      for (const a of answers) requireIndex(a, q.choices.length, where);
      q.answers = answers;
      delete q.answer;
      break;
    }
    case "slider": {
      q.min = Number(q.min ?? 0);
      q.max = Number(q.max ?? 100);
      if (!(q.max > q.min)) throw new Error(`${where}: slider max must exceed min`);
      q.step = Number(q.step) > 0 ? Number(q.step) : 1;
      q.answer = Number(q.answer);
      if (!Number.isFinite(q.answer)) throw new Error(`${where}: slider needs a numeric answer`);
      // full marks within tolerance, sliding to zero at twice the tolerance
      q.tolerance = Number(q.tolerance) >= 0 ? Number(q.tolerance) : 0;
      q.unit = typeof q.unit === "string" ? q.unit : "";
      break;
    }
    case "text": {
      const accept = asArray(q.accept ?? q.answers ?? q.answer).map((s) => String(s));
      if (!accept.length) throw new Error(`${where}: text needs an accepted answer`);
      q.accept = accept;
      q.fuzzy = q.fuzzy !== false; // forgive typos unless told not to
      delete q.answer;
      delete q.answers;
      break;
    }
    case "wordcloud": {
      q.maxWords = Number(q.maxWords) > 0 ? Math.min(Number(q.maxWords), 5) : 1;
      break;
    }
    case "order": {
      const items = asArray(q.items).map((s) => String(s));
      if (items.length < 2 || items.length > 6) throw new Error(`${where}: order needs 2-6 items`);
      q.items = items;
      break;
    }
    case "slide":
      break;
  }
  return q;
}

function requireChoices(q, where) {
  if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 4)
    throw new Error(`${where}: needs 2-4 choices`);
  q.choices = q.choices.map((c) => String(c));
}

function requireIndex(v, len, where) {
  if (!Number.isInteger(v) || v < 0 || v >= len)
    throw new Error(`${where}: answer must be an index into choices`);
}

// ---------- per-game presentation ----------
/** Anything randomised once per game, so every player sees the same thing. */
export function presentation(q) {
  if (q.type !== "order") return null;
  const shown = shuffled(q.items.map((_, i) => i));
  return { shown }; // shown[position] = index into q.items
}

export function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** What the host screen shows while the question is open. */
export function hostView(q, pres) {
  const v = { type: q.type, text: q.text, image: q.image, time: q.time };
  if (q.choices) v.choices = q.choices;
  if (q.type === "slider") Object.assign(v, { min: q.min, max: q.max, step: q.step, unit: q.unit });
  if (q.type === "order") v.items = pres.shown.map((i) => q.items[i]);
  return v;
}

/**
 * What a player's phone shows. Must never leak the answer.
 * With showText the question and its choices are mirrored to the phone, so a
 * player who cannot read the projector still has everything they need.
 */
export function playerView(q, pres, { showText = false } = {}) {
  const v = { type: q.type, time: q.time };
  if (q.choices) v.choices = q.choices.length;
  // choice labels are safe to send: the host screen already shows them
  if (q.type === "truefalse" || q.type === "poll" || q.type === "multi") v.labels = q.choices;
  else if (showText && q.choices) v.labels = q.choices;
  if (showText) {
    v.text = q.text;
    if (q.image) v.image = q.image;
  }
  if (q.type === "slider") Object.assign(v, { min: q.min, max: q.max, step: q.step, unit: q.unit });
  if (q.type === "wordcloud") v.maxWords = q.maxWords;
  if (q.type === "order") v.items = pres.shown.map((i) => q.items[i]);
  return v;
}

// ---------- answers ----------
/** Reject malformed responses before they reach grading. Returns the cleaned value. */
export function parseResponse(q, raw) {
  switch (q.type) {
    case "choice":
    case "truefalse":
    case "poll": {
      if (!Number.isInteger(raw) || raw < 0 || raw >= q.choices.length) throw new Error("Invalid choice");
      return raw;
    }
    case "multi": {
      if (!Array.isArray(raw) || !raw.length) throw new Error("Pick at least one answer");
      const set = [...new Set(raw)];
      for (const i of set) if (!Number.isInteger(i) || i < 0 || i >= q.choices.length) throw new Error("Invalid choice");
      return set.sort((a, b) => a - b);
    }
    case "slider": {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < q.min || n > q.max) throw new Error("Out of range");
      return n;
    }
    case "text": {
      const s = String(raw ?? "").trim().slice(0, 80);
      if (!s) throw new Error("Type an answer");
      return s;
    }
    case "wordcloud": {
      const words = asArray(raw).map((w) => String(w).trim().slice(0, 30)).filter(Boolean).slice(0, q.maxWords);
      if (!words.length) throw new Error("Type at least one word");
      return words;
    }
    case "order": {
      const n = q.items.length;
      if (!Array.isArray(raw) || raw.length !== n) throw new Error("Order every item");
      const seen = new Set(raw);
      if (seen.size !== n) throw new Error("Each item once");
      for (const i of raw) if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error("Invalid order");
      return raw;
    }
    default:
      throw new Error("This question takes no answer");
  }
}

/**
 * Grade one response.
 * ratio is the fraction of full credit, so partial-credit types can award part marks.
 * correct is true only at full credit, and null for types with no right answer.
 */
export function grade(q, response, pres) {
  if (isUnscored(q.type)) return { correct: null, ratio: 0 };
  switch (q.type) {
    case "choice":
    case "truefalse":
      return binary(response === q.answer);
    case "multi": {
      const want = new Set(q.answers);
      let hit = 0, miss = 0;
      for (const i of response) (want.has(i) ? hit++ : miss++);
      const ratio = Math.max(0, (hit - miss) / want.size);
      return { correct: ratio === 1, ratio: Math.min(ratio, 1) };
    }
    case "slider": {
      const tol = q.tolerance || (q.max - q.min) * 0.05;
      const off = Math.abs(response - q.answer);
      if (off <= tol) return binary(true);
      const ratio = Math.max(0, 1 - (off - tol) / Math.max(tol, 1e-9) );
      return { correct: false, ratio: Math.min(ratio, 0.99) };
    }
    case "text": {
      const got = normText(response);
      for (const a of q.accept) {
        const want = normText(a);
        if (!want) continue;
        if (got === want) return binary(true);
        if (q.fuzzy && levenshtein(got, want) <= fuzzTolerance(want)) return binary(true);
      }
      return binary(false);
    }
    case "order": {
      // response[position] = index into the shown order; map back to original items
      const n = q.items.length;
      let right = 0;
      for (let pos = 0; pos < n; pos++) if (pres.shown[response[pos]] === pos) right++;
      return { correct: right === n, ratio: right === n ? 1 : Math.max(0, (right - 1) / n) };
    }
    default:
      return { correct: null, ratio: 0 };
  }
}

const binary = (ok) => ({ correct: ok, ratio: ok ? 1 : 0 });

/** The choice labels a report needs to name a wrong answer. Null when there are none. */
export function choiceLabels(q) {
  if (q.choices) return q.choices;
  if (q.type === "order") return q.items;
  return null;
}

/** The correct answer, in a form the host screen can display. */
export function answerView(q, pres) {
  switch (q.type) {
    case "choice":
    case "truefalse":
      return { index: q.answer, label: q.choices[q.answer] };
    case "multi":
      return { indexes: q.answers, label: q.answers.map((i) => q.choices[i]).join(", ") };
    case "slider":
      return { value: q.answer, label: `${q.answer}${q.unit ? " " + q.unit : ""}` };
    case "text":
      return { accept: q.accept, label: q.accept[0] };
    case "order":
      return { items: q.items, label: q.items.join(" → ") };
    default:
      return null;
  }
}

/** Aggregate every response for the host results screen. */
export function summarize(q, pres, responses) {
  switch (q.type) {
    case "choice":
    case "truefalse":
    case "poll": {
      const counts = q.choices.map(() => 0);
      for (const r of responses) counts[r] += 1;
      return { kind: "counts", counts, labels: q.choices };
    }
    case "multi": {
      const counts = q.choices.map(() => 0);
      for (const r of responses) for (const i of r) counts[i] += 1;
      return { kind: "counts", counts, labels: q.choices };
    }
    case "slider": {
      const vals = [...responses].sort((a, b) => a - b);
      const mean = vals.length ? vals.reduce((t, v) => t + v, 0) / vals.length : null;
      return { kind: "slider", values: vals, mean, min: q.min, max: q.max, unit: q.unit };
    }
    case "text":
    case "wordcloud": {
      const freq = new Map();
      for (const r of responses) {
        for (const w of asArray(r)) {
          const k = normText(w);
          if (!k) continue;
          const cur = freq.get(k) || { text: String(w).trim(), n: 0 };
          cur.n += 1;
          freq.set(k, cur);
        }
      }
      const words = [...freq.values()].sort((a, b) => b.n - a.n).slice(0, 40);
      return { kind: "words", words };
    }
    case "order": {
      const n = q.items.length;
      const perSlot = Array.from({ length: n }, () => 0);
      for (const r of responses) for (let pos = 0; pos < n; pos++) if (pres.shown[r[pos]] === pos) perSlot[pos] += 1;
      return { kind: "order", perSlot, items: q.items };
    }
    default:
      return { kind: "none" };
  }
}
