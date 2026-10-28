// The spreadsheet importer runs in the editor, but it is plain code with no
// DOM in it, so it can be exercised here with node's zlib standing in for the
// browser's DecompressionStream.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = await readFile(path.join(ROOT, "public", "import.js"), "utf8");
const ctx = vm.createContext({ TextDecoder, DataView, Uint8Array });
vm.runInContext(src + "\nthis.TQImport = TQImport;", ctx);
/** @type {any} */
const TQImport = ctx.TQImport;
const inflate = (bytes) => inflateRawSync(Buffer.from(bytes));
// objects made inside the vm have a different Object prototype, which strict
// deep equality notices; a JSON round-trip brings them into this realm
const plain = (v) => JSON.parse(JSON.stringify(v));

describe("importing a Kahoot spreadsheet", () => {
  test("the template's rows come out as questions", async () => {
    const bytes = new Uint8Array(await readFile(path.join(ROOT, "test", "fixtures", "kahoot-template.xlsx")));
    const rows = await TQImport.parseXlsx(bytes, inflate);
    assert.ok(rows.length >= 5, `rows: ${rows.length}`);
    const qs = plain(TQImport.rowsToQuestions(rows));
    assert.equal(qs.length, 4);
    assert.deepEqual(qs[0], { text: "Which planet is red?", time: 20, type: "choice", choices: ["Venus", "Mars", "Jupiter", "Mercury"], answer: 1 });
    assert.equal(qs[1].type, "multi");
    assert.deepEqual(qs[1].answers, [1, 2]);
    assert.equal(qs[2].type, "truefalse");
    assert.equal(qs[2].answer, 0);
    assert.equal(qs[3].type, "poll"); // no correct answer given
  });

  test("our own CSV columns are recognised as rows too", () => {
    const rows = [["question", "choice1", "choice2", "choice3", "choice4", "answer", "time", "explanation"], ["2+2?", "3", "4", "", "", "2", "15", "arithmetic"]];
    const qs = TQImport.rowsToQuestions(rows);
    assert.equal(qs.length, 1);
    assert.equal(qs[0].answer, 1);
    assert.equal(qs[0].explanation, "arithmetic");
  });

  test("a Quizizz-style export with the answer written out works", () => {
    const rows = [["Question Text", "Option 1", "Option 2", "Option 3", "Correct Answer", "Time in seconds"], ["Capital of France?", "Paris", "Rome", "Oslo", "Paris", "30"]];
    const qs = TQImport.rowsToQuestions(rows);
    assert.equal(qs[0].answer, 0);
    assert.equal(qs[0].time, 30);
  });

  test("a sheet with no recognisable header yields nothing rather than nonsense", () => {
    assert.deepEqual(plain(TQImport.rowsToQuestions([["a", "b"], ["c", "d"]])), []);
  });
});
