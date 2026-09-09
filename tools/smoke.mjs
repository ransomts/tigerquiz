#!/usr/bin/env node
// End-to-end smoke test against a running development server: create a game
// over HTTP, join a player, then play a whole quiz over real Action Cable
// websockets. Needs Node 22+ for its built-in WebSocket client.
//
//   bin/rails server            # in one terminal
//   node tools/smoke.mjs        # in another; BASE=http://host:port to point elsewhere
const BASE = process.env.BASE || "http://127.0.0.1:3999";
const WS = BASE.replace(/^http/, "ws") + "/cable";
// The origin the app believes the page came from. Behind a TLS-terminating
// proxy that is https even though this tool speaks http to it, and Action Cable
// checks the two match: ORIGIN=https://quiz.example.edu to say so.
const ORIGIN = process.env.ORIGIN || new URL(BASE).origin;
// In development the server signs requests in as the developer user, who owns
// the seeded quizzes. Against a real instance the proxy decides who you are, so
// either sign in the way it expects (AUTH=user:password, for a proxy doing basic
// auth) or, with no proxy in front, send the header it would have set
// (TIGERQUIZ_USER=you@example.edu).
const HOST = {};
if (process.env.AUTH) HOST.Authorization = `Basic ${Buffer.from(process.env.AUTH).toString("base64")}`;
else if (process.env.TIGERQUIZ_USER) HOST["X-Remote-User"] = process.env.TIGERQUIZ_USER;

let cookie = "";
let csrf = "";
async function page(path, headers = {}) {
  const r = await fetch(BASE + path, { headers: { ...headers, cookie }, redirect: "manual" });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const html = await r.text();
  const m = html.match(/name="csrf-token" content="([^"]+)"/);
  if (m) csrf = m[1];
  return r.status;
}
async function api(path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method: "POST", headers: { ...headers, cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(body),
  });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return r.json();
}

function cable(params) {
  // A browser always sends Origin, and in production Action Cable refuses a
  // websocket without one. Send the origin the page would have been served from.
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
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ command: "subscribe", identifier }));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === "confirm_subscription") return resolve(conn);
      if (msg.type === "reject_subscription") return reject(new Error("rejected"));
      if (msg.type === "ping" || msg.type === "welcome") return;
      if (msg.message) {
        const e = msg.message;
        const w = waiters.findIndex((x) => x.event === e.event);
        if (w >= 0) { waiters.splice(w, 1)[0].resolve(e); e._taken = true; }
        events.push(e);
      }
    };
    ws.onerror = (e) => reject(e);
  });
  return ready;
}

let ok = 0, bad = 0;
const check = (name, cond, extra = "") => { cond ? ok++ : bad++; console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? "  (" + extra + ")" : ""}`); };

check("host page renders with the header", (await page("/host", HOST)) === 200);
const game = await api("/api/games", { quizId: "sample" }, HOST);
check("game created over http", game.ok === true, game.error);

await page("/"); // a player's page: fresh csrf for the player session
const lobby = await api("/api/lobby", { pin: game.pin });
check("lobby lookup", lobby.ok && lobby.title === "Sample Quiz");
const joined = await api("/api/join", { pin: game.pin, name: "Smoky" });
check("player joined", joined.ok === true, joined.error);

const host = await cable({ pin: game.pin, role: "host", token: game.hostToken });
check("host subscribed", true);
try { await cable({ pin: game.pin, role: "host", token: "wrong" }); check("wrong token rejected", false); } catch { check("wrong token rejected", true); }
const player = await cable({ pin: game.pin, role: "player", name: "Smoky", token: joined.token });
check("player subscribed", true);
const lobbyMsg = await host.next("lobby:players");
check("host sees the player", lobbyMsg.players.some((p) => p.name === "Smoky" && p.connected));

host.perform("start", {});
const hq = await host.next("game:question");
const pq = await player.next("game:question");
check("question reaches both screens", hq.index === 0 && pq.index === 0 && typeof pq.text === "string");
check("phone never gets the answer", pq.answer === undefined);

player.perform("answer", { response: 0, seq: 1 });
const ack = await player.next("answer:ack");
check("answer acknowledged", ack.ok === true, ack.error);
const hr = await host.next("game:results");
const pr = await player.next("game:results");
check("results on both screens", hr.summary.kind === "counts" && typeof pr.score === "number");
check("correct answer scored", pr.correct === true && pr.gained > 0, String(pr.gained));

for (let i = 0; i < 3; i++) {
  host.perform("advance");
  await player.next("game:question");
  player.perform("answer", { response: 0, seq: 10 + i });
  await player.next("answer:ack");
  await host.next("game:results");
}
host.perform("advance");
const end = await host.next("game:end");
const pend = await player.next("game:end");
check("game ends with a report", typeof end.reportId === "string" && pend.rank === 1, end.reportId);

const rep = await fetch(`${BASE}/api/reports/${end.reportId}`, { headers: { ...HOST, cookie } }).then((r) => r.json());
check("report is readable", rep.game && rep.players.length === 1 && rep.questions.length === 4);

host.close();
player.close();
console.log(`\n${ok}/${ok + bad} passed`);
process.exit(bad ? 1 : 0);
