const SYMS = ["▲", "◆", "●", "■"];
// Returns any for the same reason as edit.js: nearly every caller reaches for
// .value, .src or .disabled on the result. See docs/typing.md before tightening.
/** @param {string} id @returns {any} */
const $ = (id) => document.getElementById(id);
const show = (id) => {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
};

// served from "/" directly, or from a sub-path behind a reverse proxy
const BASE = location.pathname.replace(/\/[^/]*$/, "");
const socket = io({ path: `${BASE}/socket.io` });
let me = null;
let timerHandle = null;
let pending = null; // answer being composed for types with a Submit button
let paused = false;
let lastQuestion = null;

function renderPaused() {
  $("pausedBanner").hidden = !paused;
  document.body.classList.toggle("is-paused", paused);
}

// prefill PIN from ?pin=
const params = new URLSearchParams(location.search);
if (params.get("pin")) $("pin").value = params.get("pin");
try {
  const saved = JSON.parse(sessionStorage.getItem("tigerquiz") || "null");
  if (saved) { $("pin").value = saved.pin; $("name").value = saved.name; if (saved.identifier) $("ident").value = saved.identifier; }
} catch {}

// ---------- joining ----------
// Look the game up as soon as a full PIN is typed, so we know whether this
// quiz asks for a student name or ID before the player hits Join.
let lookupTimer = null;
function lookup() {
  const pin = $("pin").value.trim();
  if (pin.length < 4) { $("gameTitle").textContent = ""; $("ident").hidden = true; return; }
  socket.emit("player:lobby", { pin }, (res) => {
    if (!res.ok) { $("gameTitle").textContent = ""; $("ident").hidden = true; return; }
    // say what kind of thing this code opens, so nobody is surprised after joining
    let title = res.title;
    if (res.closed) title += " · closed";
    else if (res.selfPaced) title += " · homework, at your own pace";
    else if (res.started) title += " · already started, you can still join";
    $("gameTitle").textContent = title;
    $("ident").hidden = !res.identifier;
    if (res.identifier) $("ident").placeholder = res.identifier;
  });
}
$("pin").addEventListener("input", () => { clearTimeout(lookupTimer); lookupTimer = setTimeout(lookup, 250); });
if ($("pin").value) lookup();

function join() {
  const pin = $("pin").value.trim();
  const name = $("name").value.trim();
  const identifier = $("ident").hidden ? "" : $("ident").value.trim();
  $("joinErr").textContent = "";
  socket.emit("player:join", { pin, name, identifier }, (res) => {
    if (!res.ok) { $("joinErr").textContent = res.error; return; }
    me = { pin, name: res.name, identifier, selfPaced: !!res.selfPaced, uploadToken: res.uploadToken || null, team: res.team || null };
    try { sessionStorage.setItem("tigerquiz", JSON.stringify({ pin, name: res.name, identifier })); } catch {}
    $("me").textContent = `${res.name} · ${pin}`;
    $("waitName").textContent = res.name;
    const wt = $("waitTeam");
    wt.hidden = !res.team;
    if (res.team) { wt.textContent = `You're on ${res.team.name}`; wt.className = `teamline t${res.team.index}`; }
    if (res.state === "question" && res.question) {
      if (res.answered) show("answered");
      else renderQuestion(res.question);
    } else if (res.state === "end") {
      if (res.end) renderEnd(res.end); else show("end");
    } else {
      show("wait");
    }
  });
}
// offer a name rather than making everyone invent one
$("diceBtn").onclick = async () => {
  try {
    const res = await fetch("api/nickname").then((r) => r.json());
    if (res.name) { $("name").value = res.name; $("joinErr").textContent = ""; }
  } catch { /* offline; the player can type their own */ }
};

$("joinBtn").onclick = join;
$("name").addEventListener("keydown", (e) => e.key === "Enter" && join());
$("ident").addEventListener("keydown", (e) => e.key === "Enter" && join());
$("pin").addEventListener("keydown", (e) => e.key === "Enter" && $("name").focus());
$("againBtn").onclick = () => { me = null; show("join"); };

// ---------- answer inputs, one builder per question type ----------
const PROMPTS = {
  choice: "", truefalse: "", multi: "Pick every correct answer", poll: "Your opinion, no wrong answer",
  slider: "Drag to your best guess", numeric: "Type a number", text: "Type your answer", wordcloud: "Type a word",
  blank: "Fill in the blanks", order: "Tap the items in the right order", match: "Tap an item, then its match",
  hotspot: "Tap the right spot on the picture", longtext: "Write your answer", file: "Hand in a photo or a PDF", slide: "",
};
/** What a question's point multiplier is called on the phone. */
const WEIGHT_NOTE = { 0: "No points for this one", 0.5: "Half points", 2: "Double points!" };

