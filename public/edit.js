// Quiz and class list editor. Everything is edited in the browser and written
// back to the quizzes folder through the API, so no JSON has to be typed by hand.
// Returns any because nearly every caller immediately reaches for .value or
// .checked on an input. Narrowing this means a cast at each of ~26 call sites;
// see docs/typing.md before tightening it.
/** @param {string} id @returns {any} */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const api = (url, opts) => fetch(url, opts).then((r) => r.json());

let quiz = null;      // the quiz being edited
let quizId = null;    // its file name, null until first save
let dirty = false;
let checkTimer = null;

// ---------- question type definitions, mirroring the server ----------
const TYPE_LABEL = {
  choice: "Multiple choice", truefalse: "True or false", multi: "Multiple correct answers",
  slider: "Number guess", text: "Typed answer", order: "Put in order",
  poll: "Poll", wordcloud: "Word cloud", slide: "Content slide",
};
const HAS_CHOICES = new Set(["choice", "multi", "poll"]);
const SCORED = new Set(["choice", "truefalse", "multi", "slider", "text", "order"]);

function blankQuestion(type) {
  const q = { type, text: "", time: 20 };
  if (HAS_CHOICES.has(type)) {
    q.choices = ["", "", "", ""];
    if (type === "multi") q.answers = [0];
    else if (type === "choice") q.answer = 0;
  }
  if (type === "truefalse") q.answer = 0;
  if (type === "slider") Object.assign(q, { min: 0, max: 100, step: 1, answer: 50, tolerance: 5, unit: "" });
  if (type === "text") q.accept = [""];
  if (type === "order") q.items = ["", "", ""];
  if (type === "wordcloud") q.maxWords = 1;
  if (type === "slide") q.time = 0;
  return q;
}

// ---------- routing ----------
function route() {
  const hash = location.hash.slice(1);
  $("listView").hidden = true;
  $("editView").hidden = true;
  $("rosterView").hidden = true;
  if (hash.startsWith("quiz/")) openQuiz(decodeURIComponent(hash.slice(5)));
  else if (hash.startsWith("roster/")) openRoster(decodeURIComponent(hash.slice(7)));
  else if (hash === "new") newQuiz();
  else if (hash === "new-roster") newRoster();
  else showList();
}
window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

// ---------- list ----------
async function showList() {
  $("listView").hidden = false;
  const [quizzes, rosters] = await Promise.all([api("api/quizzes"), api("api/rosters")]);

  const box = $("quizList");
  box.innerHTML = "";
  if (!quizzes.length) box.appendChild(el("p", "muted", "No quizzes yet. Create one, or import questions you already have."));
  for (const q of quizzes) {
    const card = el("div", "card cardrow");
    const main = el("a", "cardmain");
    main.href = `#quiz/${encodeURIComponent(q.id)}`;
    main.append(el("div", "card-title", q.title), el("div", "card-meta", q.error ? q.error : `${q.count} questions · ${q.id}.json`));
    if (q.error) main.querySelector(".card-meta").classList.add("bad");
    const actions = el("div", "row");
    const dup = el("button", null, "Duplicate");
    dup.onclick = () => duplicateQuiz(q.id);
    actions.append(dup);
    if (q.unowned) {
      // Nobody has claimed this one, so it is read-only until somebody does.
      main.append(el("div", "card-meta muted", "Shared · claim it to edit"));
      const claim = el("button", null, "Claim");
      claim.onclick = () => claimThing("quiz", q.id, q.title);
      actions.append(claim);
    } else {
      const del = el("button", null, "Delete");
      del.onclick = () => removeQuiz(q.id, q.title);
      actions.append(del);
    }
    card.append(main, actions);
    box.appendChild(card);
  }

  const rbox = $("rosterList");
  rbox.innerHTML = "";
  if (!rosters.length) rbox.appendChild(el("p", "muted", "No class lists. Add one to restrict who can join and to see who missed a game."));
  for (const r of rosters) {
    const card = el("div", "card cardrow");
    const main = el("a", "cardmain");
    main.href = `#roster/${encodeURIComponent(r.id)}`;
    main.append(el("div", "card-title", r.title), el("div", "card-meta", `${r.count} students · ${r.id}.json`));
    let action;
    if (r.unowned) {
      main.append(el("div", "card-meta muted", "Shared · claim it to edit"));
      action = el("button", null, "Claim");
      action.onclick = () => claimThing("roster", r.id, r.title);
    } else {
      action = el("button", null, "Delete");
      action.onclick = async () => {
        if (!confirm(`Delete the class list "${r.title}"?`)) return;
        await fetch(`api/roster/${encodeURIComponent(r.id)}`, { method: "DELETE" });
        showList();
      };
    }
    card.append(main, action);
    rbox.appendChild(card);
  }
}

