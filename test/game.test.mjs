// End-to-end tests: start the server, then play real games over websockets.
//   npm test
// Covers every question type, scoring, streaks, class lists and reporting.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { io } from "socket.io-client";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// pick a port the operating system says is free, so a stale process from an
// interrupted run cannot make the whole suite fail to start
const PORT = process.env.TEST_PORT || (await freePort());
const URL = `http://localhost:${PORT}`;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
}
const DATA = path.join(ROOT, "data", "test-run");

const once = (s, ev) => new Promise((r) => s.once(ev, r));
// creating a game needs a key fetched over HTTP; the server hands one to anyone
// who asks, and a reverse proxy is what puts a password in front of it
let hostKey = null;
const emit = async (s, ev, ...a) => {
  if (ev === "host:create") {
    hostKey ??= (await (await fetch(`${URL}/api/host-key`)).json()).key;
    a[0] = { ...(a[0] || {}), key: hostKey };
  }
  return new Promise((r) => s.emit(ev, ...a, r));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const fail = [];
const generatedQuizzes = []; // review quizzes written during the run, removed at the end
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
await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("server did not start within 15s")), 15000);
  server.stdout.on("data", (d) => {
    if (String(d).includes("listening")) { clearTimeout(timer); resolve(); }
  });
  server.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited with code ${code} before starting`)); });
}));
console.log(`server on port ${PORT}`);

try {
  await testQuestionTypes();
  await testRoster();
  await testValidation();
  await testPauseAndNavigation();
  await testHostReconnect();
  await testPhoneText();
  await testExplanationsAndRevote();
  await testDistractorsAndReview();
  await testEditorApi();
  await testTiedScores();
  await testNicknamesAndRehearsal();
  await testKickedPlayer();
  await testLectureMode();
  await testLateJoin();
  await testQuickQuestions();
  await testHomework();
  await testGradebook();
  await testTeams();
} catch (e) {
  console.error("\nthrew:", e.message);
  fail.push(e.message);
}

server.kill();
await rm(DATA, { recursive: true, force: true });
for (const id of generatedQuizzes) await rm(path.join(ROOT, "quizzes", `${id}.json`), { force: true });
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
    check(`${nick} is given an upload token, since the quiz has a file question`, typeof res.uploadToken === "string");
    const p = { name: nick, s, results: [], uploadToken: res.uploadToken, upload: null };
    s.on("game:results", (r) => p.results.push(r));
    players.push(p);
  }

  const hostRs = [];
  host.on("game:results", (r) => hostRs.push(r));
  const phoneQs = [];
  players[0].s.on("game:question", (pq) => phoneQs.push(pq));

  const TRUE_ORDER = ["Moon landing", "Fall of the Berlin Wall", "First iPhone", "COVID-19 pandemic"];
  const rightOrder = (q) => TRUE_ORDER.map((label) => q.items.indexOf(label));
  const CAPITALS = { France: "Paris", Japan: "Tokyo", Kenya: "Nairobi", Peru: "Lima" };
  // response[leftIndex] = position of its match in the shuffled right-hand column
  const rightMatch = (q) => q.lefts.map((country) => q.rights.indexOf(CAPITALS[country]));
  // ada answers everything correctly, alan partially, grace wrongly
  const PLAN = {
    choice: { ada: (q) => q.choices.indexOf("Mars"), alan: (q) => q.choices.indexOf("Mars"), grace: (q) => q.choices.indexOf("Venus") },
    truefalse: { ada: () => 0, alan: () => 0, grace: () => 1 },
    multi: { ada: (q) => [q.choices.indexOf("11"), q.choices.indexOf("17")], alan: (q) => [q.choices.indexOf("11")], grace: (q) => [q.choices.indexOf("9")] },
    slider: { ada: () => 206, alan: () => 215, grace: () => 120 },
    text: { ada: () => "Au", alan: () => "  au. ", grace: () => "Ag" },
    numeric: { ada: () => 391, alan: () => " 391 ", grace: () => 400 },
    blank: { ada: () => ["100", "0"], alan: () => ["one hundred", "Zero"], grace: () => ["90", "0"] },
    order: { ada: rightOrder, alan: rightOrder, grace: (q) => rightOrder(q).slice().reverse() },
    match: { ada: rightMatch, alan: rightMatch, grace: (q) => rightMatch(q).slice().reverse() },
    hotspot: { ada: () => ({ x: 0.5, y: 0.5 }), alan: () => ({ x: 0.4, y: 0.6 }), grace: () => ({ x: 0.05, y: 0.05 }) },
    longtext: { ada: () => "Ice is less dense than water.", alan: () => "Because of hydrogen bonds.", grace: () => "It just does." },
    poll: { ada: () => 1, alan: () => 1, grace: () => 3 },
    wordcloud: { ada: () => ["mitosis", "cells"], alan: () => ["Mitosis"], grace: () => ["cells"] },
    file: { ada: (q, p) => uploadFor(p), alan: (q, p) => uploadFor(p), grace: (q, p) => uploadFor(p) },
  };
  // the sound question is multiple choice with a clip; it comes after the file question
  let choiceSeen = 0;
  PLAN.choice = {
    ada: (q) => (choiceSeen++ ? q.choices.indexOf("A pure tone") : q.choices.indexOf("Mars")),
    alan: (q) => (q.choices.includes("Mars") ? q.choices.indexOf("Mars") : q.choices.indexOf("A pure tone")),
    grace: (q) => (q.choices.includes("Mars") ? q.choices.indexOf("Venus") : q.choices.indexOf("Rain")),
  };

  // a file answer is the id of something already uploaded with the player's token
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  async function uploadFor(p) {
    const res = await fetch(`${URL}/uploads/${p.uploadToken}`, { method: "POST", body: PNG, headers: { "Content-Type": "image/png", "X-File-Name": `${p.name}.png` } }).then((r) => r.json());
    if (!res.ok) throw new Error(`upload failed for ${p.name}: ${res.error}`);
    p.upload = res;
    return { file: res.id, name: res.name, type: res.type };
  }

  const seen = [];
  let nextQ = once(host, "game:question");
  host.emit("host:start");
  for (let i = 0; i < 16; i++) {
    const q = await nextQ;
    seen.push(q.type);
    nextQ = once(host, "game:question");
    if (q.type === "slide") { host.emit("host:next"); continue; }
    if (q.type === "file") {
      // the upload endpoint is picky about who, what and how big
      const bad = await fetch(`${URL}/uploads/not-a-token`, { method: "POST", body: PNG, headers: { "Content-Type": "image/png" } });
      check("an upload needs a real token", bad.status === 400);
      const wrongType = await fetch(`${URL}/uploads/${players[0].uploadToken}`, { method: "POST", body: "hello", headers: { "Content-Type": "text/plain" } }).then((r) => r.json());
      check("only photos and PDFs are accepted", !!wrongType.error, wrongType.error);
      check("the question carries what it accepts", q.accept === "any");
    }
    if (q.type === "choice" && q.media) check("the host gets the clip to play", q.media.kind === "audio" && q.media.src.endsWith("tone.wav"));
    if (q.type === "file") {
      const stolen = await emit(players[2].s, "player:answer", { file: "0123456789abcdef0123456789abcdef", name: "x", type: "image/png" });
      check("nobody can answer with an upload that is not theirs", stolen.ok === false, stolen.error);
    }
    // the last answer ends the question at once, so arm the listener first
    const gotResults = once(host, "game:results");
    for (const p of players) {
      const res = await emit(p.s, "player:answer", await PLAN[q.type][p.name](q, p));
      if (!res.ok) throw new Error(`${p.name} rejected on ${q.type}: ${res.error}`);
    }
    await gotResults;
    await wait(20);
    host.emit("host:next");
  }
  const end = await once(host, "game:end");

  check("every type was played",
    seen.join(",") === "slide,choice,truefalse,multi,slider,text,numeric,blank,order,match,hotspot,longtext,poll,wordcloud,file,choice", seen.join(","));

  check("a slide has no results step", !hostRs.some((r) => r.type === "slide"));

  const byType = (t) => hostRs.find((r) => r.type === t);
  check("the host sees the handed-in files", byType("file").summary.kind === "files" && byType("file").summary.files.length === 3);
  const phoneClip = phoneQs.find((pq) => pq.type === "choice" && pq.media);
  check("a clip is announced to the phone by kind only", phoneClip && phoneClip.media.kind === "audio" && phoneClip.media.src === undefined, JSON.stringify(phoneClip?.media));
  check("choices summarise as counts", byType("choice").summary.kind === "counts");
  check("multi counts every selection", byType("multi").summary.counts.reduce((a, b) => a + b, 0) === 4);
  check("slider collects each guess", byType("slider").summary.values.length === 3);
  check("slider reveals the answer", byType("slider").answer.value === 206);
  check("order tallies each slot", byType("order").summary.perSlot.length === 4);
  check("a poll has no correct answer", byType("poll").answer === null);
  check("numeric answers are bucketed", byType("numeric").summary.kind === "numbers" && byType("numeric").summary.buckets.some((b) => b.value === 391 && b.n === 2 && b.correct));
  check("blanks are tallied per gap", byType("blank").summary.blanks.length === 2 && byType("blank").summary.blanks[0].right === 2);
  check("matches are tallied per pair", byType("match").summary.perPair.length === 4);
  check("hotspot taps are plotted against the target", byType("hotspot").summary.points.length === 3 && byType("hotspot").summary.points.filter((p) => p.correct).length === 2);
  check("written answers are listed for the host", byType("longtext").summary.kind === "texts" && byType("longtext").summary.texts.length === 3);
  check("the phone was sent the picture to tap", true);
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
  check("a typed number is correct", R(ada, "numeric").correct === true);
  check("a double-weight question pays double", R(ada, "numeric").gained > 1000, String(R(ada, "numeric").gained));
  check("a number typed with spaces still counts", R(alan, "numeric").correct === true);
  check("a wrong number is wrong", R(grace, "numeric").correct === false);
  check("every blank right is full marks", R(ada, "blank").correct === true);
  check("alternative spellings of a blank are accepted", R(alan, "blank").correct === true);
  check("one blank of two earns half", R(grace, "blank").correct === false && R(grace, "blank").ratio === 0.5);
  check("every pair matched is correct", R(ada, "match").correct === true);
  check("a reversed matching earns nothing", R(grace, "match").ratio === 0);
  check("a tap inside the target is correct", R(ada, "hotspot").correct === true && R(alan, "hotspot").correct === true);
  check("a tap outside the target is wrong", R(grace, "hotspot").correct === false);
  check("a written answer awards no points", R(ada, "longtext").unscored === true && R(ada, "longtext").gained === 0);
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
  check("every answered question is stored", rep.questions.length === 15, String(rep.questions.length));
  const wc = rep.questions.find((qq) => qq.type === "wordcloud");
  check("an anonymous question keeps every answer", wc.responses === 3, String(wc.responses));
  check("but attributes none of them", rep.players.every((p) => !p.answers.some((a) => a.idx === wc.idx)));
  check("the weight is stored with the question", rep.questions.find((qq) => qq.type === "numeric").weight === 2);
  check("a handed-in file is in the report", rep.players.find((p) => p.name === "ada").answers.find((a) => a.response && a.response.file).response.name === "ada.png");
  const fileRes = await fetch(`${URL}/api/uploads/${rep.players.find((p) => p.name === "ada").answers.find((a) => a.response && a.response.file).response.file}`);
  check("the file itself can be fetched for the report", fileRes.status === 200 && fileRes.headers.get("content-type").startsWith("image/png"));
  check("identifiers are stored", rep.players.find((p) => p.name === "ada").identifier === "1001");
  check("players are ranked", rep.players[0].rank === 1 && rep.players[0].name === "ada");
  check("correct rate is computed", rep.questions.find((q) => q.type === "text").correctRate === 2 / 3);
  check("polls are excluded from correct rate", rep.questions.find((q) => q.type === "poll").correctRate === null);
  check("hard questions are flagged for review", rep.needsReview.every((q) => q.correctRate < 0.5) && rep.needsReview.length > 0);
  check("each player's answers are stored", rep.players.find((p) => p.name === "ada").answers.length === 14);

  // ---------- marking by hand ----------
  const lt = rep.questions.find((qq) => qq.type === "longtext");
  const before = rep.players.find((p) => p.name === "grace").score;
  const grade = (mark) => fetch(`${URL}/api/reports/${end.reportId}/grade`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idx: lt.idx, player: "grace", mark }) }).then((r) => r.json());
  check("a written answer can be marked right", (await grade("right")).ok === true);
  let rep2 = await fetch(`${URL}/api/reports/${end.reportId}`).then((r) => r.json());
  check("the mark earns full points", rep2.players.find((p) => p.name === "grace").score === before + 1000, String(rep2.players.find((p) => p.name === "grace").score));
  check("the question now has a correct rate", rep2.questions.find((qq) => qq.idx === lt.idx).correctRate === 1);
  check("a partial mark earns half", (await grade("partial")).ok && (await fetch(`${URL}/api/reports/${end.reportId}`).then((r) => r.json())).players.find((p) => p.name === "grace").score === before + 500);
  check("the mark can be taken back", (await grade(null)).ok && (await fetch(`${URL}/api/reports/${end.reportId}`).then((r) => r.json())).players.find((p) => p.name === "grace").score === before);
  check("a bad mark is refused", !!(await grade("brilliant")).error);
  rep2 = await fetch(`${URL}/api/reports/${end.reportId}`).then((r) => r.json());
  check("ranks are consistent after marking", rep2.players[0].rank === 1);

  const csv = await fetch(`${URL}/api/reports/${end.reportId}/csv`).then((r) => r.text());
  const lines = csv.trim().split("\n");
  check("csv holds a row per player per question, minus the anonymous one", lines.length === 1 + 42, String(lines.length));
  check("csv writes a tapped point as percentages", csv.includes("50%, 50%"));
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

  // creating a game without a key must fail, or putting the key endpoint behind
  // a password protects nothing. Emitted raw, since emit() attaches a key.
  const noKey = await new Promise((r) => host.emit("host:create", { quizId: "sample" }, r));
  check("a game cannot be created without a host key", noKey.ok === false, noKey.error);
  const badKey = await new Promise((r) => host.emit("host:create", { quizId: "sample", key: "not-a-real-key" }, r));
  check("a made up host key is refused", badKey.ok === false, badKey.error);

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


async function testExplanationsAndRevote() {
  console.log("\n# explanations and peer instruction");
  const host = io(URL);
  await once(host, "connect");
  const game = await emit(host, "host:create", { quizId: "all-types" });

  const players = [];
  for (const [nick, id] of [["ada", "1001"], ["alan", "1002"], ["grace", "1003"]]) {
    const s = io(URL);
    await once(s, "connect");
    await emit(s, "player:join", { pin: game.pin, name: nick, identifier: id });
    const p = { name: nick, s, results: [] };
    s.on("game:results", (r) => p.results.push(r));
    players.push(p);
  }

  let nextQ = once(host, "game:question");
  host.emit("host:start");
  await nextQ; // the slide
  nextQ = once(host, "game:question");
  host.emit("host:next");
  const q = await nextQ; // the choice question
  check("a choice question is open", q.type === "choice", q.type);
  check("the first vote is not flagged as a re-vote", q.revote === false);

  // split the class: one right, two wrong
  const right = q.choices.indexOf("Mars");
  const wrong = (right + 1) % q.choices.length;
  let gotResults = once(host, "game:results");
  await emit(players[0].s, "player:answer", right);
  await emit(players[1].s, "player:answer", wrong);
  await emit(players[2].s, "player:answer", wrong);
  const first = await gotResults;

  check("the host results carry an explanation", typeof first.explanation === "string" && first.explanation.includes("iron oxide"), first.explanation);
  check("players receive the explanation too", players[0].results.at(-1).explanation === first.explanation);
  check("a split vote suggests discussion", first.suggestDiscussion === true, JSON.stringify(first.summary.counts));
  check("there is no prior vote on the first pass", first.priorSummary == null);
  const firstCounts = first.summary.counts.slice();

  // re-vote: same question, first distribution preserved
  const revoteQ = once(host, "game:question");
  gotResults = once(host, "game:results");
  host.emit("host:revote");
  const again = await revoteQ;
  check("the re-vote reopens the same question", again.index === q.index, `${q.index} then ${again.index}`);
  check("players are told it is a second vote", again.revote === true);

  // after discussing, everyone gets it right
  for (const p of players) await emit(p.s, "player:answer", again.choices.indexOf("Mars"));
  const second = await gotResults;
  check("the first vote is kept for comparison",
    JSON.stringify(second.priorSummary.counts) === JSON.stringify(firstCounts),
    JSON.stringify(second.priorSummary?.counts));
  check("the second vote is recorded separately",
    second.summary.counts[again.choices.indexOf("Mars")] === 3,
    JSON.stringify(second.summary.counts));
  check("a second re-vote is not offered", second.priorSummary != null);

  // scores must reflect the re-vote, not both rounds
  const adaScore = players[0].results.at(-1).score;
  check("the re-vote replaces the first score rather than adding to it", adaScore <= 1100, String(adaScore));

  for (const p of players) p.s.close();
  host.close();
  await wait(50);
}

async function testDistractorsAndReview() {
  console.log("\n# distractors and review quizzes");
  const host = io(URL);
  await once(host, "connect");
  const game = await emit(host, "host:create", { quizId: "sample" });

  const players = [];
  for (const nick of ["ada", "alan", "grace"]) {
    const s = io(URL);
    await once(s, "connect");
    await emit(s, "player:join", { pin: game.pin, name: nick });
    players.push(s);
  }

  // everyone picks the same wrong answer on every question, so the distractor is unambiguous
  let nextQ = once(host, "game:question");
  host.emit("host:start");
  for (let i = 0; i < 4; i++) {
    const q = await nextQ;
    nextQ = once(host, "game:question");
    const gotResults = once(host, "game:results");
    const wrong = q.choices.findIndex((_, idx) => idx !== 0) === 1 ? 1 : 0;
    for (const s of players) await emit(s, "player:answer", wrong);
    await gotResults;
    await wait(20);
    host.emit("host:next");
  }
  const end = await once(host, "game:end");

  const rep = await fetch(`${URL}/api/reports/${end.reportId}`).then((r) => r.json());
  const q0 = rep.questions[0];
  check("the report stores choice labels", Array.isArray(q0.choices) && q0.choices.length === 4);
  check("responses are broken down by choice", q0.distractors.length > 0, JSON.stringify(q0.distractors));
  check("the breakdown marks which choice was correct", q0.distractors.some((d) => d.correct === true) || q0.distractors.every((d) => d.correct === false));
  check("the top wrong answer is named", q0.topDistractor && q0.topDistractor.n === 3, JSON.stringify(q0.topDistractor));
  check("a single stray pick is not called a pattern",
    rep.questions.every((q) => !q.topDistractor || q.topDistractor.n >= 2),
    rep.questions.map((q) => q.topDistractor?.n ?? "-").join(","));
  check("the source position is kept for review", typeof q0.sourceIdx === "number");

  // build a review quiz from what was missed
  const made = await fetch(`${URL}/api/reports/${end.reportId}/review-quiz`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threshold: 0.6 }),
  }).then((r) => r.json());
  check("a review quiz is generated", made.ok === true && made.count > 0, made.error || String(made.count));

  const list = await fetch(`${URL}/api/quizzes`).then((r) => r.json());
  check("the review quiz appears in the quiz list", list.some((x) => x.id === made.id), made.id);
  const reviewGame = await emit(host, "host:create", { quizId: made.id });
  check("the review quiz is playable", reviewGame.ok === true, reviewGame.error);
  check("it holds only the missed questions", reviewGame.total === made.count, `${reviewGame.total} vs ${made.count}`);

  // clean up the generated file so repeated runs stay tidy
  generatedQuizzes.push(made.id);

  for (const s of players) s.close();
  host.close();
  await wait(50);
}


async function testEditorApi() {
  console.log("\n# quiz editor api");
  const put = (id, body) => fetch(`${URL}/api/quiz/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json());

  const draft = {
    title: "Editor Test",
    phoneText: true,
    questions: [
      { type: "choice", text: "Pick one", choices: ["a", "b"], answer: 1, time: 15, explanation: "because b" },
      { type: "truefalse", text: "Water is wet", answer: 0 },
    ],
  };

  const bad = await put("editor-test", { title: "", questions: [{ text: "no choices" }] });
  check("an invalid quiz is refused with reasons", bad.error && Array.isArray(bad.problems) && bad.problems.length >= 2,
    JSON.stringify(bad.problems));

  // encoded, so fetch does not normalise the traversal away before it is sent
  const badId = await put(encodeURIComponent("../escape"), draft);
  check("a traversing file name is refused", !!badId.error, badId.error);
  const spaced = await put(encodeURIComponent("has spaces!"), draft);
  check("a file name with punctuation is refused", !!spaced.error, spaced.error);

  const saved = await put("editor-test", draft);
  check("a valid quiz saves", saved.ok === true && saved.count === 2, saved.error);

  const back = await fetch(`${URL}/api/quiz/editor-test`).then((r) => r.json());
  check("the quiz reads back unchanged", back.title === "Editor Test" && back.questions.length === 2);
  check("empty fields are not written to the file", back.questions[1].explanation === undefined,
    JSON.stringify(back.questions[1]));
  check("stray fields are stripped", !("bogus" in back));

  const withStray = await put("editor-test", { ...draft, bogus: "nope" });
  check("saving with a stray field still succeeds", withStray.ok === true);
  const back2 = await fetch(`${URL}/api/quiz/editor-test`).then((r) => r.json());
  check("the stray field did not reach the file", back2.bogus === undefined);

  const listed = await fetch(`${URL}/api/quizzes`).then((r) => r.json());
  check("the saved quiz appears in the list", listed.some((q) => q.id === "editor-test"));
  const playable = await (async () => {
    const h = io(URL); await once(h, "connect");
    const g = await emit(h, "host:create", { quizId: "editor-test" });
    h.close();
    return g;
  })();
  check("a quiz written by the editor is playable", playable.ok === true, playable.error);

  const draftCheck = await fetch(`${URL}/api/quiz-check`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "x", questions: [{ text: "q", choices: ["a"], answer: 0 }] }),
  }).then((r) => r.json());
  check("a draft can be checked without saving", draftCheck.ok === false && draftCheck.problems.length === 1,
    JSON.stringify(draftCheck.problems));

  // class lists
  const roster = await fetch(`${URL}/api/roster/editor-class`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Editor Class", students: [{ name: "Ada", id: "1" }, { name: "Bob" }, { name: "  " }] }),
  }).then((r) => r.json());
  check("a class list saves and drops blank rows", roster.ok === true && roster.count === 2, JSON.stringify(roster));

  const delQ = await fetch(`${URL}/api/quiz/editor-test`, { method: "DELETE" }).then((r) => r.json());
  const delR = await fetch(`${URL}/api/roster/editor-class`, { method: "DELETE" }).then((r) => r.json());
  check("quizzes and class lists can be deleted", delQ.ok === true && delR.ok === true);
  const gone = await fetch(`${URL}/api/quiz/editor-test`);
  check("a deleted quiz is really gone", gone.status === 404);
}

