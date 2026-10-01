# v7 制作与验收

本页是 2026-10-01 已交付流程的可执行基线。后续产品迭代先按 [maintenance.md](maintenance.md) 判断是否需要更新媒体，再对需要更新的部分执行本页流程；保留视频/GIF 时无需采集或渲染。核对当前源码、素材与时轴；用户新决定优先于此处的旧参数。

## 文件与权威来源

所有命令从 browsa 仓库根运行。`scripts/`、`video-v7/` 以下均指 `.agents/skills/promo-video/` 内目录。

| 输入/输出 | 职责 |
| --- | --- |
| scripts/copy-v7.json → video-v7/src/copy.json | 七语页面数据、提问/回答、chapterCards、inkTitles、slogan；修改时同步两份 |
| scripts/growth-copy7.json → video-v7/src/growth-copy.json | 单场景获客片文案，两份同步 |
| scripts/browser-v7.html + scripts/server.mjs | 原创文章/访谈、浏览器构图、真实前端与演示传输层，服务端口 8957 |
| video-v7/src/timeline.ts | 主片 SHOTS、beatF、TOTAL、TRANSITION、SFX 的唯一权威 |
| video-v7/src/Main.tsx / PageCam.tsx | 合成与运镜；截图状态切换、点击光标、原生渲染与 DEMO CLI |
| store-assets/promo/v7/assets/<lang>/ | 基础页面/渲染/拷贝与时间线/会话采集，capture.json、capture-workflow.json 含动作与 DOM 边界 |
| store-assets/promo/v7/conversation/<lang>/ | 追问、Agent 切换、BYOK 截图；capture.json 含当前边界及 backfill 证据 |
| store-assets/promo/native-live/actual-history.json | 已认可的真实 Codex 公式与彩色 DOT 回答，避免重新请求模型 |
| store-assets/promo/v7/native/<lang>/ | 已加载真实扩展的完整侧栏、PNG 导出、capture.json、回答文本 |
| video-v7/public/textures/<lang>/ | 冻结后的最终纹理；渲染中不得改动 |
| video-v7/src/bounds.json / conversation.json | 点击/裁切用的采集边界；重摄的画面从新 capture 更新对应边界，保留画面沿用原边界 |
| video-v7/public/audio/ + ATTRIBUTION.md | Cat Walk、click-fixed 音源及出处；保留许可证信息 |
| docs/assets/promo/ + docs/assets/readme/ | 分发 MP4、海报与 GIF |
| store-assets/promo/v7/growth/ | 本地待投放三类短片；不是自动发布目录 |

`store-assets/` 被 gitignore；跨机器交接时保留/迁移冻结截图、真实回答、采集报告、音频与原生测试 profile。缺少这些输入先恢复，不生成看似相同的假证明。当前 node_modules 可能软链 video-v5，不能删除旧工程依赖后直接渲染。

## 当前节奏与四章边界

主片 148 拍，2049 帧，1080p30，68.3 秒。Cat Walk 实测约 130 BPM，BEAT_INT=0.4615385705334432 秒；按 `beatF(n)` 四舍五入到帧。下表是定位用基线，执行前读 timeline.ts，别把本表当另一份时轴。

| 拍号 | 镜头 |
| --- | --- |
| 0–20 | 品牌/插件身份 → 自己的 LLM API / 本地 Agent（BYOK） |
| 20–24 / 24–46 | 第一章卡 → 附加文章、问答、原生选中追问 |
| 46–66 | 注意力公式、Mermaid QKV、Graphviz 详细编码器；蛋白质/化学各约 0.92 秒 |
| 66–70 / 70–90 | 第二章卡 → 科技访谈要点、07:42 点击回原片 |
| 90–94 / 94–108 | 第三章卡 → Codex/Claude 选择、显式携带上下文、继续回答 |
| 108–112 / 112–130 | 第四章卡 → 消息拷贝/PNG 下载、会话保存与恢复 |
| 130–140 / 140–148 | Agent 端同一会话续接（Codex 例子，DEMO）→ 原有 slogan/入口 |

相机锚点在相邻镜头承接，光标动作前出现、动作后消失。快慢按实际可读时间调整，不把镜头卡动作生硬堆成全片。当前借用了 Ink Press 字标入场、纸墨章卡、结尾截图合影及 line-carry 的部分语法；具体映射见 store-assets/promo/v7/shot-map.md。它是改编，不能声称完整复刻 Gallery 变体。选新镜头卡时使用 video-shotcraft 的准确索引/实现/样片。

