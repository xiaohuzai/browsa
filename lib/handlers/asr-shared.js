// lib/handlers/asr-shared.js — ASR 供应商共享层：SSE 流式底层 + 提示词构建器。
//
// 从 attach-asr.js 拆出（2026-10-07，多供应商化整理）：方舟（attach-asr.js）与
// 百炼（attach-asr-qwen.js）两个适配器共用同一套流式解析与产物契约，抽出单份
// 防漂移。这里没有任何供应商分支——「契约层」，两家各自实现协议差异。

import { sseDataPayload } from '../llm-client.js';

/**
 * 流式请求共用底层（transcribeAudio 音频转写 / analyzeVideo 视听精读共用）。
 * 方舟适配器走 Responses API（{baseUrl}/responses），百炼适配器走 OpenAI 兼容
 * chat completions（{baseUrl}/chat/completions，path 参数指定，headers 参数带
 * oss:// 解析头）——两条流都解析：response.output_text.delta 累积文本（兼容
 * chat 兼容流的 choices[0].delta.content），每收到一个 chunk 重置“空闲超时”：
 * 长请求不会因中途长时间无数据而误超时（stream:false 同步等待会超时：用户实测
 * “transcribe fetch failed: signal timed out”，Ark 官方也建议长音频用流式）。
 * 返回 { text, raw, truncated?, finishReason? }：truncated 在输出被 token 上限
 * 截断时为 true，调用方必须据此拒绝把半截产物当完整结果存下来（真实 bug：
 * 52:48 视频只出 33 分钟字幕）。
 */