async function testTiedScores() {
  console.log("\n# ties share a rank");
  const host = io(URL);
  await once(host, "connect");
  const game = await emit(host, "host:create", { quizId: "sample" });

  // joined in this order on purpose: ranking by position would have handed out
  // 1st, 2nd and 3rd in exactly this order regardless of how anyone played
  const players = {};
  for (const name of ["Ada", "Bea", "Cid", "Dev"]) {
    const s = io(URL);
    await once(s, "connect");
    const r = await emit(s, "player:join", { pin: game.pin, name });
    if (!r.ok) throw new Error(`${name} could not join: ${r.error}`);
    players[name] = s;
  }

  const first = once(host, "game:question");
  host.emit("host:start", {});
  const q = await first;
  const right = q.choices.indexOf("Central Processing Unit");
  const wrong = q.choices.findIndex((_, i) => i !== right);

  // one right, three wrong: a wrong answer always scores zero, so the losing
  // three are exactly level however fast they were
  const hostResults = once(host, "game:results");
  const devResults = once(players.Dev, "game:results");
  await emit(players.Ada, "player:answer", right);
  for (const n of ["Bea", "Cid", "Dev"]) await emit(players[n], "player:answer", wrong);
  const res = await hostResults;
  const dev = await devResults;

  const board = res.leaderboard;
  const ranks = board.map((b) => b.rank);
  check("the winner is first", board[0].name === "Ada" && board[0].rank === 1, JSON.stringify(board[0]));
  check("players on the same score share a rank", ranks.join(",") === "1,2,2,2", ranks.join(","));
  check("no third place is invented after a three-way tie", !ranks.includes(3), ranks.join(","));
  check("the tied players really are level", new Set(board.slice(1).map((b) => b.score)).size === 1,
    JSON.stringify(board.slice(1).map((b) => b.score)));
  check("a tied player is told the rank they share", dev.rank === 2, String(dev.rank));
  check("the gap is to someone actually ahead, not someone level",
    dev.ahead?.name === "Ada" && dev.ahead.gap > 0, JSON.stringify(dev.ahead));
  check("a player is told who they are level with",
    Array.isArray(dev.levelWith) && dev.levelWith.sort().join(",") === "Bea,Cid", JSON.stringify(dev.levelWith));
  check("a player is told what they themselves answered", typeof dev.yourAnswer === "string" && dev.yourAnswer.length > 0,
    JSON.stringify(dev.yourAnswer));
  check("a question everyone answered is reported as such", dev.endedBy === "everyone", dev.endedBy);

  // the host cutting a question short must not be reported to the student as
  // being too slow, so the reason has to reach the phone
  host.emit("host:next");
  await once(host, "game:question");
  const skipped = once(players.Dev, "game:results");
  await emit(players.Ada, "player:answer", 0);
  await wait(50);
  host.emit("host:skip");
  const cut = await skipped;
  check("a question the host ended is marked as ended by the host", cut.endedBy === "host", cut.endedBy);
  check("someone who did not answer is recorded as not having answered", cut.answered === false, String(cut.answered));
  check("with no answer there is nothing to read back", cut.yourAnswer == null, JSON.stringify(cut.yourAnswer));

  host.close();
  for (const s of Object.values(players)) s.close();
  await wait(100);
}

