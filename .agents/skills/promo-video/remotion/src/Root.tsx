import React, { useEffect, useState } from 'react';
import { Composition, continueRender, delayRender, staticFile } from 'remotion';
import { Promo, Timeline } from './Promo';

export const INTRO_FRAMES = 60; // 2.5s 片头品牌卡
export const TAIL_FRAMES = 100; // 4.2s 片尾卡（板淡出后仍继续）

const useTimeline = () => {
  const [tl, setTl] = useState<Timeline | null>(null);
  const [handle] = useState(() => delayRender('load timeline.json'));
  useEffect(() => {
    fetch(staticFile('timeline.json'))
      .then((r) => r.json())
      .then((j: Timeline) => {
        setTl(j);
        continueRender(handle);
      })
      .catch((e) => {
        continueRender(handle);
        throw e;
      });
  }, [handle]);
  return tl;
};

export const RemotionRoot: React.FC = () => {
  const tl = useTimeline();
  if (!tl) return null;
  const total = INTRO_FRAMES + tl.totalFrames + TAIL_FRAMES;

  return (
    <>
      <Composition
        id="promo"
        component={Promo}
        durationInFrames={total}
        fps={tl.fps}
        width={tl.width}
        height={tl.height}
        defaultProps={{ timeline: tl, introFrames: INTRO_FRAMES, tailFrames: TAIL_FRAMES }}
      />
      {/* GIF 源变体：无 ken-burns 漂移（逐帧全局移动会让 GIF 差分压缩失效） */}
      <Composition
        id="promosrc"
        component={Promo}
        durationInFrames={total}
        fps={tl.fps}
        width={tl.width}
        height={tl.height}
        defaultProps={{ timeline: tl, introFrames: INTRO_FRAMES, tailFrames: TAIL_FRAMES, driftEnd: 0 }}
      />
    </>
  );
};
