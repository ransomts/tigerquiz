// Question type definitions: validation, presentation and grading.
// Every question is normalized to one internal shape by normalizeQuestion(),
// then graded by grade(). Adding a type means touching this file, the two
// renderers in public/ (play.js and host.js), the editor, and the field
// whitelist in content.js that decides what the editor may save.

export const TYPES = [
  "choice", "truefalse", "multi", "poll", "slider", "numeric", "text", "blank",
  "wordcloud", "order", "match", "hotspot", "longtext", "file", "slide",
];

/** Types that do not produce a score: no points, no streak effect, no correct answer. */
const UNSCORED = new Set(["poll", "wordcloud", "longtext", "file", "slide"]);
/** Unscored types a teacher can mark by hand afterwards, which makes them count. */
export const GRADABLE = new Set(["longtext", "file"]);
/** The point multipliers a question may carry. */
export const WEIGHTS = [0, 0.5, 1, 2];
/** What a file question will take from a phone, by MIME type prefix. */
export const FILE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "application/pdf"];
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

/** Does a typed answer match any accepted spelling, with the usual forgiveness? */
export function matchesAccept(response, accept, fuzzy) {
  const got = normText(response);
  if (!got) return false;
  for (const a of accept) {
    const want = normText(a);
    if (!want) continue;
    if (got === want) return true;
    if (fuzzy && levenshtein(got, want) <= fuzzTolerance(want)) return true;
  }
  return false;
}

/**
 * Work out what a media reference is. Returns null for nothing usable.
 * YouTube links become embeds, with any start time kept; anything else is
 * played directly, as video or audio by its extension.
 */
