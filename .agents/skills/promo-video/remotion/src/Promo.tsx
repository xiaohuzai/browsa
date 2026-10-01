import React from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export type CaptionEvent = { start: number; dur: number; zh: string; en: string };
export type SceneMark = { id: string; start: number };
export type Timeline = {
  fps: number;
  width: number;
  height: number;
  totalFrames: number;
  captions: CaptionEvent[];
  scenes: SceneMark[];
};

export type PromoProps = {
  timeline: Timeline;
  introFrames: number;
  tailFrames: number;
  /** 片尾漂移终值（ken-burns）；GIF 源变体传 0——逐帧全局移动会打爆 GIF 差分压缩 */
  driftEnd?: number;
};

const pad = (f: number) => String(f).padStart(5, '0');

const GlobalStyle: React.FC = () => (
  <style>{`
    @font-face { font-family: 'Noto Sans SC'; font-weight: 400; src: url(${staticFile('fonts/noto-sans-sc-chinese-simplified-400-normal.woff2')}) format('woff2'); }
    @font-face { font-family: 'Noto Sans SC'; font-weight: 500; src: url(${staticFile('fonts/noto-sans-sc-chinese-simplified-500-normal.woff2')}) format('woff2'); }
    @font-face { font-family: 'Noto Sans SC'; font-weight: 700; src: url(${staticFile('fonts/noto-sans-sc-chinese-simplified-700-normal.woff2')}) format('woff2'); }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Noto Sans SC', sans-serif; background: #0b0e13; }
    .hl { background: linear-gradient(100deg, #9cc3ff 10%, #5a9bff 90%); -webkit-background-clip: text; background-clip: text; color: transparent; }
  `}</style>
);

// 背景：缓慢游移的辉光渐变（逐帧计算，保证渲染确定性）
const Backdrop: React.FC<{ durationInFrames: number }> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const t = (frame / durationInFrames) * Math.PI * 2;
  const x1 = 24 + Math.sin(t * 0.7) * 6;
  const x2 = 82 + Math.cos(t * 0.5) * 6;
  return (
    <AbsoluteFill
      style={{
        background: `
          radial-gradient(900px 520px at ${x1}% 0%, rgba(76,141,255,.13), transparent 60%),
          radial-gradient(820px 560px at ${x2}% 100%, rgba(251,114,153,.08), transparent 60%),
          linear-gradient(160deg, #10151c 0%, #0b0e13 55%, #0d1117 100%)`,
      }}
    />
  );
};

// 内容板：真机帧序列 + 全程缓慢推近（ken-burns）+ 入场淡入 + 片尾压暗
const Plate: React.FC<{ timeline: Timeline; plateStart: number; plateEnd: number; driftEnd: number }> = ({
  timeline,
  plateStart,
  plateEnd,
  driftEnd,
}) => {
  const frame = useCurrentFrame();
  if (frame < plateStart || frame >= plateEnd) return null;
  const local = frame - plateStart;
  const drift = interpolate(frame, [plateStart, plateEnd], [1.0, 1 + driftEnd]);
  const fadeIn = interpolate(frame, [plateStart, plateStart + 8], [0.25, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const dim = interpolate(frame, [plateEnd - 22, plateEnd + 10], [1, 0.14], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{ opacity: fadeIn * dim }}>
      <div style={{ transform: `scale(${drift})`, transformOrigin: '50% 42%', width: '100%', height: '100%' }}>
        <Img
          src={staticFile(`frames/f${pad(local)}.png`)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </div>
    </AbsoluteFill>
  );
};

// 动效字幕：弹性上浮入场 + 尾段淡出；结束帧钳到下一条字幕开始，绝不叠字
const Caption: React.FC<{
  c: CaptionEvent;
  absStart: number;
  absEnd: number;
}> = ({ c, absStart, absEnd }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < absStart || frame >= absEnd) return null;
  const s = spring({ frame: frame - absStart, fps, config: { damping: 20, stiffness: 170, mass: 0.9 } });
  const out = interpolate(frame, [absEnd - 9, absEnd - 1], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const opacity = Math.min(s, out);
  const y = interpolate(s, [0, 1], [30, 0]);
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', pointerEvents: 'none' }}>
      <div
        style={{
          marginBottom: 34,
          transform: `translateY(${y}px) scale(${0.965 + s * 0.035})`,
          opacity,
          textAlign: 'center',
          textShadow: '0 2px 26px rgba(0,0,0,.85), 0 1px 6px rgba(0,0,0,.6)',
        }}
      >
        <div style={{ fontSize: 42, fontWeight: 700, color: '#eef3f8', letterSpacing: 1.5, lineHeight: 1.25, whiteSpace: 'nowrap' }}>
          <span dangerouslySetInnerHTML={{ __html: c.zh }} />
        </div>
        <div style={{ fontSize: 21, fontWeight: 400, color: '#a7b6c6', letterSpacing: 0.4, marginTop: 7, whiteSpace: 'nowrap' }}>
          <span dangerouslySetInnerHTML={{ __html: c.en }} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

// 片头品牌卡：字标弹入 + 强调线展开 + 双语定位句
const Intro: React.FC<{ introFrames: number }> = ({ introFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s1 = spring({ frame, fps, config: { damping: 17, stiffness: 150 } });
  const s2 = spring({ frame: frame - 8, fps, config: { damping: 20, stiffness: 130 } });
  const s3 = spring({ frame: frame - 15, fps, config: { damping: 20, stiffness: 120 } });
  const out = interpolate(frame, [introFrames - 10, introFrames - 1], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  if (frame >= introFrames) return null;
  const lineW = interpolate(Math.min(Math.max(frame - 5, 0), 24), [0, 24], [0, 190]);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: out }}>
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            fontSize: 132,
            fontWeight: 700,
            letterSpacing: -2,
            lineHeight: 1,
            transform: `scale(${0.9 + s1 * 0.1})`,
            opacity: s1,
            background: 'linear-gradient(100deg, #eaf1fa 30%, #6ea8ff 75%, #4c8dff)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
          }}
        >
          browsa
        </div>
        <div style={{ width: lineW, height: 3, borderRadius: 2, margin: '26px auto 0', background: 'linear-gradient(90deg, transparent, #5a9bff, transparent)' }} />
        <div style={{ marginTop: 30, fontSize: 33, fontWeight: 500, color: '#d7e0ea', letterSpacing: 3, opacity: s2, transform: `translateY(${(1 - s2) * 14}px)` }}>
          把正在看的网页、视频、PDF，带进对话
        </div>
        <div style={{ marginTop: 11, fontSize: 19, fontWeight: 400, color: '#a7b6c6', letterSpacing: 0.4, opacity: s3 }}>
          Bring the pages, videos &amp; PDFs you're reading into the conversation
        </div>
      </div>
    </AbsoluteFill>
  );
};

