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
let saveTimer = null;
let saving = false;
// One snapshot per destructive action, so "Undo delete" can always go back.
let undoSnapshot = null;
// Which questions are expanded, held by object reference so moving or deleting
// one does not shuffle the open state onto a different question.
let openQuestions = new Set();

// ---------- question type definitions, mirroring the server ----------
const TYPE_LABEL = {
  choice: "Multiple choice", truefalse: "True or false", multi: "Multiple correct answers",
  slider: "Number guess", text: "Typed answer", order: "Put in order",
  poll: "Poll", wordcloud: "Word cloud", slide: "Content slide",
};

/**
 * What each type is, in words rather than jargon, for the picker. Nine names in
 * a dropdown asked people to know all nine before seeing any of them; this says
 * what each one does and what it looks like.
 */
const TYPES_HELP = [
  { type: "choice", icon: "\u25b2", blurb: "Players pick one answer from up to four.", eg: "Which planet is red?" },
  { type: "truefalse", icon: "\u2713", blurb: "Just two options: true or false.", eg: "The Pacific is the largest ocean." },
  { type: "multi", icon: "\u25c6", blurb: "More than one answer is right. Partial credit for getting some.", eg: "Which of these are mammals?" },
  { type: "text", icon: "\u270e", blurb: "Players type an answer. Spelling slips are forgiven.", eg: "What is the capital of France?" },
  { type: "slider", icon: "\u2194", blurb: "Players guess a number on a slider. Close counts.", eg: "How tall is Everest, in metres?" },
  { type: "order", icon: "\u2263", blurb: "Players drag items into the right order.", eg: "Put these events in order." },
  { type: "poll", icon: "\u25cf", blurb: "No right answer \u2014 just see what the room thinks.", eg: "Which topic should we cover next?" },
  { type: "wordcloud", icon: "\u2601", blurb: "Everyone types a word, and the common ones grow larger.", eg: "One word for how today felt." },
  { type: "slide", icon: "\u25a0", blurb: "Not a question. A slide to talk over, with no timer.", eg: "Recap: three things to remember" },
];
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
/**
 * Leaving the quiz editor saves rather than asking. The only time it asks is
 * when the quiz cannot be saved because something in it is unfinished, which is
 * a real choice rather than a nag.
 */
async function leaveEditor() {
  if (!dirty) return true;
  clearTimeout(saveTimer);
  await save();
  if (!dirty) return true;
  return confirm("This quiz cannot be saved yet because something still needs fixing.\n\nLeave anyway and lose the last changes?");
}
$("backLink").onclick = async (e) => { e.preventDefault(); if (await leaveEditor()) location.hash = ""; };
// The class list still has an explicit Save button, so it still asks.
$("rosterBack").onclick = (e) => { e.preventDefault(); if (leaveOk()) location.hash = ""; };
const leaveOk = () => !dirty || confirm("You have unsaved changes. Leave anyway?");

// ---------- quiz editing ----------
function newQuiz() {
  quizId = null;
  quiz = { title: "", questions: [blankQuestion("choice")], phoneText: true };
  dirty = false;
  $("editView").hidden = false;
  $("editHeading").textContent = "New quiz";
  undoSnapshot = null;
  $("undoBtn").hidden = true;
  setSaveState("unsaved", "Give the quiz a title and it will save itself");
  resetOpenQuestions();
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
  undoSnapshot = null;
  $("undoBtn").hidden = true;
  setSaveState("saved", "All changes saved");
  resetOpenQuestions();
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

/**
 * Something changed. Saving happens on its own a moment later, so the only job
 * here is to say so and start the clock. Nothing asks the user to remember to
 * save, and nothing is lost by walking away from the page.
 */
function touch() {
  dirty = true;
  setSaveState("unsaved", "Not saved yet");
  clearTimeout(checkTimer);
  checkTimer = setTimeout(validate, 600);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1200);
}

/** The one line that says whether the work is safe. */
function setSaveState(kind, text) {
  const bar = $("saveBar");
  if (bar) bar.className = `savebar ${kind}`;
  $("saveState").textContent = text;
}

const justNow = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

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

/**
 * Save, quietly, on a timer. A half-finished quiz will not pass validation, and
 * that is fine: it is reported as something to fix rather than as an error, and
 * the next keystroke tries again.
 */
