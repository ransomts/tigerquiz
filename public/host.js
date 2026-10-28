// Defined by sound.js, loaded by host.html before this file. It cannot go in
// eslint.config.js's globals the way io can, because sound.js itself declares
// it and ESLint would report a redeclaration there.
/* global Sound */
const SYMS = ["▲", "◆", "●", "■"];
// Returns any for the same reason as edit.js: nearly every caller reaches for
// .value, .src or .disabled on the result. See docs/typing.md before tightening.
/** @param {string} id @returns {any} */
const $ = (id) => document.getElementById(id);
const show = (id) => document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
// served from "/" directly, or from a sub-path behind a reverse proxy
const BASE = location.pathname.replace(/\/[^/]*$/, "");
const socket = io({ path: `${BASE}/socket.io` });
let pin = null;
let hostToken = null;
let timerHandle = null;
let phase = "setup";
let current = null; // the question on screen
let paused = false;
let questions = []; // titles for the jump menus
let scoring = true; // false is lecture mode: no points, no leaderboard
let teams = null;   // team names when the game is played in teams
let adhoc = false;  // a quick-question game: no quiz file, the host composes each one

const SESSION_KEY = "tigerquiz.host";
const saveSession = () => { try { localStorage.setItem(SESSION_KEY, JSON.stringify({ pin, hostToken })); } catch {} };
const clearSession = () => { try { localStorage.removeItem(SESSION_KEY); } catch {} };

function renderMute() { $("muteBtn").textContent = Sound.muted ? "🔇 Sound off" : "🔊 Sound on"; }
$("muteBtn").onclick = () => { Sound.init(); Sound.muted = !Sound.muted; renderMute(); };
renderMute();

async function loadLists() {
  const [quizzes, rosters] = await Promise.all([
    fetch("api/quizzes").then((r) => r.json()),
    fetch("api/rosters").then((r) => r.json()),
  ]);
  const sel = $("quizSel");
  sel.innerHTML = "";
  if (!quizzes.length) { $("setupErr").textContent = "No quizzes found in quizzes/"; return; }
  for (const q of quizzes) {
    const o = document.createElement("option");
    o.value = q.id;
    o.textContent = q.error ? `${q.id} — ${q.error}` : `${q.title} (${q.count} questions)`;
    o.disabled = !!q.error;
    sel.appendChild(o);
  }
  const rsel = $("rosterSel");
  rsel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = rosters.length ? "No class list (anyone can join)" : "No class lists found";
  rsel.appendChild(none);
  for (const r of rosters) {
    const o = document.createElement("option");
    o.value = r.id;
    o.textContent = `Class list: ${r.title} (${r.count})`;
    rsel.appendChild(o);
  }
  rsel.hidden = rosters.length === 0;
}
loadLists();

// creating a game needs a key fetched over HTTP, which a reverse proxy can put
// behind a password; socket.io cannot be protected by path on its own
let hostKey = null;
async function withHostKey(fn) {
  try {
    if (!hostKey) hostKey = (await (await fetch("api/host-key")).json()).key;
  } catch {
    $("setupErr").textContent = "Could not start a game. Reload the page and sign in again.";
    return;
  }
  fn(hostKey);
}

$("createBtn").onclick = () => {
  Sound.init(); // audio must be unlocked by a click
  withHostKey((key) => socket.emit("host:create", {
    quizId: $("quizSel").value, rosterId: $("rosterSel").value || null, key, scoring: !$("lectureMode").checked,
    teams: Number($("teamSel").value) || 0,
  }, (res) => {
    if (!res.ok) { $("setupErr").textContent = res.error; return; }
    adopt(res);
    renderPlayers([]);
    show("lobby");
  }));
};

// no quiz at all: open a room and make each question up as the lesson goes
$("quickBtn").onclick = () => {
  Sound.init();
  withHostKey((key) => socket.emit("host:create", {
    quick: true, rosterId: $("rosterSel").value || null, key, scoring: !$("lectureMode").checked,
    teams: Number($("teamSel").value) || 0,
  }, (res) => {
    if (!res.ok) { $("setupErr").textContent = res.error; return; }
    adopt(res);
    renderPlayers([]);
    show("lobby");
  }));
};