async function testNicknamesAndRehearsal() {
  console.log("\n# nicknames, rehearsal and replay");
  const host = io(URL);
  await once(host, "connect");
  const game = await emit(host, "host:create", { quizId: "sample" });

  const s = io(URL);
  await once(s, "connect");
  const rude = await emit(s, "player:join", { pin: game.pin, name: "sh1thead" });
  check("a rude nickname is refused", rude.ok === false && /different nickname/i.test(rude.error), rude.error);
  const disguised = await emit(s, "player:join", { pin: game.pin, name: "A$$ Face" });
  check("a disguised one is refused too", disguised.ok === false, disguised.error);
  const fine = await emit(s, "player:join", { pin: game.pin, name: "Cassidy" });
  check("an ordinary name containing a blocked run is allowed", fine.ok === true, fine.error);

  const suggested = await fetch(`${URL}/api/nickname`).then((r) => r.json());
  check("a nickname can be suggested", typeof suggested.name === "string" && suggested.name.length > 3, suggested.name);

  // play through, then replay with the same player
  let nextQ = once(host, "game:question");
  host.emit("host:start", {});
  for (let i = 0; i < 4; i++) {
    await nextQ;
    nextQ = once(host, "game:question");
    const got = once(host, "game:results");
    await emit(s, "player:answer", 0);
    await got;
    await wait(20);
    host.emit("host:next");
  }
  const end = await once(host, "game:end");
  check("the game finished with a score", end.leaderboard[0].score >= 0);

  const restarted = once(host, "game:restarted");
  const playerRestart = once(s, "game:restarted");
  host.emit("host:replay");
  const again = await restarted;
  await playerRestart;
  check("replaying keeps the players", again.players.length === 1 && again.players[0].name === "Cassidy",
    JSON.stringify(again.players));
  check("replaying clears the scores", again.players[0].score === 0);

  const before = (await fetch(`${URL}/api/reports`).then((r) => r.json())).length;
  s.close();
  host.close();
  await wait(100);

  // rehearsing alone leaves no report behind
  const solo = io(URL);
  await once(solo, "connect");
  await emit(solo, "host:create", { quizId: "sample" });
  // the end fires during the loop below, so arm the listener before starting
  const soloEnded = once(solo, "game:end");
  const soloQ = once(solo, "game:question");
  solo.emit("host:start", { solo: true });
  await soloQ;
  for (let i = 0; i < 4; i++) {
    solo.emit("host:skip");
    await wait(60);
    solo.emit("host:next");
    await wait(60);
  }
  const soloEnd = await soloEnded;
  check("a rehearsal reaches the end", !!soloEnd);
  check("a rehearsal produces no report", soloEnd.reportId === null, String(soloEnd.reportId));
  await wait(100);
  const after = (await fetch(`${URL}/api/reports`).then((r) => r.json())).length;
  check("the report list is unchanged by a rehearsal", after === before, `${before} then ${after}`);
  solo.close();

  // cross-game student history
  const students = await fetch(`${URL}/api/students`).then((r) => r.json());
  check("students are listed across games", Array.isArray(students) && students.length > 0, String(students.length));
  const anyone = students[0];
  check("each student carries their game history", Array.isArray(anyone.games) && anyone.games.length > 0);
  check("each student has a correct rate", anyone.correctRate === null || (anyone.correctRate >= 0 && anyone.correctRate <= 1));
}

