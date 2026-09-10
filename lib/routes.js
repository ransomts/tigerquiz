// The HTTP API. Everything a teacher's browser calls; the game itself runs over
// the websocket in sockets.js.
//
// Note for anyone putting a proxy in front: protect all of /api and carve
// /api/nickname back out, rather than listing endpoints to protect, so an
// endpoint added here later is covered by default. See the README.
import express from "express";
import QRCode from "qrcode";
import { unlink } from "node:fs/promises";
import * as store from "./db.js";
import * as nick from "./nicknames.js";
import { issueHostKey } from "./registry.js";
import { withRoster, csvName, toCsv } from "./reports.js";
import {
  safeId, quizPath, rosterPath, readRaw, listQuizzes, listRosters, loadQuiz,
  validateQuiz, pickQuizFields, stripInternals, uniqueQuizId, writeQuiz, writeRoster,
} from "./content.js";

const clamp = (n, lo, hi) => (Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : hi);

export function apiRouter() {
  const api = express.Router();

  api.get("/quizzes", async (_req, res) => {
    try {
      res.json(await listQuizzes());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  api.get("/rosters", async (_req, res) => {
    try {
      res.json(await listRosters());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  api.get("/qr.svg", async (req, res) => {
    const text = String(req.query.text || "").slice(0, 300);
    if (!text) return res.status(400).end();
    try {
      const svg = await QRCode.toString(text, { type: "svg", margin: 1, color: { dark: "#111111", light: "#ffffff" } });
      res.type("image/svg+xml").send(svg);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  api.get("/reports", (_req, res) => res.json(store.listGames()));

  api.get("/students", (_req, res) => res.json(store.listStudents()));

  // the join screen offers players a name rather than letting them invent one
  api.get("/nickname", (_req, res) => res.json({ name: nick.suggest() }));

  api.get("/host-key", (_req, res) => res.json({ key: issueHostKey() }));

  // ---------- reports ----------
  api.get("/reports/:id", async (req, res) => {
    const report = store.getReport(req.params.id);
    if (!report) return res.status(404).json({ error: "No such game" });
    res.json(await withRoster(report));
  });

  api.get("/reports/:id/csv", (req, res) => {
    const report = store.getReport(req.params.id);
    if (!report) return res.status(404).json({ error: "No such game" });
    res.type("text/csv").set("Content-Disposition", `attachment; filename="${csvName(report.game)}"`).send(toCsv(report));
  });

  /**
   * Build a new quiz from the questions a class got wrong, for spaced review in a
   * later lesson. Questions are looked up in the original quiz file by the source
   * index recorded at play time, so shuffling does not confuse the mapping.
   */
  api.post("/reports/:id/review-quiz", async (req, res) => {
    const report = store.getReport(req.params.id);
    if (!report) return res.status(404).json({ error: "No such game" });
    const threshold = clamp(Number(req.body?.threshold ?? 0.6), 0.05, 1);
    try {
      const source = await loadQuiz(report.game.quiz_id);
      const missed = report.questions
        .filter((q) => q.correctRate !== null && q.correctRate < threshold && q.sourceIdx != null)
        .sort((a, b) => a.correctRate - b.correctRate);
      if (!missed.length) return res.status(400).json({ error: "Nothing was missed often enough to review" });

      const picked = [];
      const seen = new Set();
      for (const q of missed) {
        if (seen.has(q.sourceIdx)) continue;
        seen.add(q.sourceIdx);
        const original = source.questions[q.sourceIdx];
        if (original) picked.push(stripInternals(original));
      }
      if (!picked.length) return res.status(400).json({ error: "The original quiz no longer has those questions" });

      const id = await uniqueQuizId(`review-${report.game.quiz_id}`);
      const quiz = {
        title: `Review: ${source.title}`,
        note: `Questions the class missed on ${new Date(report.game.started_at).toISOString().slice(0, 10)}`,
        shuffleQuestions: true,
        shuffleAnswers: !!source.shuffleAnswers,
        questions: picked,
      };
      await writeQuiz(id, quiz);
      res.json({ ok: true, id, title: quiz.title, count: picked.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  api.delete("/reports/:id", (req, res) => {
    store.deleteGame(req.params.id);
    res.json({ ok: true });
  });

  // ---------- quiz editing ----------
  api.get("/quiz/:id", async (req, res) => {
    if (!safeId(req.params.id)) return res.status(400).json({ error: "bad quiz id" });
    try {
      res.json(await readRaw(quizPath(req.params.id)));
    } catch (e) {
      res.status(e.code === "ENOENT" ? 404 : 500).json({ error: e.code === "ENOENT" ? "No such quiz" : e.message });
    }
  });

  api.put("/quiz/:id", async (req, res) => {
    const id = req.params.id;
    if (!safeId(id)) return res.status(400).json({ error: "Use letters, digits, dash or underscore for the file name" });
    const { problems } = validateQuiz(req.body);
    if (problems.length) return res.status(400).json({ error: "Fix these first", problems });
    try {
      // only known fields are written, so a stray key cannot end up in the file
      const clean = pickQuizFields(req.body);
      await writeQuiz(id, clean);
      res.json({ ok: true, id, count: clean.questions.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  api.delete("/quiz/:id", async (req, res) => {
    if (!safeId(req.params.id)) return res.status(400).json({ error: "bad quiz id" });
    try {
      await unlink(quizPath(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      res.status(e.code === "ENOENT" ? 404 : 500).json({ error: e.message });
    }
  });

  /** Check a draft without saving it, so the editor can show problems as you type. */
  api.post("/quiz-check", (req, res) => {
    const { problems, questions } = validateQuiz(req.body);
    res.json({ ok: problems.length === 0, problems, count: questions ? questions.length : 0 });
  });

  // ---------- roster editing ----------
  api.get("/roster/:id", async (req, res) => {
    if (!safeId(req.params.id)) return res.status(400).json({ error: "bad roster id" });
    try {
      res.json(await readRaw(rosterPath(req.params.id)));
    } catch (e) {
      res.status(e.code === "ENOENT" ? 404 : 500).json({ error: e.code === "ENOENT" ? "No such class list" : e.message });
    }
  });

  api.put("/roster/:id", async (req, res) => {
    const id = req.params.id;
    if (!safeId(id)) return res.status(400).json({ error: "Use letters, digits, dash or underscore for the file name" });
    const body = req.body || {};
    const students = (Array.isArray(body.students) ? body.students : [])
      .map((s) => (typeof s === "string" ? { name: s } : s))
      .filter((s) => s && String(s.name || "").trim())
      .map((s) => (s.id ? { name: String(s.name).trim(), id: String(s.id).trim() } : { name: String(s.name).trim() }));
    if (!students.length) return res.status(400).json({ error: "Add at least one student" });
    try {
      await writeRoster(id, { title: String(body.title || id), students });
      res.json({ ok: true, id, count: students.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  api.delete("/roster/:id", async (req, res) => {
    if (!safeId(req.params.id)) return res.status(400).json({ error: "bad roster id" });
    try {
      await unlink(rosterPath(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      res.status(e.code === "ENOENT" ? 404 : 500).json({ error: e.message });
    }
  });

  return api;
}