/** Take on a game, whether freshly created or resumed after a reload. */
function adopt(res) {
  pin = res.pin;
  hostToken = res.hostToken;
  questions = res.questions || [];
  scoring = res.scoring !== false;
  adhoc = !!res.adhoc;
  teams = res.teams || null;
  $("teamNote").hidden = !teams;
  saveSession();
  phase = "lobby";
  $("lobbyTitle").textContent = res.title + (scoring ? "" : " · lecture mode");
  // a quick-question game has nothing to start: the first question starts it
  $("startBtn").hidden = adhoc;
  $("askFirstBtn").hidden = !adhoc;
  $("jumpSel").hidden = adhoc;
  $("rJumpSel").hidden = adhoc;
  document.body.classList.toggle("no-scoring", !scoring);
  $("lobbyPin").textContent = pin;
  $("joinUrl").textContent = `${location.host}${BASE}`;
  $("hostPin").textContent = `PIN ${pin}`;
  $("qr").src = `api/qr.svg?text=${encodeURIComponent(`${location.origin}${BASE}/?pin=${pin}`)}`;
  // students cannot reach "localhost"; tell the host before the lesson, not during it
  const local = /^(localhost|127\.|\[?::1)/i.test(location.hostname);
  const warn = $("addrWarn");
  warn.hidden = !local;
  if (local) warn.textContent = "Students cannot reach this address. Reopen this page using this machine's network name or IP so the code and link work.";

  const note = $("rosterNote");
  note.hidden = !(res.roster || res.identifier);
  if (res.roster) note.textContent = `Players must be on the class list "${res.roster.title}" (${res.roster.count} students).`;
  else if (res.identifier) note.textContent = `Players will be asked for: ${res.identifier}`;
  fillJumpMenus();
}

function fillJumpMenus() {
  for (const id of ["jumpSel", "rJumpSel"]) {
    const sel = $(id);
    sel.innerHTML = "";
    const head = document.createElement("option");
    head.value = "";
    head.textContent = "Jump to…";
    sel.appendChild(head);
    questions.forEach((q) => {
      const o = document.createElement("option");
      o.value = String(q.index);
      const label = q.text || `(${q.type})`;
      o.textContent = `${q.index + 1}. ${label.length > 44 ? label.slice(0, 44) + "…" : label}`;
      sel.appendChild(o);
    });
    sel.onchange = () => {
      if (sel.value === "") return;
      socket.emit("host:goto", Number(sel.value));
      sel.value = "";
    };
  }
}

/**
 * Reconnect to a game this browser was already hosting. The server holds the
 * room open for a few minutes, so a reload or a sleeping laptop is survivable.
 */
function tryResume() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch {}
  if (!saved || !saved.pin || !saved.hostToken) return;
  socket.emit("host:resume-session", saved, (res) => {
    if (!res.ok) { clearSession(); return; }
    Sound.init();
    adopt(res);
    phase = res.state === "lobby" ? "lobby" : res.state;
    paused = res.paused;
    renderPaused();
    if (res.state === "lobby") show("lobby");
    // the server replays whichever screen the game is on
  });
}
socket.on("connect", tryResume);

function renderPlayers(players) {
  const box = $("players");
  box.innerHTML = "";
  // in a team game the chips wear their team's colour, grouped by team
  const ordered = teams ? [...players].sort((a, b) => (a.team ?? 0) - (b.team ?? 0)) : players;
  for (const p of ordered) {
    const c = document.createElement("span");
    c.className = "chip" + (p.connected ? "" : " off") + (teams && p.team != null ? ` t${p.team}` : "");
    c.textContent = teams && p.team != null ? `${p.name} · ${teams[p.team].replace("Team ", "")}` : p.name;
    c.title = "Remove";
    c.onclick = () => confirm(`Remove ${p.name}?`) && socket.emit("host:kick", p.name);
    box.appendChild(c);
  }
  $("playerCount").textContent = players.length;
  $("startBtn").disabled = players.length === 0;
  $("askFirstBtn").disabled = players.length === 0;
}
socket.on("lobby:players", renderPlayers);
// an ad-hoc game grows a question at a time; keep the jump menus honest anyway
socket.on("game:questions", (qs) => { questions = qs; fillJumpMenus(); });

$("startBtn").onclick = () => socket.emit("host:start", {});
$("askFirstBtn").onclick = () => openComposer();
$("askAgainBtn").onclick = () => openComposer();
$("finishBtn").onclick = () => socket.emit("host:finish");
$("nextBtn").onclick = () => socket.emit("host:next");
$("skipBtn").onclick = () => socket.emit("host:skip");
$("prevBtn").onclick = () => socket.emit("host:prev");
$("rPrevBtn").onclick = () => socket.emit("host:prev");
$("revoteBtn").onclick = () => socket.emit("host:revote");
$("pauseBtn").onclick = () => socket.emit("host:pause", !paused);
$("newGameBtn").onclick = () => { clearSession(); location.reload(); };
$("replayBtn").onclick = () => socket.emit("host:replay");
$("rehearseBtn").onclick = () => {
  Sound.init();
  withHostKey((key) => socket.emit("host:create", { quizId: $("quizSel").value, rosterId: null, key }, (res) => {
    if (!res.ok) { $("setupErr").textContent = res.error; return; }
    adopt(res);
    renderPlayers([]);
    show("lobby");
    socket.emit("host:start", { solo: true });
  }));
};

// back to the lobby with the same people, scores cleared
socket.on("game:restarted", () => {
  phase = "lobby";
  paused = false;
  renderPaused();
  clearInterval(timerHandle);
  show("lobby");
});