## 环境检查

需要 Node、ffmpeg/ffprobe、Python；采集依赖 playwright-core 和字体，合成依赖锁定的 Remotion 4.0.372。NumPy/SciPy 用于音频分析，Pillow 用于工作台像素对比。缺依赖按本机运行时安装/使用隔离环境，勿为了更新素材升级 Remotion。

```bash
npm ci --prefix .agents/skills/promo-video/scripts --no-audit --no-fund
npm ci --prefix .agents/skills/promo-video/video-v7 --no-audit --no-fund
node dev-preview/gen.mjs
node .agents/skills/promo-video/scripts/server.mjs
```

服务器作为独立持续会话保留；已在运行时复用，别另起同端口。通用采集脚本目前使用 macOS 系统 Chrome 绝对路径，真实扩展脚本使用 Chrome for Testing 路径和专用 `native-live/chrome-profile`；换机器先核对并适配脚本，不宣称设置 PROMO_CHROME 会覆盖所有 v7 脚本。服务支持 PROMO_PORT，但采集脚本多处写死 8957，改端口须一起改。

真实扩展应加载当前仓库且有权限渲染/下载；仅使用专用演示 profile。文档/蛋白质资源固定本地，模型内容不重新随机生成。确认七语字体/字典成功加载后再拍。

## 全量采集与冻结顺序

在另一终端执行。所有七语采集完成再冻结；不要采集与渲染同时写 public。

```bash
node .agents/skills/promo-video/scripts/capture7.mjs zh en ja ko es pt-BR ru
node .agents/skills/promo-video/scripts/capture-workflow7.mjs zh en ja ko es pt-BR ru
node .agents/skills/promo-video/scripts/capture-native-final7.mjs zh en ja ko es pt-BR ru
node .agents/skills/promo-video/video-v7/prepare-assets.mjs
node .agents/skills/promo-video/scripts/capture-conversation-final7.mjs zh en ja ko es pt-BR ru
```

顺序有实际依赖：

1. capture7 负责原生基础问答/渲染/复制；capture-workflow7 负责访谈 seek、会话、ID。
2. capture-native-final7 复用 actual-history，不发起新模型请求；输出实际扩展的公式、DOT、下载截图。
3. **当前 prepare-assets 已自动 import prepare-native**。它先拷贝基础 assets，再覆盖最终原生公式/DOT，需七语 native 都已存在。不要先 prepare 再拍 native；若旧版 prepare 没有此 import，显式在其后执行 prepare-native。
4. **capture-conversation-final7 放在 prepare-assets 后**：它拍摄并直接拷贝 BYOK、追问、Codex→Claude 的最终截图到 public。重跑 prepare-assets 会以旧基础图覆盖同名纹理；这时须再运行 conversation 采集并更新其边界。

capture-conversation-final7 当前不会写 `src/conversation.json`，必须显式汇总新采集报告；只更新 PNG 会让光标仍用旧 UI 坐标：

```bash
node --input-type=module <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const base='.agents/skills/promo-video/video-v7';
const copy=JSON.parse(readFileSync(`${base}/src/copy.json`,'utf8'));
const reports={};
for(const lang of Object.keys(copy)){
  const report=JSON.parse(readFileSync(`store-assets/promo/v7/conversation/${lang}/capture.json`,'utf8'));
  if(report.errors.length||!report.agentRequest.backfill||!report.secondAgentRequest.backfill)
    throw Error(`Conversation verification failed: ${lang}`);
  reports[lang]=report;
}
writeFileSync(`${base}/src/conversation.json`,JSON.stringify(reports,null,2)+'\n');
JS
```

检查截图里按钮和完整回答可见，不只检查 DOM 包含文本。采集失败按具体 selector/字典/裁切原因修复，再重拍该段；不放行带错误/空画面的采集。

## 音频与渲染

当前音乐从原曲 17.99941120616214 秒起，裁到 148 拍；它是源相位，不能拿来补偿输出音轨偏移。音乐 −18 LUFS / −3 dBTP 预处理，短淡入/尾部淡出；混音 music=.72、click=.65，点击 8 帧，在 `beatF(n)-1` 开始。事件由 timeline.ts 声明。

`build-audio.mjs` 直接混音，不需要为音频渲染 2049 张图片。click 源为 44.1kHz，**必须先 aresample=48000，再按 48kHz 采样 adelay**；直接套延迟曾让片子后段音画漂移。源文件/时轴/SFX 变化时重建两个 shared.wav；并行渲染前只建一次。