async function duplicateQuiz(id) {
  const src = await api(`api/quiz/${encodeURIComponent(id)}`);
  if (src.error) return alert(src.error);
  src.title = `${src.title} (copy)`;
  const newId = await freeId(`${id}-copy`);
  const res = await api(`api/quiz/${encodeURIComponent(newId)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(src),
  });
  if (res.error) return alert(res.error);
  location.hash = `quiz/${encodeURIComponent(newId)}`;
}

async function freeId(base) {
  const taken = new Set((await api("api/quizzes")).map((q) => q.id));
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

async function removeQuiz(id, title) {
  if (!confirm(`Delete "${title}" permanently?`)) return;
  await fetch(`api/quiz/${encodeURIComponent(id)}`, { method: "DELETE" });
  showList();
}

$("newQuizBtn").onclick = () => { location.hash = "new"; };
$("newRosterBtn").onclick = () => { location.hash = "new-roster"; };
$("backLink").onclick = (e) => { e.preventDefault(); if (leaveOk()) location.hash = ""; };
$("rosterBack").onclick = (e) => { e.preventDefault(); if (leaveOk()) location.hash = ""; };
const leaveOk = () => !dirty || confirm("You have unsaved changes. Leave anyway?");

// ---------- quiz editing ----------
function newQuiz() {
  quizId = null;
  quiz = { title: "", questions: [blankQuestion("choice")], phoneText: true };
  dirty = false;
  $("editView").hidden = false;
  $("editHeading").textContent = "New quiz";
  fillQuizFields();
  renderQuestions();
}

async function openQuiz(id) {
  const data = await api(`api/quiz/${encodeURIComponent(id)}`);
  if (data.error) { alert(data.error); location.hash = ""; return; }
  quizId = id;
  quiz = data;
  quiz.questions = (quiz.questions || []).map((q) => ({ type: "choice", ...q }));
  dirty = false;
  $("editView").hidden = false;
  $("editHeading").textContent = "Edit quiz";
  fillQuizFields();
  renderQuestions();
}

function fillQuizFields() {
  $("fTitle").value = quiz.title || "";
  $("fId").value = quizId || "";
  $("fIdentifier").value = quiz.identifier || "";
  $("fShuffleQ").checked = !!quiz.shuffleQuestions;
  $("fShuffleA").checked = !!quiz.shuffleAnswers;
  $("fPhoneText").checked = quiz.phoneText !== false;
}

for (const [id, key] of [["fTitle", "title"], ["fIdentifier", "identifier"]]) {
  $(id).oninput = () => { quiz[key] = $(id).value; touch(); };
}
for (const [id, key] of [["fShuffleQ", "shuffleQuestions"], ["fShuffleA", "shuffleAnswers"], ["fPhoneText", "phoneText"]]) {
  $(id).onchange = () => { quiz[key] = $(id).checked; touch(); };
}
$("fId").oninput = () => touch();

function touch() {
  dirty = true;
  $("saveState").textContent = "Unsaved changes";
  clearTimeout(checkTimer);
  checkTimer = setTimeout(validate, 600);
}

async function validate() {
  const res = await api("api/quiz-check", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(quiz),
  });
  const box = $("problems");
  box.hidden = res.ok;
  if (!res.ok) {
    box.innerHTML = "";
    box.appendChild(el("h3", null, res.problems.length === 1 ? "One thing to fix" : `${res.problems.length} things to fix`));
    const ul = el("ul");
    for (const p of res.problems) ul.appendChild(el("li", null, p));
    box.appendChild(ul);
  }
  return res.ok;
}

$("saveBtn").onclick = async () => {
  const id = $("fId").value.trim() || slug(quiz.title);
  if (!id) return alert("Give the quiz a title or a file name");
  $("fId").value = id;
  const res = await api(`api/quiz/${encodeURIComponent(id)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(quiz),
  });
  if (res.error) {
    await validate();
    $("saveState").textContent = res.error;
    return;
  }
  dirty = false;
  quizId = id;
  $("saveState").textContent = `Saved ${res.count} question${res.count === 1 ? "" : "s"}`;
  $("problems").hidden = true;
  if (location.hash !== `#quiz/${encodeURIComponent(id)}`) history.replaceState(null, "", `#quiz/${encodeURIComponent(id)}`);
};