function renderPaused() {
  $("pausedBanner").hidden = !paused;
  $("pauseBtn").textContent = paused ? "Resume" : "Pause";
  document.body.classList.toggle("is-paused", paused);
}

socket.on("game:paused", (p) => {
  paused = p.paused;
  renderPaused();
  if (paused) clearInterval(timerHandle);
  else startTimer(p.endsAt, current ? current.totalMs : null);
});

document.addEventListener("keydown", (e) => {
  // keyboard shortcuts are for the host, not for whatever field has focus
  if (e.target instanceof HTMLElement && (e.target.tagName === "SELECT" || e.target.tagName === "INPUT")) return;
  if (!$("askModal").hidden) return; // the composer owns the keyboard while it is open
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    if (phase === "lobby") (adhoc ? $("askFirstBtn") : $("startBtn")).click();
    else if (phase === "question") $("skipBtn").click();
    else if (phase === "results") (adhoc ? $("askAgainBtn") : $("nextBtn")).click();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (phase === "question" || phase === "results") socket.emit("host:prev");
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    if (phase === "results") $("nextBtn").click();
    else if (phase === "question") $("skipBtn").click();
  } else if (e.key.toLowerCase() === "p") {
    e.preventDefault();
    if (phase === "question") socket.emit("host:pause", !paused);
  }
});

// ---------- live question view ----------
socket.on("game:question", (q) => {
  phase = "question";
  current = q;
  paused = !!q.paused;
  renderPaused();
  $("prevBtn").disabled = q.index === 0;
  $("qCount").textContent = `Question ${q.index + 1} of ${q.total}`;
  $("qAnswered").textContent = q.type === "slide" ? "" : "0 answered";
  $("qText").textContent = q.text;
  const img = $("qImage");
  img.hidden = !q.image;
  img.src = q.image || "";
  renderMedia(q.media);
  // the image and the answer area share the screen, so shrink the area when one is shown
  $("question").classList.toggle("has-image", !!q.image || !!q.media);
  const badges = [];
  if (q.weight === 2) badges.push("Double points");
  else if (q.weight === 0.5) badges.push("Half points");
  else if (q.weight === 0) badges.push("No points");
  if (q.anonymous) badges.push("Anonymous");
  $("qBadge").hidden = !badges.length;
  $("qBadge").textContent = badges.join(" · ");
  $("skipBtn").textContent = q.type === "slide" ? "Continue" : "End question now";
  $("qCount").textContent = q.revote
    ? `Question ${q.index + 1} of ${q.total} · second vote`
    : `Question ${q.index + 1} of ${q.total}`;

  const body = $("qBody");
  body.className = "";
  body.innerHTML = "";
  (LIVE[q.type] || LIVE.choice)(q, body);

  startTimer(q.endsAt, q.totalMs);
  Sound.start();
  show("question");
});

/**
 * A clip to play on the projector: a YouTube embed, or a video or audio file.
 * It autoplays, which browsers allow here because the host has already
 * clicked on this page; the controls stay for replaying it.
 */
function renderMedia(media) {
  const box = $("qMedia");
  box.innerHTML = "";
  box.hidden = !media;
  if (!media) return;
  if (media.kind === "youtube") {
    const f = document.createElement("iframe");
    f.src = `https://www.youtube-nocookie.com/embed/${media.id}?autoplay=1&rel=0${media.start ? `&start=${media.start}` : ""}`;
    f.allow = "autoplay; encrypted-media; picture-in-picture";
    f.allowFullscreen = true;
    f.title = "Video";
    box.appendChild(f);
    return;
  }
  const el = document.createElement(media.kind === "audio" ? "audio" : "video");
  el.src = media.src + (media.start ? `#t=${media.start}` : "");
  el.controls = true;
  el.autoplay = true;
  el.setAttribute("playsinline", "");
  box.appendChild(el);
}

