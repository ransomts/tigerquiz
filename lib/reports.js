// Turning a stored game into something a teacher reads: absentees folded in
// from the class list, and the CSV export.
import * as Q from "./questions.js";
import { loadRoster } from "./content.js";

/** Add absentees to a report when the game was played against a roster. */
export async function withRoster(report) {
  if (!report.game.roster_id) return report;
  try {
    const roster = await loadRoster(report.game.roster_id);
    // players are stored under their canonical roster name, but match on id too
    // in case the roster file was edited between the game and the report
    const played = new Set(report.players.map((p) => Q.normText(p.identifier || p.name)));
    const didPlay = (s) => played.has(Q.normText(s.name)) || (s.id && played.has(Q.normText(s.id)));
    report.roster = {
      title: roster.title,
      total: roster.students.length,
      absent: roster.students.filter((s) => !didPlay(s)).map((s) => s.name),
    };
  } catch {
    /* roster file has gone away; report is still valid without it */
  }
  return report;
}

export const csvName = (g) => `${g.title.replace(/[^\w-]+/g, "_")}_${new Date(g.started_at).toISOString().slice(0, 10)}.csv`;

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const formatResponse = (r) => (Array.isArray(r) ? r.join(" | ") : r == null ? "" : String(r));

export function toCsv(report) {
  const head = ["player", "identifier", "rank", "total_score", "question", "type", "question_text", "correct_answer", "response", "correct", "points", "seconds"];
  const lines = [head.join(",")];
  const qByIdx = new Map(report.questions.map((q) => [q.idx, q]));
  for (const p of report.players) {
    for (const a of p.answers) {
      const q = qByIdx.get(a.idx) || {};
      lines.push([
        p.name, p.identifier, p.rank, p.score,
        a.idx + 1, q.type, q.text, q.answer,
        formatResponse(a.response), a.correct == null ? "" : a.correct ? "yes" : "no",
        a.points, a.ms == null ? "" : (a.ms / 1000).toFixed(1),
      ].map(csvCell).join(","));
    }
  }
  return lines.join("\n") + "\n";
}
