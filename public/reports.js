// Returns any for the same reason as edit.js: nearly every caller reaches for
// .value, .src or .disabled on the result. See docs/typing.md before tightening.
/** @param {string} id @returns {any} */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const pct = (r) => (r == null ? "—" : `${Math.round(r * 100)}%`);
/** How the game was run, when that is worth saying. */
const kindLabel = (g) => {
  const bits = [];
  if (g.kind === "assignment") bits.push("homework");
  else if (g.kind === "quick") bits.push("quick questions");
  if (g.scoring === 0) bits.push("lecture mode");
  return bits.join(", ");
};

// ---------- list ----------
let allGames = [];
let allStudents = [];

async function showList() {
  $("detailView").hidden = true;
  $("listView").hidden = false;
  allGames = await fetch("api/reports").then((r) => r.json());
  $("empty").hidden = allGames.length > 0;
  drawGames();
  if (!$("studentsPane").hidden) loadStudents();
}

function drawGames() {
  const needle = $("gameSearch").value.trim().toLowerCase();
  const games = needle ? allGames.filter((g) => g.title.toLowerCase().includes(needle)) : allGames;
  const box = $("gameList");
  box.innerHTML = "";
  if (!games.length && allGames.length) box.appendChild(el("p", "muted", "No games match that search."));
  for (const g of games) {
    const a = el("a", "card");
    a.href = `#${g.id}`;
    const kind = kindLabel(g);
    a.append(
      el("div", "card-title", g.title),
      el("div", "card-meta", `${fmtDate(g.started_at)} · ${g.player_count} players · ${g.question_count} questions${kind ? ` · ${kind}` : ""}`)
    );
    box.appendChild(a);
  }
}
$("gameSearch").oninput = drawGames;
$("gameSearch").hidden = false;

// ---------- students across games ----------
$("tabGames").onclick = () => switchTab("games");
$("tabStudents").onclick = () => switchTab("students");
function switchTab(which) {
  const students = which === "students";
  $("tabGames").classList.toggle("active", !students);
  $("tabStudents").classList.toggle("active", students);
  $("gamesPane").hidden = students;
  $("studentsPane").hidden = !students;
  if (students && !allStudents.length) loadStudents();
}

async function loadStudents() {
  allStudents = await fetch("api/students").then((r) => r.json());
  $("noStudents").hidden = allStudents.length > 0;
  drawStudents();
}

function drawStudents() {
  const needle = $("studentSearch").value.trim().toLowerCase();
  const rows = needle
    ? allStudents.filter((s) => s.who.toLowerCase().includes(needle) || s.nicknames.some((n) => n.toLowerCase().includes(needle)))
    : allStudents;
  buildTable($("studentTable"),
    ["Student", "Games", "Correct", "Rate", "Last played"],
    rows.map((s) => [s.who, s.gamesPlayed, `${s.correct}/${s.scored}`, pct(s.correctRate), fmtDate(s.lastPlayed)]));
  // clicking a row opens that student's history
  [...$("studentTable").querySelectorAll("tbody tr")].forEach((tr, i) => {
    tr.classList.add("clickable");
    tr.onclick = () => showStudent(rows[i]);
  });
  $("studentDetail").innerHTML = "";
}
$("studentSearch").oninput = drawStudents;