const LIVE = {
  choice: (q, body) => choiceTiles(q, body),
  truefalse: (q, body) => choiceTiles(q, body),
  multi: (q, body) => choiceTiles(q, body),
  poll: (q, body) => choiceTiles(q, body),
  slider: (q, body) => {
    body.className = "scalebox";
    body.innerHTML = `<div class="scale"><span></span><span></span></div><p class="muted" style="text-align:center">Players are choosing a number</p>`;
    body.querySelector("span").textContent = `${q.min}${q.unit ? " " + q.unit : ""}`;
    body.querySelectorAll("span")[1].textContent = `${q.max}${q.unit ? " " + q.unit : ""}`;
  },
  text: (q, body) => { body.className = "waitnote"; body.innerHTML = `<p class="muted">Players are typing their answer</p>`; },
  numeric: (q, body) => {
    body.className = "waitnote";
    body.innerHTML = `<p class="muted"></p>`;
    body.firstChild.textContent = q.unit ? `Players are typing a number in ${q.unit}` : "Players are typing a number";
  },
  blank: (q, body) => {
    body.className = "waitnote";
    body.innerHTML = `<p class="muted"></p>`;
    body.firstChild.textContent = q.blanks > 1 ? `Players are filling in ${q.blanks} blanks` : "Players are filling in the blank";
  },
  wordcloud: (q, body) => { body.className = "waitnote"; body.innerHTML = `<p class="muted">Players are typing words</p>`; },
  longtext: (q, body) => { body.className = "waitnote"; body.innerHTML = `<p class="muted">Players are writing their answers</p>`; },
  file: (q, body) => { body.className = "waitnote"; body.innerHTML = `<p class="muted">Players are handing in a photo or a PDF</p>`; },
  hotspot: (q, body) => { body.className = "waitnote"; body.innerHTML = `<p class="muted">Players are tapping the picture</p>`; },
  match: (q, body) => {
    body.className = "matchbox host";
    for (const col of [q.lefts, q.rights]) {
      const c = document.createElement("div");
      c.className = "matchcol";
      for (const label of col) {
        const d = document.createElement("div");
        d.className = "matchitem";
        d.innerHTML = `<span class="label"></span>`;
        d.querySelector(".label").textContent = label;
        c.appendChild(d);
      }
      body.appendChild(c);
    }
  },
  order: (q, body) => {
    body.className = "orderlist host";
    q.items.forEach((label) => {
      const d = document.createElement("div");
      d.className = "orderitem";
      d.innerHTML = `<span class="label"></span>`;
      d.querySelector(".label").textContent = label;
      body.appendChild(d);
    });
  },
  slide: (q, body) => { body.className = "waitnote"; body.innerHTML = ""; },
};

function choiceTiles(q, body) {
  body.className = "grid" + (q.choices.length === 2 ? " two" : "");
  q.choices.forEach((c, i) => {
    const d = document.createElement("div");
    d.className = `choice c${i}`;
    d.innerHTML = `<span class="sym">${SYMS[i] ?? i + 1}</span><span></span>`;
    d.lastChild.textContent = c;
    body.appendChild(d);
  });
}

socket.on("game:answered", ({ answered, players }) => {
  $("qAnswered").textContent = `${answered} / ${players} answered`;
});

/** totalMs keeps the bar proportional to the whole question, not to what is left. */
function startTimer(endsAt, totalMs) {
  clearInterval(timerHandle);
  if (!endsAt) {
    $("qTimer").textContent = paused ? "paused" : "";
    if (!paused) $("qBar").style.width = "100%";
    return;
  }
  const total = Math.max(totalMs || endsAt - Date.now(), 1);
  let lastSec = null;
  const tick = () => {
    const left = Math.max(endsAt - Date.now(), 0);
    const sec = Math.ceil(left / 1000);
    $("qTimer").textContent = sec;
    $("qBar").style.width = (left / total) * 100 + "%";
    if (sec !== lastSec) {
      lastSec = sec;
      if (sec > 0 && sec <= 5) Sound.tick();
      else if (sec === 0) Sound.timeUp();
    }
    if (left <= 0) clearInterval(timerHandle);
  };
  tick();
  timerHandle = setInterval(tick, 250);
}

// ---------- results view ----------
socket.on("game:results", (r) => {
  phase = "results";
  clearInterval(timerHandle);
  renderMedia(null); // stop whatever was playing
  $("rText").textContent = r.text;
  const body = $("rBody");
  body.className = "";
  body.innerHTML = "";
  body.parentElement.querySelectorAll(".shiftnote").forEach((n) => n.remove());
  (SUMMARY[r.summary.kind] || SUMMARY.none)(r, body);

  const ex = $("rExplain");
  ex.hidden = !r.explanation;
  ex.textContent = r.explanation || "";

  // offer a discussion round while the class is split, but not twice on the same question
  const canRevote = r.summary.kind === "counts" && !!r.answer && !r.priorSummary;
  $("revoteBtn").hidden = !canRevote;
  $("revoteBtn").classList.toggle("primary", canRevote && r.suggestDiscussion);
  $("nextBtn").classList.toggle("primary", !(canRevote && r.suggestDiscussion));

  renderBoard($("board"), r.leaderboard);
  $("nextBtn").textContent = r.isLast ? (scoring ? "Show final standings" : "Finish") : "Next question";
  // a quick-question game has no "next": the host asks another, or stops here
  $("nextBtn").hidden = !!r.adhoc;
  $("askAgainBtn").hidden = !r.adhoc;
  $("finishBtn").hidden = !r.adhoc;
  $("rPrevBtn").disabled = false;
  Sound.reveal();
  show("results");
});