export function parseMedia(raw) {
  const src = typeof raw === "string" ? raw.trim() : raw && typeof raw === "object" ? String(raw.src ?? "").trim() : "";
  if (!src) return null;
  const start = raw && typeof raw === "object" && Number(raw.start) > 0 ? Math.floor(Number(raw.start)) : 0;
  const yt = src.match(/^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})(?:[?&#].*)?$/);
  if (yt) {
    const t = src.match(/[?&#](?:t|start)=(\d+)/);
    return { kind: "youtube", id: yt[1], start: t ? Number(t[1]) : start };
  }
  const ext = (src.split(/[?#]/)[0].match(/\.(\w+)$/) || [])[1]?.toLowerCase();
  const kind = ["mp3", "m4a", "ogg", "oga", "wav", "aac", "flac"].includes(ext) ? "audio"
    : ["mp4", "webm", "m4v", "mov", "ogv"].includes(ext) ? "video" : null;
  if (!kind) return null;
  const url = /^https?:\/\//.test(src) ? src : `/quiz-media/${encodeURIComponent(src.replace(/^.*[\\/]/, ""))}`;
  return { kind, src: url, start };
}

/** A fill-in-the-blank question marks each gap with three or more underscores. */
export const BLANK_MARK = /_{3,}/;
export const blankParts = (text) => String(text ?? "").split(BLANK_MARK);

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
  // double points, half points, or none: a multiplier on what a right answer earns
  q.weight = WEIGHTS.includes(Number(q.weight)) ? Number(q.weight) : 1;
  // answers recorded without a name; only meaningful where there is no right answer
  q.anonymous = q.anonymous === true && UNSCORED.has(q.type) && q.type !== "slide";
  // position in the quiz file, kept through shuffling so reviews can find it again
  q.sourceIndex = i;

  // image: a filename under quizzes/images/, or an absolute http(s) URL
  if (typeof q.image === "string" && q.image.trim()) {
    const img = q.image.trim();
    q.image = /^https?:\/\//.test(img) ? img : `/quiz-images/${encodeURIComponent(img.replace(/^.*[\\/]/, ""))}`;
  } else {
    delete q.image;
  }
  // video or audio: a YouTube link, a direct media URL, or a file under quizzes/media/
  const media = parseMedia(q.media);
  if (media) q.media = media; else delete q.media;

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
    case "numeric": {
      q.answer = Number(q.answer);
      if (!Number.isFinite(q.answer)) throw new Error(`${where}: numeric needs a numeric answer`);
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
    case "blank": {
      const gaps = blankParts(q.text).length - 1;
      if (gaps < 1) throw new Error(`${where}: mark each blank with ___ in the question text`);
      if (gaps > 5) throw new Error(`${where}: at most 5 blanks`);
      // one list of accepted spellings per blank, in reading order
      const blanks = asArray(q.blanks).map((b) => asArray(b).map((s) => String(s).trim()).filter(Boolean));
      if (blanks.length !== gaps) throw new Error(`${where}: ${gaps} blank${gaps === 1 ? "" : "s"} in the text but ${blanks.length} answer${blanks.length === 1 ? "" : "s"} given`);
      if (blanks.some((b) => !b.length)) throw new Error(`${where}: every blank needs an answer`);
      q.blanks = blanks;
      q.fuzzy = q.fuzzy !== false;
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
    case "match": {
      const pairs = asArray(q.pairs).map((p) =>
        Array.isArray(p) ? { left: String(p[0] ?? ""), right: String(p[1] ?? "") }
          : { left: String(p?.left ?? ""), right: String(p?.right ?? "") });
      if (pairs.length < 2 || pairs.length > 6) throw new Error(`${where}: match needs 2-6 pairs`);
      if (pairs.some((p) => !p.left.trim() || !p.right.trim())) throw new Error(`${where}: every pair needs both halves`);
      q.pairs = pairs;
      break;
    }
    case "hotspot": {
      if (!q.image) throw new Error(`${where}: hotspot needs an image`);
      const t = q.target && typeof q.target === "object" ? q.target : {};
      // the target is a rectangle in fractions of the image, so it survives any screen size
      const target = { x: Number(t.x), y: Number(t.y), w: Number(t.w), h: Number(t.h) };
      for (const k of ["x", "y", "w", "h"]) {
        if (!Number.isFinite(target[k]) || target[k] < 0 || target[k] > 1)
          throw new Error(`${where}: hotspot target ${k} must be between 0 and 1`);
      }
      if (!(target.w > 0 && target.h > 0)) throw new Error(`${where}: hotspot target has no size`);
      target.w = Math.min(target.w, 1 - target.x);
      target.h = Math.min(target.h, 1 - target.y);
      q.target = target;
      break;
    }
    case "longtext":
      q.maxLength = Number(q.maxLength) > 0 ? Math.min(Number(q.maxLength), 2000) : 500;
      break;
    case "file":
      // what the phone's file picker offers: pictures (usually the camera), or documents too
      q.accept = q.accept === "image" ? "image" : "any";
      if (!(Number(q.time) > 0) || Number(q.time) < 60) q.time = Math.max(q.time || 0, 120);
      break;
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
  // shown[position] = index into q.items, or into q.pairs for the right-hand column
  if (q.type === "order") return { shown: shuffled(q.items.map((_, i) => i)) };
  if (q.type === "match") return { shown: shuffled(q.pairs.map((_, i) => i)) };
  return null;
}

/** The two columns of a matching question as the room sees them: lefts in order, rights shuffled. */
function matchColumns(q, pres) {
  return { lefts: q.pairs.map((p) => p.left), rights: pres.shown.map((i) => q.pairs[i].right) };
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
  const v = { type: q.type, text: q.text, image: q.image, media: q.media, time: q.time, weight: q.weight, anonymous: q.anonymous };
  if (q.type === "file") v.accept = q.accept;
  if (q.choices) v.choices = q.choices;
  if (q.type === "slider") Object.assign(v, { min: q.min, max: q.max, step: q.step, unit: q.unit });
  if (q.type === "numeric") v.unit = q.unit;
  if (q.type === "blank") v.blanks = q.blanks.length;
  if (q.type === "order") v.items = pres.shown.map((i) => q.items[i]);
  if (q.type === "match") Object.assign(v, matchColumns(q, pres));
  return v;
}

/**
 * What a player's phone shows. Must never leak the answer.
 * With showText the question and its choices are mirrored to the phone, so a
 * player who cannot read the projector still has everything they need.
 */
export function playerView(q, pres, { showText = false } = {}) {
  const v = { type: q.type, time: q.time, weight: q.weight, anonymous: q.anonymous };
  // the clip plays on the host screen; the phone is only told there is one
  if (q.media) v.media = { kind: q.media.kind };
  if (q.type === "file") v.accept = q.accept;
  if (q.choices) v.choices = q.choices.length;
  // choice labels are safe to send: the host screen already shows them
  if (q.type === "truefalse" || q.type === "poll" || q.type === "multi") v.labels = q.choices;
  else if (showText && q.choices) v.labels = q.choices;
  if (showText) {
    v.text = q.text;
    if (q.image) v.image = q.image;
  }
  if (q.type === "slider") Object.assign(v, { min: q.min, max: q.max, step: q.step, unit: q.unit });
  if (q.type === "numeric") v.unit = q.unit;
  if (q.type === "wordcloud") v.maxWords = q.maxWords;
  if (q.type === "longtext") v.maxLength = q.maxLength;
  if (q.type === "order") v.items = pres.shown.map((i) => q.items[i]);
  // the two columns are the question itself, so they go to every phone
  if (q.type === "match") Object.assign(v, matchColumns(q, pres));
  if (q.type === "blank") {
    v.blanks = q.blanks.length;
    // the sentence with its gaps, so the inputs can sit inline where the words go
    if (showText) v.parts = blankParts(q.text);
  }
  // the picture is what gets tapped, so it goes to the phone whether or not the text does
  if (q.type === "hotspot") v.image = q.image;
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
    case "numeric": {
      const n = typeof raw === "string" ? Number(raw.trim().replace(/,/g, "")) : Number(raw);
      if (raw === "" || raw == null || !Number.isFinite(n)) throw new Error("Type a number");
      return n;
    }
    case "text": {
      const s = String(raw ?? "").trim().slice(0, 80);
      if (!s) throw new Error("Type an answer");
      return s;
    }
    case "blank": {
      const n = q.blanks.length;
      if (!Array.isArray(raw) || raw.length !== n) throw new Error("Fill in the blanks");
      const parts = raw.map((s) => String(s ?? "").trim().slice(0, 60));
      if (!parts.some(Boolean)) throw new Error("Fill in at least one blank");
      return parts;
    }
    case "longtext": {
      const s = String(raw ?? "").trim().slice(0, q.maxLength);
      if (!s) throw new Error("Write an answer");
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
    case "match": {
      // response[leftIndex] = position in the shuffled right-hand column
      const n = q.pairs.length;
      if (!Array.isArray(raw) || raw.length !== n) throw new Error("Match every item");
      if (new Set(raw).size !== n) throw new Error("Each item once");
      for (const i of raw) if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error("Invalid match");
      return raw;
    }
    case "hotspot": {
      const x = Number(raw?.x), y = Number(raw?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw new Error("Tap the picture");
      return { x, y };
    }
    case "file": {
      // the upload itself went over HTTP; the answer is the id it came back with,
      // and the room checks that id really belongs to this player
      const id = String(raw?.file ?? "").trim();
      if (!/^[\w-]{8,64}$/.test(id)) throw new Error("Upload a file first");
      return { file: id, name: String(raw?.name ?? "").slice(0, 80), type: String(raw?.type ?? "").slice(0, 60) };
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
    case "numeric":
      return binary(Math.abs(response - q.answer) <= q.tolerance + 1e-9);
    case "text":
      return binary(matchesAccept(response, q.accept, q.fuzzy));
    case "blank": {
      const n = q.blanks.length;
      const right = q.blanks.filter((accept, i) => matchesAccept(response[i], accept, q.fuzzy)).length;
      return { correct: right === n, ratio: right / n };
    }
    case "hotspot": {
      const t = q.target;
      const inside = response.x >= t.x && response.x <= t.x + t.w && response.y >= t.y && response.y <= t.y + t.h;
      return binary(inside);
    }
    case "order": {
      // response[position] = index into the shown order; map back to original items
      const n = q.items.length;
      let right = 0;
      for (let pos = 0; pos < n; pos++) if (pres.shown[response[pos]] === pos) right++;
      return { correct: right === n, ratio: right === n ? 1 : Math.max(0, (right - 1) / n) };
    }
    case "match": {
      // like order: one lucky pair is not knowledge, so credit starts at two
      const n = q.pairs.length;
      const right = matchedRight(q, pres, response);
      return { correct: right === n, ratio: right === n ? 1 : Math.max(0, (right - 1) / n) };
    }
    default:
      return { correct: null, ratio: 0 };
  }
}

const binary = (ok) => ({ correct: ok, ratio: ok ? 1 : 0 });

/** How many pairs a matching response got right. */
function matchedRight(q, pres, response) {
  let right = 0;
  for (let i = 0; i < q.pairs.length; i++) if (pres.shown[response[i]] === i) right++;
  return right;
}

/** The choice labels a report needs to name a wrong answer. Null when there are none. */
export function choiceLabels(q) {
  if (q.choices) return q.choices;
  if (q.type === "order") return q.items;
  return null;
}

/**
 * The correct answer, in a form the host screen can display.
 *
 * Takes no presentation, unlike its neighbours here: prepareQuiz() shuffles
 * choices and remaps q.answer before a game starts, so q is already in the
 * order the host is showing. Order questions reveal q.items, which is the
 * correct sequence and independent of the shuffled prompt.
 */
export function answerView(q) {
  switch (q.type) {
    case "choice":
    case "truefalse":
      return { index: q.answer, label: q.choices[q.answer] };
    case "multi":
      return { indexes: q.answers, label: q.answers.map((i) => q.choices[i]).join(", ") };
    case "slider":
    case "numeric":
      return { value: q.answer, label: `${q.answer}${q.unit ? " " + q.unit : ""}` };
    case "text":
      return { accept: q.accept, label: q.accept[0] };
    case "blank":
      return { blanks: q.blanks.map((b) => b[0]), label: q.blanks.map((b) => b[0]).join(" / ") };
    case "order":
      return { items: q.items, label: q.items.join(" → ") };
    case "match":
      return { pairs: q.pairs, label: q.pairs.map((p) => `${p.left} → ${p.right}`).join(", ") };
    case "hotspot":
      return { target: q.target, label: "the highlighted area" };
    default:
      return null;
  }
}

/**
 * How a player's own answer should read back to them, mirroring answerView.
 * Order responses index into the shuffled list the player was shown, so they
 * have to be mapped back through the presentation to name the right items.
 */
export function responseLabel(q, response, pres) {
  if (response == null) return null;
  switch (q.type) {
    case "choice":
    case "truefalse":
    case "poll":
      return q.choices?.[response] ?? null;
    case "multi":
      return response.length ? response.map((i) => q.choices[i]).join(", ") : null;
    case "slider":
    case "numeric":
      return `${response}${q.unit ? " " + q.unit : ""}`;
    case "text":
    case "longtext":
      return String(response);
    case "file":
      return response?.name || "your file";
    case "blank":
      return response.map((s) => s || "\u2014").join(" / ");
    case "order":
      return response.map((shown) => q.items[pres.shown[shown]]).join(" \u2192 ");
    case "match":
      return response.map((shown, i) => `${q.pairs[i].left} \u2192 ${q.pairs[pres.shown[shown]].right}`).join(", ");
    case "wordcloud":
      return Array.isArray(response) ? response.join(", ") : String(response);
    // a tapped point means nothing without the picture, which the phone no longer shows
    case "hotspot":
      return null;
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
    case "numeric": {
      const vals = [...responses].sort((a, b) => a - b);
      const mean = vals.length ? vals.reduce((t, v) => t + v, 0) / vals.length : null;
      const freq = new Map();
      for (const v of vals) freq.set(v, (freq.get(v) || 0) + 1);
      const buckets = [...freq.entries()]
        .map(([value, n]) => ({ value, n, correct: Math.abs(value - q.answer) <= q.tolerance + 1e-9 }))
        .sort((a, b) => b.n - a.n || a.value - b.value)
        .slice(0, 8);
      return { kind: "numbers", buckets, mean, count: vals.length, unit: q.unit };
    }
    case "blank": {
      // per blank: how many got it, and what the room wrote instead
      const blanks = q.blanks.map((accept, i) => {
        const freq = new Map();
        let right = 0;
        for (const r of responses) {
          const w = r[i];
          if (matchesAccept(w, accept, q.fuzzy)) { right++; continue; }
          const k = normText(w);
          if (!k) continue;
          const cur = freq.get(k) || { text: String(w).trim(), n: 0 };
          cur.n += 1;
          freq.set(k, cur);
        }
        const wrong = [...freq.values()].sort((a, b) => b.n - a.n).slice(0, 3);
        return { answer: accept[0], right, wrong };
      });
      return { kind: "blanks", parts: blankParts(q.text), blanks, count: responses.length };
    }
    case "longtext":
      return { kind: "texts", texts: responses.map((r) => String(r)).slice(0, 60) };
    case "file":
      return { kind: "files", files: responses.map((r) => ({ file: r.file, name: r.name, type: r.type })) };
    case "order": {
      const n = q.items.length;
      const perSlot = Array.from({ length: n }, () => 0);
      for (const r of responses) for (let pos = 0; pos < n; pos++) if (pres.shown[r[pos]] === pos) perSlot[pos] += 1;
      return { kind: "order", perSlot, items: q.items };
    }
    case "match": {
      const perPair = q.pairs.map(() => 0);
      for (const r of responses) for (let i = 0; i < q.pairs.length; i++) if (pres.shown[r[i]] === i) perPair[i] += 1;
      return { kind: "match", perPair, pairs: q.pairs, count: responses.length };
    }
    case "hotspot": {
      const t = q.target;
      const points = responses.map((p) => ({
        x: p.x, y: p.y,
        correct: p.x >= t.x && p.x <= t.x + t.w && p.y >= t.y && p.y <= t.y + t.h,
      }));
      return { kind: "hotspot", image: q.image, target: t, points };
    }
    default:
      return { kind: "none" };
  }
}
