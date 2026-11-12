// lib/asr-job-store.js — durable ASR job records for the offscreen runner.
//
// Why this exists (2026-11-11): the audio ASR pipeline used to live entirely
// in the side panel. Closing the panel destroyed the document and with it the
// download/transcode/upload/transcribe work. The offscreen runner owns that
// work now; this store is the hand-off point between the runner, the service
// worker, and a reopened side panel.
//
// SECRETS NEVER GO IN HERE. Records carry routing/progress metadata and the
// finished transcript only. API keys, cookies, and signed media URLs stay in
// chrome.storage.session as an ephemeral "job payload" (cleared when the
// runner picks the job up) or in the runner's memory. A record that outlives
// the browser session must never be enough to re-authenticate a cloud call.
//
// Payloads are session-scoped because they contain the API key and the signed
// stream URLs. chrome.storage.session is memory-backed and dies with the
// browser session, which is the right lifetime: after a browser restart the
// side panel must re-attach (and rebuild the media URLs) to continue.

const STORE_KEY = 'browsaAsrJobs';
const PAYLOAD_PREFIX = 'browsaAsrJobPayload.';

const ACTIVE_TTL_MS = 24 * 60 * 60 * 1000;
const DONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_TTL_MS = 60 * 60 * 1000;

// `paused` is deliberately NOT auto-resumed by the watchdog: it means a
// side-effectful step failed and the job is waiting for an explicit re-attach
// (or a user-initiated resume). Auto-retrying it every minute could repeat a
// submit/upload and double-bill.
const ACTIVE_STATUSES = new Set(['queued', 'running']);

// The persisted record is an ALLOWLIST, not a spread of the caller's job
// object. The runtime payload carries the API key, cookies, and signed media
// URLs; a future caller accidentally spreading it into saveAsrJob() must not
// silently write those to disk.
const JOB_FIELDS = [
  'jobId', 'key', 'assetId', 'tabId', 'pageUrl', 'platform', 'title',
  'durationSec', 'provider', 'baseUrl', 'model', 'language', 'hotwords',
  'timeoutMs', 'subtitleSource', 'originContextId', 'originSessionId',
  'status', 'phase', 'progressText', 'progressAt', 'bytes', 'totalBytes',
  'createdAt', 'updatedAt', 'startedAt', 'submittedAt', 'finishedAt',
  'taskId', 'fileId', 'resultText', 'resultUsage', 'audioBytes', 'error',
  'expiresAt',
];

// A test/extension context without chrome.storage.session still gets a
// process-local fallback; it is only used by unit tests and never needs to
// survive an offscreen restart.
const memoryPayloads = new Map();
let _jobChain = Promise.resolve();

// The background and the offscreen runner both write job records. Web Locks
// serialize those read-modify-writes across extension contexts; Node tests /
// older hosts fall back to a process-local chain. This is what keeps a
// "resume" patch from overwriting a "done" patch (which would re-run a
// completed, billable task).
function withJobLock(fn) {
  if (globalThis.navigator?.locks?.request) {
    return globalThis.navigator.locks.request('browsa.asr.jobs', fn);
  }
  const run = _jobChain.then(fn, fn);
  _jobChain = run.then(() => {}, () => {});
  return run;
}