export async function streamResponsesText({ baseUrl, apiKey, body, signal, idleTimeoutMs = 60_000, path = '/responses', headers = null }) {
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  const cleanup = () => signal?.removeEventListener('abort', onOuterAbort);
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(), idleTimeoutMs);
  };
  armIdle();
  let res;
  try {
    // 显式打出端点与模型：用户问「怎么确定用上了哪家」时，这行即答案——
    // dashscope.aliyuncs.com = 百炼 qwen；ark.volces.com = 方舟 doubao。
    console.log(`[ASR] stream -> ${baseUrl}${path} | model: ${body.model || '?'}`);
    res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
        ...(headers || {}),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    cleanup();
    // 错误路径同样要拆掉 idle 定时器（否则挂起的定时器空转到触发，测试进程也会
    // 被这个活句柄拖住不退出）。
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    // 连接阶段被中止（墙钟超时/空闲超时都会表现为 fetch reject）——说清楚是哪一种，
    // 别把 Chrome 的 "BodyStreamBuffer was aborted" 直接甩给用户。
    if (signal?.aborted) {
      throw new Error('流式请求被中止：超时预算用尽——请重试，或先用较短的视频');
    }
    if (ac.signal.aborted) {
      throw new Error(`流式请求被中止：${Math.round(idleTimeoutMs / 1000)} 秒内未连上服务端（连接空闲超时）`);
    }
    throw new Error('transcribe fetch failed: ' + e.message);
  }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!res.ok) {
    cleanup();
    const data = await res.json().catch(() => null);
    throw new Error(`transcribe HTTP ${res.status}: ${JSON.stringify(data || {}).slice(0, 300)}`);
  }

  const reader = res.body?.getReader ? res.body.getReader() : null;
  if (!reader) {
    // 非流式响应兜底（某些网关可能忽略 stream:true）——回到同步解析。
    cleanup();
    const data = await res.json().catch(() => null);
    let text = '';
    for (const item of (data?.output || [])) {
      if (item?.type !== 'message') continue;
      for (const c of (item?.content || [])) {
        if (c?.type === 'output_text' && c?.text) text += (text ? '\n' : '') + c.text;
      }
    }
    // chat 兼容形态的兜底（网关忽略 stream:true 时）：choices[].message.content。
    if (!text && Array.isArray(data?.choices)) {
      for (const ch of data.choices) {
        const c = ch?.message?.content;
        if (typeof c === 'string') text += (text ? '\n' : '') + c;
        else if (Array.isArray(c)) {
          for (const part of c) {
            if (part?.type === 'text' && part.text) text += (text ? '\n' : '') + part.text;
          }
        }
      }
    }
    if (!text) text = data?.output_text || data?.text || '';
    const truncated = !!(data?.status === 'incomplete' || data?.incomplete_details?.reason === 'max_output_tokens'
      || (Array.isArray(data?.output) && data.output.some((o) => o?.finish_reason === 'length'))
      || (Array.isArray(data?.choices) && data.choices.some((c) => c?.finish_reason === 'length')));
    console.log(`[ASR] transcribe: non-stream JSON fallback chars=${String(text || '').length} truncated=${truncated}`);
    return {
      text: String(text || '').trim(),
      raw: JSON.stringify(data),
      usage: extractUsageFromPayload(data),
      ...(truncated ? { truncated: true, finishReason: 'max_output_tokens' } : {}),
    };
  }

  // SSE 解析：累积 response.output_text.delta（Responses 流式）或
  // choices[0].delta.content（chat 兼容）。同时跟踪输出是否被 token 上限截断
  // （response.completed / finish_reason），被截断时返回 truncated:true，调用方
  // 不得把半截字幕当完整结果存下来（真实 bug：52:48 视频只出 33 分钟字幕）。
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let finishReason = '';
  let lastUsage = null;
  let pendingCR = false; // 跨 chunk 的 \r 边界（见下）
  // 进入读取循环前重新武装空闲超时：post-fetch 清掉了连接阶段的定时器，而下面的
  // armIdle() 只在【收到数据】时触发——若服务端长时间不出首 token（视频精读的
  // 服务端抽帧预处理正是这种情形），没有定时器就只剩墙钟兜底，空闲保护形同虚设。
  armIdle();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle(); // 有数据 -> 重置空闲超时
      // CRLF 归一化（openSseStream 同款 pendingCR 技法，2026-10-01）：下面的
      // 事件切分按裸 '\n\n' 找边界——上游按 SSE 规范允许的 \r\n\r\n 分隔时整条
      // 流积进一个 buffer，收尾被当一个事件交给 ssePayload（多事件 data 行拼成
      // 非法 JSON → 转写全空）。方舟现网走 LF，属鲁棒性缺口而非现行故障。
      let chunk = decoder.decode(value, { stream: true });
      if (pendingCR) { chunk = '\r' + chunk; pendingCR = false; }
      if (chunk.endsWith('\r')) { chunk = chunk.slice(0, -1); pendingCR = true; }
      buffer += chunk.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const eventBlock = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const delta = extractSseDelta(eventBlock);
        if (delta !== null) full += delta;
        finishReason = finishReason || extractFinishReason(eventBlock);
        lastUsage = extractUsageFromPayload(ssePayload(eventBlock)) || lastUsage;
      }
    }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    // 尾部未以 \n\n 结束的残留事件
    if (buffer.trim()) {
      const delta = extractSseDelta(buffer);
      if (delta !== null) full += delta;
      finishReason = finishReason || extractFinishReason(buffer);
      lastUsage = extractUsageFromPayload(ssePayload(buffer)) || lastUsage;
    }
  } catch (e) {
    cleanup();
    // 错误路径同样要拆掉 idle 定时器（否则挂起的定时器空转到触发，测试进程也会
    // 被这个活句柄拖住不退出）。
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    // 被中止时 Chrome 抛的是 "BodyStreamBuffer was aborted"——用户完全看不懂。
    // 区分两种中止源，给出可操作的报错（墙钟优先判：墙钟触发时 ac 也被连带 abort）。
    if (signal?.aborted) {
      throw new Error('流式请求被中止：超时预算用尽，视频过长未能在预算内完成——请重试，或先用较短的视频');
    }
    if (ac.signal.aborted) {
      throw new Error(`流式请求被中止：${Math.round(idleTimeoutMs / 1000)} 秒内未收到服务端任何数据（空闲超时，可能服务端预处理尚未完成）`);
    }
    throw new Error('transcribe stream failed: ' + e.message);
  }
  cleanup();
  const truncated = finishReason === 'length' || finishReason === 'max_output_tokens' || finishReason === 'incomplete';
  // 正向排障日志：流是【服务端正常结束】还是被我们中断（异常会走 catch 抛错），
  // 输出字符数、finish_reason。下次复现半截字幕时，这一行能直接区分：
  //  - truncated=true + finishReason=length/incomplete → 模型输出被上限夹住
  //  - truncated=false + chars 明显偏少 → 服务端中途自己停了/其它原因
  //  - catch 抛出的 'transcribe stream failed' → 超时/中断（客户端侧）
  console.log(`[ASR] transcribe: SSE stream ended (server closed cleanly) chars=${String(full || '').length} truncated=${truncated} finishReason=${finishReason || 'none'} usage=${JSON.stringify(lastUsage || {})}`);
  return {
    text: String(full || '').trim(),
    raw: full,
    usage: lastUsage,
    ...(truncated ? { truncated: true, finishReason } : {}),
  };
}

