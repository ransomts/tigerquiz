// A thin layer over Action Cable shaped like the socket the pages were written
// for: on(event, fn), perform(action, data), and answer(response, cb) with an
// acknowledgement. Reconnection and re-subscription are Action Cable's own.
function gameSocket() {
  const consumer = ActionCable.createConsumer();
  const handlers = {};
  const acks = new Map();
  let sub = null;
  let seq = 0;
  const emit = (event, data) => { for (const fn of handlers[event] || []) fn(data); };
  return {
    on(event, fn) { (handlers[event] ||= []).push(fn); },
    // resolves once the server has accepted the subscription
    subscribe(params) {
      if (sub) { sub.unsubscribe(); sub = null; }
      return new Promise((resolve, reject) => {
        let settled = false;
        sub = consumer.subscriptions.create({ channel: "GameChannel", ...params }, {
          connected() { if (!settled) { settled = true; resolve(); } emit("connect"); },
          disconnected() { emit("disconnect"); },
          rejected() { if (!settled) { settled = true; reject(new Error("rejected")); } emit("rejected"); },
          received(data) {
            if (data.event === "answer:ack") {
              const cb = acks.get(data.seq);
              acks.delete(data.seq);
              if (cb) cb(data);
              return;
            }
            emit(data.event, data);
          },
        });
      });
    },
    perform(action, data = {}) { if (sub) sub.perform(action, data); },
    answer(response, cb) {
      if (!sub) return cb({ ok: false, error: "Not connected" });
      const id = ++seq;
      acks.set(id, cb);
      sub.perform("answer", { response, seq: id });
    },
    unsubscribe() { if (sub) { sub.unsubscribe(); sub = null; } },
    get connected() { return !!sub; },
  };
}