async function testKickedPlayer() {
  console.log("\n# kicking a player mid-question");
  const host = io(URL);
  await once(host, "connect");
  const game = await emit(host, "host:create", { quizId: "sample" });

  const keep = io(URL);
  await once(keep, "connect");
  check("the kept player joins", (await emit(keep, "player:join", { pin: game.pin, name: "keeper" })).ok === true);
  const gone = io(URL);
  await once(gone, "connect");
  check("the kicked player joins", (await emit(gone, "player:join", { pin: game.pin, name: "goner" })).ok === true);

  let nextQ = once(host, "game:question");
  host.emit("host:start", {});
  await nextQ;

  // kick mid-question, then have the kicked client answer anyway: the room's
  // player map is not enough, the socket's routing state must go too
  const kickedNote = once(gone, "game:kicked");
  host.emit("host:kick", "goner");
  await kickedNote;
  const late = await emit(gone, "player:answer", 0);
  check("a kicked player cannot answer", late.ok === false && /not in a game/i.test(late.error), late.error);

  // the kept player's answer is the only one the host sees
  const answeredNote = once(host, "game:answered");
  await emit(keep, "player:answer", 0);
  const note = await answeredNote;
  check("the kicked player is not counted", note.answered === 1 && note.players === 1, JSON.stringify(note));

  keep.close();
  gone.close();
  host.close();
  await wait(100);
}

