// End-to-end tests: start the server, then play real games over websockets.
//   npm test
// Covers every question type, scoring, streaks, class lists and reporting.
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { io } from "socket.io-client";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = process.env.TEST_PORT || 3111;
const URL = `http://localhost:${PORT}`;
const DATA = path.join(ROOT, "data", "test-run");

const once = (s, ev) => new Promise((r) => s.once(ev, r));
const emit = (s, ev, ...a) => new Promise((r) => s.emit(ev, ...a, r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const fail = [];
let count = 0;
function check(name, cond, extra = "") {
  count += 1;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? `  (${extra})` : ""}`);
  if (!cond) fail.push(name);
}

// ---------- server under test ----------
await rm(DATA, { recursive: true, force: true });
const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TIGERQUIZ_DATA: DATA },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
  server.stdout.on("data", (d) => {
    if (String(d).includes("listening")) { clearTimeout(timer); resolve(); }
  });
});

try {
  await testQuestionTypes();
  await testRoster();
  await testValidation();
  await testPauseAndNavigation();
  await testHostReconnect();
  await testPhoneText();
} catch (e) {
  console.error("\nthrew:", e.message);
  fail.push(e.message);
}

server.kill();
await rm(DATA, { recursive: true, force: true });
console.log(`\n${count - fail.length}/${count} passed`);
if (fail.length) { console.error(`FAILED: ${fail.join(", ")}`); process.exit(1); }

// ---------- suites ----------
async function testQuestionTypes() {
  console.log("\n# question types, scoring and reports");
  const host = io(URL);
  await once(host, "connect");
  host.on("game:error", (m) => { throw new Error(`server refused: ${m}`); });

  const game = await emit(host, "host:create", { quizId: "all-types" });
  check("create a game", game.ok === true, game.error);
  check("quiz asks for an identifier", game.identifier === "Student ID");

  const peek = io(URL);
  await once(peek, "connect");
  const lobby = await emit(peek, "player:lobby", { pin: game.pin });
  check("lobby lookup reports what to ask for", lobby.ok && lobby.identifier === "Student ID");
  const noIdent = await emit(peek, "player:join", { pin: game.pin, name: "sneak" });
  check("identifier is required to join", noIdent.ok === false, noIdent.error);
  peek.close();

  const players = [];
  for (const [nick, id] of [["ada", "1001"], ["alan", "1002"], ["grace", "1003"]]) {
    const s = io(URL);
    await once(s, "connect");
    const res = await emit(s, "player:join", { pin: game.pin, name: nick, identifier: id });
    check(`${nick} joins`, res.ok === true, res.error);
    const p = { name: nick, s, results: [] };
    s.on("game:results", (r) => p.results.push(r));
    players.push(p);
  }

  const hostRs = [];
  host.on("game:results", (r) => hostRs.push(r));

  const TRUE_ORDER = ["Moon landing", "Fall of the Berlin Wall", "First iPhone", "COVID-19 pandemic"];
  const rightOrder = (q) => TRUE_ORDER.map((label) => q.items.indexOf(label));
  // ada answers everything correctly, alan partially, grace wrongly
  const PLAN = {
    choice: { ada: (q) => q.choices.indexOf("Mars"), alan: (q) => q.choices.indexOf("Mars"), grace: (q) => q.choices.indexOf("Venus") },
    truefalse: { ada: () => 0, alan: () => 0, grace: () => 1 },
    multi: { ada: (q) => [q.choices.indexOf("11"), q.choices.indexOf("17")], alan: (q) => [q.choices.indexOf("11")], grace: (q) => [q.choices.indexOf("9")] },
    slider: { ada: () => 206, alan: () => 215, grace: () => 120 },
    text: { ada: () => "Au", alan: () => "  au. ", grace: () => "Ag" },
    order: { ada: rightOrder, alan: rightOrder, grace: (q) => rightOrder(q).slice().reverse() },
    poll: { ada: () => 1, alan: () => 1, grace: () => 3 },
    wordcloud: { ada: () => ["mitosis", "cells"], alan: () => ["Mitosis"], grace: () => ["cells"] },
  };

  const seen = [];
  let nextQ = once(host, "game:question");
  host.emit("host:start");
  for (let i = 0; i < 9; i++) {
    const q = await nextQ;
    seen.push(q.type);
    nextQ = once(host, "game:question");
    if (q.type === "slide") { host.emit("host:next"); continue; }
    // the last answer ends the question at once, so arm the listener first
    const gotResults = once(host, "game:results");
    for (const p of players) {
      const res = await emit(p.s, "player:answer", PLAN[q.type][p.name](q));
      if (!res.ok) throw new Error(`${p.name} rejected on ${q.type}: ${res.error}`);
    }
    await gotResults;
    await wait(20);
    host.emit("host:next");
  }
  const end = await once(host, "game:end");

  check("every type was played", seen.join(",") === "slide,choice,truefalse,multi,slider,text,order,poll,wordcloud", seen.join(","));
  check("a slide has no results step", !hostRs.some((r) => r.type === "slide"));

  const byType = (t) => hostRs.find((r) => r.type === t);
  check("choices summarise as counts", byType("choice").summary.kind === "counts");
  check("multi counts every selection", byType("multi").summary.counts.reduce((a, b) => a + b, 0) === 4);
  check("slider collects each guess", byType("slider").summary.values.length === 3);
  check("slider reveals the answer", byType("slider").answer.value === 206);
  check("order tallies each slot", byType("order").summary.perSlot.length === 4);
  check("a poll has no correct answer", byType("poll").answer === null);
  check("word cloud merges case variants", byType("wordcloud").summary.words.some((w) => w.n === 2));

  // results arrive in play order, skipping the slide
  const answerable = seen.filter((t) => t !== "slide");
  const R = (p, type) => p.results[answerable.indexOf(type)];
  const [ada, alan, grace] = players;
  check("exact text answer is correct", R(ada, "text").correct === true);
  check("case and punctuation are forgiven", R(alan, "text").correct === true);
  check("a wrong text answer is wrong", R(grace, "text").correct === false);
  check("all correct options scores full marks", R(ada, "multi").correct === true);
  check("a partial multi answer earns partial credit", R(alan, "multi").ratio === 0.5);
  check("a wrong multi answer earns nothing", R(grace, "multi").ratio === 0);
  check("a slider guess inside tolerance is correct", R(ada, "slider").correct === true);
  check("a near slider guess earns partial credit", R(alan, "slider").ratio > 0 && R(alan, "slider").correct === false);
  check("a far slider guess earns nothing", R(grace, "slider").ratio === 0);
  check("the right order is correct", R(ada, "order").correct === true);
  check("a reversed order earns nothing", R(grace, "order").ratio === 0);
  check("a poll awards no points", R(ada, "poll").unscored === true && R(ada, "poll").gained === 0);
  check("a poll leaves a streak intact", R(ada, "poll").streak === R(ada, "wordcloud").streak);
  check("streaks build on consecutive correct answers", R(ada, "order").streak >= 4, String(R(ada, "order").streak));
  check("a wrong answer resets a streak", R(grace, "order").streak === 0);
  check("the strongest player leads", end.leaderboard[0].name === "ada", end.leaderboard.map((p) => `${p.name}:${p.score}`).join(" "));

  // ---------- report ----------
  const rep = await fetch(`${URL}/api/reports/${end.reportId}`).then((r) => r.json());
  check("the game is listed in reports", (await fetch(`${URL}/api/reports`).then((r) => r.json())).some((g) => g.id === end.reportId));
  check("every answered question is stored", rep.questions.length === 8, String(rep.questions.length));
  check("identifiers are stored", rep.players.find((p) => p.name === "ada").identifier === "1001");
  check("players are ranked", rep.players[0].rank === 1 && rep.players[0].name === "ada");
  check("correct rate is computed", rep.questions.find((q) => q.type === "text").correctRate === 2 / 3);
  check("polls are excluded from correct rate", rep.questions.find((q) => q.type === "poll").correctRate === null);
  check("hard questions are flagged for review", rep.needsReview.every((q) => q.correctRate < 0.5) && rep.needsReview.length > 0);
  check("each player's answers are stored", rep.players.find((p) => p.name === "ada").answers.length === 8);

  const csv = await fetch(`${URL}/api/reports/${end.reportId}/csv`).then((r) => r.text());
  const lines = csv.trim().split("\n");
  check("csv holds a row per player per question", lines.length === 1 + 24, String(lines.length));
  check("csv quotes fields containing commas", csv.includes('"11, 17"'));
  check("csv carries identifiers", csv.includes(",1001,"));

  for (const p of players) p.s.close();
  host.close();
  await wait(50);
}

async function testRoster() {
  console.log("\n# class lists");
  const host = io(URL);
  await once(host, "connect");
  const game = await emit(host, "host:create", { quizId: "sample", rosterId: "period3" });
  check("a game can use a class list", game.ok && game.roster.title === "Period 3 Biology", game.error);

  const peek = io(URL);
  await once(peek, "connect");
  const stranger = await emit(peek, "player:join", { pin: game.pin, name: "mallory", identifier: "Nobody" });
  check("someone off the list is turned away", stranger.ok === false, stranger.error);
  peek.close();

  const players = [];
  for (const [nick, ident] of [["ada", "1001"], ["alan", "Alan Turing"], ["grace", "  grace   HOPPER "]]) {
    const s = io(URL);
    await once(s, "connect");
    const res = await emit(s, "player:join", { pin: game.pin, name: nick, identifier: ident });
    check(`joining as "${ident.trim()}" works`, res.ok === true, res.error);
    players.push(s);
  }

  let nextQ = once(host, "game:question");
  host.emit("host:start");
  for (let i = 0; i < 4; i++) {
    await nextQ;
    nextQ = once(host, "game:question");
    const gotResults = once(host, "game:results");
    for (const s of players) await emit(s, "player:answer", 0);
    await gotResults;
    await wait(20);
    host.emit("host:next");
  }
  const end = await once(host, "game:end");
  const rep = await fetch(`${URL}/api/reports/${end.reportId}`).then((r) => r.json());
  check("roster names are canonicalised",
    rep.players.map((p) => p.identifier).sort().join("|") === "Ada Lovelace|Alan Turing|Grace Hopper",
    rep.players.map((p) => p.identifier).join("|"));
  check("students who never played are named",
    rep.roster.absent.slice().sort().join(", ") === "Charles Babbage, Katherine Johnson",
    JSON.stringify(rep.roster.absent));

  for (const s of players) s.close();
  host.close();
  await wait(50);
}

async function testValidation() {
  console.log("\n# validation and abandoned games");
  const host = io(URL);
  await once(host, "connect");
  const missing = await emit(host, "host:create", { quizId: "does-not-exist" });
  check("a missing quiz is refused", missing.ok === false);
  const traversal = await emit(host, "host:create", { quizId: "../server" });
  check("a path traversal id is refused", traversal.ok === false && /bad quiz id/.test(traversal.error), traversal.error);

  const before = (await fetch(`${URL}/api/reports`).then((r) => r.json())).length;
  const game = await emit(host, "host:create", { quizId: "sample" });
  const p = io(URL);
  await once(p, "connect");
  await emit(p, "player:join", { pin: game.pin, name: "x" });
  host.emit("host:start");
  await once(host, "game:question");
  host.close(); // host walks out mid-game
  p.close();
  await wait(300);
  const after = (await fetch(`${URL}/api/reports/`).then((r) => r.json())).length;
  check("an abandoned game leaves no report", after === before, `${before} -> ${after}`);
}


async function testPauseAndNavigation() {
  console.log("\n# pause and navigation");
  const host = io(URL);
  await once(host, "connect");
  const game = await emit(host, "host:create", { quizId: "sample" });
  check("quiz list is sent for the jump menu", Array.isArray(game.questions) && game.questions.length === 4);

  const s = io(URL);
  await once(s, "connect");
  await emit(s, "player:join", { pin: game.pin, name: "ada" });
  const results = [];
  s.on("game:results", (r) => results.push(r));
  const paused = [];
  s.on("game:paused", (p) => paused.push(p));

  let nextQ = once(host, "game:question");
  host.emit("host:start");
  const q1 = await nextQ;
  check("question carries its full duration", q1.totalMs === 20000, String(q1.totalMs));

  // pause, confirm the clock stops and answers are refused
  const gotPause = once(s, "game:paused");
  host.emit("host:pause", true);
  const pauseEvt = await gotPause;
  check("pausing tells players", pauseEvt.paused === true);
  check("the clock stops while paused", pauseEvt.endsAt === null);
  const blocked = await emit(s, "player:answer", 0);
  check("answers are refused while paused", blocked.ok === false, blocked.error);

  const gotResume = once(s, "game:paused");
  await wait(700);
  host.emit("host:pause", false);
  const resumeEvt = await gotResume;
  check("resuming restarts the clock", resumeEvt.paused === false && resumeEvt.endsAt > Date.now());
  check("paused time is not deducted", resumeEvt.remainingMs > 19000, String(resumeEvt.remainingMs));

  // answer question 1 correctly and bank the score
  nextQ = once(host, "game:question");
  let gotResults = once(host, "game:results");
  await emit(s, "player:answer", 0);
  await gotResults;
  const afterQ1 = results.at(-1).score;
  check("a correct answer scores", afterQ1 > 0, String(afterQ1));

  // go back and replay question 1: the first award must be rolled back, not stacked
  host.emit("host:prev");
  const again = await nextQ;
  check("going back reopens the same question", again.index === 0, String(again.index));
  nextQ = once(host, "game:question");
  gotResults = once(host, "game:results");
  await emit(s, "player:answer", 0);
  await gotResults;
  const afterReplay = results.at(-1).score;
  check("replaying does not award the question twice", afterReplay <= afterQ1 + 50, `${afterQ1} then ${afterReplay}`);

  // jump forward, skipping a question entirely
  host.emit("host:goto", 3);
  const jumped = await nextQ;
  check("the host can jump to any question", jumped.index === 3, String(jumped.index));

  s.close();
  host.close();
  await wait(50);
}

async function testHostReconnect() {
  console.log("\n# host reconnection");
  const host = io(URL);
  await once(host, "connect");
  const game = await emit(host, "host:create", { quizId: "sample" });
  check("a resume token is issued", typeof game.hostToken === "string" && game.hostToken.length > 10);

  const player = io(URL);
  await once(player, "connect");
  await emit(player, "player:join", { pin: game.pin, name: "ada" });
  const away = once(player, "game:hostaway");
  let nextQ = once(host, "game:question");
  host.emit("host:start");
  await nextQ;

  // the host's browser vanishes
  host.close();
  const awayEvt = await away;
  check("players are told the host dropped", awayEvt.away === true);
  await wait(200);
  const stillThere = await fetch(`${URL}/api/reports`).then((r) => r.json());
  void stillThere;

  // a new socket resumes the same game with the token
  const host2 = io(URL);
  await once(host2, "connect");
  const back = once(player, "game:hostaway");
  const replay = once(host2, "game:question");
  const res = await emit(host2, "host:resume-session", { pin: game.pin, hostToken: game.hostToken, token: game.hostToken });
  check("the game resumes with the right token", res.ok === true, res.error);
  check("resume reports where the game is", res.state === "question", res.state);
  check("the game was paused while the host was away", res.paused === true);
  const backEvt = await back;
  check("players are told the host is back", backEvt.away === false);
  const q = await replay;
  check("the current question is replayed to the host", q.index === 0 && !!q.text);

  const wrongToken = io(URL);
  await once(wrongToken, "connect");
  const bad = await emit(wrongToken, "host:resume-session", { pin: game.pin, token: "not-the-token" });
  check("a wrong token cannot take over a game", bad.ok === false, bad.error);
  wrongToken.close();

  host2.close();
  player.close();
  await wait(50);
}

async function testPhoneText() {
  console.log("\n# question text on phones");
  const host = io(URL);
  await once(host, "connect");
  const game = await emit(host, "host:create", { quizId: "all-types" });
  const s = io(URL);
  await once(s, "connect");
  await emit(s, "player:join", { pin: game.pin, name: "ada", identifier: "1001" });

  let nextPlayerQ = once(s, "game:question");
  let nextHostQ = once(host, "game:question");
  host.emit("host:start");
  await nextHostQ; // the slide
  nextHostQ = once(host, "game:question");
  host.emit("host:next");
  await nextPlayerQ;
  nextPlayerQ = once(s, "game:question");
  const hq = await nextHostQ;
  await wait(50);

  // grab the multiple-choice question as the player sees it
  let playerQ = null;
  s.on("game:question", (q) => { playerQ = q; });
  const first = await new Promise((resolve) => {
    const h = (q) => { if (q.type === "choice") { s.off("game:question", h); resolve(q); } };
    s.on("game:question", h);
    // the choice question is already on screen; ask for it again by replaying
    host.emit("host:goto", 1);
  });
  check("the phone receives the question text", typeof first.text === "string" && first.text.length > 0, first.text);
  check("the phone receives the choice labels", Array.isArray(first.labels) && first.labels.length === 4, JSON.stringify(first.labels));
  check("the phone still never receives the answer", first.answer === undefined && first.answers === undefined);
  void hq; void playerQ;

  s.close();
  host.close();
  await wait(50);
}
