// lib/handlers/attach-asr-qwen.js — 千问AI平台（阿里云百炼 / DashScope 端点）ASR 适配器。
//
// 平台的模型矩阵决定了这里的结构（与方舟「单请求 input_video+input_audio」不同）：
//  - 视觉系（qwen3.8-flash 等）：能看视频画面（video_url，官方标称最长 2 小时/2GB），
//    但官方文档明确视觉模型「不支持理解视频文件中的音频内容」，也不接受纯音频输入；
//  - Omni 系（qwen3.5-omni-flash 等）：接受纯音频（input_audio，官方标称 10 小时+），
//    但音视频混合输入上限只有约 400 秒，撑不起长视频精读。
//
// 因此：音频转写 = Omni 单请求（与方舟同款 prompt 协议）；视频精读 = 两段式——
// Omni 听独立音频出转写主干，视觉系看画面出「画面：」注解/[截屏]标记/说话人改名，
// 客户端按时间轴合并（mergeQwenPasses）。转写文本永远原样保留（2026-08-30 用户定调：
// 字幕完整是主、画面是辅助），视觉通道只做插入，绝不改写语音行。
//
// 文件引用：平台免费临时存储（48 小时有效、与上传时的 model 绑定）。上传走
// getPolicy → OSS POST（file 必须是最后一个表单域），成功后得到 `oss://` key；
// 之后所有模型调用的 HTTP 头必须带 X-DashScope-OssResourceResolve: enable，
// 服务端才会代为解析该 URL。官方文档：
// platform.qianwenai.com/docs/api-reference/more/upload-file-get-temporary-url

import { parseOutputCapFromError, outputCapRetryBudget } from '../llm-client.js';

const QWEN_DEFAULT_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

/**
 * 把用户填的 Base URL 规整成 OpenAI 兼容端点（纯函数）。只填到域名（或贴了
 * /chat/completions 结尾）都自动补齐 /compatible-mode/v1；国际站 dashscope-intl
 * 同样适用（同域拼接）。临时文件上传/任务接口固定走同域 /api/v1（见 qwenUploadOrigin）。
 */
export function normalizeQwenBaseUrl(raw) {
  let b = String(raw || '').trim().replace(/\/+$/, '');
  if (!b) return QWEN_DEFAULT_BASE;
  b = b.replace(/\/chat\/completions$/, '');
  if (/\/compatible-mode\/v\d+$/.test(b)) return b;
  if (/\/compatible-mode$/.test(b)) return b + '/v1';
  return b + '/compatible-mode/v1';
}

/** 临时文件上传 / 异步任务的同域 /api/v1 根（与 chat 的 compatible-mode 无关）。 */
export function qwenUploadOrigin(rawBaseUrl) {
  return new URL(normalizeQwenBaseUrl(rawBaseUrl)).origin + '/api/v1';
}

/** 视频 fps：目标全片 ≈512 帧（1M 窗口下 720p 帧的 token 预算安全线），夹在 [0.1, 2]。 */
export function qwenVideoFps(durationSec = 0) {
  const d = Math.max(1, Number(durationSec) || 0);
  const fps = 512 / d;
  return Math.round(Math.min(2, Math.max(0.1, fps)) * 100) / 100;
}

/**
 * 上传 Blob 到千问免费临时存储，返回可直接喂给模型调用的 `oss://` 引用。
 * 临时文件与 model 绑定（getPolicy 必须带消费它的那个 model），有效期 48 小时，
 * 平台不提供查询接口——所以这里的成功即立即可用，调用方无需轮询。
 * onProgress 走 XHR（fetch 无上传进度）；否则走纯 fetch（测试环境）。
 * @returns {Promise<{ok:true, fileId:string, bytes:number} | {ok:false, error:string}>}
 */