const slug = (s) => String(s).toLowerCase().trim().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

$("addBtn").onclick = () => {
  quiz.questions.push(blankQuestion($("addType").value));
  touch();
  renderQuestions();
  const cards = document.querySelectorAll(".qcard-edit");
  cards[cards.length - 1]?.scrollIntoView({ behavior: "smooth", block: "center" });
};

// ---------- one card per question ----------
function renderQuestions() {
  const box = $("questions");
  box.innerHTML = "";
  quiz.questions.forEach((q, i) => box.appendChild(questionCard(q, i)));
}

function questionCard(q, i) {
  const card = el("div", "qcard-edit");
  const head = el("div", "qcard-edit-head");
  head.append(el("span", "qnum", String(i + 1)), el("span", "qtype", TYPE_LABEL[q.type] || q.type));

  const tools = el("div", "row");
  const up = el("button", "icon", "↑"); up.title = "Move up"; up.disabled = i === 0;
  up.onclick = () => moveQuestion(i, -1);
  const down = el("button", "icon", "↓"); down.title = "Move down"; down.disabled = i === quiz.questions.length - 1;
  down.onclick = () => moveQuestion(i, 1);
  const copy = el("button", "icon", "⧉"); copy.title = "Duplicate";
  copy.onclick = () => { quiz.questions.splice(i + 1, 0, JSON.parse(JSON.stringify(q))); touch(); renderQuestions(); };
  const del = el("button", "icon", "✕"); del.title = "Delete";
  del.onclick = () => {
    if (quiz.questions.length === 1) return alert("A quiz needs at least one question");
    quiz.questions.splice(i, 1); touch(); renderQuestions();
  };
  tools.append(up, down, copy, del);
  head.appendChild(tools);
  card.appendChild(head);

  card.appendChild(field("Question", textInput(q.text, (v) => { q.text = v; })));
  buildTypeFields(card, q);

  card.appendChild(field("Image file (optional)", textInput(q.image || "", (v) => { q.image = v; }), "A file in quizzes/images/, or a full http address"));
  if (q.type !== "slide") {
    card.appendChild(field("Seconds to answer", numInput(q.time ?? 20, 1, 600, (v) => { q.time = v; })));
  }
  if (SCORED.has(q.type)) {
    card.appendChild(field("Explanation", textInput(q.explanation || "", (v) => { q.explanation = v; }), "Shown to everyone when the answer is revealed"));
  }
  if (["choice", "truefalse", "multi"].includes(q.type)) {
    card.appendChild(checkbox("Worth discussing, then voting again", !!q.discuss, (v) => { q.discuss = v; }));
  }
  return card;
}

function moveQuestion(i, by) {
  const j = i + by;
  if (j < 0 || j >= quiz.questions.length) return;
  [quiz.questions[i], quiz.questions[j]] = [quiz.questions[j], quiz.questions[i]];
  touch();
  renderQuestions();
}