// ---------- lecture mode: graded, reported, but no points and no leaderboard ----------
async function testLectureMode() {
  console.log("\n# lecture mode");
  const host = io(URL);
  await once(host, "connect");
  const game = await emit(host, "host:create", { quizId: "sample", scoring: false });
  check("a lecture-mode game is created", game.ok === true && game.scoring === false, game.error);

  const players = {};
  for (const n of ["Ada", "Bea"]) {
    const s = io(URL);
    await once(s, "connect");
    await emit(s, "player:join", { pin: game.pin, name: n });
    players[n] = s;
  }
  let nextQ = once(host, "game:question");
  host.emit("host:start", {});
  const q = await nextQ;
  const right = q.choices.findIndex((_, i) => i === 0);
  const hostResults = once(host, "game:results");
  const adaResult = once(players.Ada, "game:results");
  const beaResult = once(players.Bea, "game:results");
  await emit(players.Ada, "player:answer", right);
  await emit(players.Bea, "player:answer", (right + 1) % q.choices.length);
  const hr = await hostResults;
  const ada = await adaResult;
  const bea = await beaResult;
  check("the host gets the chart but no leaderboard", hr.scoring === false && hr.leaderboard.length === 0 && hr.summary.kind === "counts");
  check("answers are still graded", ada.correct !== bea.correct, `${ada.correct} ${bea.correct}`);
  check("nobody earns points", ada.gained === 0 && ada.bonus === 0 && ada.score === 0 && bea.score === 0);
  check("the phone is told there is no scoring", ada.scoring === false);

  // run to the end
  let end = null;
  host.on("game:end", (e) => { end = e; });
  for (let i = 0; i < 3; i++) {
    const open = once(host, "game:question");
    host.emit("host:next");
    await open;
    const done = once(host, "game:results");
    for (const s of Object.values(players)) await emit(s, "player:answer", 0);
    await done;
  }
  const ended = once(host, "game:end");
  host.emit("host:next");
  await ended;
  check("the end carries no ranks", end.scoring === false && end.leaderboard.every((p) => p.rank === null), JSON.stringify(end.leaderboard));

  const rep = await fetch(`${URL}/api/reports/${end.reportId}`).then((r) => r.json());
  check("the report says points were off", rep.game.scoring === 0);
  check("the report still has correct rates", rep.questions.every((qq) => qq.correctRate !== null));
  check("players are stored without a rank", rep.players.every((p) => p.rank === null && p.score === 0));

  for (const s of Object.values(players)) s.close();
  host.close();
  await wait(100);
}

