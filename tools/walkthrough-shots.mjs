#!/usr/bin/env node
// Recapture every screenshot in docs/teaching-with-tigerquiz.md by playing a
// real game: a headless browser is the host at the front of the room, and four
// players join over websockets the way phones do.
//
//   bin/rails db:seed                 # the all-types quiz and period3 class list
//   bin/rails server -p 3999          # in one terminal
//   node tools/walkthrough-shots.mjs  # in another
//
// BASE=http://host:port points it elsewhere; CHROME=/path/to/chromium picks the
// browser. The host shots are 2560x1440 and the phone shot 1170x2340, matching
// what a projector and a phone actually show.
//
// Point BASE at this machine's network address rather than 127.0.0.1, and serve
// with `-b 0.0.0.0`. The lobby warns, correctly, that students cannot reach a
// loopback address, and that warning has no business in a teaching guide.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:3999";
const WS = BASE.replace(/^http/, "ws") + "/cable";
const ORIGIN = process.env.ORIGIN || new URL(BASE).origin;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "docs", "images");
const HOST_VIEW = { width: 1280, height: 720, scale: 2 };
const PHONE_VIEW = { width: 390, height: 780, scale: 3, mobile: true };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = [];
async function capture(tab, name, opts = {}) {
  await tab.shot(path.join(OUT, name), opts);
  shots.push(name);
  console.log(`  captured ${name}`);
}

// ---------- players, over the same websocket a phone uses ----------
let cookie = "";
let csrf = "";
// Load a page first: Rails wants the session cookie and the CSRF token from it
// on anything that is not a GET, exactly as the browser would send them.
async function page(pathname) {
  const r = await fetch(BASE + pathname, { headers: { cookie } });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const m = (await r.text()).match(/name="csrf-token" content="([^"]+)"/);
  if (m) csrf = m[1];
  return r.status;
}

async function post(pathname, body) {
  const r = await fetch(BASE + pathname, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(body),
  });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(`${pathname} answered with ${r.status}, not JSON`); }
}

function cable(params) {
  const ws = new WebSocket(WS, { protocols: ["actioncable-v1-json"], headers: { Origin: ORIGIN } });
  const identifier = JSON.stringify({ channel: "GameChannel", ...params });
  const events = [];
  const waiters = [];
  const conn = {
    events,
    perform: (action, data = {}) => ws.send(JSON.stringify({ command: "message", identifier, data: JSON.stringify({ action, ...data }) })),
    next: (event) => new Promise((resolve) => {
      const found = events.find((e) => e.event === event && !e._taken);
      if (found) { found._taken = true; return resolve(found); }
      waiters.push({ event, resolve });
    }),
    close: () => ws.close(),
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ command: "subscribe", identifier }));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === "confirm_subscription") return resolve(conn);
      if (msg.type === "reject_subscription") return reject(new Error("subscription rejected"));
      if (!msg.message) return;
      const e = msg.message;
      const w = waiters.findIndex((x) => x.event === e.event);
      if (w >= 0) { waiters.splice(w, 1)[0].resolve(e); e._taken = true; }
      events.push(e);
    };
    ws.onerror = () => reject(new Error("websocket failed"));
  });
}

/** Send one answer and wait for the server to say it took it. */
async function answer(player, who, response) {
  player.perform("answer", { response });
  const ack = await player.next("answer:ack");
  if (!ack.ok) throw new Error(`${who} could not answer: ${ack.error}`);
}

/** The right answer, in the shape the phone sends and the order it was shown. */
function correctResponse(source, question) {
  switch (source.type || "choice") {
    case "choice": return source.answer;
    case "truefalse": return source.answer === true || source.answer === 0 ? 0 : 1;
    case "multi": return source.answers;
    case "slider": return source.answer;
    case "text": return source.accept[0];
    case "poll": return 0;
    case "wordcloud": return [ "clear" ];
    // items are shuffled per game: put each one back where the source has it
    case "order": return source.items.map((label) => question.items.indexOf(label));
    default: return null;
  }
}

// ---------- the walkthrough ----------
const browser = await launch();
const host = await browser.tab();
console.log(`driving ${BASE}`);

await host.open(`${BASE}/host`, HOST_VIEW);
await host.until(`document.getElementById("quizSel").options.length > 0`);
await host.eval(`
  const q = document.getElementById("quizSel"), r = document.getElementById("rosterSel");
  q.value = "all-types"; r.value = "period3";
  q.dispatchEvent(new Event("change")); r.dispatchEvent(new Event("change")); true;
`);
await capture(host, "01-choose-quiz.png");