function localArea(area) {
  return area
    || (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
    || null;
}

function sessionArea(area) {
  return area
    || (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session)
    || null;
}

function normalizeBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

/**
 * Identity of a reusable transcription job. The key deliberately excludes the
 * API key: a key rotation must not orphan an in-flight task, and the key must
 * never become part of a persisted record's identity.
 */
export function asrJobKey({ assetId, provider, baseUrl, model, language, hotwords } = {}) {
  return JSON.stringify([
    String(assetId || ''),
    String(provider || ''),
    String(model || ''),
    normalizeBase(baseUrl),
    String(language || 'auto'),
    String(hotwords || '').trim(),
  ]);
}

export function isActiveAsrJobStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

function expiryFor(status, now) {
  if (status === 'done') return now + DONE_TTL_MS;
  if (status === 'failed' || status === 'canceled') return now + FAILED_TTL_MS;
  return now + ACTIVE_TTL_MS;
}

function normalizeJob(job) {
  if (!job || !job.jobId) return null;
  const now = Date.now();
  const status = String(job.status || 'queued');
  const pick = {};
  for (const field of JOB_FIELDS) {
    if (job[field] !== undefined) pick[field] = job[field];
  }
  return {
    ...pick,
    key: job.key || asrJobKey(pick),
    status,
    phase: String(job.phase || status),
    updatedAt: now,
    createdAt: Number(job.createdAt) || now,
    // Recompute on every write: a progress patch keeps an active job alive,
    // and a terminal transition needs the terminal TTL rather than the active
    // one it inherited.
    expiresAt: expiryFor(status, now),
  };
}

async function readMap(area) {
  const a = localArea(area);
  if (!a) return {};
  try {
    const raw = (await a.get(STORE_KEY))?.[STORE_KEY];
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (_) {
    return {};
  }
}

function pruneMap(map, now = Date.now()) {
  const out = {};
  for (const [key, value] of Object.entries(map || {})) {
    if (!value || typeof value !== 'object') continue;
    const expiresAt = Number(value.expiresAt) || 0;
    if (expiresAt > 0 && expiresAt <= now) continue;
    out[key] = value;
  }
  return out;
}

async function writeMap(map, area) {
  const a = localArea(area);
  if (!a) return;
  await a.set({ [STORE_KEY]: map });
}

/** Read one job by id. Returns null when missing/expired. */
export async function getAsrJob(jobId, { area } = {}) {
  if (!jobId) return null;
  const map = pruneMap(await readMap(area));
  for (const job of Object.values(map)) {
    if (job?.jobId === jobId) return job;
  }
  return null;
}

/**
 * Find the job matching a video/config tuple. Duration is a coarse content
 * identity check (same convention as browsaArkFileCache): a mismatch means the
 * video was re-cut or the URL now points at different content, so reusing its
 * transcript would be wrong.
 */
export async function findAsrJob(query = {}, { area } = {}) {
  const key = asrJobKey(query);
  const map = pruneMap(await readMap(area));
  const job = map[key] || null;
  if (!job) return null;
  const want = Number(query.durationSec) || 0;
  const got = Number(job.durationSec) || 0;
  if (want > 0 && got > 0 && Math.abs(want - got) > Math.max(5, want * 0.1)) return null;
  return job;
}

/** Insert or replace a job record. Returns the normalized record. */
export async function saveAsrJob(job, { area } = {}) {
  return withJobLock(async () => {
    const normalized = normalizeJob(job);
    if (!normalized) return null;
    const map = pruneMap(await readMap(area));
    map[normalized.key] = normalized;
    await writeMap(map, area);
    return normalized;
  });
}

/**
 * Atomic create-or-return-existing for the job's identity key. Two side
 * panels / a re-attach race cannot both create a job (and thus cannot both
 * upload or submit). A failed/canceled/stale-done record is replaced.
 */
export async function createAsrJobIfAbsent(job, { area } = {}) {
  const normalized = normalizeJob(job);
  if (!normalized) return { created: false, job: null };
  return withJobLock(async () => {
    const map = pruneMap(await readMap(area));
    const existing = map[normalized.key];
    const staleDone = existing?.status === 'done' && !existing.resultText;
    if (existing && !staleDone && existing.status !== 'failed' && existing.status !== 'canceled') {
      return { created: false, job: existing };
    }
    map[normalized.key] = normalized;
    await writeMap(map, area);
    return { created: true, job: normalized };
  });
}

/**
 * Read-modify-write by jobId. Returns the updated record (null if missing).
 * onlyIfStatus makes a status transition conditional, atomically with other
 * job-store writers (paused→queued must never overwrite done).
 */
export async function patchAsrJob(jobId, patch, { area, onlyIfStatus = null } = {}) {
  if (!jobId) return null;
  return withJobLock(async () => {
    const map = pruneMap(await readMap(area));
    for (const [key, job] of Object.entries(map)) {
      if (job?.jobId !== jobId) continue;
      if (Array.isArray(onlyIfStatus) && !onlyIfStatus.includes(job.status)) return job;
      const merged = normalizeJob({ ...job, ...(patch || {}), jobId, key: job.key || key });
      map[key] = merged;
      await writeMap(map, area);
      return merged;
    }
    return null;
  });
}

export async function clearAsrJob(jobId, { area } = {}) {
  if (!jobId) return false;
  return withJobLock(async () => {
    const map = pruneMap(await readMap(area));
    let removed = false;
    for (const [key, job] of Object.entries(map)) {
      if (job?.jobId === jobId) {
        delete map[key];
        removed = true;
      }
    }
    if (removed) await writeMap(map, area);
    return removed;
  });
}

/** All non-terminal jobs, newest first. Used by the runner/watchdog. */
export async function listActiveAsrJobs({ area } = {}) {
  const map = pruneMap(await readMap(area));
  return Object.values(map)
    .filter((job) => isActiveAsrJobStatus(job?.status))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function hasActiveAsrJobs({ area } = {}) {
  return (await listActiveAsrJobs({ area })).length > 0;
}

/**
 * Ephemeral payload (API key + media URLs + the original ctx). Prefer
 * chrome.storage.session; fall back to memory for unit tests.
 */
export async function saveAsrJobPayload(jobId, payload, { area } = {}) {
  if (!jobId) return;
  const value = { ...(payload || {}), jobId, savedAt: Date.now() };
  const a = sessionArea(area);
  if (a) {
    try {
      await a.set({ [`${PAYLOAD_PREFIX}${jobId}`]: value });
      return;
    } catch (_) { /* fall through to memory */ }
  }
  memoryPayloads.set(jobId, value);
}

export async function getAsrJobPayload(jobId, { area } = {}) {
  if (!jobId) return null;
  const a = sessionArea(area);
  if (a) {
    try {
      const value = (await a.get(`${PAYLOAD_PREFIX}${jobId}`))?.[`${PAYLOAD_PREFIX}${jobId}`];
      if (value && typeof value === 'object') return value;
    } catch (_) { /* fall through */ }
  }
  return memoryPayloads.get(jobId) || null;
}

export async function clearAsrJobPayload(jobId, { area } = {}) {
  if (!jobId) return;
  memoryPayloads.delete(jobId);
  const a = sessionArea(area);
  if (a?.remove) {
    try { await a.remove(`${PAYLOAD_PREFIX}${jobId}`); } catch (_) { /* best effort */ }
  }
}

/** Test-only reset; never called by production code. */
export function _resetAsrJobMemoryForTests() {
  memoryPayloads.clear();
}

export const ASR_JOB_LIMITS = {
  ACTIVE_TTL_MS,
  DONE_TTL_MS,
  FAILED_TTL_MS,
};