function buildTypeFields(card, q) {
  switch (q.type) {
    case "choice":
    case "multi":
    case "poll": {
      const wrap = el("div", "choices");
      const isMulti = q.type === "multi";
      const hasAnswer = q.type !== "poll";
      q.choices.forEach((c, ci) => {
        const row = el("div", "choicerow");
        if (hasAnswer) {
          const mark = document.createElement("input");
          mark.type = isMulti ? "checkbox" : "radio";
          mark.name = `ans-${q.text}-${quiz.questions.indexOf(q)}`;
          mark.checked = isMulti ? (q.answers || []).includes(ci) : q.answer === ci;
          mark.title = "Correct answer";
          mark.onchange = () => {
            if (isMulti) {
              const set = new Set(q.answers || []);
              mark.checked ? set.add(ci) : set.delete(ci);
              q.answers = [...set].sort((a, b) => a - b);
            } else {
              q.answer = ci;
            }
            touch();
          };
          row.appendChild(mark);
        }
        const input = textInput(c, (v) => { q.choices[ci] = v; });
        input.placeholder = `Choice ${ci + 1}`;
        row.appendChild(input);
        if (q.choices.length > 2) {
          const rm = el("button", "icon", "✕");
          rm.title = "Remove this choice";
          rm.onclick = () => {
            q.choices.splice(ci, 1);
            if (isMulti) q.answers = (q.answers || []).filter((a) => a !== ci).map((a) => (a > ci ? a - 1 : a));
            else if (q.answer === ci) q.answer = 0;
            else if (q.answer > ci) q.answer -= 1;
            touch(); renderQuestions();
          };
          row.appendChild(rm);
        }
        wrap.appendChild(row);
      });
      if (q.choices.length < 4) {
        const add = el("button", "small", "Add choice");
        add.onclick = () => { q.choices.push(""); touch(); renderQuestions(); };
        wrap.appendChild(add);
      }
      card.appendChild(field(hasAnswer ? "Choices, with the correct one marked" : "Choices", wrap));
      break;
    }
    case "truefalse": {
      const wrap = el("div", "row");
      ["True", "False"].forEach((label, ci) => {
        const b = el("button", "toggle" + (q.answer === ci ? " on" : ""), label);
        b.onclick = () => { q.answer = ci; touch(); renderQuestions(); };
        wrap.appendChild(b);
      });
      card.appendChild(field("Correct answer", wrap));
      break;
    }
    case "slider": {
      const grid = el("div", "fieldgrid tight");
      grid.append(
        field("Lowest", numInput(q.min ?? 0, -1e9, 1e9, (v) => { q.min = v; })),
        field("Highest", numInput(q.max ?? 100, -1e9, 1e9, (v) => { q.max = v; })),
        field("Step", numInput(q.step ?? 1, 0.001, 1e6, (v) => { q.step = v; })),
        field("Correct value", numInput(q.answer ?? 0, -1e9, 1e9, (v) => { q.answer = v; })),
        field("Allowed margin", numInput(q.tolerance ?? 0, 0, 1e9, (v) => { q.tolerance = v; }), "Full marks within this much"),
        field("Unit", textInput(q.unit || "", (v) => { q.unit = v; })),
      );
      card.appendChild(grid);
      break;
    }
    case "text": {
      const wrap = el("div", "choices");
      (q.accept || [""]).forEach((a, ai) => {
        const row = el("div", "choicerow");
        const input = textInput(a, (v) => { q.accept[ai] = v; });
        input.placeholder = ai === 0 ? "Accepted answer" : "Also accept";
        row.appendChild(input);
        if (q.accept.length > 1) {
          const rm = el("button", "icon", "✕");
          rm.onclick = () => { q.accept.splice(ai, 1); touch(); renderQuestions(); };
          row.appendChild(rm);
        }
        wrap.appendChild(row);
      });
      const add = el("button", "small", "Accept another spelling");
      add.onclick = () => { q.accept.push(""); touch(); renderQuestions(); };
      wrap.appendChild(add);
      card.appendChild(field("Accepted answers", wrap, "Case, accents and light typos are already forgiven"));
      card.appendChild(checkbox("Forgive typos", q.fuzzy !== false, (v) => { q.fuzzy = v; }));
      break;
    }
    case "order": {
      const wrap = el("div", "choices");
      q.items.forEach((it, ii) => {
        const row = el("div", "choicerow");
        row.appendChild(el("span", "qnum small", String(ii + 1)));
        const input = textInput(it, (v) => { q.items[ii] = v; });
        input.placeholder = `Item ${ii + 1}`;
        row.appendChild(input);
        if (q.items.length > 2) {
          const rm = el("button", "icon", "✕");
          rm.onclick = () => { q.items.splice(ii, 1); touch(); renderQuestions(); };
          row.appendChild(rm);
        }
        wrap.appendChild(row);
      });
      if (q.items.length < 6) {
        const add = el("button", "small", "Add item");
        add.onclick = () => { q.items.push(""); touch(); renderQuestions(); };
        wrap.appendChild(add);
      }
      card.appendChild(field("Items in the correct order", wrap, "Players see them shuffled"));
      break;
    }
    case "wordcloud":
      card.appendChild(field("Words each player may enter", numInput(q.maxWords ?? 1, 1, 5, (v) => { q.maxWords = v; })));
      break;
    case "slide":
      break;
  }
}