async function save() {
  if (saving || !dirty) return;
  const id = $("fId").value.trim() || slug(quiz.title);
  if (!id) {
    setSaveState("unsaved", "Give the quiz a title and it will save itself");
    return;
  }
  saving = true;
  setSaveState("saving", "Saving\u2026");
  try {
    const res = await api(`api/quiz/${encodeURIComponent(id)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(quiz),
    });
    if (res.error) {
      await validate();
      // A quiz that is not finished yet is not a failure worth alarming anyone
      // about; anything else is.
      setSaveState("unsaved", res.problems?.length ? "Not saved \u2014 see what needs fixing below" : res.error);
      return;
    }
    dirty = false;
    quizId = id;
    $("fId").value = id;
    setSaveState("saved", `All changes saved \u00b7 ${justNow()}`);
    $("problems").hidden = true;
    if (location.hash !== `#quiz/${encodeURIComponent(id)}`) history.replaceState(null, "", `#quiz/${encodeURIComponent(id)}`);
  } catch {
    setSaveState("unsaved", "Could not reach the server. Your work is still on screen.");
  } finally {
    saving = false;
  }
}

// Leaving the page saves rather than nagging. The beforeunload warning stays as
// a last resort for the case where this does not get the chance to finish.
window.addEventListener("pagehide", () => { if (dirty) save(); });

const slug = (s) => String(s).toLowerCase().trim().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

$("addBtn").onclick = () => {
  pickType("What kind of question?", (type) => {
    const q = blankQuestion(type);
    quiz.questions.push(q);
    openQuestions.add(q); // you just made it, so you want to fill it in
    touch();
    renderQuestions();
    const cards = document.querySelectorAll(".qcard-edit");
    cards[cards.length - 1]?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
};

/**
 * Show the nine kinds of question as cards with an example, and call back with
 * whichever one is chosen.
 */
function pickType(title, onPick) {
  $("typeModalTitle").textContent = title;
  const grid = $("typeGrid");
  grid.innerHTML = "";
  for (const t of TYPES_HELP) {
    const card = el("button", "typecard");
    card.append(
      el("span", "typeicon", t.icon),
      el("span", "typename", TYPE_LABEL[t.type]),
      el("span", "typeblurb", t.blurb),
      el("span", "typeeg", `e.g. \u201c${t.eg}\u201d`),
    );
    card.onclick = () => { closeType(); onPick(t.type); };
    grid.appendChild(card);
  }
  $("typeModal").hidden = false;
}

const closeType = () => { $("typeModal").hidden = true; };
$("cancelType").onclick = closeType;

/**
 * Change an existing question's type without losing the wording. Anything the
 * new type cannot use is dropped, which is why it asks first.
 */
function changeType(q, i) {
  pickType("Change this question to\u2026", (type) => {
    if (type === q.type) return;
    const text = q.text;
    const time = q.time;
    const explanation = q.explanation;
    const fresh = blankQuestion(type);
    // Keep what carries over; a new type gets fresh answers.
    if (HAS_CHOICES.has(type) && HAS_CHOICES.has(q.type) && Array.isArray(q.choices) && q.choices.length >= 2) {
      fresh.choices = [...q.choices];
      if (type === "choice") fresh.answer = 0;
      if (type === "multi") fresh.answers = [0];
    }
    Object.assign(fresh, { text, time, explanation });
    snapshot();
    openQuestions.delete(quiz.questions[i]);
    openQuestions.add(fresh);
    quiz.questions[i] = fresh;
    touch();
    renderQuestions();
  });
}

// ---------- one card per question ----------
function renderQuestions() {
  const box = $("questions");
  box.innerHTML = "";

  if (quiz.questions.length > 1) {
    const bar = el("div", "qlist-tools");
    const allOpen = quiz.questions.every((q) => openQuestions.has(q));
    const toggle = el("button", "small", allOpen ? "Collapse all" : "Expand all");
    toggle.onclick = () => {
      if (allOpen) openQuestions.clear();
      else for (const q of quiz.questions) openQuestions.add(q);
      renderQuestions();
    };
    bar.append(el("span", "muted small", `${quiz.questions.length} questions`), toggle);
    box.appendChild(bar);
  }

  quiz.questions.forEach((q, i) => box.appendChild(questionCard(q, i)));
}

/**
 * A short quiz opens with everything visible; a long one would be a wall of
 * boxes, so it opens collapsed with the wording of each question showing.
 */
function resetOpenQuestions() {
  openQuestions = new Set(quiz.questions.length <= 5 ? quiz.questions : []);
}

/** Remember the whole quiz before something destructive, so Undo can restore it. */
function snapshot() {
  undoSnapshot = JSON.parse(JSON.stringify(quiz));
  const btn = $("undoBtn");
  if (btn) btn.hidden = false;
}

function undo() {
  if (!undoSnapshot) return;
  quiz = undoSnapshot;
  undoSnapshot = null;
  $("undoBtn").hidden = true;
  resetOpenQuestions();
  fillQuizFields();
  touch();
  renderQuestions();
}

function questionCard(q, i) {
  // A real <details>, so collapsing works from the keyboard and the browser
  // handles the open state rather than a class of our own.
  const card = el("details", "qcard-edit");
  card.open = openQuestions.has(q);
  card.addEventListener("toggle", () => {
    if (card.open) openQuestions.add(q);
    else openQuestions.delete(q);
  });

  const head = document.createElement("summary");
  head.className = "qcard-edit-head";
  head.append(el("span", "qnum", String(i + 1)), el("span", "qtype", TYPE_LABEL[q.type] || q.type));
  // Enough of the wording to find the right question while it is shut.
  const peek = (q.text || "").trim();
  head.append(el("span", "qpeek", peek || "(no question yet)"));
  card.appendChild(head);

  const body = el("div", "qcard-body");
  card.appendChild(body);

  body.appendChild(field("Question", textInput(q.text, (v) => { q.text = v; })));
  buildTypeFields(body, q);

  body.appendChild(field("Image file (optional)", textInput(q.image || "", (v) => { q.image = v; }), "A file in quizzes/images/, or a full http address"));
  if (q.type !== "slide") {
    body.appendChild(field("Seconds to answer", numInput(q.time ?? 20, 1, 600, (v) => { q.time = v; })));
  }
  if (SCORED.has(q.type)) {
    body.appendChild(field("Explanation", textInput(q.explanation || "", (v) => { q.explanation = v; }), "Shown to everyone when the answer is revealed"));
  }
  if (["choice", "truefalse", "multi"].includes(q.type)) {
    body.appendChild(checkbox("Worth discussing, then voting again", !!q.discuss, (v) => { q.discuss = v; }));
  }

  const tools = el("div", "qcard-actions");
  const changeBtn = el("button", null, "Change type");
  changeBtn.onclick = () => changeType(q, i);
  const previewBtn = el("button", null, "Preview");
  previewBtn.onclick = () => showPreview(q, i);
  const up = el("button", null, "↑ Move up");
  up.disabled = i === 0;
  up.onclick = () => moveQuestion(i, -1);
  const down = el("button", null, "↓ Move down");
  down.disabled = i === quiz.questions.length - 1;
  down.onclick = () => moveQuestion(i, 1);
  const copy = el("button", null, "Duplicate");
  copy.onclick = () => {
    snapshot();
    const dupe = JSON.parse(JSON.stringify(q));
    quiz.questions.splice(i + 1, 0, dupe);
    openQuestions.add(dupe);
    touch();
    renderQuestions();
  };
  const del = el("button", "danger", "Delete");
  del.onclick = () => {
    if (quiz.questions.length === 1) return alert("A quiz needs at least one question, so this one cannot be deleted. Change it to something else instead.");
    const what = q.text && q.text.trim() ? `“${q.text.trim().slice(0, 60)}”` : `question ${i + 1}`;
    if (!confirm(`Delete ${what}?\n\nYou can undo this straight afterwards.`)) return;
    snapshot();
    quiz.questions.splice(i, 1);
    touch();
    renderQuestions();
  };
  tools.append(changeBtn, previewBtn, up, down, copy, el("span", "spacer"), del);
  body.appendChild(tools);
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
          const rm = el("button", "small", "Remove");
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
        const add = el("button", "small", "+ Add another answer");
        add.onclick = () => { q.choices.push(""); touch(); renderQuestions(); };
        wrap.appendChild(add);
      } else {
        // The button vanishing with no explanation reads as a bug.
        wrap.appendChild(el("p", "hint-inline", "Four answers is the most a question can have."));
      }
      card.appendChild(field(hasAnswer ? "Answers — tick the correct one" : "Options for the poll", wrap));
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
          const rm = el("button", "small", "Remove");
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
          const rm = el("button", "small", "Remove");
          rm.onclick = () => { q.items.splice(ii, 1); touch(); renderQuestions(); };
          row.appendChild(rm);
        }
        wrap.appendChild(row);
      });
      if (q.items.length < 6) {
        const add = el("button", "small", "+ Add another item");
        add.onclick = () => { q.items.push(""); touch(); renderQuestions(); };
        wrap.appendChild(add);
      } else {
        wrap.appendChild(el("p", "hint-inline", "Six items is the most a question can have."));
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
  setRosterState("unsaved", "Not saved yet");
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
  setRosterState("saved", "Saved");
}

