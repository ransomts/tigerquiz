// Reading other tools' spreadsheets into questions. Loaded by edit.html before
// edit.js, and also evaluated by the unit tests in node, so it must stay free
// of DOM calls: the zip is inflated through a function the caller supplies
// (DecompressionStream in the browser, zlib in node) and the sheet XML is
// picked apart with regular expressions rather than a parser.
/* eslint-disable no-unused-vars */
const TQImport = (() => {
  // ---------- a minimal zip reader: enough for an .xlsx ----------
  function zipEntries(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // the end-of-central-directory record is within the last 64k; search back for its signature
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a zip file");
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const entries = new Map();
    for (let n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt zip");
      const method = view.getUint16(p + 10, true);
      const csize = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const offset = view.getUint32(p + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries.set(name, { method, csize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, data: (e) => {
      // local header: skip its own name and extra fields to reach the bytes
      const nameLen = view.getUint16(e.offset + 26, true);
      const extraLen = view.getUint16(e.offset + 28, true);
      const start = e.offset + 30 + nameLen + extraLen;
      return bytes.subarray(start, start + e.csize);
    } };
  }

  const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

  /**
   * The first worksheet of an .xlsx as rows of strings. `inflate` turns
   * deflate-raw bytes back into bytes and may be async.
   */
  async function parseXlsx(bytes, inflate) {
    const zip = zipEntries(bytes);
    const read = async (name) => {
      const e = zip.entries.get(name);
      if (!e) return null;
      const raw = zip.data(e);
      const out = e.method === 0 ? raw : await inflate(raw);
      return new TextDecoder().decode(out);
    };
    const shared = [];
    const ss = await read("xl/sharedStrings.xml");
    if (ss) {
      for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
        shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescape(t[1])).join(""));
      }
    }
    const sheetName = [...zip.entries.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
    const xml = sheetName ? await read(sheetName) : null;
    if (!xml) throw new Error("No worksheet in this file");
    const rows = [];
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of r[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[2] || "";
        const body = c[3] || "";
        const type = (attrs.match(/t="(\w+)"/) || [])[1];
        const value = type === "s" ? shared[Number((body.match(/<v>(.*?)<\/v>/) || [])[1])] ?? ""
          : type === "inlineStr" ? [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescape(t[1])).join("")
          : unescape((body.match(/<v>(.*?)<\/v>/) || [])[1] ?? "");
        cells[colIndex(c[1])] = value;
      }
      rows.push(Array.from(cells, (v) => (v == null ? "" : String(v))));
    }
    return rows;
  }

  // ---------- rows to questions ----------
  const norm = (s) => String(s ?? "").trim().toLowerCase();

  /**
   * Kahoot's template has a header row whose cells begin "Question", "Answer 1"
   * ... "Time limit", "Correct answer(s)"; Quizizz and Wayground exports use
   * "Question Text", "Option 1" ... "Correct Answer". Ours is "question,
   * choice1 ... answer". Find whichever header is there and map by column.
   */
  function findLayout(rows) {
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const h = rows[i].map(norm);
      // names are tried in order, so "correct answer" wins over a bare "answer",
      // and a bare name must match a whole cell or it would catch "answer 1"
      const col = (...names) => {
        for (const n of names) {
          const i = h.findIndex((c) => c === n || (n.includes(" ") && c.startsWith(n)));
          if (i >= 0) return i;
        }
        return -1;
      };
      const question = col("question - max", "question text", "question");
      if (question < 0) continue;
      const answers = [];
      for (let k = 1; k <= 6; k++) {
        const c = col(`answer ${k}`, `option ${k}`, `choice${k}`, `choice ${k}`);
        if (c >= 0) answers.push(c);
      }
      if (answers.length < 2) continue;
      return {
        start: i + 1, question, answers,
        time: col("time limit", "time in seconds", "time"),
        correct: col("correct answer", "answer"),
        explanation: col("explanation"),
      };
    }
    return null;
  }

  function rowsToQuestions(rows) {
    const layout = findLayout(rows);
    if (!layout) return [];
    const out = [];
    for (const r of rows.slice(layout.start)) {
      const text = String(r[layout.question] ?? "").trim();
      if (!text) continue;
      const choices = layout.answers.map((c) => String(r[c] ?? "").trim()).filter(Boolean).slice(0, 4);
      if (choices.length < 2) continue;
      // "2" or "1,3" (one-based) in Kahoot and ours; Quizizz sometimes writes the answer text itself
      const rawCorrect = String(layout.correct >= 0 ? r[layout.correct] ?? "" : "").trim();
      let correct = rawCorrect.split(/[,;\s]+/).map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 1 && n <= choices.length).map((n) => n - 1);
      if (!correct.length && rawCorrect) {
        const byText = choices.findIndex((c) => norm(c) === norm(rawCorrect));
        if (byText >= 0) correct = [byText];
      }
      const time = Number(layout.time >= 0 ? r[layout.time] : 0);
      const q = { text, time: time > 0 ? time : 20 };
      const ex = layout.explanation >= 0 ? String(r[layout.explanation] ?? "").trim() : "";
      if (ex) q.explanation = ex;
      const tf = choices.length === 2 && choices.every((c) => /^(true|false)$/i.test(c));
      if (!correct.length) Object.assign(q, { type: "poll", choices });
      else if (tf) Object.assign(q, { type: "truefalse", answer: /^true$/i.test(choices[correct[0]]) ? 0 : 1 });
      else if (correct.length > 1) Object.assign(q, { type: "multi", choices, answers: correct });
      else Object.assign(q, { type: "choice", choices, answer: correct[0] });
      out.push(q);
    }
    return out;
  }

  return { parseXlsx, rowsToQuestions, findLayout };
})();