function renderQuestion(q) {
  const area = $("answerArea");
  area.className = "";
  area.innerHTML = "";
  pending = null;
  paused = !!q.paused;
  renderPaused();

  // the quiz can mirror the question onto phones, for anyone who cannot read the projector
  const t = $("qText");
  t.hidden = !q.text;
  t.textContent = q.text || "";
  const img = $("qImage");
  img.hidden = !q.image || q.type === "hotspot";
  img.src = q.image || "";
  // a second vote on the same question, after the class has discussed it
  const notes = [];
  if (q.revote) notes.push("Discuss, then answer again");
  else if (PROMPTS[q.type]) notes.push(PROMPTS[q.type]);
  if (q.media) notes.push(q.media.kind === "audio" ? "Listen on the host screen" : "Watch the host screen");
  if (q.weight != null && q.weight !== 1 && WEIGHT_NOTE[q.weight]) notes.push(WEIGHT_NOTE[q.weight]);
  if (q.anonymous) notes.push("Anonymous: your name is not recorded");
  $("prompt").textContent = notes.join(" · ");
  $("submitRow").hidden = true;
  $("submitBtn").disabled = true;
  $("submitBtn").textContent = "Submit";

  const builder = BUILDERS[q.type] || BUILDERS.choice;
  builder(q, area);

  if (q.index != null) $("qCount").textContent = `Q${q.index + 1} / ${q.total}`;
  // homework has no clock to race; the bar just sits full
  startTimer(q.selfPaced ? null : q.endsAt, q.totalMs);
  show("question");
}

