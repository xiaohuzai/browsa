# 随 browsa 迭代更新宣传素材

先读本轮 diff 和当前 timeline，沿用已认可内容，仅处理受影响的画面/文案/动作。完整采集与验收命令见 [production-v7.md](production-v7.md)。这里的区间和文件名是当前 v7 基线；时轴变化后重新计算。

## 更新决策

| 可观察的变化 | 需要做的工作 |
| --- | --- |
| 仅章标题/合成字幕，截图与时轴不变 | 同步七语 copy；重渲受影响完整 composition 区间及交叉淡化；保留原音轨 |
| 仅构图/相机/光标变化 | 复用截图；按新镜头输出画面，检查边界与停留；动作时刻变化则一起更新 SFX |
| 原生 sidepanel/options 的字号、颜色、结构或按钮位置变化 | 重摄涉及该 UI 的所有可辨镜头；更新 bounds/conversation，检查新坐标；公式也在侧栏中，不能因公式内容未变就跳过 |
| 附加/追问/视频/切换 Agent/会话的行为变化 | 先让当前产品真实操作跑通，再修改采集协议与演示状态，保存动作证据；不要只换截图或移动光标掩盖坏行为 |
| 新渲染能力或新增亮点 | 放进相关章节；保持一个任务与结果，必要时调整时长；按真实 renderer 拍摄，七语文案同步 |
| 音乐、SFX、节拍或时长变化 | timeline 和音频一起更新，重建 shared.wav；源音乐相位与输出偏移分开记录，抽终渲音轨回测 |
| 产品功能/宣传定位显著变化 | 先更新简报、四章故事与关键画面，再采集；旧参数只是起点，按用户决定推进 |

每次记录：产品版本/提交与工作区状态、哪些内容变了、涉及镜头/语言/素材、哪些冻结输入沿用、需要刷新哪些缓存与引用、验收范围。不是每次重新 brainstorm 用户已认可的故事，也不是无条件全量拍七条片。

## 保留当前认可的内容

当前基础故事是“读文章 → 看视频 → 在 browsa 切换 Agent → 回到 Agent”。最后一章通称 Agent，具体用 Codex；会话管理位于第四章。文档是 Transformer，视频是独立原创科技采访，化学/蛋白质轻带过。公式/DOT 使用已冻结的真实模型输出，侧栏、字号与渲染由当前 browsa 原生代码产生。新用户指示可以修改这些选择；不要因为模板或默认示例自行改回旧故事。

品牌 slogan 从当前已提交 README 核对。Cat Walk 与无旁白是当前用户选择，不是所有未来视频必须使用的固定音乐。新增素材仍记录其出处与许可。

## 仅改第四章标题：已验证的快速路径

成立条件：主片 timeline、素材、相机、所有音频和其他画面保持一致，仅 `chapterCards[3][0]` 改变。同步：

- `.agents/skills/promo-video/scripts/copy-v7.json`
- `.agents/skills/promo-video/video-v7/src/copy.json`

逐语修改标题，保持其他字段与 Codex CLI 示例。章节文案不是普通 Footer：当前 Chapter 读取 chapterCards，工作台通用 Headline 字段不会覆盖它；不要以为改工作台那个字段就改了章卡。

当前 `patch-chapter.mjs` 已验证七语更新：

```bash
node .agents/skills/promo-video/video-v7/patch-chapter.mjs zh en ja ko es pt-BR ru
```

脚本打包一次、每语渲染 **完整 BrowsaPromo composition** 的 1495–1558 帧（含首尾转场），拼接到原片，复制原音乐版与 SFX-only 的音轨；两版共用新视频流。记录 `store-assets/promo/v7/chapter-agent-update/report.json` 的前后音轨 hash/帧数，及实际 MP4 抽帧。不是独立渲 Scene：那会丢前后镜头的交叉淡化。

范围依据是第四章从 `beatF(108)=1495` 起，下一镜头从 `beatF(112)=1551` 起，旧章卡仍延长 TRANSITION=8 帧至 1559（不含）；所以最后受影响帧为 1558。脚本目前写死 108/112 拍，**仅适用于当前第四章区间**，不适用于其他镜头。用前核对 timeline.ts；时轴变了应改范围或全渲。

