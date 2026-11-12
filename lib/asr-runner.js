// lib/asr-runner.js — the offscreen-owned ASR job runner.
//
// The side panel starts a job and then only watches the job store. This module
// is the executor that survives the panel: it downloads, transcodes, uploads,
// polls, and writes the finished transcript back to the store. It is
// deliberately serial (one job at a time): the media blobs are hundreds of
// MB, and a single pair of DNR rule ids covers the download path.
//
// Resume split:
//   Qwen filetrans  -> taskId exists: poll the cloud task only.
//   Ark / upload    -> file_id + browsaArkFileCache: re-run transcription
//                      without re-downloading or re-uploading.
//   neither         -> ask background for a fresh asr-pending ctx (new signed
//                      playurl) and restart from the download stage.
//
// Read-only steps (poll/fetch result) are safe to retry. Upload/submit are
// side-effectful; this module never retries them blindly after a failure —
// it keeps the taskId/fileId and pauses the job for an explicit re-attach.

import { t as _t, tSub } from './i18n.js';
import {
  getAsrJob, patchAsrJob, getAsrJobPayload, clearAsrJobPayload,
  listActiveAsrJobs,
} from './asr-job-store.js';
import {
  runAudioTranscribePipeline,
} from './asr-audio-pipeline.js';
import {
  readPlatformCookie, registerMediaHeaders, removeMediaHeaders, MEDIA_RULE_IDS,
} from './sidepanel/media-headers.js';
import { resumeQwenFiletransTask } from './handlers/attach-asr.js';

const JOB_MAX_MS = 6 * 60 * 60 * 1000;
const IDLE_CLOSE_MS = 60 * 1000;