const BUILDERS = {
  choice: (q, area) => buildButtons(q, area, (i) => answer(i)),
  truefalse: (q, area) => buildButtons(q, area, (i) => answer(i)),
  poll: (q, area) => buildButtons(q, area, (i) => answer(i)),

  multi: (q, area) => {
    const chosen = new Set();
    const grid = buildButtons(q, area, null);
    [...grid.children].forEach((/** @type {any} */ b, i) => {
      b.onclick = () => {
        chosen.has(i) ? chosen.delete(i) : chosen.add(i);
        b.classList.toggle("picked", chosen.has(i));
        pending = [...chosen];
        $("submitBtn").disabled = chosen.size === 0;
      };
    });
    $("submitRow").hidden = false;
  },

  slider: (q, area) => {
    area.className = "pad";
    const wrap = document.createElement("div");
    wrap.className = "sliderbox";
    const out = document.createElement("div");
    out.className = "sliderval";
    const input = document.createElement("input");
    input.type = "range";
    input.min = q.min; input.max = q.max; input.step = q.step;
    input.value = String(Math.round((q.min + q.max) / 2 / q.step) * q.step);
    const ends = document.createElement("div");
    ends.className = "sliderends muted";
    ends.innerHTML = `<span></span><span></span>`;
    ends.firstChild.textContent = `${q.min}${q.unit ? " " + q.unit : ""}`;
    ends.lastChild.textContent = `${q.max}${q.unit ? " " + q.unit : ""}`;
    const sync = () => { out.textContent = `${input.value}${q.unit ? " " + q.unit : ""}`; pending = Number(input.value); };
    input.oninput = sync;
    sync();
    $("submitBtn").disabled = false;
    wrap.append(out, input, ends);
    area.appendChild(wrap);
    $("submitRow").hidden = false;
  },

  text: (q, area) => {
    area.className = "pad";
    const input = document.createElement("input");
    input.className = "answerinput";
    input.placeholder = "Your answer";
    input.maxLength = 80;
    input.autocomplete = "off";
    input.oninput = () => { pending = input.value; $("submitBtn").disabled = !input.value.trim(); };
    input.onkeydown = (e) => { if (e.key === "Enter" && input.value.trim()) submit(); };
    area.appendChild(input);
    $("submitRow").hidden = false;
    setTimeout(() => input.focus(), 50);
  },

  numeric: (q, area) => {
    area.className = "pad";
    const wrap = document.createElement("div");
    wrap.className = "numericbox";
    const input = document.createElement("input");
    input.className = "answerinput";
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = q.unit ? `Number in ${q.unit}` : "Your number";
    input.autocomplete = "off";
    const valid = () => input.value.trim() !== "" && Number.isFinite(Number(input.value.trim().replace(/,/g, "")));
    input.oninput = () => { pending = valid() ? input.value.trim() : null; $("submitBtn").disabled = !valid(); };
    input.onkeydown = (e) => { if (e.key === "Enter" && valid()) submit(); };
    wrap.appendChild(input);
    if (q.unit) {
      const u = document.createElement("span");
      u.className = "unit muted";
      u.textContent = q.unit;
      wrap.appendChild(u);
    }
    area.appendChild(wrap);
    $("submitRow").hidden = false;
    setTimeout(() => input.focus(), 50);
  },

  blank: (q, area) => {
    area.className = "pad";
    const inputs = [];
    const update = () => {
      const vals = inputs.map((x) => x.value.trim());
      pending = vals.some(Boolean) ? vals : null;
      $("submitBtn").disabled = !pending;
    };
    const makeInput = (i) => {
      const input = document.createElement("input");
      input.className = "blankinput";
      input.placeholder = q.blanks > 1 ? `Blank ${i + 1}` : "Your answer";
      input.maxLength = 60;
      input.autocomplete = "off";
      input.oninput = update;
      input.onkeydown = (e) => {
        if (e.key !== "Enter") return;
        // Enter moves to the next gap, and submits from the last one
        if (i + 1 < inputs.length) inputs[i + 1].focus();
        else if (pending) submit();
      };
      inputs.push(input);
      return input;
    };
    if (q.parts) {
      // the sentence itself, with an input sitting in each gap
      const p = document.createElement("p");
      p.className = "blanktext";
      q.parts.forEach((part, i) => {
        p.appendChild(document.createTextNode(part));
        if (i < q.parts.length - 1) p.appendChild(makeInput(i));
      });
      $("qText").hidden = true; // the sentence is rendered here instead
      area.appendChild(p);
    } else {
      for (let i = 0; i < q.blanks; i++) {
        const input = makeInput(i);
        input.className = "answerinput";
        area.appendChild(input);
      }
    }
    $("submitRow").hidden = false;
    setTimeout(() => inputs[0].focus(), 50);
  },

  longtext: (q, area) => {
    area.className = "pad";
    const ta = document.createElement("textarea");
    ta.className = "longinput";
    ta.placeholder = "Write your answer";
    ta.maxLength = q.maxLength || 500;
    ta.rows = 6;
    const count = document.createElement("div");
    count.className = "muted small charcount";
    const sync = () => {
      pending = ta.value.trim() ? ta.value : null;
      $("submitBtn").disabled = !pending;
      count.textContent = `${ta.value.length} / ${ta.maxLength}`;
    };
    ta.oninput = sync;
    sync();
    area.append(ta, count);
    $("submitRow").hidden = false;
    setTimeout(() => ta.focus(), 50);
  },

  match: (q, area) => {
    area.className = "matchbox";
    const n = q.lefts.length;
    const pairs = new Array(n).fill(null); // left index -> right index
    let activeLeft = null;
    const leftCol = document.createElement("div");
    leftCol.className = "matchcol";
    const rightCol = document.createElement("div");
    rightCol.className = "matchcol";
    const mk = (label, cls) => {
      const b = document.createElement("button");
      b.className = `matchitem ${cls}`;
      b.innerHTML = `<span class="pos"></span><span class="label"></span>`;
      b.querySelector(".label").textContent = label;
      return b;
    };
    const lefts = q.lefts.map((label) => mk(label, "left"));
    const rights = q.rights.map((label) => mk(label, "right"));
    const redraw = () => {
      lefts.forEach((b, i) => {
        b.classList.toggle("active", activeLeft === i);
        b.classList.toggle("paired", pairs[i] != null);
        b.querySelector(".pos").textContent = pairs[i] != null ? String(i + 1) : "";
      });
      rights.forEach((b, j) => {
        const i = pairs.indexOf(j);
        b.classList.toggle("paired", i >= 0);
        b.querySelector(".pos").textContent = i >= 0 ? String(i + 1) : "";
      });
      const done = pairs.every((p) => p != null);
      pending = done ? [...pairs] : null;
      $("submitBtn").disabled = !done;
      $("submitBtn").textContent = done ? "Submit" : `${pairs.filter((p) => p == null).length} left to match`;
    };
    lefts.forEach((b, i) => {
      b.onclick = () => {
        if (pairs[i] != null) { pairs[i] = null; activeLeft = i; }
        else activeLeft = activeLeft === i ? null : i;
        redraw();
      };
      leftCol.appendChild(b);
    });
    rights.forEach((b, j) => {
      b.onclick = () => {
        const had = pairs.indexOf(j);
        if (had >= 0) { pairs[had] = null; activeLeft = had; redraw(); return; }
        if (activeLeft == null) {
          // no left item chosen yet: pick the first unmatched one for them
          activeLeft = pairs.indexOf(null);
          if (activeLeft < 0) return;
        }
        pairs[activeLeft] = j;
        activeLeft = pairs.indexOf(null) >= 0 ? pairs.indexOf(null) : null;
        redraw();
      };
      rightCol.appendChild(b);
    });
    activeLeft = 0;
    redraw();
    area.append(leftCol, rightCol);
    $("submitRow").hidden = false;
  },

  file: (q, area) => {
    area.className = "pad center";
    const wrap = document.createElement("div");
    wrap.className = "filebox";
    const input = document.createElement("input");
    input.type = "file";
    input.id = "fileInput";
    input.hidden = true;
    input.accept = q.accept === "image" ? "image/*" : "image/*,application/pdf";
    const pick = document.createElement("button");
    pick.className = "primary big";
    pick.textContent = q.accept === "image" ? "Take or choose a photo" : "Choose a photo or PDF";
    pick.onclick = () => input.click();
    const status = document.createElement("div");
    status.className = "muted filestatus";
    status.textContent = "Nothing chosen yet";
    const thumb = document.createElement("img");
    thumb.className = "filethumb";
    thumb.hidden = true;
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      pending = null;
      $("submitBtn").disabled = true;
      if (!me?.uploadToken) { status.textContent = "Join again to upload"; return; }
      status.textContent = `Uploading ${f.name}…`;
      try {
        const res = await fetch(`uploads/${encodeURIComponent(me.uploadToken)}`, {
          method: "POST", body: f, headers: { "Content-Type": f.type || "application/octet-stream", "X-File-Name": encodeURIComponent(f.name) },
        }).then((r) => r.json());
        if (!res.ok) throw new Error(res.error || "Upload failed");
        pending = { file: res.id, name: res.name, type: res.type };
        status.textContent = `${f.name} uploaded. Submit when you're ready.`;
        if (f.type.startsWith("image/")) { thumb.src = URL.createObjectURL(f); thumb.hidden = false; }
        $("submitBtn").disabled = false;
      } catch (e) {
        status.textContent = e.message;
      }
    };
    wrap.append(input, pick, status, thumb);
    area.appendChild(wrap);
    $("submitRow").hidden = false;
  },

  hotspot: (q, area) => {
    area.className = "pad center";
    const box = document.createElement("div");
    box.className = "hotspotbox";
    const img = document.createElement("img");
    img.src = q.image;
    img.alt = "";
    img.draggable = false;
    const dot = document.createElement("div");
    dot.className = "hotdot";
    dot.hidden = true;
    box.append(img, dot);
    box.onclick = (e) => {
      const r = img.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const x = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
      const y = Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1);
      dot.style.left = `${x * 100}%`;
      dot.style.top = `${y * 100}%`;
      dot.hidden = false;
      pending = { x, y };
      $("submitBtn").disabled = false;
    };
    area.appendChild(box);
    $("submitRow").hidden = false;
  },

  wordcloud: (q, area) => {
    area.className = "pad";
    const inputs = [];
    for (let i = 0; i < (q.maxWords || 1); i++) {
      const input = document.createElement("input");
      input.className = "answerinput";
      input.placeholder = q.maxWords > 1 ? `Word ${i + 1}` : "One word";
      input.maxLength = 30;
      input.autocomplete = "off";
      input.oninput = () => {
        pending = inputs.map((x) => x.value.trim()).filter(Boolean);
        $("submitBtn").disabled = pending.length === 0;
      };
      inputs.push(input);
      area.appendChild(input);
    }
    $("submitRow").hidden = false;
    setTimeout(() => inputs[0].focus(), 50);
  },

  order: (q, area) => {
    area.className = "orderlist";
    const picked = [];
    const buttons = q.items.map((label, i) => {
      const b = document.createElement("button");
      b.className = "orderitem";
      b.innerHTML = `<span class="pos"></span><span class="label"></span>`;
      b.querySelector(".label").textContent = label;
      b.onclick = () => {
        const at = picked.indexOf(i);
        if (at >= 0) picked.splice(at, 1); else picked.push(i);
        redraw();
      };
      area.appendChild(b);
      return b;
    });
    const redraw = () => {
      buttons.forEach((b, i) => {
        const at = picked.indexOf(i);
        b.classList.toggle("picked", at >= 0);
        b.querySelector(".pos").textContent = at >= 0 ? at + 1 : "";
      });
      pending = picked.length === q.items.length ? [...picked] : null;
      $("submitBtn").disabled = !pending;
      $("submitBtn").textContent = pending ? "Submit" : `Tap ${q.items.length - picked.length} more`;
    };
    redraw();
    $("submitRow").hidden = false;
  },

  slide: (q, area) => {
    area.className = "pad center";
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Look at the host screen.";
    area.appendChild(p);
  },
};

