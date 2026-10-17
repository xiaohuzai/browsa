// lib/sidepanel/approval-chime.js — a tiny Web Audio synth cue for agent
// approval requests. Zero binary assets (MV3-friendly): one triangle blip,
// 520 Hz, 150 ms, 0.25 peak gain — the CDS approval-cue constants. The point
// is attention recall: an approval blocks the agent and waits for the user,
// who may be on another tab entirely.
//
// Sound is garnish: every failure path (no AudioContext in jsdom, autoplay
// policy suspension, storage hiccup, setting off) degrades to SILENCE, never
// to an error — the approval card itself is the real UI, this only accompanies
// it. A module-level AudioContext singleton keeps us clear of the browser's
// ~6-context ceiling; approval chimes are far too rare to need more.

let _ctx = null;

/** Test hook: drop the cached AudioContext singleton (it would otherwise leak
 * a previous test's stub into the next assertion). */
export function _resetChimeForTests() { _ctx = null; }

export function playApprovalChime(win = globalThis) {
  try {
    const Ctx = win.AudioContext || win.webkitAudioContext;
    if (!Ctx) return;
    _ctx = _ctx || new Ctx();
    // The side panel's context can start suspended until first user gesture;
    // by approval time the user has usually typed a message, so this resume
    // normally just works — and if it doesn't, we stay silent.
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
    const t = _ctx.currentTime;
    const osc = _ctx.createOscillator();
    const gain = _ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 520;
    // exponential ramps need a nonzero start; 10ms attack, decay to inaudible.
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    osc.connect(gain);
    gain.connect(_ctx.destination);
    osc.start(t);
    osc.stop(t + 0.16);
  } catch (_) { /* garnish — never break the approval flow */ }
}

/** Read the setting and chime if enabled (default ON — an approval NEEDS the
 * user's attention; turning it off is the explicit opt-out). */
export function maybePlayApprovalChime(storage, win = globalThis) {
  try {
    storage?.get?.(['approvalChime'])
      .then((cfg) => { if (cfg?.approvalChime !== false) playApprovalChime(win); })
      .catch(() => {});
  } catch (_) { /* garnish */ }
}
