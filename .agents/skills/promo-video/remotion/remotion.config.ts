import { Config } from '@remotion/cli/config';

// 2-CPU/4GB VPS：并发 2（两个 chrome 工作进程 ~1.2GB，OOM 就降到 1）
Config.setConcurrency(2);
Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
if (process.env.PROMO_PUBLIC) {
  // 帧序列 + timeline.json 都在 $TMPDIR/browsa-promo，直接当 public 目录，免拷 1.4GB
  Config.setPublicDir(process.env.PROMO_PUBLIC);
}
// 复用 playwright 缓存的 chrome-headless-shell，免另下 150MB
Config.setBrowserExecutable(
  process.env.PROMO_REMOTION_CHROME ||
    '/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell'
);