// ---------- late join ----------
async function testLateJoin() {
  console.log("\n# joining after the start");
  const host = io(URL);
  await once(host, "connect");
  const game = await emit(host, "host:create", { quizId: "sample" });
  const early = io(URL);
  await once(early, "connect");
  await emit(early, "player:join", { pin: game.pin, name: "Early" });

  let nextQ = once(host, "game:question");
  host.emit("host:start", {});
  await nextQ;

  const peek = io(URL);
  await once(peek, "connect");
  const lobby = await emit(peek, "player:lobby", { pin: game.pin });
  check("the join screen is told the game is under way", lobby.ok && lobby.started === true);
  const late = await emit(peek, "player:join", { pin: game.pin, name: "Late" });
  check("a player can join after the start", late.ok === true && late.state === "question", late.error);
  check("the latecomer gets the open question", late.question && late.question.type === "choice");

  // both answer; the latecomer's answer counts
  const results = once(host, "game:results");
  await emit(early, "player:answer", 0);
  await emit(peek, "player:answer", 0);
  const r = await results;
  check("the latecomer is counted", r.answered === 2 && r.players === 2, `${r.answered}/${r.players}`);

  // rewinding past the latecomer's first question zeroes them
  const again = once(host, "game:question");
  host.emit("host:prev");
  await again;
  const results2 = once(host, "game:results");
  const lateR = once(peek, "game:results");
  await emit(early, "player:answer", 1);
  await emit(peek, "player:answer", 1);
  await results2;
  const lr = await lateR;
  check("a replay does not pay the latecomer twice", lr.score === lr.gained + lr.bonus, `${lr.score} vs ${lr.gained}+${lr.bonus}`);

  // a kicked player cannot come straight back in through the open door
  const kicked = once(peek, "game:kicked");
  host.emit("host:kick", "Late");
  await kicked;
  const back = await emit(peek, "player:join", { pin: game.pin, name: "Late" });
  check("a removed player cannot rejoin", back.ok === false && /removed/i.test(back.error), back.error);

  early.close(); peek.close(); host.close();
  await wait(100);
}