```bash
node .agents/skills/promo-video/video-v7/build-audio.mjs
BROWSA_QA_FRAMES=210,525,621,920,1260,1400,1520,1750 node .agents/skills/promo-video/video-v7/render.mjs --stills zh en ja ko es pt-BR ru
node .agents/skills/promo-video/video-v7/render.mjs zh en ja ko es pt-BR ru
```

先看每章关键静帧和短动作，再全量渲染。render.mjs 输出音乐版、SFX-only、海报和 GIF。主片已配置 `--concurrency=2 --gl=swiftshader`；别直接用 remotion.config.ts 的旧 concurrency=4 跑最终主片。若分语言开多个渲染进程，BROWSA_RENDER_PORT 必须不同，并先冻结素材和音频；内存不足降低总并行量。软件 GL 仍不能替代全片空帧扫描。

当前输出：

- `docs/assets/promo/browsa-promo-v7-<slug>.mp4` / `-nobgm.mp4`
- `docs/assets/promo/poster-v7-<slug>.jpg`（4.3 秒取帧）
- `docs/assets/readme/demo-v16-<slug>.gif`（32.4 秒、720px、10fps）

内容改变需更新 GIF 版本名和脚本输出，再同步引用。新视频版本应同步脚本路径、copy、public、验证规格与交付索引，不能只改文件名。

## 三条获客短片（按需更新）

完整片介绍产品，短片各自展示一个结果：读技术文档并追问、访谈时间点核对、回到 Agent 续接。tech/agent 各 720 帧/24 秒，podcast 498 帧/16.6 秒。不是机械裁同一段。

GrowthClips 使用当前主片纹理，并另读取 `public/textures/live` 中文真实回答/续接证据。中文真实模型请求不是默认重拍步骤：`capture-growth-live.mjs` 会调用当地 Bridge；已经认可的回答与 ID 优先保留。若 UI 变化需要重摄，读取既有 `growth-live/capture-live.json` 和 verified-resume.json，沿用其回复/ID重新驱动原生 UI，不覆盖它们的模型证明或用新请求冒充旧会话。

中文 Tech 的 attached/typed/answer/followup 没有独立的冻结重播脚本。未来 UI 重摄时以 `capture-growth-live.mjs` 为交互参考，制作一次冻结重播驱动，保持下面的明确契约（不直接执行其在线请求）：

1. 读取原 capture-live.json 的 answer、followup.full、sessionId；保留旧证明文件，新的 UI 拍摄报告写独立子目录，并标明“既有真实输出的重播”。原 question 在该 capture 脚本中，不能改题后仍称为旧模型回答。
2. 用 browser-v7 与当前前端、原 Codex seed 配置附加文章；拍 attached，填原问题拍 typed，点击真实 send。
3. **替换所有 fetch(3968/turns) 分支**：将冻结 answer 通过当前 __promoPorts['browsa-chat'] 推 CHUNK 和 DONE，providerKey 用 `{name:'bridge',model:'http://127.0.0.1:3968'}`；等 finishBubble、字体与滚动落定后拍 answer。
4. 点击原生输入/发送原追问，用冻结 followup.full 推下一 CHUNK/DONE，拍 followup；保留旧 ID 的证明，不宣称重播再次在线验证了续接。确认报告无 pageerror、附页和两次 CHAT 都产生，再将四张新图冻结到 `public/textures/live/`。
5. 用已有 capture-growth-session 与 capture-resume-proof 刷新会话/续接展示，核对 ID 与原证明一致。新在线响应或 CLI 证明确有需要时，在独立演示后端/profile 中重新验证并写新证据，不覆盖旧证明冒充连续记录。

- 已有 `capture-growth-session.mjs` 可用既有中文回答/ID 重摄会话动作；将它产出的 sessions/session-copy 图拷到 textures/live。
- `capture-resume-proof.mjs` 从 verified-resume.json 重新排版真实结果，仍标注重排；不是重新执行 CLI。
- 六个其他语言使用演示数据。将新短片纹理冻结后，运行 render-growth；它目前旧默认并发为 4，没有主片的强制软件 GL；最终渲染前将其画面 render CLI 参数 `--concurrency=4` 改为 `--concurrency=2` 并添加 `--gl=swiftshader`，用一支短片先验收再批量。不要假设主片渲染参数自动作用于短片。