主片成对 MP4 必须已存在，脚本输出到同一文件名。修改前保留可恢复的原片与本轮源快照；避免对同一成片反复全片重编码，多轮修订从干净基片或重新全渲输出。更换成片文件后预览 URL 添加新 query，以免浏览器缓存旧版。

此次只改章卡的影响判断（未来用当前取帧逻辑重新判断）：

- 海报取 4.3 秒，没包含章卡；指南截图/banner 是产品 UI，不含章卡 → 保留。
- demo-v15 最后取段截止 49.4 秒，第四章从 1495/30≈49.83 秒开始 → GIF 内容没变，保留文件名。
- 三类获客短片不含主片第四章卡 → 不重渲。
- 七语 MP4 音乐/SFX 两版 → 全部更新；交付索引和制作 spec 同步。

局部处理节省采帧工作，不降低验收要求：完整解码、2049 帧、无意外空帧、成对画面流一致、原音轨 hash 不变；逐语检查章卡/两侧转场，工作台 parity 包含 1520。独立复核本区间和 Codex 示例，写新 addendum，保持调整前审查原样。

## 原生 UI 更新：避免旧截图/旧坐标

按需执行 production-v7 中的采集；采集可分语言，但最终七语都要覆盖受影响画面。capture7 和 workflow7 产基础图，native-final7 产真实公式/DOT/下载；prepare-assets 拷基础图并自动覆盖 native。

BYOK/原生追问/Agent 选择使用 **capture-conversation-final7**。它应在 prepare-assets 后运行，且它的报告必须汇总到 src/conversation.json。这两步是完整主线不可省略的部分；不能把旧 capture-workflow7 的泛型菜单截图当作当前携带上下文动作。

若只重摄某一类别，也核对最终 public 是否正确。例如：

- 只重摄 native → prepare-native 即可，不必先 prepare-assets。
- prepare-assets 重跑 → 可能覆盖 conversation 同名纹理；随后刷新 conversation 截图/边界。
- API/options 变化 → BYOK 纹理在 conversation，完整公式无需因其内容不变重请求模型。
- 侧栏全局 UI 变化 → native、conversation、基础/workflow 都有 sidepanel，应各自拍当前 UI；获客片中的 textures/live 也不能仍用旧 UI。

始终保持面板宽度稳定，按新 DOM 边界算裁切与点击。公式/图被 overflow 切掉就修构图后重拍；只拍局部图去掉 sidepanel 会违背当前认可的形式。

## 音频更新与缓存

主片 `render.mjs --reuse-video` 可以复用已有画面并重新混入 shared.wav，再生成海报/GIF。只变音频时先 build-audio，确认画面没变化后使用；它不是标题局部更新命令。短片缓存位于 growth/*-shared.wav，主片重建不会刷新它们；对应使用 render-growth 的 --refresh-audio。

改 timeline 时同时核对：SHOTS/TOTAL/TRANSITION、SFX 拍位、源音乐裁切长度、Main 中截图动作的 localBeat、短片使用的 beatF、verify-audio 的 cuts/events、verify-delivery 预期帧数、patch 范围及 GIF 取段。主片 SFX 是唯一时轴声明；检查脚本内的当前列表只是测量输入，不能偷偷成为第二个时轴。

最终音轨数值通过再试听音乐/SFX关系；没主观试听明确写验证范围，别宣称“听感完全同步”。仅标题变化且音轨 hash 精确保持，可报告原音轨未变，不需要重新选择音乐。

## 版本与交付记录

- GIF 内容变更必须改 demo-vN 文件名；七个 README 对应语言同步。主片换版本时七个官网 MP4/poster 引用同步。修同版本小标题可保留 MP4 名，刷新本地预览 query。
- guide、banner、GIF、视频每类都写判断，在各自分辨率看是否可辨；“只改宣传构图”不能替代 UI 已变时的截图重拍。
- 完整片与短片、真实记录与 DEMO、全片验证与抽样、数值音频与主观试听在报告中分清；无需把它们都扩大成同一次重拍。
- 当前规格可写新交付记录；当版本升级，把现役指针和验证脚本一起切换，历史记录保留但不充当新验收证据。
