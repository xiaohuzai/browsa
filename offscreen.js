// offscreen.js — the DOM-capable extension context that owns long ASR jobs.
//
// It exists for one reason: MV3 service workers have no window/AudioContext
// and no XHR upload progress, while the ASR pipeline needs both and may run
// for hours after the side panel is closed. The side panel starts a job via
// background; this page drains the serial queue and writes progress/results
// to the shared job store.

import { initI18n } from './lib/i18n.js';
import { createAsrRunner } from './lib/asr-runner.js';

const runner = createAsrRunner();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'ASR_JOB_START' || msg.type === 'ASR_JOB_RESUME') {
    runner.enqueue(msg.jobId).catch((e) => {
      console.warn('browsa[offscreen]: enqueue failed', msg.jobId, e?.message || e);
    });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'ASR_JOB_CANCEL') {
    runner.cancel(msg.jobId).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'ASR_RUNNER_PING') {
    sendResponse({ ok: true, active: runner.activeJobId() });
    return true;
  }
});

// A new offscreen document starts with an empty queue; the job store is the
// source of truth. This is also the recovery path after the browser killed
// the previous offscreen document.
initI18n()
  .catch(() => {})
  .then(() => runner.resumeActiveJobs())
  .catch((e) => console.warn('browsa[offscreen]: resume failed', e?.message || e));
