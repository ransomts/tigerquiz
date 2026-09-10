// The PIN guessing throttle, in isolation.
//   npm run test:unit
//
// The property that matters is not "slow down clients" but "slow down clients
// who are wrong". A classroom shares one NAT address, so charging every attempt
// would throttle the room instead of the attacker.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createLimiter, clientKey } from "../lib/ratelimit.js";

describe("the guess limiter", () => {
  test("lets a client through until the burst is spent", () => {
    const rl = createLimiter({ capacity: 3, refillMs: 1000 });
    for (let i = 0; i < 3; i++) {
      assert.equal(rl.allow("a"), true, `attempt ${i + 1} should be allowed`);
      rl.penalise("a");
    }
    assert.equal(rl.allow("a"), false, "the fourth wrong guess should be refused");
  });

  test("clients are budgeted separately", () => {
    const rl = createLimiter({ capacity: 1, refillMs: 1000 });
    rl.penalise("a");
    assert.equal(rl.allow("a"), false);
    assert.equal(rl.allow("b"), true, "one client must not spend another's budget");
  });

  test("budget comes back over time", async () => {
    const rl = createLimiter({ capacity: 1, refillMs: 40 });
    rl.penalise("a");
    assert.equal(rl.allow("a"), false);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(rl.allow("a"), true, "a token should have refilled");
  });

  test("waiting a long time does not bank more than the burst", async () => {
    const rl = createLimiter({ capacity: 2, refillMs: 5 });
    await new Promise((r) => setTimeout(r, 60)); // long enough for ~12 tokens
    rl.penalise("a");
    rl.penalise("a");
    assert.equal(rl.allow("a"), false, "the bucket must cap at its capacity");
  });

  test("it says how long to wait", () => {
    const rl = createLimiter({ capacity: 1, refillMs: 10_000 });
    rl.penalise("a");
    const wait = rl.retryAfter("a");
    assert.ok(wait > 0 && wait <= 10, `retryAfter was ${wait}`);
  });

  test("a client in good standing is told to wait zero", () => {
    const rl = createLimiter({ capacity: 5, refillMs: 1000 });
    assert.equal(rl.retryAfter("never-seen"), 0);
  });

  // The reason only failures are charged: thirty students joining the same
  // game from one classroom must not exhaust anything.
  test("a whole class joining correctly costs nothing", () => {
    const rl = createLimiter({ capacity: 5, refillMs: 60_000 });
    for (let i = 0; i < 30; i++) assert.equal(rl.allow("school-nat"), true);
  });
});

describe("choosing who to charge", () => {
  const sock = (address, fwd) => ({ handshake: { address, headers: fwd ? { "x-forwarded-for": fwd } : {} } });

  test("without a proxy it uses the socket address", () => {
    assert.equal(clientKey(sock("203.0.113.9"), false), "203.0.113.9");
  });

  test("a forwarded header is ignored unless a proxy is trusted", () => {
    // otherwise a client hands itself a fresh budget by inventing a header
    assert.equal(clientKey(sock("203.0.113.9", "1.2.3.4"), false), "203.0.113.9");
  });

  test("behind a trusted proxy it uses the forwarded address", () => {
    // every socket looks like 127.0.0.1 there, so this is what separates clients
    assert.equal(clientKey(sock("127.0.0.1", "198.51.100.7"), true), "198.51.100.7");
  });

  test("it takes the original client from a chain of proxies", () => {
    assert.equal(clientKey(sock("127.0.0.1", "198.51.100.7, 10.0.0.1"), true), "198.51.100.7");
  });

  test("it falls back to the socket address when the header is empty", () => {
    assert.equal(clientKey(sock("127.0.0.1", ""), true), "127.0.0.1");
  });
});