/** The shared coloured-button grid used by every choice-shaped type. */
function buildButtons(q, area, onClick) {
  const n = typeof q.choices === "number" ? q.choices : q.choices.length;
  const grid = document.createElement("div");
  grid.className = "grid" + (n === 2 ? " two" : "");
  for (let i = 0; i < n; i++) {
    const b = document.createElement("button");
    b.className = `choice c${i}`;
    b.innerHTML = `<span class="sym">${SYMS[i] ?? i + 1}</span>`;
    // labels are shown when knowing them cannot give the answer away
    if (q.labels && q.labels[i]) {
      const t = document.createElement("span");
      t.className = "tf";
      t.textContent = q.labels[i];
      b.appendChild(t);
    }
    if (onClick) b.onclick = () => onClick(i);
    grid.appendChild(b);
  }
  area.appendChild(grid);
  return grid;
}

$("submitBtn").onclick = () => submit();
function submit() {
  if (pending == null) return;
  answer(pending);
}

/** totalMs keeps the bar proportional to the whole question, not to what is left. */
function startTimer(endsAt, totalMs) {
  clearInterval(timerHandle);
  if (!endsAt) {
    $("qTimer").textContent = paused ? "paused" : "";
    if (!paused) $("qBar").style.width = "100%";
    return;
  }
  const total = Math.max(totalMs || endsAt - Date.now(), 1);
  const tick = () => {
    const left = Math.max(endsAt - Date.now(), 0);
    $("qTimer").textContent = Math.ceil(left / 1000);
    $("qBar").style.width = (left / total) * 100 + "%";
    if (left <= 0) clearInterval(timerHandle);
  };
  tick();
  timerHandle = setInterval(tick, 250);
}