export async function uploadBlobToQwen({ blob, filename, apiKey, baseUrl: rawBaseUrl, model, onProgress } = {}) {
  if (!blob) return { ok: false, error: 'no blob' };
  if (!apiKey) return { ok: false, error: 'no apiKey' };
  if (!model) return { ok: false, error: 'no model（千问的临时文件与模型绑定，上传必须带 model）' };
  const apiV1 = qwenUploadOrigin(rawBaseUrl);
  try {
    const polRes = await fetch(`${apiV1}/uploads?action=getPolicy&model=${encodeURIComponent(model)}`, {
      headers: { Authorization: 'Bearer ' + apiKey },
    });
    const polData = await polRes.json().catch(() => null);
    // 兼容两种返回形态：{data:{...}} 包裹 / 扁平
    const pol = polData?.data || polData;
    if (!polRes.ok || !pol?.policy || !pol?.signature || !pol?.upload_host || !pol?.upload_dir || !pol?.oss_access_key_id) {
      return { ok: false, error: `qwen getPolicy HTTP ${polRes.status}: ${JSON.stringify(polData || {}).slice(0, 300)}` };
    }
    const name = filename || 'audio.wav';
    const key = `${pol.upload_dir}/${name}`;
    // OSS POST：字段顺序按官方文档（file 必须是最后一个表单域），成功 = 2xx 空响应体
    const send = (fd) => new Promise((resolve) => {
      if (onProgress && typeof XMLHttpRequest !== 'undefined') {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', pol.upload_host);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0) onProgress(e.loaded, e.total);
        };
        xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300
          ? { ok: true }
          : { ok: false, error: `qwen OSS upload HTTP ${xhr.status}` });
        xhr.onerror = () => resolve({ ok: false, error: 'qwen OSS upload network error' });
        xhr.onabort = () => resolve({ ok: false, error: 'qwen OSS upload aborted' });
        xhr.send(fd);
        return;
      }
      fetch(pol.upload_host, { method: 'POST', body: fd })
        .then((res) => resolve(res.ok ? { ok: true } : { ok: false, error: `qwen OSS upload HTTP ${res.status}` }))
        .catch(() => resolve({ ok: false, error: 'qwen OSS upload network error' }));
    });
    const fd = new FormData();
    fd.append('OSSAccessKeyId', pol.oss_access_key_id);
    fd.append('Signature', pol.signature);
    fd.append('policy', pol.policy);
    fd.append('key', key);
    fd.append('x-oss-object-acl', pol.x_oss_object_acl || 'private');
    fd.append('x-oss-forbid-overwrite', pol.x_oss_forbid_overwrite || 'true');
    fd.append('success_action_status', '200');
    fd.append('file', blob, name);
    const up = await send(fd);
    if (!up.ok) return up;
    if (onProgress) onProgress(blob.size, blob.size);
    return { ok: true, fileId: 'oss://' + key, bytes: blob.size };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 千问没有「上传后服务端处理」的文件状态（oss:// 上传成功即可用），轮询是 no-op。
 * 保留与方舟 pollFileStatus 相同的签名与返回形态，sidepanel 管线零分支。
 */
export async function pollFileStatusQwen() {
  return { status: 'ready', ready: true };
}

/** 千问 chat/completions 的 usage 兼容两种字段名（OpenAI 风格 / input_tokens 风格）。 */
function normalizeQwenUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.input_tokens ?? u.prompt_tokens ?? 0) || 0;
  const output = Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0;
  return { input_tokens: input, output_tokens: output, total_tokens: Number(u.total_tokens ?? (input + output)) || (input + output) };
}

function sumQwenUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return {
    input_tokens: (a.input_tokens || 0) + (b.input_tokens || 0),
    output_tokens: (a.output_tokens || 0) + (b.output_tokens || 0),
    total_tokens: (a.total_tokens || 0) + (b.total_tokens || 0),
  };
}

/**
 * chat/completions 流式共用底层（音频转写与视频画面注解共用）。SSE 从
 * choices[0].delta.content 累积（reasoning_content 忽略——只要正文），跟踪
 * finish_reason 与 usage；oss:// 引用依赖请求头 X-DashScope-OssResourceResolve。
 * 400 且报错指向 max_tokens 超限时按解析出的真实上限自动降档重试一次
 * （与 llm-client 的 renegotiateOutputCap 同一纪律：用户不需要懂该填多少）。
 * 返回 { text, truncated?, finishReason?, usage? }。
 */