// 片尾卡：板压暗后品牌 + 双语定位 + 商店 CTA，逐行弹性入场
const Outro: React.FC<{ plateEnd: number; tailFrames: number }> = ({ plateEnd, tailFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rel = frame - (plateEnd - 6);
  if (rel < 0) return null;
  const s = (off: number) => spring({ frame: rel - off, fps, config: { damping: 18, stiffness: 140 } });
  const s0 = s(0);
  const s1 = s(7);
  const s2 = s(13);
  const s3 = s(19);
  const s4 = s(27);
  const globalOut = interpolate(frame, [plateEnd + tailFrames - 12, plateEnd + tailFrames - 1], [1, 0.75], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: globalOut }}>
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            fontSize: 104,
            fontWeight: 700,
            letterSpacing: -1,
            lineHeight: 1,
            opacity: s0,
            transform: `scale(${0.94 + s0 * 0.06})`,
            background: 'linear-gradient(100deg, #eaf1fa 30%, #6ea8ff 75%, #4c8dff)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
          }}
        >
          browsa
        </div>
        <div style={{ marginTop: 28, fontSize: 32, fontWeight: 500, color: '#d7e0ea', letterSpacing: 2, opacity: s1, transform: `translateY(${(1 - s1) * 12}px)` }}>
          读到哪，问到哪。
        </div>
        <div style={{ marginTop: 10, fontSize: 19, fontWeight: 400, color: '#a7b6c6', opacity: s2 }}>
          Ask right where you read.
        </div>
        <div style={{ marginTop: 22, fontSize: 18, color: '#8b97a5', letterSpacing: 1, opacity: s3 }}>
          Chrome / Edge 侧边栏 · 接你自己的模型与 Agent
          <span style={{ display: 'block', fontSize: 14, color: '#718091', marginTop: 6 }}>Chrome / Edge side panel · your own models &amp; agents</span>
        </div>
        <div
          style={{
            marginTop: 40,
            display: 'inline-block',
            fontSize: 20,
            color: '#cfe0ff',
            background: 'rgba(76,141,255,.14)',
            border: '1px solid rgba(108,160,255,.42)',
            padding: '13px 30px',
            borderRadius: 999,
            letterSpacing: 0.6,
            opacity: s4,
            transform: `translateY(${(1 - s4) * 10}px)`,
          }}
        >
          Chrome Web Store → 搜索 / search browsa
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const Promo: React.FC<PromoProps> = ({ timeline, introFrames, tailFrames, driftEnd = 0.038 }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const plateStart = introFrames;
  const plateEnd = introFrames + timeline.totalFrames;
  // 每条字幕的有效区间：[start, min(start+dur, 下一条 start, 板结束))——绝不相叠
  const spans = timeline.captions.map((c, i) => {
    const absStart = plateStart + c.start;
    const nextStart = i + 1 < timeline.captions.length ? plateStart + timeline.captions[i + 1].start : plateEnd;
    return { c, absStart, absEnd: Math.min(absStart + c.dur, nextStart, plateEnd) };
  });
  return (
    <AbsoluteFill style={{ background: '#0b0e13' }}>
      <GlobalStyle />
      <Backdrop durationInFrames={durationInFrames} />
      <Plate timeline={timeline} plateStart={plateStart} plateEnd={plateEnd} driftEnd={driftEnd} />
      {spans.map(({ c, absStart, absEnd }, i) => (
        <Caption key={i} c={c} absStart={absStart} absEnd={absEnd} />
      ))}
      <Outro plateEnd={plateEnd} tailFrames={tailFrames} />
      <Intro introFrames={introFrames} />
    </AbsoluteFill>
  );
};
