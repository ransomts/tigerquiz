// The browser pages are classic scripts with no bundler, so they share one
// global scope with the two scripts a page loads before its own: socket.io's
// browser bundle defines io(), and public/sound.js defines Sound. Under
// "module": "nodenext" every file is its own module, so tsc cannot see those
// globals from host.js or play.js without them being described here. The
// runtime shape is sound.js itself; this only mirrors it for the checker.
// See eslint.config.js for the lint-side declaration of the same globals.

/** Connect a websocket, like the socket.io client script's own global. */
declare const io: (opts?: { path?: string }) => import("socket.io-client").Socket;

/** The synthesized sound effects of public/sound.js, host screen only. */
declare const Sound: {
  /** Call from a user gesture (click) before anything will play. */
  init(): void;
  muted: boolean;
  /** new question shown */
  start(): void;
  /** one second passing during the final countdown */
  tick(): void;
  /** timer ran out */
  timeUp(): void;
  /** results / correct answer revealed */
  reveal(): void;
  /** drumroll of the given length in seconds */
  drumroll(secs?: number): void;
  /** podium fanfare */
  fanfare(): void;
};