await host.eval(`document.getElementById("createBtn").click(); true`);
await host.until(`document.getElementById("lobby").classList.contains("active")`);
const pin = await host.eval(`document.getElementById("lobbyPin").textContent.trim()`);
console.log(`  game ${pin}`);

// the join screen a student sees, with the PIN already filled in by the QR code
const phone = await browser.tab();
await phone.open(`${BASE}/?pin=${pin}`, PHONE_VIEW);
await phone.until(`!document.getElementById("ident").hidden`);
await phone.eval(`
  document.getElementById("name").value = "Ada";
  document.getElementById("ident").value = "1001"; true;
`);
await capture(phone, "03-student-join.png");
// gone for good: a tab left open would keep the host's in the background
await phone.close();
await host.front();

// Katherine Johnson stays away on purpose: the report names who never played.
const roster = [
  { nick: "Ada", id: "1001" }, { nick: "Alan", id: "1002" },
  { nick: "Grace", id: "1003" }, { nick: "Charlie", id: "1005" },
];
const players = {};
await page("/");
for (const { nick, id } of roster) {
  const res = await post("/api/join", { pin, name: nick, identifier: id });
  if (!res.ok) throw new Error(`${nick} could not join: ${res.error}`);
  players[nick] = await cable({ pin, role: "player", name: res.name, token: res.token });
}
await host.until(`document.querySelectorAll("#players .chip, #players > *").length >= 4`);
await capture(host, "02-lobby.png");

const source = await fetch(`${BASE}/api/quiz/all-types`, { headers: { cookie } }).then((r) => r.json());
const questions = source.questions;

await host.eval(`document.getElementById("startBtn").click(); true`);
await host.until(`document.getElementById("question").classList.contains("active")`);
await Promise.all(Object.values(players).map((p) => p.next("game:question")));
await capture(host, "04-slide.png");

for (let i = 1; i < questions.length; i++) {
  const q = questions[i];
  await host.eval(`document.getElementById("nextBtn").click(); true`);
  const [ shown ] = await Promise.all(Object.values(players).map((p) => p.next("game:question")));

  // Everybody answers the first real question, so the results screen has a
  // distribution worth reading. After that only Ada does, which leaves the
  // other three level on nothing and sharing a place at the end.
  if (i === 1) {
    // two for Venus, so the results screen has a wrong answer the class landed
    // on rather than a flat spread, which is the thing worth reading off it
    await answer(players.Alan, "Alan", 0);
    await answer(players.Grace, "Grace", 0);
    await host.until(`document.getElementById("qAnswered").textContent.startsWith("2 /")`);
    await capture(host, "05-question-live.png");
    await answer(players.Charlie, "Charlie", 2);
  }
  const right = correctResponse(q, shown);
  if (right !== null) await answer(players.Ada, "Ada", right);

  if (i === 1) {
    await host.until(`document.getElementById("results").classList.contains("active")`);
    await sleep(1200); // let the bars finish growing
    await capture(host, "06-results.png");
  } else {
    await host.eval(`document.getElementById("skipBtn").click(); true`);
    await host.until(`document.getElementById("results").classList.contains("active") || document.getElementById("question").classList.contains("active")`);
  }
}

await host.eval(`document.getElementById("nextBtn").click(); true`);
await host.until(`document.getElementById("end").classList.contains("active")`);
await host.until(`!document.getElementById("finalBoard").hidden`, { ms: 30000 });
await sleep(800);
await capture(host, "07-podium.png");

const board = await host.eval(`[...document.querySelectorAll("#finalBoard li")].map((li) => li.textContent.trim())`);
console.log("  final board:", JSON.stringify(board));
Object.values(players).forEach((p) => p.close());

// ---------- afterwards ----------
const reports = await host.tab === undefined ? null : null;
await host.open(`${BASE}/reports`, HOST_VIEW);
await host.until(`document.querySelectorAll("#gamesPane .card, #gamesPane li, #gamesPane > *").length > 0`);
await sleep(400);
await capture(host, "08-reports-list.png", { full: true });

await host.eval(`(document.querySelector("#gamesPane .card") || document.querySelector("#gamesPane a") || document.querySelector("#gamesPane > *")).click(); true`);
await sleep(1200);
await capture(host, "09-report-detail.png", { full: true });

await host.open(`${BASE}/reports`, HOST_VIEW);
await host.until(`document.getElementById("tabStudents")`);
await host.eval(`document.getElementById("tabStudents").click(); true`);
await sleep(1200);
await capture(host, "10-students-across-games.png", { full: true });

host.close();
await browser.close();
console.log(`\nwrote ${shots.length} screenshots to docs/images/`);
