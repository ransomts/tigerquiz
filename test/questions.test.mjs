// Unit tests for the pure question logic: scoring, partial credit, text
// matching and validation.
//   npm run test:unit
//
// These run in-process, unlike the end-to-end suites which drive a spawned
// server. That is the point: it is the only way to get a coverage number, and
// it is where the edge cases of grading are cheap to state. A wrong answer here
// does not crash anything, it quietly mis-scores a student, so it is worth
// testing directly rather than only through a websocket.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as Q from "../lib/questions.js";

const q = (raw) => Q.normalizeQuestion(raw, 0);

describe("speedPoints", () => {
  test("a full-speed answer is worth the maximum", () => {
    assert.equal(Q.speedPoints(0, 20000), 1000);
  });

  test("an answer at the buzzer is still worth half", () => {
    assert.equal(Q.speedPoints(20000, 20000), 500);
  });

  test("it scales linearly in between", () => {
    assert.equal(Q.speedPoints(10000, 20000), 750);
  });

  test("answering later than the clock allowed cannot go below half", () => {
    assert.equal(Q.speedPoints(99999, 20000), 500);
  });

  test("a negative time cannot earn more than the maximum", () => {
    assert.equal(Q.speedPoints(-500, 20000), 1000);
  });
});

describe("normText", () => {
  test("case and surrounding space do not matter", () => {
    assert.equal(Q.normText("  Ada LOVELACE "), "ada lovelace");
  });

  test("accents are folded", () => {
    assert.equal(Q.normText("café"), "cafe");
  });

  test("punctuation is dropped and runs of space collapse", () => {
    assert.equal(Q.normText("it's   a  test!"), "its a test");
  });

  test("null and undefined normalise to empty rather than throwing", () => {
    assert.equal(Q.normText(null), "");
    assert.equal(Q.normText(undefined), "");
  });
});

describe("grading multiple choice", () => {
  const mc = q({ text: "Pick", choices: ["a", "b", "c"], answer: 1 });

  test("the right choice is fully correct", () => {
    assert.deepEqual(Q.grade(mc, 1), { correct: true, ratio: 1 });
  });

  test("a wrong choice earns nothing", () => {
    assert.deepEqual(Q.grade(mc, 0), { correct: false, ratio: 0 });
  });
});

describe("grading multiple-answer questions", () => {
  const multi = q({ type: "multi", text: "Pick two", choices: ["a", "b", "c", "d"], answers: [0, 2] });

  test("both right and nothing wrong is full marks", () => {
    assert.deepEqual(Q.grade(multi, [0, 2]), { correct: true, ratio: 1 });
  });

  test("one of two right earns half", () => {
    assert.deepEqual(Q.grade(multi, [0]), { correct: false, ratio: 0.5 });
  });

  test("a wrong pick cancels out a right one", () => {
    assert.deepEqual(Q.grade(multi, [0, 1]), { correct: false, ratio: 0 });
  });

  test("picking everything scores zero rather than full marks", () => {
    const g = Q.grade(multi, [0, 1, 2, 3]);
    assert.equal(g.correct, false);
    assert.equal(g.ratio, 0);
  });

  test("answering nothing earns nothing", () => {
    assert.deepEqual(Q.grade(multi, []), { correct: false, ratio: 0 });
  });
});

describe("grading a number guess", () => {
  const slider = q({ type: "slider", text: "How many?", min: 0, max: 100, answer: 50, tolerance: 5 });

  test("inside the tolerance is correct", () => {
    assert.deepEqual(Q.grade(slider, 53), { correct: true, ratio: 1 });
    assert.deepEqual(Q.grade(slider, 45), { correct: true, ratio: 1 });
  });

  test("just outside earns partial credit, never full", () => {
    const g = Q.grade(slider, 57);
    assert.equal(g.correct, false);
    assert.ok(g.ratio > 0 && g.ratio <= 0.99, `ratio was ${g.ratio}`);
  });

  test("a wild guess earns nothing", () => {
    assert.deepEqual(Q.grade(slider, 100), { correct: false, ratio: 0 });
  });

  test("with no tolerance set it falls back to a share of the range", () => {
    const loose = q({ type: "slider", text: "?", min: 0, max: 100, answer: 50 });
    assert.equal(Q.grade(loose, 54).correct, true); // 5% of 0..100
    assert.equal(Q.grade(loose, 56).correct, false);
  });
});