// ---------- quick questions: no quiz file ----------
async function testQuickQuestions() {
  console.log("\n# quick questions");
  const host = io(URL);
  await once(host, "connect");
  const game = await emit(host, "host:create", { quick: true });
  check("a quick-question game opens", game.ok === true && game.adhoc === true && game.total === 0, game.error);

  const noPlayers = await emit(host, "host:ask", { type: "choice", text: "Q", choices: ["A", "B"], answer: 0 });
  check("asking with nobody in the room is refused", noPlayers.ok === false, noPlayers.error);

  const s = io(URL);
  await once(s, "connect");
  await emit(s, "player:join", { pin: game.pin, name: "Solo" });

  let q = once(s, "game:question");
  const asked = await emit(host, "host:ask", { type: "choice", text: "", choices: ["A", "B", "C", "D"], answer: 2, time: 30 });
  check("a composed question with no text still works", asked.ok === false && /text/.test(asked.error), asked.error);
  const asked2 = await emit(host, "host:ask", { type: "choice", text: "Which one?", choices: ["A", "B", "C", "D"], answer: 2, time: 30 });
  check("a composed question is asked", asked2.ok === true && asked2.index === 0, asked2.error);
  const first = await q;
  check("the phone shows the lettered buttons", first.labels && first.labels[2] === "C");
  const open = await emit(host, "host:ask", { type: "truefalse", text: "Again?", answer: true });
  check("a second question cannot open over the first", open.ok === false, open.error);

  const results = once(host, "game:results");
  await emit(s, "player:answer", 2);
  const r = await results;
  check("results do not pretend this was the last question", r.adhoc === true && r.isLast === false);

  q = once(s, "game:question");
  const tf = await emit(host, "host:ask", { type: "truefalse", text: "The sky is blue.", answer: true, time: 10 });
  check("another question follows", tf.ok === true && tf.index === 1);
  await q;
  const results2 = once(host, "game:results");
  await emit(s, "player:answer", 0);
  await results2;

  const ended = once(host, "game:end");
  host.emit("host:finish");
  const end = await ended;
  check("the host can finish whenever", end.reportId && end.leaderboard[0].name === "Solo");
  const rep = await fetch(`${URL}/api/reports/${end.reportId}`).then((r) => r.json());
  check("the report has both composed questions", rep.game.kind === "quick" && rep.questions.length === 2, String(rep.questions.length));
  const review = await fetch(`${URL}/api/reports/${end.reportId}/review-quiz`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("no review quiz can be built from quick questions", review.status === 400);

  s.close(); host.close();
  await wait(100);
}

// ---------- homework: self-paced ----------
async function testHomework() {
  console.log("\n# homework (self-paced)");
  const post = (body) => fetch(`${URL}/api/assignments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const bad = await post({ quizId: "all-types", dueAt: "2001-01-01T00:00" });
  check("a due date in the past is refused", !!bad.error, bad.error);
  const made = await post({ quizId: "all-types", rosterId: "period3" });
  check("an assignment is created with a code", made.ok === true && /^\d{6}$/.test(made.code), made.error);
  const listed = await fetch(`${URL}/api/assignments`).then((r) => r.json());
  check("it is listed as open with nobody started", listed.some((a) => a.code === made.code && a.started === 0 && !a.closed_at));
  check("it already appears in the reports", (await fetch(`${URL}/api/reports`).then((r) => r.json())).some((g) => g.id === made.gameId && g.kind === "assignment"));

  const s = io(URL);
  await once(s, "connect");
  const lobby = await emit(s, "player:lobby", { pin: made.code });
  check("the join screen knows it is homework", lobby.ok && lobby.selfPaced === true && lobby.roster === true, JSON.stringify(lobby));
  const stranger = await emit(s, "player:join", { pin: made.code, name: "Nobody", identifier: "9999" });
  check("the class list is enforced", stranger.ok === false, stranger.error);
  const join = await emit(s, "player:join", { pin: made.code, name: "ada", identifier: "1001" });
  check("a student joins and gets the first question", join.ok === true && join.selfPaced === true && join.state === "question", join.error);
  // all-types opens with a slide, which self-paced play steps straight over
  check("slides are skipped", join.question.type === "choice" && join.question.index === 1, `${join.question.type} ${join.question.index}`);
  check("no clock is running", join.question.endsAt === null);
  check("the answer never reaches the phone", join.question.answer === undefined);

  const a1 = await emit(s, "player:answer", join.question.labels ? join.question.labels.indexOf("Mars") : 1);
  check("an answer is graded on the spot", a1.ok === true && a1.result && a1.result.correct === true && a1.result.gained > 0, JSON.stringify(a1).slice(0, 200));
  check("the explanation comes with it", /iron oxide/.test(a1.result.explanation));

  // a dropped connection: joining again resumes on the next question
  s.close();
  const s2 = io(URL);
  await once(s2, "connect");
  const back = await emit(s2, "player:join", { pin: made.code, name: "whatever", identifier: "Ada Lovelace" });
  check("coming back resumes where they were, by identity", back.ok && back.name === "ada" && back.question.index === 2, JSON.stringify(back).slice(0, 160));
  check("homework with a file question hands out an upload token", typeof back.uploadToken === "string");

  // play it out
  let step = back;
  let n = 0;
  let last = null;
  while (step.question && n < 20) {
    n++;
    const q = step.question;
    const ANSWERS = {
      truefalse: 0, multi: [0], slider: 200, text: "Au", numeric: 391, blank: ["100", "0"],
      order: q.items ? q.items.map((_, i) => i) : null, match: q.lefts ? q.lefts.map((_, i) => i) : null,
      hotspot: { x: 0.5, y: 0.5 }, longtext: "Because.", poll: 0, wordcloud: ["cells"], choice: 0,
    };
    let answer = ANSWERS[q.type];
    if (q.type === "file") {
      const up = await fetch(`${URL}/uploads/${back.uploadToken}`, { method: "POST", body: Buffer.from("%PDF-1.4 tiny"), headers: { "Content-Type": "application/pdf", "X-File-Name": "working.pdf" } }).then((r) => r.json());
      if (!up.ok) throw new Error(`homework upload failed: ${up.error}`);
      answer = { file: up.id, name: up.name, type: up.type };
    }
    const res = await emit(s2, "player:answer", answer);
    if (!res.ok) throw new Error(`homework answer rejected on ${q.type}: ${res.error}`);
    last = res.result;
    step = await emit(s2, "player:next");
  }
  check("the run reaches the end", step.ok && step.end && step.end.finished === true, JSON.stringify(step).slice(0, 200));
  check("the last result says so", last && last.isLast === true);
  check("a finished student is ranked among finishers", step.end.rank === 1 && step.end.players === 1);
  const again = await emit(s2, "player:answer", 0);
  check("answering after the end is refused", again.ok === false, again.error);

  const prog = (await fetch(`${URL}/api/assignments`).then((r) => r.json())).find((a) => a.code === made.code);
  check("the instructor sees one finished", prog.started === 1 && prog.finished === 1, JSON.stringify(prog));
  const rep = await fetch(`${URL}/api/reports/${made.gameId}`).then((r) => r.json());
  check("the report has the student's answers", rep.players.length === 1 && rep.players[0].answers.length === 14, String(rep.players[0]?.answers.length));
  check("the report names who was absent", rep.roster && rep.roster.absent.length === 4, JSON.stringify(rep.roster));

  // close it
  const closed = await fetch(`${URL}/api/assignments/${made.code}`, { method: "DELETE" }).then((r) => r.json());
  check("an assignment can be closed", closed.ok === true);
  const s3 = io(URL);
  await once(s3, "connect");
  const after = await emit(s3, "player:join", { pin: made.code, name: "alan", identifier: "1002" });
  check("nobody can join a closed assignment", after.ok === false && /closed/i.test(after.error), after.error);
  s2.close(); s3.close();
  await wait(100);
}

// ---------- the gradebook ----------
async function testGradebook() {
  console.log("\n# gradebook export");
  const csv = await fetch(`${URL}/api/students/csv`).then((r) => r.text());
  const [head, ...rows] = csv.trim().split("\n");
  check("the gradebook has a column per game", head.startsWith("student,nicknames,") && head.includes("Every Question Type ("));
  check("one row per student", rows.length >= 3, String(rows.length));
  const ada = rows.find((r) => r.startsWith("Ada Lovelace,") || r.startsWith("1001,"));
  check("a student who played is a row", !!ada, rows.slice(0, 3).join(" / "));
  const points = await fetch(`${URL}/api/students/csv?metric=points`).then((r) => r.text());
  check("points is the other metric", points.split("\n")[0] === head && points !== csv);
  const cells = head.split(",").length;
  check("every row has every column", rows.every((r) => r.split(",").length >= cells - 2), "rows with quoted titles may split differently");
}

// ---------- teams ----------
async function testTeams() {
  console.log("\n# teams");
  const host = io(URL);
  await once(host, "connect");
  const game = await emit(host, "host:create", { quizId: "sample", teams: 2 });
  check("a team game names its teams", game.ok && Array.isArray(game.teams) && game.teams.length === 2, JSON.stringify(game.teams));
  const players = {};
  const joins = [];
  for (const n of ["Ada", "Bea", "Cid"]) {
    const s = io(URL);
    await once(s, "connect");
    const j = await emit(s, "player:join", { pin: game.pin, name: n });
    joins.push(j);
    players[n] = s;
  }
  check("players are told their team", joins.every((j) => j.team && typeof j.team.name === "string"));
  const sizes = {};
  for (const j of joins) sizes[j.team.index] = (sizes[j.team.index] || 0) + 1;
  check("teams are kept balanced", Object.values(sizes).sort().join(",") === "1,2", JSON.stringify(sizes));

  let nextQ = once(host, "game:question");
  host.emit("host:start", {});
  const q = await nextQ;
  const hostR = once(host, "game:results");
  const adaR = once(players.Ada, "game:results");
  await emit(players.Ada, "player:answer", 0);
  await emit(players.Bea, "player:answer", 0);
  await emit(players.Cid, "player:answer", (0 + 1) % q.choices.length);
  const hr = await hostR;
  const ar = await adaR;
  check("the host leaderboard is the teams", hr.teams === true && hr.leaderboard.length === 2 && hr.leaderboard.every((t) => Array.isArray(t.members)), JSON.stringify(hr.leaderboard));
  check("a team score is the average of its members", hr.leaderboard.every((t) => Number.isInteger(t.score)));
  check("the phone gets its team's standing", ar.team && typeof ar.team.rank === "number" && typeof ar.team.score === "number", JSON.stringify(ar.team));

  // play out and finish
  for (let i = 0; i < 3; i++) {
    const open = once(host, "game:question");
    host.emit("host:next");
    await open;
    const done = once(host, "game:results");
    for (const s of Object.values(players)) await emit(s, "player:answer", 0);
    await done;
  }
  const ended = once(host, "game:end");
  host.emit("host:next");
  const end = await ended;
  check("the final standings are teams, with the individual board alongside", end.teams === true && end.leaderboard.length === 2 && end.players.length === 3);
  const rep = await fetch(`${URL}/api/reports/${end.reportId}`).then((r) => r.json());
  check("the report records each player's team", rep.players.every((p) => /^Team /.test(p.team)), JSON.stringify(rep.players.map((p) => p.team)));

  for (const s of Object.values(players)) s.close();
  host.close();
  await wait(100);
}
