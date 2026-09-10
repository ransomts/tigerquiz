// Sign-in and per-instructor ownership, with TIGERQUIZ_AUTH=required.
//   npm run test:auth
//
// The server is started the way Apache would run it, and each request carries
// the header Apache would set. That is the whole authentication model, so these
// tests are the ones that say the boundary actually holds.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { rm, writeFile } from "node:fs/promises";
import { io } from "socket.io-client";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = process.env.TEST_PORT || (await freePort());
const URL = `http://localhost:${PORT}`;
const DATA = path.join(ROOT, "data", "test-auth");

const ALICE = "alice@example.edu";
const BOB = "bob@example.edu";

// A quiz nobody has claimed, standing in for the samples that ship with the app
// and for anything dropped into quizzes/ by hand.
const UNOWNED = "auth-test-unowned";
const ALICES = "auth-test-alices";
const files = [UNOWNED, ALICES];

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

const quizPath = (id) => path.join(ROOT, "quizzes", `${id}.json`);
const sampleQuiz = (title) => ({
  title,
  questions: [{ text: "Two plus two?", choices: ["3", "4"], answer: 1, time: 5 }],
});

/** A request as a given instructor, or as nobody when eppn is null. */
const as = (eppn, url, opts = {}) =>
  fetch(`${URL}${url}`, {
    ...opts,
    headers: {
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(eppn ? { "X-Remote-User": eppn } : {}),
      ...(opts.headers || {}),
    },
  });

const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
/** @param {import("socket.io-client").Socket} s */
const connected = (s) => /** @type {Promise<void>} */ (new Promise((r) => s.once("connect", () => r())));
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
await writeFile(quizPath(UNOWNED), JSON.stringify(sampleQuiz("Nobody's Quiz"), null, 2), "utf8");