describe("grading typed answers", () => {
  const text = q({ type: "text", text: "Capital?", accept: ["Paris", "Lutetia"] });

  test("any accepted answer is correct", () => {
    assert.equal(Q.grade(text, "Paris").correct, true);
    assert.equal(Q.grade(text, "lutetia").correct, true);
  });

  test("matching ignores case, accent and punctuation", () => {
    assert.equal(Q.grade(text, "  PARIS! ").correct, true);
  });

  test("a wrong answer is wrong", () => {
    assert.equal(Q.grade(text, "London").correct, false);
  });

  test("a typo is forgiven by default", () => {
    // normalizeQuestion sets fuzzy unless the quiz says otherwise, so spelling
    // does not decide the mark unless the teacher asks for it to
    assert.equal(text.fuzzy, true);
    assert.equal(Q.grade(text, "Pariss").correct, true);
  });

  test("a quiz can turn typo forgiveness off", () => {
    const strict = q({ type: "text", text: "Capital?", accept: ["Paris"], fuzzy: false });
    assert.equal(Q.grade(strict, "Pariss").correct, false);
    assert.equal(Q.grade(strict, "Paris").correct, true);
  });

  test("forgiveness does not stretch to a different word", () => {
    assert.equal(Q.grade(text, "Berlin").correct, false);
  });
});

describe("grading a put-in-order question", () => {
  // Four items, because with three you cannot get exactly two in place: the
  // third has nowhere else to go.
  const order = q({ type: "order", text: "Sort", items: ["one", "two", "three", "four"] });
  // pres.shown[position] = index into q.items, and a response indexes the shown list
  const identity = { shown: [0, 1, 2, 3] };

  test("the right order is full marks", () => {
    assert.deepEqual(Q.grade(order, [0, 1, 2, 3], identity), { correct: true, ratio: 1 });
  });

  test("a completely wrong order earns nothing", () => {
    const g = Q.grade(order, [3, 2, 1, 0], identity);
    assert.equal(g.correct, false);
    assert.equal(g.ratio, 0);
  });

  test("one in the right place is still nothing", () => {
    // (right - 1) / n, so a single hit is treated as luck rather than partial
    // knowledge
    const g = Q.grade(order, [0, 2, 3, 1], identity); // only the first is home
    assert.equal(g.ratio, 0);
  });

  test("two in the right place earns partial credit", () => {
    const g = Q.grade(order, [0, 1, 3, 2], identity);
    assert.equal(g.correct, false);
    assert.ok(g.ratio > 0, `ratio was ${g.ratio}`);
  });
});

describe("unscored types", () => {
  for (const type of ["poll", "wordcloud", "slide"]) {
    test(`${type} never awards or denies points`, () => {
      assert.equal(Q.isUnscored(type), true);
      const graded = Q.grade({ type }, "anything");
      assert.equal(graded.correct, null);
      assert.equal(graded.ratio, 0);
    });
  }

  test("a slide is not answerable at all", () => {
    assert.equal(Q.isAnswerable("slide"), false);
    assert.equal(Q.isAnswerable("poll"), true);
  });
});

describe("normalizeQuestion", () => {
  test("a bare question defaults to multiple choice", () => {
    assert.equal(q({ text: "?", choices: ["a", "b"], answer: 0 }).type, "choice");
  });

  test("an unrecognised type quietly becomes multiple choice", () => {
    // Deliberately permissive rather than fatal, so one bad question does not
    // stop a lesson. It does mean a typo like "sliderr" is graded as a choice
    // question instead of reported; npm run check is what catches that.
    const coerced = q({ type: "sliderr", text: "?", choices: ["a", "b"], answer: 0 });
    assert.equal(coerced.type, "choice");
  });

  test("a choice question with no correct answer is rejected", () => {
    assert.throws(() => q({ text: "?", choices: ["a", "b"] }));
  });

  test("an answer pointing past the choices is rejected", () => {
    assert.throws(() => q({ text: "?", choices: ["a", "b"], answer: 5 }));
  });

  test("a question with no text is rejected", () => {
    assert.throws(() => q({ choices: ["a", "b"], answer: 0 }));
  });

  test("the position in the file is kept, so a review quiz can find it again", () => {
    assert.equal(Q.normalizeQuestion({ text: "?", choices: ["a", "b"], answer: 0 }, 7).sourceIndex, 7);
  });
});

describe("playerView", () => {
  test("never leaks the answer to a phone", () => {
    const mc = q({ text: "Pick", choices: ["a", "b"], answer: 1 });
    const view = Q.playerView(mc, null, { showText: true });
    assert.equal(view.answer, undefined);
    assert.equal(view.answers, undefined);
    assert.equal(JSON.stringify(view).includes('"answer"'), false);
  });

  test("a typed answer's accepted values never reach the phone", () => {
    const text = q({ type: "text", text: "Capital?", accept: ["Paris"] });
    const view = Q.playerView(text, null, { showText: true });
    assert.equal(view.accept, undefined);
    assert.equal(JSON.stringify(view).includes("Paris"), false);
  });
});
