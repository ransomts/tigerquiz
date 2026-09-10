// Hand ownership of existing content to an instructor, and promote admins.
//
//   node tools/assign-owner.mjs --user you@example.edu --reports
//   node tools/assign-owner.mjs --user you@example.edu --all --dry-run
//   node tools/assign-owner.mjs --user you@example.edu --admin
//
// Why this exists: reports recorded before sign-in was switched on have no
// owner, and an unowned report is visible to nobody but an admin, because it
// holds student names, identifiers and every answer they gave. This is how they
// get back to the person who ran them. Quizzes and class lists do not need it —
// unowned ones are shared and claimable from the editor — but --quizzes and
// --rosters are here for tidying up a shared box.
//
// Run it on the machine that has the database, with the server stopped or
// running; SQLite handles both.
import path from "node:path";
import { readdir } from "node:fs/promises";
import * as store from "../lib/db.js";
import { DATA_DIR, QUIZ_DIR, ROSTER_DIR } from "../lib/config.js";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

const user = value("user");
const dryRun = flag("dry-run");
const wantAll = flag("all");
const wantReports = wantAll || flag("reports");
const wantQuizzes = wantAll || flag("quizzes");
const wantRosters = wantAll || flag("rosters");
const makeAdmin = flag("admin");

if (!user || (!wantReports && !wantQuizzes && !wantRosters && !makeAdmin)) {
  console.error(`Assign existing content to an instructor.

  --user <eppn>   who to assign to (required)
  --reports       every report nobody owns
  --quizzes       every quiz file nobody owns
  --rosters       every class list nobody owns
  --all           all three
  --admin         also make this user an admin
  --dry-run       say what would change, change nothing

An admin sees unowned reports and everyone else's work, so promote sparingly.`);
  process.exit(1);
}

store.open(DATA_DIR);
console.log(`database: ${path.join(DATA_DIR, "tigerquiz.db")}`);
console.log(`assigning to: ${user}${dryRun ? "  (dry run)" : ""}\n`);

// The user row has to exist before anything can point at it.
if (!dryRun) store.touchUser(user);

if (wantReports) {
  const n = store.countUnownedGames();
  if (dryRun) console.log(`reports:  ${n} unowned would be assigned`);
  else console.log(`reports:  ${store.assignUnownedGames(user)} assigned`);
}

/** Files on disk with no row in the owners table. */
async function unownedFiles(kind, dir) {
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map((f) => f.replace(/\.json$/, "")).filter((id) => store.ownerOf(kind, id) === null);
}

for (const { want, kind, dir, label } of [
  { want: wantQuizzes, kind: "quiz", dir: QUIZ_DIR, label: "quizzes" },
  { want: wantRosters, kind: "roster", dir: ROSTER_DIR, label: "rosters" },
]) {
  if (!want) continue;
  const ids = await unownedFiles(kind, dir);
  if (!dryRun) for (const id of ids) store.setOwner(kind, id, user);
  console.log(`${label.padEnd(9)} ${ids.length} ${dryRun ? "unowned would be assigned" : "assigned"}${ids.length ? `: ${ids.join(", ")}` : ""}`);
}

if (makeAdmin) {
  if (dryRun) console.log(`role:     would become admin`);
  else console.log(`role:     ${store.setRole(user, "admin").role}`);
}

store.close();
console.log(dryRun ? "\nNothing was changed." : "\nDone.");