export async function streamQwenChat({ baseUrl: rawBaseUrl, apiKey, body, signal, idleTimeoutMs = 60_000, label = 'qwen' }) {
  const baseUrl = normalizeQwenBaseUrl(rawBaseUrl);
  const url = `${baseUrl}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + apiKey,
    // oss:// 临时 URL 必须带这个头，服务端才会代为解析（官方上传文档调用步骤）
    'X-DashScope-OssResourceResolve': 'enable',
  };
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  const cleanup = () => signal?.removeEventListener('abort', onOuterAbort);
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(), idleTimeoutMs);
  };
  const clearIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };
  const doFetch = async (b) => {
    armIdle();
    try {
      return await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(b),
        signal: ac.signal,
      });
    } catch (e) {
      clearIdle();
      cleanup();
      if (signal?.aborted) {
        throw new Error(`${label} 请求被中止：超时预算用尽——请重试，或先用较短的视频`);
      }
      if (ac.signal.aborted) {
        throw new Error(`${label} 请求被中止：${Math.round(idleTimeoutMs / 1000)} 秒内未连上服务端（连接空闲超时）`);
      }
      throw new Error(`${label} fetch failed: ${e.message}`);
    }
  };
  let res = await doFetch(body);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // max_tokens 超模型上限：解析真实上限自动降档重试一次（错误不指向预算则原样抛）
    const retry = outputCapRetryBudget(errText, body.max_tokens);
    if (retry) {
      res = await doFetch({ ...body, max_tokens: retry });
      if (!res.ok) {
        clearIdle();
        cleanup();
        const t2 = await res.text().catch(() => '');
        throw new Error(`${label} HTTP ${res.status}: ${t2.slice(0, 300)}`);
      }
    } else {
      clearIdle();
      cleanup();
      throw new Error(`${label} HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
  }

  const reader = res.body?.getReader ? res.body.getReader() : null;
  if (!reader) {
    // 非流式兜底（网关忽略 stream:true）——同步解析
    clearIdle();
    cleanup();
    const data = await res.json().catch(() => null);
    const choice = data?.choices?.[0];
    const truncated = choice?.finish_reason === 'length';
    console.log(`[ASR] ${label}: non-stream JSON fallback chars=${String(choice?.message?.content || '').length} truncated=${truncated}`);
    return {
      text: String(choice?.message?.content || '').trim(),
      ...(truncated ? { truncated: true, finishReason: 'length' } : {}),
      ...(normalizeQwenUsage(data?.usage) ? { usage: normalizeQwenUsage(data.usage) } : {}),
    };
  }

  // 进入读取循环前重新武装空闲超时：服务端长预处理（音视频抽帧）可能让首 token
  // 静默远超连接阶段（与方舟 streamResponsesText 同款结构）。
  armIdle();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let finishReason = '';
  let usage = null;
  const feedLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk = null;
    try { chunk = JSON.parse(payload); } catch (_) { return; }
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta) full += delta;
    finishReason = finishReason || choice?.finish_reason || '';
    if (chunk?.usage) usage = normalizeQwenUsage(chunk.usage);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        feedLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    clearIdle();
    if (buffer.trim()) feedLine(buffer);
  } catch (e) {
    clearIdle();
    cleanup();
    if (signal?.aborted) {
      throw new Error(`${label} 请求被中止：超时预算用尽——请重试，或先用较短的视频`);
    }
    if (ac.signal.aborted) {
      throw new Error(`${label} 请求被中止：${Math.round(idleTimeoutMs / 1000)} 秒内未收到服务端任何数据（空闲超时，可能服务端预处理尚未完成）`);
    }
    throw new Error(`${label} stream failed: ${e.message}`);
  }
  cleanup();
  const truncated = finishReason === 'length';
  console.log(`[ASR] ${label}: SSE ended chars=${String(full || '').length} truncated=${truncated} finishReason=${finishReason || 'none'} usage=${JSON.stringify(usage || {})}`);
  return {
    text: String(full || '').trim(),
    ...(truncated ? { truncated: true, finishReason: 'length' } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * 转写 system 指令（Omni 系纯音频）。协议与方舟 transcribeAudio 逐条对齐
 * （[mm:ss] 单起始时间戳、禁裸秒/区间/小数、强制标点、行粒度、说话人编号规则），
 * 保证两个供应商产出同构、下游共用。forVideoAnalysis 时追加广告压缩规则——
 * 这是精读文档的行为，纯音频转写模式保持全量逐字。
 */
function qwenTranscribeSys({ language = 'zh', forVideoAnalysis = false } = {}) {
  const langHint = language && language !== 'auto'
    ? `The audio language is ${language}.`
    : 'The audio language is unknown; auto-detect it.';
  const adRule = forVideoAnalysis
    ? 'AD READS: when a segment is clearly a paid placement (a sponsored pitch interrupting the content), do NOT transcribe it verbatim — ' +
      'compress it into ONE line "[mm:ss] （广告：品牌+核心卖点）"; content that merely discusses a product as part of the topic is NOT an ad. '
    : '';
  return 'Transcribe the audio verbatim in its original language. ' + langHint +
    'Output ONLY transcript lines, each starting with EXACTLY one bracket containing the single start ' +
    'timecode "[mm:ss]" (use "[h:mm:ss]" over an hour) followed by the text — e.g. "[00:12] 你好". ' +
    'NEVER output duration ranges like "[00:00-00:12]" and never add decimals like "[00:12.5]" — ' +
    'one plain start timestamp per line, nothing else inside the brackets. ' +
    'PUNCTUATION IS MANDATORY: add punctuation （，。！？） so every sentence is complete and readable; ' +
    'break long continuous speech into separate sentences at semantic boundaries — ' +
    'never output long run-on unpunctuated text. ' +
    'Put ONE sentence per line. ' + adRule +
    'SPEAKER LABELS (deterministic rules): count EVERY distinct human voice as a speaker — the host/narrator, ' +
    'an embedded or quoted recording (a played interview, speech or phone call), a voiceover, or a different person ' +
    'even when the language switches. If the ENTIRE audio has only ONE such voice, output NO labels at all. ' +
    'Otherwise label EVERY line EXACTLY: each line starts with ' +
    '"[mm:ss] [说话人N] text" (the label sits right after the timecode, with NO exception — this includes ' +
    'the main narrator/host, whose lines must also carry their own label). ' +
    'Numbers start at 1 for the first voice that appears and are assigned in order of first appearance ' +
    'across the ENTIRE audio; the same voice must keep the same number everywhere. ' +
    'Never merge two people into one number and never split one person into two. ' +
    'Preserve wording and order — no summary, no preamble, no markdown fences, no numbering.';
}

/** 转写任务的中文 input_text（与方舟 transcribeAudio 的双语结构一致）。 */
function qwenTranscribeTask({ forVideoAnalysis = false, durationSec = 0 } = {}) {
  const durHint = durationSec > 0 ? `音频总长约 ${Math.round(durationSec / 60)} 分钟，请把时间戳均匀铺满全片、一直标到结尾。` : '';
  const adRule = forVideoAnalysis
    ? '广告口播：遇到明显的商单/广告口播段落，不要逐字转写，压缩成一行 `[mm:ss] （广告：品牌+核心卖点）`；只是客观介绍产品的不算广告。'
    : '';
  return '请逐字转写这段音频的语音内容：每句一行、每行行首加一个单一起始时刻时间戳 [mm:ss]（超过一小时用 [h:mm:ss]），时间戳永远是「分:秒」——禁止裸秒数（如 [62.0] 或 [62]），必须换算成 [01:02]；不要输出区间（如 [00:00-00:12]）也不要小数（如 [00:12.5]），括号内只放这一个起始时间；必须补全中文标点（，。！？），即使原音频没有明显停顿也要按语义断句，不要输出一整段没有标点的长句；行粒度：一行 = 一句完整的话或紧连的 1-3 个短句，不要把连续的碎片段各占一行；' + adRule +
    '说话人标签规则：每一个独立人声都算一个说话人——主讲人/旁白、插播的采访或演讲录音、画外音、电话音、换了语言的其他人都算。只有一个人说话全程才不标；否则每一行都必须在时间戳后标注 [说话人N]（主讲人也不例外，无例外），编号从 1 开始按全片首次出现的声音顺序分配，同一个声音全片用同一个号，不能把两个人合并成一个号，也不能把一个人拆成两个号。' + durHint;
}

/**
 * 音频转写（Omni 系，OpenAI 兼容 chat/completions）。fileId 是上传得到的 `oss://`
 * 引用（已与该 model 绑定）。出参与方舟版同构：{ text, truncated?, finishReason?, usage? }。
 */
export async function transcribeAudioQwen({ baseUrl, apiKey, fileId, model, language = 'zh', durationSec = 0, forVideoAnalysis = false, signal, idleTimeoutMs = 60_000 }) {
  if (!fileId) throw new Error('no fileId');
  if (!model) throw new Error('no model');
  const body = {
    model,
    messages: [
      { role: 'system', content: qwenTranscribeSys({ language, forVideoAnalysis }) },
      {
        role: 'user',
        content: [
          // 平台仅 Omni 系接受纯音频输入；data 字段放公网 URL 或 oss:// 临时引用
          { type: 'input_audio', input_audio: { data: fileId, format: 'wav' } },
          { type: 'text', text: qwenTranscribeTask({ forVideoAnalysis, durationSec }) },
        ],
      },
    ],
    stream: true,
    // usage 随最后一个 chunk 返回（排障：区分模型没读 vs 服务端截断输入）
    stream_options: { include_usage: true },
    // 逐字转写整段长音频的输出远大于默认上限——与方舟 max_output_tokens: 65536
    // 同款放开；模型真实上限更低时 streamQwenChat 按 400 报错自动降档重试。
    max_tokens: 65536,
  };
  return streamQwenChat({ baseUrl, apiKey, body, signal, idleTimeoutMs, label: 'qwen transcribe' });
}

/** 画面注解 system 指令（视觉系）：只输出「画面：」行 / [截屏] 标记 / 改名指令。 */
function qwenVisualSys({ language = 'zh' } = {}) {
  const langHint = language && language !== 'auto'
    ? `The video language is ${language}; write annotations in that language.`
    : 'The video language is unknown; auto-detect it and write annotations in the same language.';
  return 'You are annotating the VISUAL channel of a video. A separate acoustic transcript of the speech is PROVIDED as context — ' +
    'the speech is already captured elsewhere; do NOT transcribe, summarize or repeat it. ' +
    'Output ONLY the following three kinds of lines (no preamble, no markdown fences, no section headers): ' +
    '(1) VISUAL-INFO lines — on-screen information beyond the speech (on-screen text, slide titles, code, terminal output, charts, diagrams, demonstrated actions): ' +
    'one line each, "[mm:ss] 画面：…" — transcribe on-screen text verbatim; technical terms, names and numbers must be exact; ' +
    'a purely visual segment with no speech also gets its own 「画面：」 line. ' +
    '(2) KEYFRAME SCREENSHOT MARKERS — KEY visuals ONLY: a marker ONLY for a visual the argument DEPENDS on seeing ' +
    '(a data chart or figure being discussed, a slide or on-screen text with real information, code or terminal output, a key piece of evidence such as a document or note). ' +
    'A 15-20 minute video typically warrants around 6-10; scale with length. ' +
    'Do NOT capture title cards, section transitions, ending/thank-you cards, decorative cartoons, memes, or scene filler — ' +
    'and never capture the same visual twice (once, at its clearest appearance). ' +
    'Each marker is ONE line of its own immediately AFTER the 「画面：」 line it belongs to: "[mm:ss] [截屏] 短标题" — ' +
    'the same timestamp as that moment, followed by a short noun-phrase title. At least 10 seconds apart. ' +
    '(3) SPEAKER RENAME DIRECTIVES: when the frames genuinely confirm a numbered speaker\'s real identity ' +
    '(on-screen name card, caption, or the provided video metadata), output ONE line "[改名] [说话人2] → [说话人：王小磊]" (no timestamp). ' +
    'ONLY when identity is genuinely confirmed — a wrong name is worse than a number; when unsure, output nothing. ' +
    'The same person must map to the same name everywhere; the name is at most 8 characters; prefer the most common appellation. ' +
    'Timecode discipline: every content line starts with EXACTLY one bracket containing the single start timecode "[mm:ss]" ' +
    '(use "[h:mm:ss]" over an hour); raw seconds like "[62.0]" or "[62]" are FORBIDDEN; never ranges, never decimals. ' +
    'Chronological order, cover from the first meaningful visual to the last. ' + langHint;
}

/** 画面注解任务的中文 input_text：附转写文本作上下文（严禁复述）+ 视频元信息。 */
function qwenVisualTask({ durationSec = 0, metaHint = '', transcript = '' } = {}) {
  const durHint = durationSec > 0 ? `视频总长约 ${Math.round(durationSec / 60)} 分钟，请把时间戳均匀铺满全片。` : '';
  const meta = metaHint ? `视频元信息（用于识别说话人姓名与职务，仅供参考，不要原样写进正文）：${metaHint}。` : '';
  return '请观看这段视频的画面，只输出三类行：' +
    '①「画面：」行——画面里超出语音的独立信息（屏幕文字、幻灯片标题、代码、终端输出、图表、演示操作），屏幕文字逐字转写；纯画面无语音的段落也单独成行；' +
    '②关键帧截图标记——只截【关键】画面：正在讲解的数据图表、有独立信息的幻灯片或屏幕文字、代码或终端输出、文件便签等关键证据；' +
    '紧随其「画面：」行单独加一行 `[mm:ss] [截屏] 短标题`（时间与该画面一致）；彼此至少间隔 10 秒；15-20 分钟的视频通常 6-10 处，按长度增减；' +
    '不要截：标题卡、章节转场、片尾致谢卡、装饰性卡通或表情包、与讲解无关的空镜；同一画面只截一次，选它最清晰的那次出现；' +
    '广告段内不要输出截图标记。' +
    '③说话人改名指令——仅当画面能确凿确认某编号说话人的真实身份时，输出一行 `[改名] [说话人2] → [说话人：名字]`（不带时间戳）；' +
    '没把握宁可不改（写错名字比编号危害大）；同一人全片必须同一个名字，最长 8 字，取最常用的称呼。' +
    '每行行首加一个单一起始时刻时间戳 [mm:ss]（超过一小时用 [h:mm:ss]），括号内只放这一个起始时间，不要区间也不要小数；' +
    '禁止裸秒数（如 [62.0] 或 [62]），必须换算成 [01:02]。' +
    '除这三类行外什么都不要输出：不要复述/转写/总结语音内容，不要输出下方转写文本里已有的任何一行。' + durHint + meta +
    (transcript ? `\n语音转写文本（仅作时间轴与说话人上下文，严禁复述）：\n${transcript}` : '');
}

// ─── 两段式合并 ────────────────────────────────────────────────────────────────

const STAMP_RE = /^\s*\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/;
const RENAME_RE = /^\s*\[改名\]\s*\[\s*说话人\s*(\d+)\s*\]\s*→\s*\[\s*说话人[:：]\s*([^\]\s]{1,12})\s*\]\s*$/;
// 视觉通道只认这两类行；其余（模型违规复述的转写等）一律丢弃，杜绝转写被改写
const VISUAL_LINE_RE = /^\s*\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]\s*(?:画面[:：]|\[截屏\])/;