function answer(response) {
  if (paused) { $("status").textContent = "The host paused the game"; return; }
  socket.emit("player:answer", response, (res) => {
    if (!res.ok) { $("status").textContent = res.error; return; }
    // homework grades on the spot: the result comes back with the acknowledgement
    if (res.result) { renderResult(res.result); return; }
    // The last answer ends the question, and the server sends the results
    // before it acknowledges the answer. By the time this runs the result
    // screen may already be up, and must not be covered by "locked in".
    if (!$("question").classList.contains("active")) return;
    $("answeredTitle").textContent = "Answer locked in";
    show("answered");
  });
}

// homework: the student decides when to move on
$("nextBtn").onclick = () => {
  $("nextBtn").disabled = true;
  socket.emit("player:next", (res) => {
    $("nextBtn").disabled = false;
    if (!res.ok) { $("status").textContent = res.error; return; }
    if (res.question) renderQuestion(res.question);
    else renderEnd(res.end);
  });
};

socket.on("game:question", (q) => { lastQuestion = q; renderQuestion(q); });

socket.on("game:paused", (p) => {
  paused = p.paused;
  renderPaused();
  if (paused) clearInterval(timerHandle);
  else startTimer(p.endsAt, lastQuestion ? lastQuestion.totalMs : null);
});

// the host's screen dropped off; the server is holding the game open for them
socket.on("game:hostaway", ({ away }) => {
  $("status").textContent = away ? "Waiting for the host to reconnect…" : "";
});

socket.on("game:results", renderResult);