function setRosterState(kind, text) {
  const bar = $("rosterBar");
  if (bar) bar.className = `savebar ${kind}`;
  $("rosterState").textContent = text;
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
  setRosterState(res.error ? "unsaved" : "saved",
    res.error || `Saved. ${res.count} student${res.count === 1 ? "" : "s"} in this class.`);
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


// ---------- what players will see ----------
const PREVIEW_SYMS = ["▲", "◆", "●", "■"];

/**
 * Show one question the way a player's phone shows it. Not pixel-perfect with
 * the real game, but honest about the shape of it: this is the only way to
 * check a question reads well without starting a game and joining from a phone.
 */
function showPreview(q, i) {
  const body = $("previewBody");
  body.innerHTML = "";

  body.appendChild(el("div", "preview-meta", `Question ${i + 1} of ${quiz.questions.length}${q.type === "slide" ? "" : ` · ${q.time ?? 20} seconds`}`));

  const text = (q.text || "").trim();
  body.appendChild(el("div", "preview-q", text || "(no question text yet)"));
  if (!text) body.querySelector(".preview-q").classList.add("muted");

  if (q.image) body.appendChild(el("div", "preview-img", `[image: ${q.image}]`));

  const answers = el("div", "preview-answers");
  const labelled = (list) => list.forEach((c, ci) => {
    const b = el("div", `preview-choice c${ci % 4}`);
    b.append(el("span", "sym", PREVIEW_SYMS[ci] ?? String(ci + 1)), el("span", null, c || `(answer ${ci + 1} is empty)`));
    answers.appendChild(b);
  });

  switch (q.type) {
    case "choice":
    case "multi":
    case "poll":
      labelled(q.choices || []);
      break;
    case "truefalse":
      labelled(["True", "False"]);
      break;
    case "order":
      (q.items || []).forEach((it, ii) => answers.appendChild(el("div", "preview-item", `${ii + 1}. ${it || "(empty)"}`)));
      answers.appendChild(el("p", "hint-inline", "Players see these shuffled and drag them into order."));
      break;
    case "text":
      answers.appendChild(el("div", "preview-input", "Players type their answer here"));
      break;
    case "slider":
      answers.appendChild(el("div", "preview-input", `A slider from ${q.min ?? 0} to ${q.max ?? 100}${q.unit ? ` ${q.unit}` : ""}`));
      break;
    case "wordcloud":
      answers.appendChild(el("div", "preview-input", `Players type ${q.maxWords ?? 1} word${(q.maxWords ?? 1) === 1 ? "" : "s"}`));
      break;
    case "slide":
      answers.appendChild(el("p", "hint-inline", "Nothing to answer. The host talks over this, then moves on."));
      break;
  }
  body.appendChild(answers);

  if (quiz.phoneText === false && q.type !== "slide") {
    body.appendChild(el("p", "hint-inline", "\u2139 \u201cShow the question on players\u2019 phones\u201d is off, so players see only the answer buttons and read the question from the projector."));
  }
  $("previewModal").hidden = false;
}

$("closePreview").onclick = () => { $("previewModal").hidden = true; };
$("undoBtn").onclick = undo;

// Escape closes whichever dialog is open, which is what people expect.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const id of ["previewModal", "typeModal"]) {
    if (!$(id).hidden) { $(id).hidden = true; return; }
  }
});