const SUMMARY = {
  counts: (r, body) => {
    body.className = "bars";
    const s = r.summary;
    const prior = r.priorSummary && r.priorSummary.kind === "counts" ? r.priorSummary.counts : null;
    const max = Math.max(1, ...s.counts, ...(prior || []));
    // which tiles to mark correct: one index, a set of them, or none for a poll
    const right = new Set(r.answer ? (r.answer.indexes ?? [r.answer.index]).filter((v) => v != null) : []);
    s.counts.forEach((n, i) => {
      const was = prior ? prior[i] : null;
      const b = document.createElement("div");
      b.className = "bar" + (right.has(i) ? " correct" : "");
      // bar heights are proportional via flex-grow: spacer takes (max - n), fill takes n
      const ghost = prior
        ? `<div class="track"><div class="spacer" style="flex-grow:${max - was}"></div><div class="fillbar ghost c${i}" style="flex-grow:${was}"></div></div>`
        : "";
      b.innerHTML = `<span class="count">${prior ? `<span class="was">${was}→</span>` : ""}${n}</span>
        <div class="tracks">${ghost}<div class="track"><div class="spacer" style="flex-grow:${max - n}"></div><div class="fillbar c${i}" style="flex-grow:${n}"></div></div></div>
        <div class="label c${i}"><span class="sym">${SYMS[i] ?? i + 1}</span><span class="text"></span></div>`;
      b.querySelector(".text").textContent = s.labels[i] ?? "";
      body.appendChild(b);
    });
    if (prior) {
      const rightIdx = [...right];
      const before = rightIdx.reduce((t, i) => t + prior[i], 0);
      const after = rightIdx.reduce((t, i) => t + s.counts[i], 0);
      const note = document.createElement("p");
      note.className = "shiftnote";
      note.textContent = `Correct: ${before} before discussion, ${after} after`;
      body.parentElement.insertBefore(note, body.nextSibling);
    }
  },

  slider: (r, body) => {
    const s = r.summary;
    const span = Math.max(s.max - s.min, 1e-9);
    const pct = (v) => ((v - s.min) / span) * 100;
    body.className = "sliderresult";
    body.innerHTML = `
      <div class="numberline">
        <div class="axis"></div>
        <div class="marker answer" style="left:${pct(r.answer.value)}%"><span class="flag"></span></div>
      </div>
      <div class="scale"><span></span><span></span></div>
      <p class="answerline">Answer: <strong></strong></p>
      <p class="muted meanline"></p>`;
    const line = body.querySelector(".numberline");
    for (const v of s.values) {
      const d = document.createElement("div");
      d.className = "marker guess";
      d.style.left = `${pct(v)}%`;
      line.appendChild(d);
    }
    body.querySelector(".flag").textContent = r.answer.label;
    body.querySelector(".scale span").textContent = `${s.min}${s.unit ? " " + s.unit : ""}`;
    body.querySelectorAll(".scale span")[1].textContent = `${s.max}${s.unit ? " " + s.unit : ""}`;
    body.querySelector(".answerline strong").textContent = r.answer.label;
    body.querySelector(".meanline").textContent = s.mean == null ? "No guesses" : `${s.values.length} guesses · average ${Math.round(s.mean * 10) / 10}${s.unit ? " " + s.unit : ""}`;
  },

  words: (r, body) => {
    body.className = "cloud";
    const s = r.summary;
    if (!s.words.length) { body.innerHTML = `<p class="muted">No answers</p>`; return; }
    const max = s.words[0].n;
    for (const w of s.words) {
      const span = document.createElement("span");
      span.className = "word";
      // size by frequency, floored so a single mention is still readable
      span.style.fontSize = `${1 + (w.n / max) * 2.2}rem`;
      span.style.opacity = String(0.55 + (w.n / max) * 0.45);
      span.textContent = w.n > 1 ? `${w.text} ×${w.n}` : w.text;
      body.appendChild(span);
    }
    if (r.answer) {
      const p = document.createElement("p");
      p.className = "answerline";
      p.innerHTML = `Answer: <strong></strong>`;
      p.querySelector("strong").textContent = r.answer.label;
      body.appendChild(p);
    }
  },

  order: (r, body) => {
    body.className = "orderlist host result";
    const s = r.summary;
    s.items.forEach((label, pos) => {
      const d = document.createElement("div");
      d.className = "orderitem correct";
      d.innerHTML = `<span class="pos">${pos + 1}</span><span class="label"></span><span class="tally"></span>`;
      d.querySelector(".label").textContent = label;
      d.querySelector(".tally").textContent = `${s.perSlot[pos]} right`;
      body.appendChild(d);
    });
  },

  numbers: (r, body) => {
    const s = r.summary;
    body.className = "numbersresult";
    if (!s.buckets.length) { body.innerHTML = `<p class="muted">No answers</p>`; return; }
    const max = Math.max(1, ...s.buckets.map((b) => b.n));
    const unit = s.unit ? ` ${s.unit}` : "";
    for (const b of s.buckets) {
      const row = document.createElement("div");
      row.className = "dbar" + (b.correct ? " right" : " wrong");
      row.innerHTML = `<div class="dbar-fill" style="width:${(b.n / max) * 100}%"></div><span class="dbar-label"></span><span class="dbar-n"></span>`;
      row.querySelector(".dbar-label").textContent = `${b.value}${unit}${b.correct ? " \u2713" : ""}`;
      row.querySelector(".dbar-n").textContent = String(b.n);
      body.appendChild(row);
    }
    const p = document.createElement("p");
    p.className = "answerline";
    p.innerHTML = `Answer: <strong></strong> <span class="muted meanline"></span>`;
    p.querySelector("strong").textContent = r.answer.label;
    p.querySelector(".meanline").textContent = s.mean == null ? "" : `\u00b7 ${s.count} answers, average ${Math.round(s.mean * 100) / 100}${unit}`;
    body.appendChild(p);
  },

  blanks: (r, body) => {
    const s = r.summary;
    body.className = "blanksresult";
    // the sentence with the right words dropped in
    const sentence = document.createElement("p");
    sentence.className = "blanktext";
    s.parts.forEach((part, i) => {
      sentence.appendChild(document.createTextNode(part));
      if (i < s.blanks.length) {
        const w = document.createElement("strong");
        w.className = "filled";
        w.textContent = s.blanks[i].answer;
        sentence.appendChild(w);
      }
    });
    body.appendChild(sentence);
    s.blanks.forEach((b, i) => {
      const row = document.createElement("div");
      row.className = "blankrow";
      const head = document.createElement("span");
      head.className = "tally";
      head.textContent = `${s.blanks.length > 1 ? `Blank ${i + 1}: ` : ""}${b.right} of ${s.count} right`;
      row.appendChild(head);
      if (b.wrong.length) {
        const alt = document.createElement("span");
        alt.className = "muted";
        alt.textContent = "also wrote " + b.wrong.map((w) => (w.n > 1 ? `${w.text} \u00d7${w.n}` : w.text)).join(", ");
        row.appendChild(alt);
      }
      body.appendChild(row);
    });
  },

  files: (r, body) => {
    body.className = "filesresult";
    const s = r.summary;
    if (!s.files.length) { body.innerHTML = `<p class="muted">Nothing handed in</p>`; return; }
    for (const f of s.files) {
      const a = document.createElement("a");
      a.className = "filecard";
      a.href = `api/uploads/${encodeURIComponent(f.file)}`;
      a.target = "_blank";
      a.rel = "noopener";
      if (String(f.type).startsWith("image/")) {
        const img = document.createElement("img");
        img.src = a.href;
        img.alt = f.name || "";
        img.loading = "lazy";
        a.appendChild(img);
      } else {
        a.appendChild(Object.assign(document.createElement("span"), { className: "fileicon", textContent: "PDF" }));
      }
      a.appendChild(Object.assign(document.createElement("span"), { className: "filename", textContent: f.name || "file" }));
      body.appendChild(a);
    }
  },

  texts: (r, body) => {
    body.className = "textsresult";
    const s = r.summary;
    if (!s.texts.length) { body.innerHTML = `<p class="muted">No answers</p>`; return; }
    for (const t of s.texts) {
      const card = document.createElement("div");
      card.className = "textcard";
      card.textContent = t;
      body.appendChild(card);
    }
  },

  match: (r, body) => {
    body.className = "orderlist host result";
    const s = r.summary;
    s.pairs.forEach((p, i) => {
      const d = document.createElement("div");
      d.className = "orderitem correct";
      d.innerHTML = `<span class="label"></span><span class="tally"></span>`;
      d.querySelector(".label").textContent = `${p.left} \u2192 ${p.right}`;
      d.querySelector(".tally").textContent = `${s.perPair[i]} right`;
      body.appendChild(d);
    });
  },

  hotspot: (r, body) => {
    const s = r.summary;
    body.className = "hotspotresult";
    const box = document.createElement("div");
    box.className = "hotspotbox";
    const img = document.createElement("img");
    img.src = s.image;
    img.alt = "";
    const t = document.createElement("div");
    t.className = "hottarget";
    Object.assign(t.style, { left: `${s.target.x * 100}%`, top: `${s.target.y * 100}%`, width: `${s.target.w * 100}%`, height: `${s.target.h * 100}%` });
    box.append(img, t);
    for (const p of s.points) {
      const d = document.createElement("div");
      d.className = "hotdot " + (p.correct ? "ok" : "bad");
      d.style.left = `${p.x * 100}%`;
      d.style.top = `${p.y * 100}%`;
      box.appendChild(d);
    }
    body.appendChild(box);
    const right = s.points.filter((p) => p.correct).length;
    const p = document.createElement("p");
    p.className = "answerline";
    p.textContent = s.points.length ? `${right} of ${s.points.length} tapped inside the target` : "Nobody tapped";
    body.appendChild(p);
  },

  none: (r, body) => {
    body.className = "waitnote";
    body.innerHTML = `<p class="muted">No answers to show</p>`;
  },
};