function lineSec(line) {
  const m = STAMP_RE.exec(line);
  if (!m) return null;
  return (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
}

/**
 * 合并两段产物（纯函数，Node 可直接测试）：转写行为主干原样保留；视觉产物里只
 * 接受「画面：」/[截屏]/[改名] 三类行，按时间戳插到转写主干上（画面行落在它所属
 * 语音行之后——与方舟单请求精读的行序约定一致）。改名指令应用到转写行的说话人
 * 标签（[说话人2] → [说话人：名字]），全量替换保证同一人全片同名。
 */
export function mergeQwenPasses(transcriptText, visualText) {
  const renames = [];
  const visuals = [];
  for (const line of String(visualText || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const rm = RENAME_RE.exec(line);
    if (rm) {
      renames.push({ num: parseInt(rm[1], 10), name: rm[2].trim() });
      continue;
    }
    if (VISUAL_LINE_RE.test(line)) {
      const sec = lineSec(line);
      if (sec == null) continue;
      visuals.push({ sec, text: line.trim() });
    }
  }
  visuals.sort((a, b) => a.sec - b.sec); // 稳定排序：同秒保持「画面：」在 [截屏] 前的输出顺序
  const rawLines = String(transcriptText || '').split(/\r?\n/).filter((l) => l.trim());
  const tLines = rawLines.map((text) => {
    let out = text;
    for (const { num, name } of renames) {
      out = out.replace(new RegExp(`\\[\\s*说话人\\s*${num}\\s*\\]`, 'g'), `[说话人：${name}]`);
    }
    return out;
  });
  // 无时间戳的转写行（理论不该出现）挂到前一行的时间上，避免插入语义漂移
  let lastSec = 0;
  const tNorm = tLines.map((text) => {
    const s = lineSec(text);
    const sec = s == null ? lastSec : s;
    lastSec = sec;
    return { sec, text };
  });
  const out = [];
  let vi = 0;
  while (vi < visuals.length && (tNorm.length === 0 || visuals[vi].sec < tNorm[0].sec)) {
    out.push(visuals[vi++].text);
  }
  for (let i = 0; i < tNorm.length; i++) {
    out.push(tNorm[i].text);
    const nextSec = i + 1 < tNorm.length ? tNorm[i + 1].sec : Infinity;
    while (vi < visuals.length && visuals[vi].sec <= nextSec) {
      out.push(visuals[vi++].text);
    }
  }
  while (vi < visuals.length) out.push(visuals[vi++].text);
  return out.join('\n');
}

/**
 * 视听精读（千问两段式）：
 *  1) Omni（transcribeModel）读独立音频 → 全量转写主干（含广告压缩）；
 *  2) 视觉系（model，默认 qwen3.8-flash）读视频画面（fps 随时长自适应）→
 *     画面注解 + [截屏] 标记 + 说话人改名（带转写与元信息作上下文）；
 *  3) mergeQwenPasses 按时间轴合并。转写永不改写；任一段截断即整体 truncated
 *     （调用方据此拒绝半截产物，与方舟版语义一致）。
 */
export async function analyzeVideoQwen({
  baseUrl, apiKey, videoFileId, audioFileId, transcribeModel, model,
  language = 'zh', durationSec = 0, metaHint = '', signal, idleTimeoutMs = 60_000,
}) {
  if (!videoFileId) throw new Error('no videoFileId');
  if (!audioFileId) {
    throw new Error('千问视频精读需要独立音频流：视觉模型（qwen3.8-flash 等）听不到视频里的声音，语音转写必须由 Omni 模型读取独立音频文件');
  }
  if (!model) throw new Error('no model');
  const trModel = (transcribeModel || '').trim() || model;
  const tr = await transcribeAudioQwen({
    baseUrl, apiKey, fileId: audioFileId, model: trModel,
    language, durationSec, forVideoAnalysis: true, signal, idleTimeoutMs,
  });
  if (tr.truncated) {
    return { text: tr.text, truncated: true, finishReason: tr.finishReason || 'length', usage: tr.usage || null };
  }
  if (!tr.text) {
    throw new Error('千问音频转写返回为空（Omni 模型未产出任何转写行），视频精读中止');
  }
  const visBody = {
    model,
    messages: [
      { role: 'system', content: qwenVisualSys({ language }) },
      {
        role: 'user',
        content: [
          { type: 'video_url', video_url: { url: videoFileId, fps: qwenVideoFps(durationSec) } },
          { type: 'text', text: qwenVisualTask({ durationSec, metaHint, transcript: tr.text }) },
        ],
      },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 65536,
  };
  const vis = await streamQwenChat({ baseUrl, apiKey, body: visBody, signal, idleTimeoutMs, label: 'qwen video' });
  const text = mergeQwenPasses(tr.text, vis.text);
  const usage = sumQwenUsage(tr.usage, vis.usage);
  console.log(`[ASR] qwen video: transcript ${tr.text.length} chars + visual ${vis.text.length} chars -> merged ${text.length} chars; usage ${JSON.stringify(usage || {})}`);
  return {
    text,
    ...(vis.truncated ? { truncated: true, finishReason: vis.finishReason || 'length' } : {}),
    ...(usage ? { usage } : {}),
  };
}