/**
 * 取事件块的 data: JSON 负载（解析失败返回 null）。提取走 llm-client 的共享
 * sseDataPayload（2026-09-29 收敛时漏掉的第六份副本）：逐行 JSON.parse 会把
 * 跨多条 data: 行的同一个 JSON（SSE 规范合法，值以 \n 连接）整个事件丢掉——
 * 对这条管线，丢一个 delta 事件 = 半截字幕。
 */
function ssePayload(eventBlock) {
  const payload = sseDataPayload(String(eventBlock || ''));
  if (!payload || payload === '[DONE]') return null;
  try { return JSON.parse(payload); } catch (_) { return null; }
}

/**
 * 从负载里取 token 用量（诊断用）。Responses 形态：response.completed 事件带
 * response.usage {input_tokens, output_tokens}；chat 兼容形态：流末尾的 usage
 * 对象（prompt_tokens/completion_tokens）。只透传数字字段。
 */
function extractUsageFromPayload(data) {
  const u = data?.usage || data?.response?.usage;
  if (!u || typeof u !== 'object') return null;
  const out = {};
  for (const k of ['input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens']) {
    if (typeof u[k] === 'number') out[k] = u[k];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 从一段 SSE 事件块提取文本增量；无法解析或非文本事件返回 null。
 * 兼容两类流式：Responses API（response.output_text.delta / output_text.done
 * 的 text 字段）与 chat completions（choices[0].delta.content）。
 */
function extractSseDelta(eventBlock) {
  const obj = ssePayload(eventBlock);
  if (!obj) return null;
  // Responses 流式：只从 response.output_text.delta 累加增量。
  // output_text.done 携带的是完整文本快照（delta 已累加过），不能再用，
  // 否则会重复（真实用例：delta=“你好” + done=“你好” → “你好你好”）。
  if (obj.type === 'response.output_text.delta' && typeof obj.delta === 'string') return obj.delta;
  // chat 兼容：choices[0].delta.content
  const c = obj.choices?.[0]?.delta?.content;
  if (typeof c === 'string') return c;
  return null;
}

/**
 * 从一段 SSE 事件块提取“输出被截断”信号；无截断信号返回 ''。
 * 兼容：Responses API 的 response.completed（status/incomplete_details.reason）与
 * chat completions 的 choices[0].finish_reason。
 */
function extractFinishReason(eventBlock) {
  const obj = ssePayload(eventBlock);
  if (!obj) return '';
  if (obj.type === 'response.completed') {
    const r = obj.response || {};
    if (r.status === 'incomplete') return 'incomplete';
    if (r.incomplete_details?.reason === 'max_output_tokens') return 'max_output_tokens';
  }
  const fr = obj.choices?.[0]?.finish_reason;
  if (fr === 'length') return 'length';
  return '';
}

/**
 * ASR 转写 instructions（英文格式纪律）。方舟（Responses API 的 instructions 字段）
 * 与百炼（chat/completions 的 system 消息）两个适配器共用同一份文本——这是产物能被
 * formatAsrTranscript / transcriptEndSec / 字幕抽屉无差别消费的契约，抽出单份防漂移。
 * durationSec > 0 时追加全片覆盖硬约束（coverageHintEn）。纯函数，Node 可直接测试。
 */
export function buildTranscribeInstructions(language = 'zh', durationSec = 0) {
  // 'auto'（或空）＝让模型自己检测语种，不给具体的语种 hint。
  const langHint = language && language !== 'auto'
    ? `音频语种为 ${language}。`
    : '音频语种未知，请自动检测。';
  return 'Transcribe the audio verbatim in its original language. ' + langHint +
    'Output ONLY transcript lines, each starting with EXACTLY one bracket containing the single start ' +
    'timecode "[mm:ss]" (use "[h:mm:ss]" over an hour) followed by the text — e.g. "[00:12] 你好". ' +
    'NEVER output duration ranges like "[00:00-00:12]" and never add decimals like "[00:12.5]" — ' +
    'one plain start timestamp per line, nothing else inside the brackets. ' +
    'PUNCTUATION IS MANDATORY: add punctuation （，。！？） so every sentence is complete and readable; ' +
    'break long continuous speech into separate sentences at semantic boundaries — ' +
    'never output long run-on unpunctuated text. ' +
    'Put ONE sentence per line. ' +
    'SPEAKER LABELS (deterministic rules): count EVERY distinct human voice as a speaker — the host/narrator, ' +
    'an embedded or quoted recording (a played interview, speech or phone call), a voiceover, or a different person ' +
    'even when the language switches. If the ENTIRE audio has only ONE such voice, output NO labels at all. ' +
    'Otherwise label EVERY line EXACTLY: each line starts with ' +
    '"[mm:ss] [说话人N] text" (the label sits right after the timecode, with NO exception — this includes ' +
    'the main narrator/host, whose lines must also carry their own label). ' +
    'Numbers start at 1 for the first voice that appears and are assigned in order of first appearance ' +
    'across the ENTIRE audio; the same voice must keep the same number everywhere. ' +
    'Never merge two people into one number and never split one person into two. ' +
    'When a speaker\'s identity is evident from the content (a self-introduction, how others address them), append the name in parentheses at the end ' +
    'of that speaker\'s FIRST line — and AGAIN at their first line after every absence of about two minutes or longer, so long transcripts stay readable. ' +
    'LABEL WITH REAL NAMES when the identity is confirmed — evidence hierarchy: on-screen name card > self-introduction > how others address them > the video\'s title/description metadata. Use "[说话人:英博博士]" form: the most common appellation, IDENTICAL everywhere for the same person, at most 8 characters. Fall back to "[说话人N]" ONLY when the identity is genuinely unknown; both forms may coexist (numbered speakers keep the numbering rules above). ' +
    'Overlapping speech (crosstalk): attribute the line to the dominant voice; split into two separately-labelled lines only when both voices carry distinct, content-worthy statements. ' +
    'Preserve wording and order — no summary, no preamble, no markdown fences, no numbering. ' +
    'NEVER translate and never "correct" the speaker\'s wording — transcribe exactly what was said, as it was said.' + coverageHintEn(durationSec);
}

/**
 * ASR 转写的中文任务文本（与 instructions 的英文格式纪律互补，双语结构与精读一致）。
 * 方舟 / 百炼两个适配器共用。durationSec > 0 时附带全片覆盖硬约束（具体 90% 时刻
 * 锚点 + 相邻间隔上限），帮模型把时间戳铺满全片——客户端的 transcriptEndSec 完整度
 * 校验与空窗守卫依赖这一点。纯函数，Node 可直接测试。
 */
export function buildTranscribeTaskText(durationSec = 0) {
  return '请逐字转写这段音频的语音内容：每句一行、每行行首加一个单一起始时刻时间戳 [mm:ss]（超过一小时用 [h:mm:ss]），时间戳永远是「分:秒」——禁止裸秒数（如 [62.0] 或 [62]），必须换算成 [01:02]；不要输出区间（如 [00:00-00:12]）也不要小数（如 [00:12.5]），括号内只放这一个起始时间；必须补全中文标点（，。！？），即使原音频没有明显停顿也要按语义断句，不要输出一整段没有标点的长句；行粒度：一行 = 一句完整的话或紧连的 1-3 个短句，不要把连续的碎片段各占一行；说话人标签规则：每一个独立人声都算一个说话人——主讲人/旁白、插播的采访或演讲录音、画外音、电话音、换了语言的其他人都算。只有一个人说话全程才不标；否则每一行都必须在时间戳后标注 [说话人N]（主讲人也不例外，无例外），编号从 1 开始按全片首次出现的声音顺序分配，同一个声音全片用同一个号，不能把两个人合并成一个号，也不能把一个人拆成两个号；说话人身份能从内容确认时（自我介绍、相互称呼），在该说话人第一行末尾括注姓名，并在消失约两分钟以上再次出现的第一行再次括注；两人同时说话（抢话）归给主导者，只有各自都有独立信息量时才拆成两行分别标注；绝对不要翻译、也不要「纠正」说话人的用词——说了什么就写什么。' + coverageHintZh(durationSec);
}
/**
 * 解析转写文本的时间轴为覆盖区间列表 [[startSec,endSec], ...]（未排序）。
 * 区间令牌 [a-b] 取 [a,b]；单时间戳与行首裸秒数取 [t,t]。
 * transcriptEndSec / largestTranscriptGapSec 共用本函数。
 */
function parseTranscriptTimeline(rawText) {
  if (!rawText) return [];
  // 形态：[mm:ss] | [mm:ss.mmm] | [h:mm:ss] | [mm:ss.mmm-mm:ss.mmm] | [h:mm:ss.mmm-h:mm:ss.mmm] |
  //       [mm:ss, mm:ss]（逗号/空白分隔——模型漂移真实案例 2026-08-24），(*) 可重复。
  const TS_RE = /\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?(?:(?:\s*[-,]\s*|\s+)(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?)*\]/g;
  // 裸秒数兜底：只认【行首】纯数字（可带小数，保留小数精度——不能复用归一化的
  // 截断版，边界 90% 校验会误判）。>12h 视为非时间戳。
  const BARE_RE = /^\[(\d{1,5})(?:\.(\d{1,3}))?\]/;
  const toSec = (h, m, s, frac) => {
    const mm = parseInt(m, 10);
    const ss = parseInt(s, 10);
    const hh = h ? parseInt(h, 10) : 0;
    const f = frac ? parseFloat('0.' + frac) : 0;
    return hh * 3600 + mm * 60 + ss + f;
  };
  const intervals = [];
  for (const line of String(rawText).split(/\r?\n/)) {
    TS_RE.lastIndex = 0;
    let m;
    let matched = false;
    while ((m = TS_RE.exec(line)) !== null) {
      matched = true;
      const hasRange = m[5] != null || m[6] != null || m[7] != null || m[8] != null;
      const a = toSec(m[1], m[2], m[3], m[4]);
      // 注意不能只判 m[5]（右端小时）：普通分钟级区间 [33:17.22-33:25.45] 的
      // 右端小时是空的。
      intervals.push(hasRange ? [a, toSec(m[5], m[6], m[7], m[8])] : [a, a]);
      if (m.index === TS_RE.lastIndex) TS_RE.lastIndex++; // 防止零宽匹配死循环
    }
    // 本行没有任何 mm:ss 令牌才尝试裸秒数（混合文档：语音行裸秒、标记行 mm:ss）。
    if (!matched) {
      const bare = BARE_RE.exec(line);
      if (bare) {
        const total = parseFloat(bare[1] + (bare[2] ? '.' + bare[2] : ''));
        if (total <= 43200) intervals.push([total, total]);
      }
    }
  }
  return intervals;
}

export function transcriptEndSec(rawText) {
  const intervals = parseTranscriptTimeline(rawText);
  let maxEnd = null;
  for (const [, b] of intervals) {
    if (maxEnd == null || b > maxEnd) maxEnd = b;
  }
  return maxEnd;
}

/** 空窗判定阈值（秒）：相邻时间戳间隔超过它视为产物有整段缺失。 */
export const TRANSCRIPT_GAP_LIMIT_SEC = 300;
/**
 * 找转写时间轴上最大的相邻空窗。2026-08-30 真实故障：81 分钟视频的精读只覆盖
 * 0-16 分钟 + 49:27 前后 + 片尾——「最后一个时间戳 ≥ 90% 时长」的守卫对中间
 * 空洞完全无感（last stamp 过线 → 静默存了缺 1 小时的产物）。
 * 覆盖区间先合并（区间的内部跨度不是空窗——[00:00-05:00] 自身 5 分钟是覆盖），
 * 再取合并后相邻区间的最大间隔。返回 { fromSec, toSec, gapSec } 或 null。
 */
export function largestTranscriptGapSec(rawText) {
  const intervals = parseTranscriptTimeline(rawText).slice().sort((a, b) => a[0] - b[0]);
  let worst = null;
  let curEnd = null;
  for (const [a, b] of intervals) {
    if (curEnd == null || a > curEnd) {
      // 与已合并覆盖区之间出现空隙
      if (curEnd != null) {
        const gapSec = a - curEnd;
        if (!worst || gapSec > worst.gapSec) worst = { fromSec: curEnd, toSec: a, gapSec };
      }
      curEnd = b;
    } else if (b > curEnd) {
      curEnd = b; // 重叠/相接 → 延伸覆盖
    }
  }
  return worst;
}

// ===================== 视频解析（视听精读） =====================
//
// 音频 ASR 之上的高级模式：B站 DASH 的视频流（无声）与音频流分别下载、分别上传
// 到方舟 Files API，然后用 Responses API 在【同一个请求】里以 input_video +
// input_audio 两个 content part 引用（两条输入共享同一条时间线，都从 0:00 开始），
// 让多模态模型融合画面与语音，产出带 [mm:ss] 时间戳的「视听精读」文档。下游与
// 字幕 ASR 完全同构（同一抽屉/搜索/记一笔/主 LLM 总结），唯一区别是产物的生产者。
// ※ input_video + input_audio 组合是设计推演路线，尚待实机验证：页面带 durl 合一
//   流（音画合一）时走单文件（input_video only，原生音轨最稳）；否则走双文件组合，
//   若方舟拒绝该组合，错误原样抛给调用方，用户退回音频模式即可。
// ※ 纯音频 m4s 会被方舟按内容判成视频（ASR 的真实教训）；反过来视频流被判成视频
//   正是我们要的，音频流转码成 WAV 后按内容判成音频，两条上传互不干扰。

/** 方舟 Files API 上传硬上限 512MB，选流预算留出余量。 */

/** 秒 → [mm:ss]/[h:mm:ss] 形态（报错文案用）。 */
export function formatStampSec(totalSec) {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return (h > 0 ? `${h}:` : '') + `${mm}:${ss}`;
}

/**
 * 全片覆盖硬约束（纯函数，Node 可直接测试；En/zh 各一条，分别进 instructions
 * 与中文任务文本）。youtube-digest 章节 prompt 的 lateThreshold 思路：模糊的
 * 「覆盖到结尾」模型会当耳旁风，给出具体时刻锚点（约 90% 处）+ 相邻间隔上限
 * 才拦得住「写完前半段就收工」。阈值与客户端守卫同源（90% 完整度 +
 * TRANSCRIPT_GAP_LIMIT_SEC 空窗）——prompt 预防、客户端兜底，双保险。
 * durationSec 无效时返回空串（时长未知则无锚点可给，退回原软性措辞）。
 */
export function coverageHintEn(durationSec) {
  if (!durationSec || durationSec <= 0) return '';
  const lateTs = formatStampSec(durationSec * 0.9);
  return ` COVERAGE REQUIREMENT: the recording is about ${Math.round(durationSec / 60)} minutes long — ` +
    `the LAST line's timecode MUST be at or after [${lateTs}] (about 90% of the total length). ` +
    'Keep producing lines all the way to the end; never stop early, and never let consecutive timestamps jump more than about 5 minutes. ';
}

export function coverageHintZh(durationSec) {
  if (!durationSec || durationSec <= 0) return '';
  const lateTs = formatStampSec(durationSec * 0.9);
  return `视频总长约 ${Math.round(durationSec / 60)} 分钟，时间戳必须铺满全片：最后一行的时间戳不得早于 [${lateTs}]（约全片 90% 处），` +
    '相邻时间戳的间隔不要超过约 5 分钟——必须覆盖到结尾。';
}
/**
 * 精读 instructions（英文格式纪律——时间戳/说话人/标点规则与 transcribeAudio
 * 同一套，保证产物能被 formatAsrTranscript / transcriptEndSec / 字幕抽屉直接消费）。
 * durationSec > 0 时追加全片覆盖硬约束（见 coverageHintEn）。纯函数，Node 可直接测试。
 */
export function buildVideoAnalysisInstructions(language = 'zh', durationSec = 0) {
  const langHint = language && language !== 'auto'
    ? `The audio language is ${language}; write the document in that language.`
    : 'The audio language is unknown; auto-detect it and write the document in the same language.';
  return 'You are producing a timestamped AUDIOVISUAL READING document (视听精读) for a video. ' +
    'The video track and the audio track arrive as TWO separate inputs sharing the SAME timeline (both start at 0:00); fuse them — ' +
    'the audio carries speech, the video carries on-screen text, slides, code, terminal output, charts, UI demonstrations and scene changes. ' +
    'Output ONLY document lines, each starting with EXACTLY one bracket containing the single start timecode "[mm:ss]" ' +
    '(use "[h:mm:ss]" over an hour) followed by the content — e.g. "[00:12] 你好". ' +
    'Timecodes are always MINUTES:SECONDS — raw seconds like "[62.0]" or "[62]" are FORBIDDEN, convert them to "[01:02]". ' +
    'NEVER output duration ranges like "[00:00-00:12]" and never add decimals like "[00:12.5]" — ' +
    'one plain start timestamp per line, nothing else inside the brackets. ' +
    'For each segment: (1) faithfully transcribe or tightly condense the SPOKEN content — technical terms, names and numbers must be exact; ' +
    '(2) when the visuals carry information beyond the speech (on-screen text, slide titles, code, terminal output, diagrams, demonstrated actions), ' +
    'transcribe or describe it in a 「画面：」 line right after the speech line it belongs to; ' +
    'SCREEN TEXT INTEGRITY: in 「画面：」 lines transcribe ONLY text, code and numbers actually legible in the frame — ' +
    'never guess, complete or invent partially-visible content; when unclear, describe it generically instead. ' +
    'It is better to write fewer unconfirmable details than to hallucinate; ' +
    '(3) a purely visual segment with no speech gets its own line starting with 「画面：」. ' +
    'AD READS: when a segment is clearly a paid placement (a sponsored pitch interrupting the content), do NOT transcribe it verbatim — ' +
    'compress it into ONE line "[mm:ss] （广告：品牌+核心卖点）" and never place a keyframe marker inside it; ' +
    'content that merely discusses a product as part of the topic is NOT an ad. ' +
    'KEYFRAME SCREENSHOT MARKERS — KEY visuals ONLY: the transcript already carries the content; a marker is ONLY for a visual the argument DEPENDS on seeing ' +
    '(a data chart or figure being discussed, a slide or on-screen text with real information, code or terminal output, a key piece of evidence such as a document or note). ' +
    'A 15-20 minute video typically warrants around 6-10; scale with length. ' +
    'Do NOT capture title cards, section transitions, ending/thank-you cards, decorative cartoons, memes, or scene filler — and never capture the same visual twice (once, at its clearest appearance). ' +
    'Each marker is ONE line of its own immediately AFTER that 「画面：」 line: "[mm:ss] [截屏] 短标题" — the same timestamp as that moment, followed by a short noun-phrase title. ' +
    'At least 10 seconds apart; markers are additional lines, never replacements. ' +
    'Markers are additional lines, never replacements. ' +
    'PUNCTUATION IS MANDATORY: complete, readable sentences. ' +
    'LINE GRANULARITY: one line = one complete sentence or a tight run of 1-3 short sentences — typically 5-20 seconds of speech. ' +
    'Do NOT emit one line per short ASR/breath segment: consecutive fragments of the same sentence MUST be merged into a single line ' +
    'that starts at that sentence\'s first timestamp. ' +
    'SPEAKER LABELS (deterministic rules): count EVERY distinct human voice as a speaker — the host/narrator, an embedded or quoted recording ' +
    '(a played interview, speech or phone call), a voiceover, or a different person even when the language switches. ' +
    'If the ENTIRE audio has only ONE such voice, output NO labels at all. ' +
    'Otherwise label EVERY line EXACTLY: each line starts with ' +
    '"[mm:ss] [说话人N] text" (the label sits right after the timecode, with NO exception — this includes ' +
    'the main narrator/host, whose lines must also carry their own label). ' +
    'Numbers start at 1 for the first voice that appears and are assigned in order of first appearance ' +
    'across the ENTIRE video; the same voice must keep the same number everywhere. ' +
    'Never merge two people into one number and never split one person into two. ' +
    'DIARIZE WITH THE VISUAL CHANNEL (this is a video — use it): in interviews and podcasts the camera usually frames whoever is speaking, ' +
    'so the on-screen active speaker is the STRONGEST attribution signal — stronger than acoustic similarity. As each voice appears, bind its number ' +
    'to the on-screen identity: a lower-third name card, a self-introduction, or an unmistakable public figure. When two voices sound alike, ' +
    'disambiguate with the visual evidence and conversational context; never flip-flop a speaker\'s number mid-video. ' +
    'When a speaker\'s identity is evident from the video (a name card, an on-screen caption, a self-introduction, an unmistakable public figure), ' +
    'append the name in parentheses at the end of that speaker\'s FIRST line — e.g. "……（特朗普）" — and AGAIN at their first line after every absence ' +
    'of about two minutes or longer, so long documents stay readable. ' +
    'LABEL WITH REAL NAMES when the identity is confirmed — evidence hierarchy: on-screen name card > self-introduction > how others address them > the video\'s title/description metadata. Use "[说话人:英博博士]" form: the most common appellation, IDENTICAL everywhere for the same person, at most 8 characters. Fall back to "[说话人N]" ONLY when the identity is genuinely unknown; both forms may coexist (numbered speakers keep the numbering rules above). ' +
    'Overlapping speech (crosstalk): attribute the line to the dominant voice; split into two separately-labelled lines only when both voices carry distinct, content-worthy statements. ' +
    'Preserve chronological order and cover the video from start to finish INCLUDING the ending. ' +
    'No summary, no preamble, no markdown fences, no numbering. ' + coverageHintEn(durationSec) + langHint;
}

/**
 * 精读任务的中文 input_text（与 instructions 的英文格式纪律互补，跟
 * transcribeAudio 的双语结构一致）。durationSec > 0 时附带全片覆盖硬约束
 * （具体 90% 时刻锚点 + 相邻间隔上限），帮模型把时间戳铺满全片——客户端的
 * transcriptEndSec 完整度校验与空窗守卫依赖这一点。
 */
export function buildVideoAnalysisTaskText(durationSec = 0, language = 'zh', metaHint = '') {
  const durHint = coverageHintZh(durationSec);
  const meta = metaHint ? `视频元信息（用于识别说话人姓名与职务，仅供参考，不要原样写进正文）：${metaHint}。` : '';
  return '请结合画面与声音，逐段产出这份视频的「视听精读」文档：语音内容忠实转写（术语、人名、数字必须准确）；' +
    '画面里超出语音的独立信息（屏幕文字、幻灯片标题、代码、终端输出、图表、演示操作）用「画面：」单独成行转写或描述；' +
    '「画面：」行只转写画面上真实可辨认的文字/代码/数字——看不清、看不全就概括描述，绝不猜测或脑补；宁可少写无法确认的细节，也不要幻觉；' +
    '纯画面无语音的段落也单独一行以「画面：」开头。' +
    '广告口播：遇到明显的商单/广告口播段落，不要逐字转写，压缩成一行 `[mm:ss] （广告：品牌+核心卖点）`，并且不要在广告段内输出截图标记；只是客观介绍产品的不算广告。' +
    '关键帧截图标记——只截【关键】画面：转写已承载内容，只有当论证依赖看到该画面时才标记（正在讲解的数据图表、有独立信息的幻灯片或屏幕文字、代码或终端输出、文件便签等关键证据）。' +
    '15-20 分钟的视频通常 6-10 处即可，更长视频相应增加。' +
    '不要截：标题卡、章节转场、片尾致谢卡、装饰性卡通或表情包、与讲解无关的空镜——同一画面只截一次，选它最清晰的那次出现。' +
    '紧随「画面：」行单独加一行 `[mm:ss] [截屏] 短标题`（时间与该画面一致，标题用简短名词短语）；彼此至少间隔 10 秒。' +
    '每行行首加一个单一起始时刻时间戳 [mm:ss]（超过一小时用 [h:mm:ss]），括号内只放这一个起始时间，不要区间也不要小数；' +
    '时间戳永远是「分:秒」——禁止裸秒数（如 [62.0] 或 [62]），必须换算成 [01:02]。' +
    '必须补全标点。行粒度：一行 = 一句完整的话或紧连的 1-3 个短句（通常对应 5-20 秒语音）；' +
    '不要把连续的碎片段各占一行——同一句话的连续片段必须合并成一行，时间戳用这句话开头的时刻。说话人标签规则：每一个独立人声都算一个说话人——主讲人/旁白、插播的采访或演讲录音、画外音、电话音、换了语言的其他人都算；' +
    '只有一个人说话全程才不标，否则每一行都在时间戳后标注 [说话人N]（主讲人也不例外），' +
    '编号按全片首次出现的顺序从 1 开始分配，同一个声音全片用同一个号，不能合并也不能拆分。' +
    '用画面辅助分辨说话人（这是视频）：访谈/播客类镜头通常正对着正在说话的人——画面中的当前发言者是最强的归属信号，强于听声音相似度；' +
    '每个声音一出现就把编号绑定到画面身份（姓名条、自我介绍、公众人物），两个声音听感相似时用画面与上下文消歧，绝不在中途调换编号。' +
    '标签优先用真实名字：当能从画面姓名条、自我介绍、他人称呼或视频简介确认身份时，用 `[说话人:英博博士]` 形态（取最常用的称呼，全片同一人必须同一写法，最长 8 字）；身份确实未知才用 `[说话人N]`，两种形态可混用。' +
    '说话人身份能从画面确认时（姓名条、字幕条、自我介绍、公众人物），在该说话人第一行末尾括注姓名或职务（如「……（特朗普）」「……（艾博生物CEO）」），' +
    '并在该说话人消失约两分钟以上再次出现的第一行再次括注——长文档才不会读着读着忘了谁是谁；' +
    '两人同时说话（抢话）归给主导者，只有各自都有独立信息量时才拆成两行分别标注。' + durHint + meta +
    '从开头覆盖到结尾，不要总结、不要开场白、不要代码块围栏。';
}