function renderBoard(ol, rows) {
  ol.innerHTML = "";
  for (const p of rows) {
    const li = document.createElement("li");
    // a team row carries its members, and its colour
    if (p.members) li.classList.add(`t${p.team}`);
    li.innerHTML = `<span><span class="who"></span><span class="members muted"></span></span><span></span>`;
    li.querySelector(".who").textContent = `${p.rank ? `#${p.rank}  ` : ""}${p.name}`;
    if (p.members) li.querySelector(".members").textContent = p.members.length ? ` ${p.members.join(", ")}` : " nobody yet";
    li.lastChild.textContent = p.members ? `${p.score} avg` : `${p.score}`;
    ol.appendChild(li);
  }
}

socket.on("game:end", (r) => {
  phase = "end";
  paused = false;
  renderPaused();
  clearSession(); // the game is over; nothing left to resume
  $("reportLink").href = r.reportId ? `reports.html#${r.reportId}` : "reports.html";
  $("reportLink").hidden = !r.reportId;
  $("replayBtn").hidden = !r.leaderboard.length || adhoc;
  const note = $("endNote");
  if (r.scoring === false) {
    // lecture mode: there are no standings to reveal, only a report to read
    $("endHeading").textContent = "That's everything";
    note.hidden = false;
    note.textContent = `${r.leaderboard.length} took part. Every answer is in the report.`;
    $("podium").innerHTML = "";
    $("finalBoard").innerHTML = "";
    $("finalBoard").hidden = true;
    show("end");
    return;
  }
  $("endHeading").textContent = "Final standings";
  note.hidden = true;
  renderBoard($("finalBoard"), r.leaderboard);
  show("end");
  runPodium(r.leaderboard);
});