function combineSignals(signals) {
  const list = signals.filter(Boolean);
  if (list.length === 1) return list[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(list);
  }
  const c = new AbortController();
  for (const s of list) {
    if (s.aborted) { c.abort(s.reason); break; }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

function dnrRuleFor(platform) {
  if (platform === 'youtube') return MEDIA_RULE_IDS.asrYoutube;
  if (platform === 'bilibili') return MEDIA_RULE_IDS.asrBilibili;
  return null;
}

function hasMedia(ctx) {
  return !!(ctx?.audioUrl || (Array.isArray(ctx?.audioCandidates) && ctx.audioCandidates.length));
}

export function createAsrRunner(overrides = {}) {
  const deps = {
    getAsrJob,
    patchAsrJob,
    getAsrJobPayload,
    clearAsrJobPayload,
    listActiveAsrJobs,
    runAudioTranscribePipeline,
    resumeQwenFiletransTask,
    readPlatformCookie,
    registerMediaHeaders,
    removeMediaHeaders,
    refreshStreams: async (job, platform, want) => {
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'ASR_FRESH_URLS', tabId: job.tabId, platform, want,
        });
        if (res?.data?.ok && Array.isArray(res.data.streams) && res.data.streams.length) {
          return res.data.streams;
        }
      } catch (_) { /* tab gone / SW unavailable */ }
      return null;
    },
    reconstruct: async (job) => {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'ASR_JOB_CONTEXT', jobId: job.jobId });
        return res?.data?.ok ? res.data : { ok: false, error: res?.data?.error || 'no-context' };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    },
    onIdle: async () => {
      try { await chrome.runtime.sendMessage({ type: 'ASR_RUNNER_IDLE' }); } catch (_) {}
    },
    now: () => Date.now(),
    idleMs: IDLE_CLOSE_MS,
    ...overrides,
  };

  let running = false;
  let active = null; // { jobId, controller }
  let queue = [];
  let idleTimer = null;
  let progressChain = Promise.resolve();

  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!running && queue.length === 0) deps.onIdle?.();
    }, deps.idleMs);
  }

  function patch(jobId, patchValue) {
    progressChain = progressChain
      .then(() => deps.patchAsrJob(jobId, patchValue))
      .catch(() => null);
    return progressChain;
  }

  async function loadRunState(job) {
    // Ark preprocessing can take minutes on long videos; the panel default
    // (150s) was tuned for short clips. Give the background job a duration-
    // scaled budget without changing the user's configured value downward.
    const withJobPollBudget = (a) => a ? {
      ...a,
      timeoutMs: Math.max(
        Number(a.timeoutMs) || 0,
        Math.min(30 * 60_000, Math.max(150_000, (Number(job.durationSec) || 0) * 1000)),
      ),
    } : a;
    let payload = await deps.getAsrJobPayload(job.jobId).catch(() => null);
    let asr = payload?.asr || null;
    let ctx = payload?.ctx || null;
    if (job.taskId && job.provider === 'qwen') {
      if (!asr) {
        const rec = await deps.reconstruct(job);
        if (!rec.ok) throw new Error(rec.error || 'no-context');
        asr = rec.asr || null;
      }
      if (!asr) throw new Error('no-asr-config');
      return { taskOnly: true, asr: withJobPollBudget(asr), ctx: null };
    }
    if (!ctx || !hasMedia(ctx)) {
      const rec = await deps.reconstruct(job);
      if (!rec.ok) {
        // A cached upload can still be transcribed without a fresh playurl.
        // Use the minimal ctx below and let the pipeline's file cache decide.
        if (job.fileId || job.taskId) {
          ctx = ctx || {
            mode: 'asr-pending', asrPlatform: job.platform,
            meta: { url: job.pageUrl || '', title: job.title || '' },
            videoDurationSec: job.durationSec || 0,
          };
        } else {
          throw new Error(rec.error || 'no-context');
        }
      } else {
        asr = rec.asr || asr;
        ctx = rec.ctx || ctx;
      }
    }
    if (!asr) {
      const rec = await deps.reconstruct(job);
      if (!rec.ok) throw new Error(rec.error || 'no-asr-config');
      asr = rec.asr;
      if (!asr) throw new Error('no-asr-config');
      if (rec.taskOnly) return { taskOnly: true, asr: withJobPollBudget(asr), ctx: null };
      ctx = rec.ctx || ctx;
    }
    asr = withJobPollBudget(asr);
    return { taskOnly: false, asr, ctx: { ...(ctx || {}), asr } };
  }

  async function runTaskOnly(job, asr, signal) {
    const started = job.submittedAt || deps.now();
    const onStatus = (status) => {
      const elapsed = Math.max(0, Math.round((deps.now() - started) / 1000));
      const label = tSub('progressStageWait', '$1中…（已等待 $2s）', _t('stageRecognizing', '识别处理'), elapsed);
      patch(job.jobId, {
        status: 'running',
        phase: status === 'SUCCEEDED' ? 'done' : 'polling',
        progressText: label,
      });
    };
    const resumed = await deps.resumeQwenFiletransTask({
      baseUrl: asr.baseUrl, apiKey: asr.apiKey, taskId: job.taskId,
      signal, onStatus,
    });
    // The Qwen adapter's contract is { text, usage, taskId } (shared with the
    // live pipeline); the runner's internal result shape is transcriptText.
    // Normalize here so a resumed task cannot land an empty transcript.
    if (!resumed?.text) throw new Error('qwen task returned empty transcript');
    return {
      transcriptText: resumed.text,
      audioBytes: 0,
      usage: resumed.usage || null,
      fileId: job.fileId || '',
    };
  }

  async function runPipeline(job, asr, ctx, signal, onUploaded) {
    const started = job.startedAt || deps.now();
    let lastWrite = 0;
    let lastPhase = job.phase;
    const onProgress = (event) => {
      const now = deps.now();
      const nextPhase = event?.phase || lastPhase || 'running';
      if (now - lastWrite < 1000 && nextPhase === lastPhase) return;
      lastWrite = now;
      lastPhase = nextPhase;
      patch(job.jobId, {
        status: 'running',
        phase: nextPhase,
        progressText: event?.text || '',
        ...(Number.isFinite(event?.doneBytes) ? { bytes: event.doneBytes } : {}),
        ...(Number.isFinite(event?.totalBytes) ? { totalBytes: event.totalBytes } : {}),
      });
    };
    const onTaskSubmitted = (taskId) => {
      return patch(job.jobId, {
        taskId,
        status: 'running',
        phase: 'polling',
        submittedAt: job.submittedAt || deps.now(),
        progressText: _t('stageRecognizing', '识别处理'),
      });
    };
    const onStatus = (status) => {
      const elapsed = Math.max(0, Math.round((deps.now() - started) / 1000));
      patch(job.jobId, {
        status: 'running',
        phase: status === 'SUCCEEDED' ? 'done' : 'polling',
        progressText: tSub('progressStageWait', '$1中…（已等待 $2s）', _t('stageRecognizing', '识别处理'), elapsed),
      });
    };
    const onUploadedCb = (fileId) => {
      try { return onUploaded?.(fileId); } catch (_) { /* telemetry */ }
    };
    return deps.runAudioTranscribePipeline({
      ctx, platform: job.platform, wantDurSec: job.durationSec || 0,
      env: {
        progress: onProgress,
        refreshStreams: (platform, want) => deps.refreshStreams(job, platform, want),
        onTaskSubmitted,
        onStatus,
        onUploaded: onUploadedCb,
        fileId: job.fileId || '',
        signal,
        pollBudgetMs: JOB_MAX_MS,
      },
    });
  }

  async function runJob(job) {
    const controller = new AbortController();
    active = { jobId: job.jobId, controller };
    const signal = combineSignals([controller.signal, AbortSignal.timeout(JOB_MAX_MS)]);
    let dnrRuleId = null;
    let dnrRegistered = false;
    let state = null;
    let uploadedFileId = '';
    try {
      await patch(job.jobId, {
        status: 'running',
        phase: job.phase === 'paused' ? 'resuming' : 'downloading',
        startedAt: job.startedAt || deps.now(),
      });
      state = await loadRunState(job);
      let result;
      if (state.taskOnly) {
        result = await runTaskOnly(job, state.asr, signal);
      } else {
        // Only register DNR when the pipeline may actually download. A
        // resumed Qwen task / cached upload needs no cookie injection.
        dnrRuleId = dnrRuleFor(job.platform);
        if (dnrRuleId != null && hasMedia(state.ctx)) {
          const cookie = await deps.readPlatformCookie(job.platform).catch(() => '');
          await deps.registerMediaHeaders(dnrRuleId, job.platform, cookie);
          dnrRegistered = true;
        }
        const persistUpload = (fileId) => {
          uploadedFileId = fileId || '';
          return patch(job.jobId, { fileId: uploadedFileId, phase: 'transcribing' });
        };
        try {
          result = await runPipeline(job, state.asr, state.ctx, signal, persistUpload);
        } catch (firstError) {
          // The persisted playurl may have expired while the offscreen was
          // asleep. Reconstruct a fresh ctx once; never retry an upload or a
          // task submit (those errors carry a taskId/fileId and are paused).
          const msg = String(firstError?.message || firstError);
          const latest = await deps.getAsrJob(job.jobId).catch(() => null);
          const preUploadError = /ASR download failed|ASR transcode failed|no usable audio stream|audio stream is truncated/.test(msg)
            && !uploadedFileId && !latest?.fileId && !latest?.taskId;
          if (!signal.aborted && preUploadError && hasMedia(state.ctx)) {
            const rec = await deps.reconstruct(job);
            if (rec.ok && rec.ctx && hasMedia(rec.ctx)) {
              state = { taskOnly: false, asr: rec.asr || state.asr, ctx: { ...rec.ctx, asr: rec.asr || state.asr } };
              result = await runPipeline(job, state.asr, state.ctx, signal, persistUpload);
            } else {
              throw firstError;
            }
          } else {
            throw firstError;
          }
        }
      }
      if (!result?.transcriptText) throw new Error('ASR returned empty transcript');
      await patch(job.jobId, {
        status: 'done',
        phase: 'done',
        resultText: result.transcriptText,
        audioBytes: Number(result.audioBytes) || 0,
        fileId: result.fileId || job.fileId || '',
        resultUsage: result.usage || null,
        finishedAt: deps.now(),
        progressText: '',
        error: '',
      });
      await deps.clearAsrJobPayload(job.jobId).catch(() => {});
    } catch (e) {
      // A user cancel and the 6h safety timeout both abort the signal, but
      // they mean different things: cancel is terminal, timeout is resumable
      // when a task/file handle exists.
      const userCanceled = controller.signal.aborted;
      const msg = String(e?.message || e);
      const latest = await deps.getAsrJob(job.jobId).catch(() => null);
      // Terminal task errors must not be retried as "paused": a re-attach
      // would poll the same dead task forever, and a new submit is a
      // side-effectful decision that belongs to the user.
      const terminalTask = /qwen 转写任务失败 \((FAILED|CANCELED|UNKNOWN)\)|qwen task returned empty transcript|task query HTTP (404|410)/.test(msg);
      const keepForResume = !terminalTask && !!(latest?.taskId || latest?.fileId);
      if (userCanceled) {
        await patch(job.jobId, { status: 'canceled', phase: 'canceled', error: '' });
      } else if (keepForResume) {
        // A submitted task/file exists: this is a resumable pause, not a
        // terminal failure. Do not clear the handle; re-attach resumes it.
        await patch(job.jobId, {
          status: 'paused', phase: 'paused', error: msg,
        });
      } else {
        await patch(job.jobId, { status: 'failed', phase: 'failed', error: msg });
      }
      await deps.clearAsrJobPayload(job.jobId).catch(() => {});
    } finally {
      if (dnrRegistered && dnrRuleId != null) {
        await deps.removeMediaHeaders(dnrRuleId).catch(() => {});
      }
      active = null;
    }
  }

  async function enqueue(jobOrId) {
    const job = typeof jobOrId === 'string'
      ? await deps.getAsrJob(jobOrId).catch(() => null)
      : jobOrId;
    if (!job?.jobId) return false;
    if (job.status === 'done' || job.status === 'failed' || job.status === 'canceled') return false;
    if (active?.jobId === job.jobId || queue.some((j) => j.jobId === job.jobId)) return false;
    clearTimeout(idleTimer);
    queue.push(job);
    drain();
    return true;
  }

  function drain() {
    if (running || !queue.length) {
      if (!running && !queue.length) scheduleIdle();
      return;
    }
    running = true;
    const job = queue.shift();
    runJob(job).catch((e) => {
      console.warn('browsa[asr-runner]: job crashed', job?.jobId, e?.message || e);
    }).finally(() => {
      running = false;
      if (queue.length) drain();
      else scheduleIdle();
    });
  }

  async function cancel(jobId) {
    queue = queue.filter((j) => j.jobId !== jobId);
    if (active?.jobId === jobId) {
      try { active.controller.abort('user-cancel'); } catch (_) {}
    } else {
      await patch(jobId, { status: 'canceled', phase: 'canceled', error: '' });
      await deps.clearAsrJobPayload(jobId).catch(() => {});
    }
  }

  async function resumeActiveJobs() {
    const jobs = await deps.listActiveAsrJobs().catch(() => []);
    for (const job of jobs) await enqueue(job);
  }

  return {
    enqueue,
    cancel,
    resumeActiveJobs,
    activeJobId: () => active?.jobId || '',
    stop() {
      try { active?.controller.abort('stop'); } catch (_) {}
      queue = [];
      clearTimeout(idleTimer);
    },
  };
}
