// Tiny synthesized sound effects (no audio files needed). Host screen only.
// Call Sound.init() from a user gesture (click) before anything will play.
/* exported Sound */
const Sound = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem("tigerquiz.muted") === "1"; } catch {}

  function init() {
    if (ctx) return;
    try { ctx = new (window.AudioContext || /** @type {any} */ (window).webkitAudioContext)(); } catch { ctx = null; }
  }

  // play one tone: frequency, duration (s), optional start offset (s), waveform, volume
  function tone(freq, dur, at = 0, type = "sine", vol = 0.25) {
    if (!ctx || muted) return;
    if (ctx.state === "suspended") ctx.resume();
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // short filtered noise burst, used for the drumroll
  function thump(at = 0, vol = 0.3) {
    if (!ctx || muted) return;
    const t0 = ctx.currentTime + at;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.08, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.value = 400;
    const gain = ctx.createGain();
    gain.gain.value = vol;
    src.connect(filt).connect(gain).connect(ctx.destination);
    src.start(t0);
  }

  return {
    init,
    get muted() { return muted; },
    set muted(v) {
      muted = !!v;
      try { localStorage.setItem("tigerquiz.muted", muted ? "1" : "0"); } catch {}
    },
    /** new question shown */
    start() { tone(660, 0.12); tone(880, 0.18, 0.12); },
    /** one second passing during the final countdown */
    tick() { tone(1200, 0.05, 0, "square", 0.08); },
    /** timer ran out */
    timeUp() { tone(300, 0.25, 0, "sawtooth", 0.2); tone(220, 0.4, 0.2, "sawtooth", 0.2); },
    /** results / correct answer revealed */
    reveal() { tone(523, 0.12); tone(659, 0.12, 0.12); tone(784, 0.3, 0.24); },
    /** drumroll of the given length in seconds */
    drumroll(secs = 1.5) { for (let t = 0; t < secs; t += 0.09) thump(t, 0.25); },
    /** podium fanfare */
    fanfare() {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, i * 0.13, "triangle", 0.3));
      tone(1047, 0.8, 0.55, "triangle", 0.3);
      tone(784, 0.8, 0.55, "triangle", 0.15);
    },
  };
})();