// ---------- small form helpers ----------
function field(label, control, hint) {
  const wrap = el("label", "field");
  wrap.appendChild(el("span", "fieldlabel", label));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(el("span", "fieldhint", hint));
  return wrap;
}
function textInput(value, onChange) {
  const i = document.createElement("input");
  i.type = "text";
  i.value = value ?? "";
  i.oninput = () => { onChange(i.value); touch(); };
  return i;
}
function numInput(value, min, max, onChange) {
  const i = document.createElement("input");
  i.type = "number";
  i.value = value;
  i.min = min; i.max = max; i.step = "any";
  i.oninput = () => { onChange(i.value === "" ? "" : Number(i.value)); touch(); };
  return i;
}
function checkbox(label, checked, onChange) {
  const wrap = el("label", "check");
  const i = document.createElement("input");
  i.type = "checkbox";
  i.checked = checked;
  i.onchange = () => { onChange(i.checked); touch(); };
  wrap.append(i, document.createTextNode(" " + label));
  return wrap;
}

// ---------- class lists ----------
function newRoster() {
  $("rosterView").hidden = false;
  $("rTitle").value = "";
  $("rId").value = "";
  $("rStudents").value = "";
  $("rosterState").textContent = "";
}
async function openRoster(id) {
  const data = await api(`api/roster/${encodeURIComponent(id)}`);
  if (data.error) { alert(data.error); location.hash = ""; return; }
  $("rosterView").hidden = false;
  $("rTitle").value = data.title || id;
  $("rId").value = id;
  const list = Array.isArray(data) ? data : data.students || [];
  $("rStudents").value = list
    .map((s) => (typeof s === "string" ? s : s.id ? `${s.name}, ${s.id}` : s.name))
    .join("\n");
  $("rosterState").textContent = "";
}
$("rosterSaveBtn").onclick = async () => {
  const id = $("rId").value.trim() || slug($("rTitle").value);
  if (!id) return alert("Give the class a name or a file name");
  const students = $("rStudents").value.split("\n").map((line) => {
    const [name, sid] = line.split(",");
    return { name: (name || "").trim(), id: (sid || "").trim() };
  }).filter((s) => s.name);
  const res = await api(`api/roster/${encodeURIComponent(id)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: $("rTitle").value.trim() || id, students }),
  });
  $("rosterState").textContent = res.error || `Saved ${res.count} students`;
  if (!res.error) $("rId").value = id;
};

// ---------- import ----------
const TEXT_HELP = `Which planet is red?
- Venus
* Mars
- Jupiter

T/F The Pacific is the largest ocean.
* True

Blank lines separate questions. * marks correct.`;
const CSV_HELP = `question,choice1,choice2,choice3,choice4,answer,time,explanation
Which planet is red?,Venus,Mars,Jupiter,Mercury,2,20,Mars looks rusty

answer is the number of the correct choice, counting from 1.`;

let importFormat = "text";
function setFormat(f) {
  importFormat = f;
  $("fmtText").classList.toggle("active", f === "text");
  $("fmtCsv").classList.toggle("active", f === "csv");
  $("fmtHelp").textContent = f === "text" ? TEXT_HELP : CSV_HELP;
  previewImport();
}
$("fmtText").onclick = () => setFormat("text");
$("fmtCsv").onclick = () => setFormat("csv");
$("importText").oninput = previewImport;

function openImport() {
  if (!quiz) { newQuiz(); location.hash = "new"; }
  $("importModal").hidden = false;
  $("importText").value = "";
  setFormat("text");
  $("importText").focus();
}
$("importBtn").onclick = openImport;
$("importInlineBtn").onclick = openImport;
$("cancelImport").onclick = () => { $("importModal").hidden = true; };

function previewImport() {
  const parsed = parseImport($("importText").value, importFormat);
  $("importPreview").textContent = parsed.length
    ? `${parsed.length} question${parsed.length === 1 ? "" : "s"} recognised`
    : "Nothing recognised yet";
  $("doImport").disabled = !parsed.length;
}

$("doImport").onclick = () => {
  const parsed = parseImport($("importText").value, importFormat);
  if (!parsed.length) return;
  // a brand new quiz starts with one empty placeholder; drop it
  if (quiz.questions.length === 1 && !quiz.questions[0].text) quiz.questions = [];
  quiz.questions.push(...parsed);
  $("importModal").hidden = true;
  touch();
  renderQuestions();
};

/** Turn pasted text or CSV into questions. Unrecognisable blocks are skipped. */
function parseImport(raw, format) {
  if (!raw.trim()) return [];
  return format === "csv" ? parseCsv(raw) : parseText(raw);
}

function parseText(raw) {
  const out = [];
  for (const block of raw.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let text = lines[0];
    const options = lines.slice(1).filter((l) => /^[-*]\s*/.test(l));
    if (!options.length) continue;
    const trueFalse = /^t\/f[:\s]/i.test(text);
    if (trueFalse) text = text.replace(/^t\/f[:\s]\s*/i, "");
    const choices = options.map((l) => l.replace(/^[-*]\s*/, "").trim());
    const correct = options.map((l, i) => (l.startsWith("*") ? i : -1)).filter((i) => i >= 0);
    if (!correct.length) continue;
    if (trueFalse || (choices.length === 2 && choices.every((c) => /^(true|false)$/i.test(c)))) {
      const trueIdx = choices.findIndex((c) => /^true$/i.test(c));
      out.push({ type: "truefalse", text, answer: correct[0] === trueIdx ? 0 : 1, time: 20 });
    } else if (correct.length > 1) {
      out.push({ type: "multi", text, choices, answers: correct, time: 20 });
    } else {
      out.push({ type: "choice", text, choices, answer: correct[0], time: 20 });
    }
  }
  return out;
}

function parseCsv(raw) {
  const rows = csvRows(raw).filter((r) => r.some((c) => c.trim()));
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const looksLikeHeader = head.includes("question");
  const body = looksLikeHeader ? rows.slice(1) : rows;
  const col = (name) => head.indexOf(name);
  const out = [];
  for (const r of body) {
    const text = (looksLikeHeader ? r[col("question")] : r[0])?.trim();
    if (!text) continue;
    const choices = looksLikeHeader
      ? ["choice1", "choice2", "choice3", "choice4"].map((c) => r[col(c)]).filter((v) => v && v.trim()).map((v) => v.trim())
      : r.slice(1, 5).filter((v) => v && v.trim()).map((v) => v.trim());
    if (choices.length < 2) continue;
    const answerRaw = looksLikeHeader ? r[col("answer")] : r[5];
    const answer = Math.max(0, (Number(answerRaw) || 1) - 1);
    const q = { type: "choice", text, choices, answer: Math.min(answer, choices.length - 1), time: 20 };
    const t = looksLikeHeader ? Number(r[col("time")]) : Number(r[6]);
    if (t > 0) q.time = t;
    const ex = looksLikeHeader ? r[col("explanation")] : r[7];
    if (ex && ex.trim()) q.explanation = ex.trim();
    out.push(q);
  }
  return out;
}

/** Minimal CSV reader that understands quoted fields containing commas. */
function csvRows(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

route();

/**
 * Take over a quiz or class list nobody owns. Until then it is visible to every
 * instructor and editable by none, which is what stops two people quietly
 * overwriting the same file.
 */
async function claimThing(kind, id, title) {
  if (!confirm(`Claim "${title}"? It becomes yours to edit, and other instructors stop seeing it.`)) return;
  const res = await api(`api/${kind}/${encodeURIComponent(id)}/claim`, { method: "POST" });
  if (res.error) return alert(res.error);
  showList();
}

/** Name whoever is signed in, so it is obvious whose quizzes these are. */
async function showWhoAmI() {
  let me;
  try {
    me = await api("api/me");
  } catch {
    return; // an older server without /api/me; the page still works
  }
  if (!me.authRequired) return;
  const bar = document.getElementById("whoami");
  if (!bar) return;
  bar.textContent = me.user ? `Signed in as ${me.user.name || me.user.eppn}` : "Not signed in";
  bar.hidden = false;
}
showWhoAmI();