function showStudent(s) {
  const box = $("studentDetail");
  box.innerHTML = "";
  const card = el("div", "callout");
  card.appendChild(el("h3", null, s.who));
  if (s.nicknames.length > 1 || s.nicknames[0] !== s.who)
    card.appendChild(el("p", "muted", `Played as: ${s.nicknames.join(", ")}`));
  const list = el("div", "cardlist");
  for (const g of [...s.games].sort((a, b) => b.startedAt - a.startedAt)) {
    const a = el("a", "card");
    a.href = `#${g.gameId}`;
    a.append(
      el("div", "card-title", g.title),
      el("div", "card-meta",
        `${fmtDate(g.startedAt)} · ${g.scored ? `${g.correct}/${g.scored} correct` : "no scored questions"} · ${g.score} points${g.rank ? ` · rank ${g.rank}` : ""}`)
    );
    list.appendChild(a);
  }
  card.appendChild(list);
  box.appendChild(card);
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- detail ----------
async function showDetail(id) {
  const res = await fetch(`api/reports/${encodeURIComponent(id)}`);
  if (!res.ok) { location.hash = ""; return; }
  const r = await res.json();
  $("listView").hidden = true;
  $("detailView").hidden = false;
  $("dTitle").textContent = r.game.title;
  const kind = kindLabel(r.game);
  $("dWhen").textContent = `${fmtDate(r.game.started_at)} · ${r.game.kind === "assignment" ? "code" : "PIN"} ${r.game.pin}${kind ? ` · ${kind}` : ""}`;
  $("csvLink").href = `api/reports/${encodeURIComponent(id)}/csv`;
  const msg = $("dMsg");
  msg.hidden = true;
  $("reviewBtn").onclick = async () => {
    $("reviewBtn").disabled = true;
    try {
      const out = await fetch(`api/reports/${encodeURIComponent(id)}/review-quiz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: 0.6 }),
      }).then((res) => res.json());
      msg.hidden = false;
      msg.innerHTML = "";
      if (out.error) {
        msg.appendChild(el("p", null, out.error));
      } else {
        msg.appendChild(el("h3", null, "Review quiz created"));
        msg.appendChild(el("p", null,
          `"${out.title}" has the ${out.count} question${out.count === 1 ? "" : "s"} this class did worst on. It is in your quizzes folder and will appear in the host list.`));
      }
    } finally {
      $("reviewBtn").disabled = false;
    }
  };

  $("delBtn").onclick = async () => {
    if (!confirm("Delete this report permanently?")) return;
    await fetch(`api/reports/${encodeURIComponent(id)}`, { method: "DELETE" });
    location.hash = "";
  };

  // headline numbers
  const scored = r.questions.filter((q) => q.correctRate !== null);
  const avg = scored.length ? scored.reduce((t, q) => t + q.correctRate, 0) / scored.length : null;
  const stats = $("dStats");
  stats.innerHTML = "";
  for (const [label, value] of [
    ["Players", r.players.length],
    ["Questions", r.questions.length],
    ["Class average", pct(avg)],
    [r.game.scoring === 0 ? "Points" : "Top score", r.game.scoring === 0 ? "off" : r.players.length ? r.players[0].score : 0],
  ]) {
    const s = el("div", "stat");
    s.append(el("div", "stat-value", String(value)), el("div", "stat-label", label));
    stats.appendChild(s);
  }

  // questions most people missed
  const review = $("dReview");
  review.innerHTML = "";
  if (r.needsReview.length) {
    const box = el("div", "callout");
    box.appendChild(el("h3", null, "Worth reviewing"));
    box.appendChild(el("p", "muted", "Fewer than half the class got these right."));
    const ul = el("ul");
    for (const q of r.needsReview) {
      const li = el("li");
      li.append(el("strong", null, `${pct(q.correctRate)} `), document.createTextNode(`Q${q.idx + 1}. ${q.text}`));
      ul.appendChild(li);
    }
    box.appendChild(ul);
    review.appendChild(box);
  }

  // who was on the class list but never played
  const absent = $("dAbsent");
  absent.innerHTML = "";
  if (r.roster) {
    const box = el("div", "callout");
    box.appendChild(el("h3", null, `Class list: ${r.roster.title}`));
    box.appendChild(el("p", null,
      r.roster.absent.length
        ? `${r.roster.absent.length} of ${r.roster.total} did not play: ${r.roster.absent.join(", ")}`
        : `All ${r.roster.total} students played.`));
    absent.appendChild(box);
  }

  buildTable($("qTable"),
    ["#", "Question", "Type", "Answer", "Correct", "Responses", "Avg time"],
    r.questions.map((q) => [
      q.idx + 1, q.text, q.type, q.answer ?? "—",
      q.correctRate === null ? "—" : `${q.correct}/${q.scored} · ${pct(q.correctRate)}`,
      q.responses,
      q.avgMs == null ? "—" : `${(q.avgMs / 1000).toFixed(1)}s`,
    ]),
    r.questions.map((q) => (q.correctRate !== null && q.correctRate < 0.5 ? "warn" : "")));

  renderDistractors(r);
  renderMarking(r, id);

  const idLabel = r.players.some((p) => p.identifier) ? "Identifier" : null;
  const teamLabel = r.players.some((p) => p.team) ? "Team" : null;
  buildTable($("pTable"),
    ["Rank", "Nickname", ...(idLabel ? [idLabel] : []), ...(teamLabel ? [teamLabel] : []), "Score", "Correct"],
    r.players.map((p) => [
      p.rank ?? "—", p.name, ...(idLabel ? [p.identifier ?? "—"] : []), ...(teamLabel ? [p.team ?? "—"] : []),
      p.score, p.scored ? `${p.correct}/${p.scored}` : "—",
    ]));
}

/**
 * Written answers and uploaded files, one card per question, each answer with
 * three marks to choose from. Anonymous questions cannot be marked, since
 * there is nobody to credit.
 */
function renderMarking(r, gameId) {
  const box = $("dMarkList");
  box.innerHTML = "";
  const gradable = r.questions.filter((q) => q.type === "longtext" || q.type === "file");
  const items = [];
  for (const q of gradable) {
    for (const p of r.players) {
      const a = p.answers.find((x) => x.idx === q.idx);
      if (a && a.response != null) items.push({ q, p, a });
    }
  }
  $("dMarking").hidden = !items.length;
  if (!items.length) return;
  for (const q of gradable) {
    const mine = items.filter((it) => it.q === q);
    if (!mine.length) continue;
    const card = el("div", "qcard");
    card.appendChild(el("div", "qcard-head", `Q${q.idx + 1}. ${q.text}${q.weight !== 1 ? ` (worth ×${q.weight})` : ""}`));
    if (q.explanation) card.appendChild(el("div", "qcard-note", `Model answer: ${q.explanation}`));
    for (const { p, a } of mine) {
      const row = el("div", "markrow");
      const who = el("div", "markwho", p.identifier ? `${p.name} · ${p.identifier}` : p.name);
      const body = el("div", "markbody");
      if (q.type === "file" && a.response && a.response.file) {
        const link = el("a", "btnlink small", a.response.name || "Open file");
        link.href = `api/uploads/${encodeURIComponent(a.response.file)}`;
        link.target = "_blank";
        link.rel = "noopener";
        body.appendChild(link);
        if (String(a.response.type || "").startsWith("image/")) {
          const img = document.createElement("img");
          img.className = "markthumb";
          img.src = link.href;
          img.alt = "";
          img.loading = "lazy";
          body.appendChild(img);
        }
      } else {
        body.appendChild(el("div", "marktext", String(a.response)));
      }
      const marks = el("div", "marks");
      const current = a.correct === true ? "right" : a.correct === false && a.points > 0 ? "partial" : a.correct === false ? "wrong" : null;
      for (const [mark, label] of [["right", "Right"], ["partial", "Partial"], ["wrong", "Wrong"]]) {
        const b = el("button", "small" + (current === mark ? " on" : ""), label);
        b.onclick = async () => {
          const next = current === mark ? null : mark; // clicking the current mark clears it
          const res = await fetch(`api/reports/${encodeURIComponent(gameId)}/grade`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idx: q.idx, player: p.name, mark: next }),
          }).then((x) => x.json());
          if (res.error) { alert(res.error); return; }
          showDetail(gameId); // scores and ranks moved; redraw from the server's view
        };
        marks.appendChild(b);
      }
      row.append(who, body, marks);
      card.appendChild(row);
    }
    box.appendChild(card);
  }
}

function renderDistractors(r) {
  const box = $("dDistract");
  box.innerHTML = "";
  const withData = r.questions.filter((q) => q.distractors && q.distractors.length);
  if (!withData.length) { box.appendChild(el("p", "muted", "No responses to break down.")); return; }

  for (const q of withData) {
    const card = el("div", "qcard");
    card.appendChild(el("div", "qcard-head", `Q${q.idx + 1}. ${q.text}`));
    if (q.topDistractor) {
      card.appendChild(el("div", "qcard-note",
        `Most common wrong answer: "${q.topDistractor.label}", chosen ${q.topDistractor.n} time${q.topDistractor.n === 1 ? "" : "s"}`));
    }
    const total = q.distractors.reduce((t, d) => t + d.n, 0) || 1;
    const list = el("div", "dbars");
    for (const d of q.distractors) {
      const row = el("div", "dbar" + (d.correct ? " right" : d.correct === false ? " wrong" : ""));
      const fill = el("div", "dbar-fill");
      fill.style.width = `${(d.n / total) * 100}%`;
      const label = el("span", "dbar-label", d.correct ? `${d.label} ✓` : d.label);
      const n = el("span", "dbar-n", String(d.n));
      row.append(fill, label, n);
      list.appendChild(row);
    }
    card.appendChild(list);
    if (q.explanation) card.appendChild(el("div", "qcard-explain", q.explanation));
    box.appendChild(card);
  }
}

function buildTable(table, head, rows, rowClasses = []) {
  table.innerHTML = "";
  const thead = el("thead");
  const hr = el("tr");
  for (const h of head) hr.appendChild(el("th", null, h));
  thead.appendChild(hr);
  const tbody = el("tbody");
  rows.forEach((row, i) => {
    const tr = el("tr", rowClasses[i] || null);
    for (const cell of row) tr.appendChild(el("td", null, String(cell)));
    tbody.appendChild(tr);
  });
  table.append(thead, tbody);
}

function route() {
  const id = location.hash.slice(1);
  if (id) showDetail(id); else showList();
}
$("backLink").onclick = (e) => { e.preventDefault(); location.hash = ""; };
window.addEventListener("hashchange", route);
route();

// Name whoever is signed in, matching the editor.
(async () => {
  try {
    const me = await fetch("api/me").then((r) => r.json());
    if (!me.authRequired) return;
    const bar = document.getElementById("whoami");
    bar.textContent = me.user ? `Signed in as ${me.user.name || me.user.eppn}` : "Not signed in";
    bar.hidden = false;
  } catch { /* older server, or offline; the page still works */ }
})();
