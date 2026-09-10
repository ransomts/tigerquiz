// A token bucket per client, used to make PIN guessing impractical.
//
// The thing being defended: a game PIN is six digits, so the whole space is
// 900,000. Measured against this server, one socket sustained about 3,400
// lookups a second, which sweeps every PIN in roughly four minutes and hands
// the attacker the title of every lesson running and a way into any game not
// gated by a class list.
//
// Only *failures* are counted, which is what makes this safe to key by IP. A
// class of thirty joining at once is thirty successes and costs nothing; a
// scanner is nearly all failures. That matters because a whole classroom
// usually shares one NAT address, and counting every attempt would lock out the
// room rather than the attacker.
export function createLimiter({ capacity, refillMs, sweepMs = 10 * 60 * 1000 }) {
  /** @type {Map<string, { tokens: number, seen: number }>} */
  const buckets = new Map();
  let lastSweep = Date.now();

  const bucketFor = (key, now) => {
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, seen: now };
      buckets.set(key, b);
      return b;
    }
    // Refill for the time that passed, capped at the burst size.
    b.tokens = Math.min(capacity, b.tokens + (now - b.seen) / refillMs);
    b.seen = now;
    return b;
  };

  return {
    /** True when this client still has budget to get something wrong. */
    allow(key) {
      const now = Date.now();
      // Drop buckets nobody has touched in a while, so this cannot grow without
      // bound on a public server.
      if (now - lastSweep > sweepMs) {
        for (const [k, b] of buckets) if (now - b.seen > sweepMs) buckets.delete(k);
        lastSweep = now;
      }
      return bucketFor(key, now).tokens >= 1;
    },

    /** Charge a client for a failed attempt. */
    penalise(key) {
      const b = bucketFor(key, Date.now());
      b.tokens = Math.max(0, b.tokens - 1);
    },

    /** Seconds until this client may try again, for the message they get. */
    retryAfter(key) {
      const b = buckets.get(key);
      if (!b || b.tokens >= 1) return 0;
      return Math.ceil(((1 - b.tokens) * refillMs) / 1000);
    },

    /** Testing and diagnostics only. */
    size: () => buckets.size,
  };
}

/**
 * Who to charge. Behind a proxy every socket appears to come from 127.0.0.1,
 * so the forwarded address is the only way to tell two clients apart — and
 * without it one attacker would spend the whole classroom's budget. It is only
 * trusted when the deployment says a proxy is really there, because otherwise a
 * client could set the header itself and get a fresh bucket per request.
 */
export function clientKey(socket, trustProxy) {
  if (trustProxy) {
    const fwd = socket.handshake?.headers?.["x-forwarded-for"];
    const first = String(Array.isArray(fwd) ? fwd[0] : fwd || "").split(",")[0].trim();
    if (first) return first;
  }
  return socket.handshake?.address || "unknown";
}