// ---------- quick questions: the composer ----------
function openComposer() {
  $("askErr").textContent = "";
  $("askText").value = "";
  syncComposer();
  $("askModal").hidden = false;
  setTimeout(() => $("askText").focus(), 50);
}
function syncComposer() {
  const kind = $("askKind").value;
  const n = Number($("askCount").value);
  $("askCountField").hidden = kind !== "choice";
  $("askAnswerField").hidden = !(kind === "choice" || kind === "truefalse");
  $("askAcceptField").hidden = !(kind === "text" || kind === "numeric");
  $("askAcceptField").querySelector(".fieldlabel").textContent = kind === "numeric"
    ? "Correct number (leave blank for no right answer)" : "Accepted answer (leave blank for no right answer)";
  const sel = $("askAnswer");
  sel.innerHTML = "";
  const opts = kind === "truefalse" ? ["True", "False"] : Array.from({ length: n }, (_, i) => "ABCD"[i]);
  for (const o of opts) {
    const el = document.createElement("option");
    el.value = o; el.textContent = o;
    sel.appendChild(el);
  }
  if (kind === "choice") {
    const none = document.createElement("option");
    none.value = ""; none.textContent = "No right answer (poll)";
    sel.appendChild(none);
  }
}
$("askKind").onchange = syncComposer;
$("askCount").onchange = syncComposer;
$("askCancel").onclick = () => { $("askModal").hidden = true; };
$("askGo").onclick = () => {
  const kind = $("askKind").value;
  const time = Number($("askTime").value) || 30;
  const text = $("askText").value.trim() || `Question ${questions.length + 1}`;
  let q;
  if (kind === "choice") {
    const n = Number($("askCount").value);
    const choices = Array.from({ length: n }, (_, i) => "ABCD"[i]);
    const ans = $("askAnswer").value;
    q = ans ? { type: "choice", text, choices, answer: choices.indexOf(ans), time } : { type: "poll", text, choices, time };
  } else if (kind === "truefalse") {
    q = { type: "truefalse", text, answer: $("askAnswer").value === "True", time };
  } else if (kind === "text") {
    const accept = $("askAccept").value.trim();
    q = accept ? { type: "text", text, accept: [accept], time } : { type: "wordcloud", text, maxWords: 1, time };
  } else if (kind === "numeric") {
    const accept = $("askAccept").value.trim();
    q = accept ? { type: "numeric", text, answer: Number(accept), time } : { type: "wordcloud", text, maxWords: 1, time };
  } else if (kind === "wordcloud") {
    q = { type: "wordcloud", text, maxWords: 1, time };
  } else {
    q = { type: "longtext", text, time };
  }
  socket.emit("host:ask", q, (res) => {
    if (!res.ok) { $("askErr").textContent = res.error; return; }
    $("askModal").hidden = true;
  });
};
// ---------- homework: self-paced assignments ----------
$("assignBtn").onclick = () => {
  $("assignPanel").hidden = !$("assignPanel").hidden;
  $("assignErr").textContent = "";
};
$("assignCancel").onclick = () => { $("assignPanel").hidden = true; };
$("assignCreate").onclick = async () => {
  $("assignErr").textContent = "";
  const body = {
    quizId: $("quizSel").value, rosterId: $("rosterSel").value || null,
    dueAt: $("dueAt").value || null, scoring: !$("lectureMode").checked,
  };
  const res = await fetch("api/assignments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  if (res.error) { $("assignErr").textContent = res.error; return; }
  $("assignPanel").hidden = true;
  await loadAssignments();
  showAssignment(res);
};

function showAssignment(a) {
  $("aTitle").textContent = a.title;
  $("aCode").textContent = a.code;
  $("aJoinUrl").textContent = `${location.host}${BASE}`;
  $("aQr").src = `api/qr.svg?text=${encodeURIComponent(`${location.origin}${BASE}/?pin=${a.code}`)}`;
  const due = a.dueAt ?? a.due_at;
  $("aDue").textContent = due ? `Closes ${new Date(due).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : "Open until you close it";
  show("assignShow");
}
$("aBack").onclick = () => show("setup");

async function loadAssignments() {
  let list;
  try { list = await fetch("api/assignments").then((r) => r.json()); } catch { return; }
  const box = $("assignments");
  box.innerHTML = "";
  const open = list.filter((a) => !a.closed_at && !(a.due_at && a.due_at < Date.now()));
  if (!open.length) return;
  const h = document.createElement("h3");
  h.className = "muted";
  h.textContent = "Open homework";
  box.appendChild(h);
  for (const a of open) {
    const card = document.createElement("div");
    card.className = "assigncard";
    card.innerHTML = `<div class="assignmain"><strong class="assigntitle"></strong><span class="muted small assignmeta"></span></div><div class="row"></div>`;
    card.querySelector(".assigntitle").textContent = `${a.title} · code ${a.code}`;
    card.querySelector(".assignmeta").textContent =
      `${a.finished} finished, ${a.started - a.finished} in progress` +
      (a.due_at ? ` · closes ${new Date(a.due_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : "") +
      (a.scoring ? "" : " · lecture mode");
    const row = card.querySelector(".row");
    const showBtn = document.createElement("button");
    showBtn.textContent = "Show code";
    showBtn.onclick = () => showAssignment(a);
    const report = document.createElement("a");
    report.className = "btnlink";
    report.href = `reports.html#${a.game_id}`;
    report.textContent = "Report";
    const close = document.createElement("button");
    close.textContent = "Close";
    close.onclick = async () => {
      if (!confirm(`Close "${a.title}"? Nobody can answer after this; the report stays.`)) return;
      await fetch(`api/assignments/${encodeURIComponent(a.code)}`, { method: "DELETE" });
      loadAssignments();
    };
    row.append(showBtn, report, close);
    box.appendChild(card);
  }
}
loadAssignments();

// Reveal 3rd, then 2nd, then 1st with a drumroll between each; the full list follows.
const PODIUM_STEP_MS = 2200;
function runPodium(board) {
  const top = board.slice(0, 3);
  const box = $("podium");
  const list = $("finalBoard");
  box.innerHTML = "";
  list.hidden = true;
  if (top.length < 2) { list.hidden = false; return; } // nothing to build up to
  // One column per player, not per rank: players tied on score share a rank,
  // so keying by rank would collapse them onto one column.
  const cols = top.map((p) => {
    const c = document.createElement("div");
    c.className = `podium-col place${p.rank}`;
    c.innerHTML = `<div class="who"><span class="pname"></span><span class="pscore"></span></div><div class="block">${p.rank}</div>`;
    c.querySelector(".pname").textContent = p.name;
    c.querySelector(".pscore").textContent = `${p.score} pts`;
    return { player: p, el: c };
  });
  // columns are laid out 2nd | 1st | 3rd like a real podium
  for (const c of [cols[1], cols[0], cols[2]].filter(Boolean)) box.appendChild(c.el);

  // reveal lowest place first, and everyone sharing a place together
  const places = [...new Set(top.map((p) => p.rank))].sort((a, b) => b - a);
  places.forEach((rank, i) => {
    setTimeout(() => Sound.drumroll(1.2), i * PODIUM_STEP_MS);
    setTimeout(() => {
      for (const c of cols) if (c.player.rank === rank) c.el.classList.add("shown");
      if (rank === 1) Sound.fanfare(); else Sound.reveal();
    }, i * PODIUM_STEP_MS + 1400);
  });
  setTimeout(() => { list.hidden = false; }, places.length * PODIUM_STEP_MS + 800);
}

socket.on("game:error", (msg) => alert(msg));
socket.on("disconnect", () => {
  // the server holds the room open, and tryResume() runs on reconnect
  if (!pin) return;
  clearInterval(timerHandle);
  $("hostPin").textContent = `PIN ${pin} · reconnecting…`;
});
socket.on("connect", () => { if (pin) $("hostPin").textContent = `PIN ${pin}`; });