const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TIGERQUIZ_DATA: DATA, TIGERQUIZ_AUTH: "required" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("server did not start within 15s")), 15000);
  server.stdout.on("data", (d) => {
    if (String(d).includes("listening")) { clearTimeout(timer); resolve(); }
  });
  server.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code}`)); });
}));
console.log(`server on port ${PORT}`);

try {
  await testPublicAndProtected();
  await testOwnershipOnCreate();
  await testIsolationBetweenInstructors();
  await testUnownedIsSharedAndClaimable();
  await testGameAndReportOwnership();
} catch (e) {
  console.error("\nthrew:", e.message);
  fail.push(e.message);
}

server.kill();
await rm(DATA, { recursive: true, force: true });
for (const id of files) await rm(quizPath(id), { force: true });
console.log(`\n${count - fail.length}/${count} passed`);
if (fail.length) { console.error(`FAILED: ${fail.join(", ")}`); process.exit(1); }

// ---------- suites ----------

async function testPublicAndProtected() {
  console.log("\n# what needs a session and what does not");

  // Students never sign in; these are the endpoints their phones touch.
  check("the join page is public", (await as(null, "/")).status === 200);
  check("a nickname can be suggested without signing in", (await as(null, "/api/nickname")).status === 200);

  // Everything a teacher touches needs an identity. The QR code is in here
  // because only the host screen ever asks for one; students scan it, they do
  // not fetch it.
  for (const url of ["/api/quizzes", "/api/rosters", "/api/reports", "/api/students", "/api/host-key", "/api/qr.svg?text=hi"]) {
    check(`${url} refuses an anonymous request`, (await as(null, url)).status === 401);
  }

  const me = await json(await as(null, "/api/me"));
  check("/api/me says sign-in is required", me.body?.authRequired === true);
  check("/api/me reports nobody when no header arrives", me.body?.user === null);

  const mine = await json(await as(ALICE, "/api/me"));
  check("/api/me names the signed-in instructor", mine.body?.user?.eppn === ALICE, String(mine.body?.user?.eppn));
}

async function testOwnershipOnCreate() {
  console.log("\n# saving something makes it yours");

  const put = await json(
    await as(ALICE, `/api/quiz/${ALICES}`, { method: "PUT", body: JSON.stringify(sampleQuiz("Alice's Quiz")) })
  );
  check("an instructor can save a new quiz", put.status === 200, String(put.status));

  const got = await json(await as(ALICE, `/api/quiz/${ALICES}`));
  check("the saver owns it", got.body?.owner === ALICE, String(got.body?.owner));
  check("and is told it is theirs", got.body?.mine === true);

  const list = await json(await as(ALICE, "/api/quizzes"));
  const row = list.body?.find((q) => q.id === ALICES);
  check("it appears in the owner's list", !!row);
  check("marked as theirs", row?.mine === true);
}

async function testIsolationBetweenInstructors() {
  console.log("\n# one instructor cannot reach another's work");

  const list = await json(await as(BOB, "/api/quizzes"));
  check("another instructor does not see it listed", !list.body?.some((q) => q.id === ALICES));

  // 404 rather than 403: a listing must not become a way to enumerate
  // other people's quizzes.
  const read = await as(BOB, `/api/quiz/${ALICES}`);
  check("reading it reports missing, not forbidden", read.status === 404, String(read.status));

  const write = await as(BOB, `/api/quiz/${ALICES}`, {
    method: "PUT", body: JSON.stringify(sampleQuiz("Bob was here")),
  });
  check("overwriting it is refused", write.status === 404, String(write.status));

  const del = await as(BOB, `/api/quiz/${ALICES}`, { method: "DELETE" });
  check("deleting it is refused", del.status === 404, String(del.status));

  // 404 again, and for the same reason: a refusal must not confirm it is there.
  const claim = await as(BOB, `/api/quiz/${ALICES}/claim`, { method: "POST" });
  check("claiming it is refused without confirming it exists", claim.status === 404, String(claim.status));

  // and none of that damaged the file
  const after = await json(await as(ALICE, `/api/quiz/${ALICES}`));
  check("the owner's quiz is untouched", after.body?.title === "Alice's Quiz", String(after.body?.title));
}

async function testUnownedIsSharedAndClaimable() {
  console.log("\n# an unclaimed file is shared, read-only, and claimable");

  for (const [who, name] of [[ALICE, "one instructor"], [BOB, "another"]]) {
    const list = await json(await as(who, "/api/quizzes"));
    const row = list.body?.find((q) => q.id === UNOWNED);
    check(`${name} can see an unowned quiz`, !!row);
    check(`${name} is told nobody owns it`, row?.unowned === true);
  }

  const write = await json(await as(ALICE, `/api/quiz/${UNOWNED}`, {
    method: "PUT", body: JSON.stringify(sampleQuiz("Taken")),
  }));
  check("an unowned quiz cannot be edited", write.status === 403, String(write.status));
  check("and the refusal says it can be claimed", write.body?.claimable === true);

  const claim = await json(await as(BOB, `/api/quiz/${UNOWNED}/claim`, { method: "POST" }));
  check("any instructor may claim it", claim.status === 200, String(claim.status));

  const edit = await as(BOB, `/api/quiz/${UNOWNED}`, {
    method: "PUT", body: JSON.stringify(sampleQuiz("Bob's now")),
  });
  check("the claimer can then edit it", edit.status === 200, String(edit.status));

  const other = await as(ALICE, `/api/quiz/${UNOWNED}`);
  check("and it is private from then on", other.status === 404, String(other.status));

  // Once claimed it is private, so a second claim is refused the same way a
  // read is: as missing, not as forbidden.
  const again = await as(ALICE, `/api/quiz/${UNOWNED}/claim`, { method: "POST" });
  check("a claimed quiz cannot be claimed again", again.status === 404, String(again.status));
}

async function testGameAndReportOwnership() {
  console.log("\n# games and their reports belong to whoever ran them");

  const key = (await json(await as(ALICE, "/api/host-key"))).body.key;
  const host = io(URL, { extraHeaders: { "X-Remote-User": ALICE } });
  await connected(host);

  const created = await new Promise((r) => host.emit("host:create", { quizId: ALICES, key }, r));
  check("the owner can host their own quiz", created?.ok === true, created?.error || "");

  // Play it through with a real player, so a report is actually kept: a
  // rehearsal with nobody in the room deliberately leaves none behind.
  const player = io(URL);
  await connected(player);
  const joined = await new Promise((r) => player.emit("player:join", { pin: created.pin, name: "Robin" }, r));
  check("a student joins without signing in", joined?.ok === true, joined?.error || "");

  const ended = new Promise((r) => host.once("game:end", r));
  host.emit("host:start", {});
  await wait(150);
  host.emit("host:skip");
  await wait(150);
  host.emit("host:next");
  await ended;
  await wait(200);
  player.close();
  host.close();

  const mine = await json(await as(ALICE, "/api/reports"));
  const theirs = await json(await as(BOB, "/api/reports"));
  check("the report reaches the instructor who ran it", mine.body?.length > 0, String(mine.body?.length));
  check("and not anybody else", theirs.body?.length === 0, String(theirs.body?.length));

  const id = mine.body[0].id;
  check("the report records its owner", mine.body[0].owner === ALICE, String(mine.body[0].owner));
  check("another instructor cannot open it", (await as(BOB, `/api/reports/${id}`)).status === 404);
  check("nor download the CSV of student names", (await as(BOB, `/api/reports/${id}/csv`)).status === 404);
  check("nor delete it", (await as(BOB, `/api/reports/${id}`, { method: "DELETE" })).status === 404);

  const students = await json(await as(BOB, "/api/students"));
  check("nor see the students in it", students.body?.length === 0, String(students.body?.length));

  // An unowned report is nobody's, not everybody's: unlike a quiz, it carries
  // student names, identifiers and every answer they gave.
  await testUnownedReportsArePrivate(id);

  // hosting over the websocket is gated the same way as the HTTP API
  const bobKey = (await json(await as(BOB, "/api/host-key"))).body.key;
  const bobSock = io(URL, { extraHeaders: { "X-Remote-User": BOB } });
  await connected(bobSock);
  const refused = await new Promise((r) => bobSock.emit("host:create", { quizId: ALICES, key: bobKey }, r));
  check("another instructor cannot host it either", refused?.ok === false, refused?.error || "");
  bobSock.close();
}

/**
 * Reports recorded before sign-in existed have no owner. They must not follow
 * the quiz rule, where unowned means shared.
 */
async function testUnownedReportsArePrivate(ownedId) {
  console.log("\n# an unowned report is nobody's, not everybody's");

  // Put the report back the way a pre-sign-in one looks. There is no endpoint
  // for this on purpose, so the test reaches for the database directly.
  const db = await import("node:child_process");
  db.execSync(`sqlite3 ${DATA}/tigerquiz.db "UPDATE games SET owner = NULL WHERE id = '${ownedId}'"`);

  for (const [who, label] of [[ALICE, "the instructor who ran it"], [BOB, "another instructor"]]) {
    const list = await json(await as(who, "/api/reports"));
    check(`${label} no longer sees it once it is unowned`, list.body?.length === 0, String(list.body?.length));
    check(`${label} cannot open it`, (await as(who, `/api/reports/${ownedId}`)).status === 404);
    check(`${label} cannot take its CSV`, (await as(who, `/api/reports/${ownedId}/csv`)).status === 404);
  }

  const students = await json(await as(ALICE, "/api/students"));
  check("the students in it are hidden too", students.body?.length === 0, String(students.body?.length));

  // An admin can see it, which is what makes it recoverable at all.
  db.execSync(`sqlite3 ${DATA}/tigerquiz.db "UPDATE users SET role = 'admin' WHERE eppn = '${BOB}'"`);
  const adminList = await json(await as(BOB, "/api/reports"));
  check("an admin can see unowned reports", adminList.body?.length === 1, String(adminList.body?.length));
  check("and can open one", (await as(BOB, `/api/reports/${ownedId}`)).status === 200);

  // ...and hand it to whoever should have it.
  const claim = await as(BOB, `/api/reports/${ownedId}/claim`, { method: "POST" });
  check("and can claim it", claim.status === 200, String(claim.status));

  db.execSync(`sqlite3 ${DATA}/tigerquiz.db "UPDATE users SET role = 'instructor' WHERE eppn = '${BOB}'"`);
}