function renderResult(r) {
  clearInterval(timerHandle);
  const box = $("resultBox");
  const partial = r.ratio > 0 && r.correct !== true;
  const scoring = r.scoring !== false;
  $("nextBtn").hidden = !r.selfPaced;
  $("nextBtn").textContent = r.isLast ? "See how you did" : "Next question";

  const answerLine = $("resultAnswer");
  answerLine.textContent = "";

  if (r.unscored) {
    box.className = "fill result-neutral";
    $("resultTitle").textContent = r.answered ? "Thanks!" : "No answer";
    $("resultPts").textContent = r.answered ? "Your response is on the host screen" : "";
    if (r.yourAnswer) answerLine.textContent = `You said ${r.yourAnswer}`;
  } else {
    box.className = "fill " + (r.correct ? "result-ok" : partial ? "result-part" : "result-bad");
    // not answering is not the same as being slow: the host can end a question
    // while somebody is still thinking, and blaming them for that is unfair
    const noAnswer = r.endedBy === "host" ? "No answer" : "Time's up";
    $("resultTitle").textContent = r.correct ? "Correct!" : partial ? "Close!" : !r.answered ? noAnswer : "Wrong";
    const total = r.gained + (r.bonus || 0);
    $("resultPts").textContent = scoring && total > 0 ? `+${total} points` : "";
    // always both halves: the right answer alone leaves them guessing what they
    // picked, and with phoneText off they never saw the question either
    const lines = [];
    if (r.yourAnswer) lines.push(`You said ${r.yourAnswer}`);
    if (r.answer && !r.correct) lines.push(`The answer was ${r.answer.label}`);
    answerLine.textContent = lines.join(" · ");
  }

  const streak = $("resultStreak");
  streak.hidden = !(scoring && r.correct && r.streak >= 2);
  if (!streak.hidden) streak.textContent = `🔥 ${r.streak} in a row` + (r.bonus ? ` · +${r.bonus} bonus` : "");

  const ex = $("resultExplain");
  ex.hidden = !r.explanation;
  ex.textContent = r.explanation || "";

  const tl = $("resultTeam");
  tl.hidden = !(scoring && r.team);
  if (!tl.hidden) {
    tl.className = `teamline t${r.team.index}`;
    tl.textContent = `${r.team.name}: ${r.team.score} pts` + (r.team.rank ? ` · team rank #${r.team.rank}` : "");
  }

  // lecture mode and homework have no standings to report between questions
  if (!scoring || r.selfPaced) {
    $("resultRank").textContent = scoring && r.selfPaced ? `${r.score} pts so far` : "";
    $("resultGap").textContent = "";
    show("result");
    return;
  }
  const moved = (r.prevRank ?? r.rank) - r.rank;
  const movement = moved > 0 ? ` · up ${moved} place${moved > 1 ? "s" : ""}` : moved < 0 ? ` · down ${-moved}` : "";
  $("resultRank").textContent = `Rank #${r.rank} · ${r.score} pts${movement}`;

  // being level is reported here rather than in the gap, which now always
  // points at somebody genuinely ahead
  const level = r.levelWith || [];
  const bits = [];
  if (level.length === 1) bits.push(`Level with ${level[0]}`);
  else if (level.length > 1) bits.push(`Level with ${level.length} others`);
  if (r.ahead) bits.push(`${r.ahead.gap} pts behind ${r.ahead.name}`);
  else if (!bits.length && r.rank === 1) bits.push(r.score > 0 ? "You're in the lead!" : "Nobody has scored yet");
  $("resultGap").textContent = bits.join(" · ");
  show("result");
}

socket.on("game:end", renderEnd);

function renderEnd(r) {
  clearInterval(timerHandle);
  const scoring = r.scoring !== false;
  const homework = me?.selfPaced;
  $("endHeading").textContent = homework ? "All done" : "Game over";
  // no points means no rank; say thank you and leave it there
  $("endRank").textContent = scoring && r.rank ? `#${r.rank} of ${r.players}` : (scoring ? "" : "Thanks for taking part");
  $("endScore").textContent = scoring ? `${r.score} points` : "";
  const note = $("endNote");
  note.hidden = !(homework || (scoring && r.team));
  if (homework) {
    note.textContent = scoring && r.players > 1
      ? `Ranked among the ${r.players} who have finished so far. Your answers are saved.`
      : "Your answers are saved.";
  } else if (scoring && r.team) {
    note.textContent = `${r.team.name} finished ${r.team.rank === 1 ? "first" : `#${r.team.rank}`} with ${r.team.score} pts per player`;
  }
  show("end");
}

socket.on("game:restarted", () => {
  clearInterval(timerHandle);
  paused = false;
  renderPaused();
  $("status").textContent = "";
  if (me) show("wait");
});

socket.on("game:closed", () => { $("status").textContent = "Host ended the game"; show("join"); });
socket.on("game:kicked", () => { $("status").textContent = "You were removed by the host"; me = null; show("join"); });
socket.on("disconnect", () => { $("status").textContent = "Reconnecting…"; });
socket.on("connect", () => {
  $("status").textContent = "";
  if (me) join(); // auto-rejoin after a dropped connection
});
