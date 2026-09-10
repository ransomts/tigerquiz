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
import { requireInstructor, reportScope, canRead, canWrite, canCreate, canReadReport, canWriteReport, forbidden } from "./auth.js";
import { AUTH_REQUIRED } from "./config.js";
import {
  safeId, quizPath, rosterPath, readRaw, listQuizzes, listRosters, loadQuiz, exists,
  validateQuiz, pickQuizFields, stripInternals, uniqueQuizId, writeQuiz, writeRoster,
} from "./content.js";

const clamp = (n, lo, hi) => (Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : hi);

/**
 * Narrow a listing to what this instructor may open, and say who owns each
 * entry so the editor can show it and offer to claim the unowned ones.
 */
function visible(rows, kind, user) {
  const owners = store.ownerMap(kind);
  return rows
    .map((r) => {
      const owner = owners.get(r.id) ?? null;
      return { ...r, owner, mine: !!user && owner === user.eppn, unowned: owner === null };
    })
    .filter((r) => canRead(user, r.owner));
}

export function apiRouter() {
  const api = express.Router();

  // Who am I, for the header on the teacher pages. Public: the join screen asks
  // too, and the honest answer there is "nobody".
  api.get("/me", (req, res) =>
    res.json({
      authRequired: AUTH_REQUIRED,
      user: req.user ? { eppn: req.user.eppn, name: req.user.display_name, role: req.user.role } : null,
    })
  );

  // the join screen offers players a name rather than letting them invent one
  api.get("/nickname", (_req, res) => res.json({ name: nick.suggest() }));

  // Everything past this point belongs to a teacher. Apache decides the same
  // thing by path; this is the second line of defence, and the only one when
  // the app is run without a proxy.
  api.use(requireInstructor);

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

  api.get("/quizzes", async (req, res) => {
    try {
      res.json(visible(await listQuizzes(), "quiz", req.user));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  api.get("/rosters", async (req, res) => {
    try {
      res.json(visible(await listRosters(), "roster", req.user));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  api.get("/reports", (req, res) => res.json(store.listGames(100, reportScope(req))));

  api.get("/students", (req, res) => res.json(store.listStudents(reportScope(req))));

  api.get("/host-key", (_req, res) => res.json({ key: issueHostKey() }));

  // ---------- reports ----------
  api.get("/reports/:id", async (req, res) => {
    const report = store.getReport(req.params.id);
    if (!report) return res.status(404).json({ error: "No such game" });
    if (!canReadReport(req.user, report.game.owner)) return res.status(404).json({ error: "No such game" });
    res.json(await withRoster(report));
  });

  api.get("/reports/:id/csv", (req, res) => {
    const report = store.getReport(req.params.id);
    if (!report) return res.status(404).json({ error: "No such game" });
    if (!canReadReport(req.user, report.game.owner)) return res.status(404).json({ error: "No such game" });
    res.type("text/csv").set("Content-Disposition", `attachment; filename="${csvName(report.game)}"`).send(toCsv(report));
  });

  // Take over a report from before sign-in existed, so it can be deleted.
  api.post("/reports/:id/claim", (req, res) => {
    const owner = store.gameOwner(req.params.id);
    if (owner === undefined) return res.status(404).json({ error: "No such game" });
    // Only an admin can see an unowned report, so only an admin can claim one.
    // For everyone else this is how historical reports are handed back:
    //   node tools/assign-owner.mjs --user you@example.edu --reports
    if (!canReadReport(req.user, owner)) return res.status(404).json({ error: "No such game" });
    if (owner !== null) return res.status(403).json(forbidden(owner));
    if (!canCreate(req.user)) return res.status(401).json({ error: "Sign in first" });
    if (req.user) store.setGameOwner(req.params.id, req.user.eppn);
    res.json({ ok: true });
  });

  /**
   * Build a new quiz from the questions a class got wrong, for spaced review in a
   * later lesson. Questions are looked up in the original quiz file by the source
   * index recorded at play time, so shuffling does not confuse the mapping.
   */
  api.post("/reports/:id/review-quiz", async (req, res) => {
    const report = store.getReport(req.params.id);
    if (!report) return res.status(404).json({ error: "No such game" });
    if (!canReadReport(req.user, report.game.owner)) return res.status(404).json({ error: "No such game" });
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
      // the instructor who asked for the review quiz owns it
      if (req.user) store.setOwner("quiz", id, req.user.eppn);
      res.json({ ok: true, id, title: quiz.title, count: picked.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  api.delete("/reports/:id", (req, res) => {
    const owner = store.gameOwner(req.params.id);
    if (owner === undefined) return res.status(404).json({ error: "No such game" });
    if (!canWriteReport(req.user, owner)) return res.status(404).json({ error: "No such game" });
    store.deleteGame(req.params.id);
    res.json({ ok: true });
  });


  /**
   * Read one quiz or class list. An unowned file is readable by everyone; one
   * that belongs to another instructor is reported as missing rather than
   * forbidden, so a listing cannot be used to enumerate other people's work.
   */
  function readOne(kind, pathOf, missing) {
    return async (req, res) => {
      const id = req.params.id;
      if (!safeId(id)) return res.status(400).json({ error: `bad ${kind} id` });
      const owner = store.ownerOf(kind, id);
      if (!canRead(req.user, owner)) return res.status(404).json({ error: missing });
      try {
        res.json({ ...(await readRaw(pathOf(id))), owner, mine: !!req.user && owner === req.user.eppn });
      } catch (e) {
        res.status(e.code === "ENOENT" ? 404 : 500).json({ error: e.code === "ENOENT" ? missing : e.message });
      }
    };
  }

  /** Take an unowned quiz or class list, which is what makes it editable. */
  function claimOne(kind, pathOf, missing) {
    return async (req, res) => {
      const id = req.params.id;
      if (!safeId(id)) return res.status(400).json({ error: `bad ${kind} id` });
      if (!(await exists(pathOf(id)))) return res.status(404).json({ error: missing });
      const owner = store.ownerOf(kind, id);
      if (!canRead(req.user, owner)) return res.status(404).json({ error: missing });
      if (owner !== null) return res.status(403).json(forbidden(owner));
      if (!canCreate(req.user)) return res.status(401).json({ error: "Sign in first" });
      if (req.user) store.setOwner(kind, id, req.user.eppn);
      res.json({ ok: true, id, owner: req.user?.eppn ?? null });
    };
  }

  /**
   * Refuse a write unless the caller owns the file, or it does not exist yet —
   * saving something new is how you come to own it. Returns true when the
   * request has already been answered.
   */
  async function refuseWrite(req, res, kind, pathOf) {
    const id = req.params.id;
    if (!(await exists(pathOf(id)))) {
      if (!canCreate(req.user)) {
        res.status(401).json({ error: "Sign in to create this" });
        return true;
      }
      return false;
    }
    const owner = store.ownerOf(kind, id);
    if (!canWrite(req.user, owner)) {
      // an existing file the caller may not even see should read as missing
      if (!canRead(req.user, owner)) res.status(404).json({ error: `No such ${kind}` });
      else res.status(403).json(forbidden(owner));
      return true;
    }
    return false;
  }

  // ---------- quiz editing ----------
  api.get("/quiz/:id", readOne("quiz", quizPath, "No such quiz"));
  api.post("/quiz/:id/claim", claimOne("quiz", quizPath, "No such quiz"));

  api.put("/quiz/:id", async (req, res) => {
    const id = req.params.id;
    if (!safeId(id)) return res.status(400).json({ error: "Use letters, digits, dash or underscore for the file name" });
    const { problems } = validateQuiz(req.body);
    if (problems.length) return res.status(400).json({ error: "Fix these first", problems });
    if (await refuseWrite(req, res, "quiz", quizPath)) return;
    try {
      // only known fields are written, so a stray key cannot end up in the file
      const clean = pickQuizFields(req.body);
      await writeQuiz(id, clean);
      // saving a new quiz is what makes it yours
      if (req.user) store.setOwner("quiz", id, req.user.eppn);
      res.json({ ok: true, id, count: clean.questions.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  api.delete("/quiz/:id", async (req, res) => {
    if (!safeId(req.params.id)) return res.status(400).json({ error: "bad quiz id" });
    if (await refuseWrite(req, res, "quiz", quizPath)) return;
    try {
      await unlink(quizPath(req.params.id));
      store.clearOwner("quiz", req.params.id);
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
  api.get("/roster/:id", readOne("roster", rosterPath, "No such class list"));
  api.post("/roster/:id/claim", claimOne("roster", rosterPath, "No such class list"));

  api.put("/roster/:id", async (req, res) => {
    const id = req.params.id;
    if (!safeId(id)) return res.status(400).json({ error: "Use letters, digits, dash or underscore for the file name" });
    const body = req.body || {};
    const students = (Array.isArray(body.students) ? body.students : [])
      .map((s) => (typeof s === "string" ? { name: s } : s))
      .filter((s) => s && String(s.name || "").trim())
      .map((s) => (s.id ? { name: String(s.name).trim(), id: String(s.id).trim() } : { name: String(s.name).trim() }));
    if (!students.length) return res.status(400).json({ error: "Add at least one student" });
    if (await refuseWrite(req, res, "roster", rosterPath)) return;
    try {
      await writeRoster(id, { title: String(body.title || id), students });
      if (req.user) store.setOwner("roster", id, req.user.eppn);
      res.json({ ok: true, id, count: students.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  api.delete("/roster/:id", async (req, res) => {
    if (!safeId(req.params.id)) return res.status(400).json({ error: "bad roster id" });
    if (await refuseWrite(req, res, "roster", rosterPath)) return;
    try {
      await unlink(rosterPath(req.params.id));
      store.clearOwner("roster", req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(e.code === "ENOENT" ? 404 : 500).json({ error: e.message });
    }
  });

  return api;
}
