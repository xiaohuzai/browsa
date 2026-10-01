---
name: promo-video
description: Use when browsa 需要宣传片、演示视频、demo GIF、随产品迭代更新素材、重拍分镜、调整运镜或字幕、导出七语素材、生成或更新 YouTube 标题与说明、上传 YouTube 或维护新旧版播放列表，或排查拍摄与编码问题。
---

# browsa 宣传素材

沿用已认可的故事与真实 UI，按本轮产品变更更新素材。当前基线为 **v7 四章版**（2026-10-01）：68.3 秒、七语、Ink Press 改编、Cat Walk — Arulo、背景音乐与动作音效，无旁白。版本号和时长是当前基线，不是未来硬限制。

## 先确定更新范围

- 产品 UI/UX 或交互变化：先读 [maintenance.md](references/maintenance.md) 判断现有分镜是否受影响。没有影响演示操作、结果或功能表达时，可保留视频/GIF并记录原因；需要更新的画面再按 [production-v7.md](references/production-v7.md) 采集、冻结、渲染、验收。
- 用户要求完整重拍：读 [production-v7.md](references/production-v7.md)，核对本轮故事和素材，再执行制作流程。
- 只改字幕/章标题、运镜、音效或局部画面：读 [maintenance.md](references/maintenance.md)，先判断能否复用截图与音轨。局部修改仍须交付实际更新的 MP4，不能只改 JSON。
- YouTube 上传标题/说明，或新片更新发布文案：读 [youtube-metadata.md](references/youtube-metadata.md)。按当前成片输出七语可粘贴文案；只改发布文案无需重渲视频。
- 批量上传 YouTube、补填已有视频或维护新旧版播放列表：读 [youtube-upload.md](references/youtube-upload.md)。主列表仅保留最新七语，旧版归档；先核对既有记录，避免重复上传。仅要求完善 skill 时不操作线上账号。
- 当前工程 `.agents/skills/promo-video/video-v7`；主片镜头与音效以 `src/timeline.ts` 为唯一权威，不能按旧文档帧号执行。历史 [v4](references/v4.md) / [v3](references/v3.md) 仅用于明确要求的回溯。

## 已认可的产品故事

开场用一两句话明确：browsa 是 Chrome / Edge 浏览器插件，把当前网页交给用户自己的 LLM 或 Agent。随后四个明显的章节，每章演一个完整任务：

| 章节 | 主线与必见结果 |
| --- | --- |
| 01 读文章 | 文章/博客/技术文档 → 附加 Transformer 文档 → 提问 → 选中回答追问 → 丰富渲染 |
| 02 看视频 | B 站/YouTube 科技访谈 → 要点时间线 → 点击 07:42 → 原片跳到 462 秒核对 |
| 03 切换 Agent，继续对话 | 在 browsa 内 Codex → Claude → 用户选择“带上当前对话继续” → 继续整理，历史保留 |
| 04 回到 Agent，继续工作 | 拷贝消息/下载图片 → 保存与恢复会话 → 拷贝会话 ID → 在 Agent 端续接；用 Codex 举例 |

会话管理是第四章中的桥梁，不单列一章。第四章的能力标题保持 Agent 通称；Codex 是示例。主线不是新的 slogan：中文品牌用「读到哪里，问到哪里。」、英文「Stay on the page. Ask beside it.」；其他五语沿用已提交 README 的对应 slogan。

## 素材与审美约束

- 文档、公式、Mermaid、Graphviz 以计算机/Transformer 为主要例子，蛋白质 3D 与化学仅简短带过。访谈参考“硅谷101”的采访形式，当前用原创 AI/工作主题；不改成 Transformer 讲课，不冒用节目品牌、真人片段或声音。
- 渲染展示留在 **真实 sidepanel**，保留顶栏、气泡与网页关系。公式和 Graphviz 复用已认可的真实 Codex 回答及原生渲染；不重画成独立展示卡，不重复调用模型碰运气。仅品牌结尾可以收集截图。
- 采用 browsa 的纸色/墨色/橙色与原生字体。镜头在焦点转移时运动，阅读时停稳；完整演出点击、追问、结果与续接，避免无缘由跳章、长等待、反复控制同一按钮。
- 七语分别输出界面、问题/答案、标题、字幕与海报：zh/en/ja/ko/es/pt-BR/ru；文件 pt-br，Chrome 字典 pt_BR，UI 短码 pt。长标题逐语检查换行与裁切。
- UI 是真实前端；大部分主片回复、访谈与 CLI 为明确标注的冻结 DEMO。真实公式/DOT 不等于整窗实录。Agent 上下文需用户明确选择；不宣传静默自动同步、在线响应速度、一键启动 CLI 或未经验证的文件写入。

## 交付门槛

需要更新成片时，更新对应的带 BGM 与无 BGM（保留 SFX）两版，复用同一画面流。验收实际更新的编码文件：动作证据、受影响语言的文字/转场、完整解码、帧数、空帧扫描、画面流配对；改音频/时轴则回测最终音轨。按 video-shotcraft 做工作台同帧对比，并派干净上下文子代理独立终检；报告区分实际观察、数值验证与无法验证的范围。保留成片时记录影响判断即可，无需重新执行制作验收。

截图、banner、GIF、视频 **逐一判断**：先看各自场景是否受影响，再看交付分辨率下是否可辨，不能仅因 UI 有可见差异就自动重拍。视频/GIF 未涉及改动，或仅有不影响演示操作、结果与理解的周边细节变化，可保留并记录原因，详见 maintenance.md。指南中的操作入口仍须准确。GIF 与视频按各自实际镜头独立判断；GIF 内容确实变更才递增 demo-vN 文件名，并同步对应语言的引用。当前交付索引 [docs/promo-v7-2026-10-01.md](../../../docs/promo-v7-2026-10-01.md)。制作完成不自动授权提交、推送、上传或发布。

成片故事、能力表述、音乐或入口变化时，同轮更新对应 YouTube 文案；纯画面调整也核对文案是否仍匹配。当前文案样例为 [七语上传包](../../../docs/youtube-promo-v7-2026-10-01.md)，未来依新成片修订，不固定复用 v7 内容。