```bash
node .agents/skills/promo-video/video-v7/render-growth.mjs zh en ja ko es pt-BR ru
```

只改主片章卡通常不影响短片。音频变更时给短片 `--refresh-audio`，否则 group-shared.wav 可能命中旧缓存。旧 finalize-growth/patch-sessions 是特定旧帧号修复脚本，不列入默认流程。

## 交付验收

1. **真实动作**：附加/CHAT、选中/SUBCHAT、完整回答；SEEK_VIDEO=462 与可见播放器一致；原生复制文本等于源答案；PNG 下载有实际文件；保存会话恢复成不同内容；复制的 Agent ID 与续接例子一致。两个 Agent 携带上下文步骤的下一 CHAT.backfill=true，保留前文。DONE providerKey 使用当前 `{name,model}`，不注入过期字符串。
2. **实际编码文件**：逐章、动作前后、章卡/转场边界、最后一帧、GIF 首尾，七语检查字体与裁切。检查 1080p、官网约 960px、GIF 720px；小字可暂停阅读的限制要记录。
3. **数值与媒体**：下面检查不是视觉验收的替代。verify-delivery 是当前 28 组主片/短片及配对清单，有硬编码 repo/帧数；改变版本/时长/机器/GIF 文件名时先同步脚本（包括其 demo-v16 引用断言）。verify-audio 仍含当前 cuts/events 列表；改 timeline 后同步为当前值，不能沿用旧报告。

```bash
python3 .agents/skills/promo-video/video-v7/verify-delivery.py
python3 - <<'PYCHECK'
import json
from pathlib import Path
r=json.loads(Path('store-assets/promo/v7/verification.json').read_text())
assert r['complete'] and not r['missing'], r['missing']
PYCHECK
uv run --with numpy python .agents/skills/promo-video/video-v7/scan-frames.py zh en ja ko es pt-br ru
uv run --with numpy --with scipy python .agents/skills/promo-video/video-v7/verify-audio.py
```

没有 uv 时使用装有对应依赖的 Python。verify-delivery 当前只完整解码音乐版，而且缺文件时可能只写 complete=false 而仍退出0，所以必须读取/断言报告。发布前对实际更新的 SFX-only 文件也执行 `ffmpeg -v error -threads 2 -i <file> -f null -`。scan-frames 当前只读取 docs/assets/promo 的主片；它不证明短片无空帧，短片更新时将相同扫描逻辑用于 growth 目录的新输出。空帧扫描遍历全部帧，拒绝意外纯黑/纯色帧；full decode 只能发现编码错误，不能发现渲染成功但画面为空。发现坏帧先排查渲染参数，再从相同冻结 composition 重渲；repair-render-frames 仅用于可明确定位的个别坏帧，修后重新检查整片、画面流配对与音频。

4. **工作台**：使用已安装 video-shotcraft 的 workbench/scripts/open.mjs 打开此工程；当前清单 src/workbench.ts，revision 变化时更新。用其 parity.mjs 对当前章卡/动作/结尾采样（本轮 210/525/621/920/1260/1400/1520/1750），Python 需 Pillow；parity 输入为 `--frames 210,525,...`。公开说明这只是采样一致性。
5. **独立终检**：派干净上下文子代理，输入实际 MP4、关键帧、当前简报/设计/镜头映射、准确卡片实现与可用参考，遵循 video-shotcraft 的 final-review。完整新片全片评审；局部修订写 addendum，不覆写旧哈希/旧评审。主观音乐/SFX 听感未试听就标无法验证。
6. **四类素材和引用**：按 maintenance.md 逐一判断 guide 截图、banner、GIF、视频的场景影响；不因 UI 有差异就自动更新全部素材。banner 的现有命令为 `node dev-preview/banners/render.mjs`。需要更新的指南截图没有统一现役批处理脚本：读取原 PNG 的像素尺寸、对应 guide 场景与 preview DOM，用当前 UI 在同尺寸/语言下重拍，再核对指南正文与新图。同步受影响语言的 README/官网引用及 docs 的交付索引；保留媒体不改其引用。商店/YouTube 链接未实际换源就保留旧版说明。

当前结果索引为 docs/promo-v7-2026-10-01.md；本地 verification.json、analysis/final-beat-check.json、frame-scan-*.json 与独立报告保留在 store-assets/promo/v7。把未来结论写入新的当前记录，而不是不断往一个旧 spec 末尾堆互相冲突的时长。
