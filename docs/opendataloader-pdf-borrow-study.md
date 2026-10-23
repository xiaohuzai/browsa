# opendataloader-pdf 借鉴研究：browsa PDF 链路移植记录（2026-10-23）

> 本文是 `docs/orca-multi-agent-context-study.md` 同款的全仓审计叙事档：对
> https://github.com/opendataloader-project/opendataloader-pdf （Hancom 开源，
> Apache-2.0，Java + veraPDF WCAG 算法库）逐文件审计后，把对 browsa 有用的
> 确定性后处理移植进 `lib/sidepanel/pdf-extractor.js` 的完整记录。AGENTS.md
> 只留裁决卡（context 预算所限），机制、阈值依据与不移植清单以本文为准。
> 源码检出曾留在 `/tmp/odl/repo`（36MB，已可重拉：`gh api repos/opendataloader-project/opendataloader-pdf/tarball`——
> 本机 git 直连 github.com 不通，走 api.github.com）。

## 对方是什么（与 browsa 的架构差）

DocumentProcessor 管线：veraPDF 解析出带坐标的文本块/线条/图片 → 每页过滤
（ContentFilterProcessor）→ 表格（边框法 + 聚类法）→ 行/段落/列表/标题/图注重建 →
跨页处理（页眉页脚、邻接列表/表格）→ 可选 XY-Cut++ 排序 → PII 脱敏 → 输出
markdown / JSON（每元素 bbox）/ HTML / Tagged PDF。hybrid 模式用 TriageProcessor
几何启发式逐页分流：简单页走本地快路径，难页（网格线、大图、扫描页、U+FFFD 高）
发给 Docling 服务器。browsa 主路径是 firecrawl pdf-inspector-wasm（结构化
markdown），opendataloader 的价值在**确定性几何后处理**那一层——恰好是 browsa
pdf.js 兜底路径的空洞。

## 已移植（本轮落地，五项）

1. **扫描件 vision 兜底**。opendataloader 把扫描页发给 OCR 服务器；browsa 的
   等价物是已有的 vision 管线：扫描页=单张满页栅格，figure pass 本就整页渲染。
   `extractPdfContent` 的 legacy 文本为空且 figure pass 有货时不再 throw 占位符，
   页图切片随附、`scanned:true`，文本槽写 `[PDF file — scanned, no text layer]`
   说明（保留 `[PDF file` 前缀——`hasPdfTrace()` 靠它门控 wasm 预热）。上限
   `SCANNED_MAX_PAGE_IMAGES=12`（每张 ~1K+ 视觉 token 每轮重发）；note 写明
   「前 N/共 M 页」，不静默截断。无图可附（figures 关闭/超时）仍走原 throw 占位符。
   触发判定参考 TriageProcessor：图片 ≥40% 页面 + 非空白文本块 ≤5 ≈ scanned；
   U+FFFD ≥0.3 是最高优先级信号（见第 4 条）。browsa 用「legacy 文本空」做主
   判定，几何信号留作后续细化。
2. **页眉页脚跨页去重**（HeaderFooterProcessor 的两票制改编）。fallback 路径
   （`stripPageFurniture`，pieces 有坐标：页上下 1/3 区）与 wasm 路径
   （`stripMarkdownPageFurniture`，分页块首尾行）：① 数字归一化（数字→`#`）后
   逐字相同的候选行占 ≥max(3, 60%) 页；② 纯页码形状（"7"、"7/12"、"Page 7"、
   "第 7 页"）占 ≥max(3, 50%) 页。误杀即吞正文，阈值宁紧；`[Page N]` 字面行
   豁免；<3 页不动。⚠ 数字归一化让「常数+递增数字」的首尾行（"Body line of
   page N."）天然落在页眉形状里——真实正文几乎不长这样，但**测试 fixture 必须
   用互异措辞**（lib-pdf-structure 里踩过）。`extractPdfText` 因此改为先读满
   pagesRead 页再 strip 再拼接（maxChars 提前 break 移入拼接循环；cap 满时多读
   几页 getTextContent 是 strip 的前提成本，fallback 罕见路径可接受）。
3. **重叠重复 run 去重**（`dedupeRuns`，removeSameTextChunks 改编）：同文本、
   近字号、近原点 → 保留一份。合成粗体/描边字让生成器把同一段文字画两遍，
   pdf.js 两份都交——粗体句从此不再翻倍。
4. **微小字号过滤**（`filterTinyRuns`，<1pt 即弃）。对方动机原话：text too
   small to read is a common way to hide a prompt-injection payload（0.05pt 的
   "ignore all previous instructions"）。其「bbox 高 ≤1pt 且字号 ≤5pt」双条件
   在 browsa 坍缩为 size<1——我们的 run size 本就从完整 transform 算（含
   text-matrix 缩放，正是对方第二个测试用例的逃逸路径）。脚注 6-8pt 不受影响。
5. **U+FFFD 替换字符比例**（`measureReplacementCharRatio`，阈值 0.3 同
   ContentFilterProcessor）：两条路径都算，OR 进 `hasEncodingIssues` → 附加
   chip 的「文本可能存在编码问题」。高比例 = CID 字体缺 ToUnicode 映射，文字
   已是乱码，提示用户换视觉模型。

测试：`test/lib-pdf-structure.test.mjs`（纯函数 18 例）、
`test/lib-pdf-scanned-fallback.test.mjs`（`_extractText` 缝 + fallback 分支旗标）、
`test/lib-pdf-encoding-flag.test.mjs`（wasm 路径旗标）。⚠ worker-client 单例在
进程内共享——**一个测试文件只能承载一个 wasm worker 场景**（既有约定，新测试
文件即按此拆分）。i18n：`chipPdfScanned` 七语同步。

## 刻意不移植（审计结论，勿重提）

- **段落合并**：markdown 软换行已等效合并连续行；错误合并是不可逆的正文破坏，
  对方的 542 行 ParagraphProcessor 依赖 veraPDF 概率函数，无法忠实复刻。
- **列表检测**（ListProcessor + BulletedParagraphUtils 的 CJK 标签正则全套）：
  browsa 兜底文本逐字保留原始行——行首 `1. ` 在 markdown 语义里本来就是有序
  列表，`•` 项目符号模型直接可读，扁平化近乎无损。对方重建列表结构是为了
  重生成 `- ` markdown 与 Tagged PDF；browsa 重建反而要先剥掉原标签（有损、
  有险）。迁移条件：兜底路径将来需要结构化（非逐字）输出时再议。
- **跨页表格/列表链接**（checkNeighborTables / checkNeighborLists）：它们链接
  的是 opendataloader 自己检测出的 TableBorder/PDFList 对象；browsa 兜底路径
  不产表格/列表对象（表格检测本身未移植），wasm 主路径的表格按页由引擎输出
  ——没有可挂载的宿主结构。
- **XY-Cut++ 阅读顺序**：**延期，非拒绝**。现有 band 算法过全部既有单测、
  双栏正确；XY-Cut++ 的三项改进（跨栏元素 premask、密度自适应切轴、窄条
  过滤防页码架在栏隙上）对复杂版面更强，但替换的是内容最关键的阅读顺序核心，
  回归风险与本轮「不引入 bug」约束冲突。触发条件：兜底路径出现真实乱序报告
  即重启（算法纯几何无依赖，651 行 Java 可压成 ~80 行 JS，tests 已有夹具）。
- **空格插入阈值 0.17**（对方 `--space-ratio` 默认）：保留 browsa 现值 0.25
  （有既有测试钉住）；无证据表明 0.17 更优，盲改对 CJK 有插假空格风险。
- **白底白字隐藏文本过滤**：需整页渲染算对比度；opendataloader 自己也默认关
  （filterHiddenText=false，成本理由相同）。
- **删除线/下划线检测**：每页 operatorList 全扫，成本 > browsa 场景收益。
- **标题层级（字号稀有度统计）**：wasm 主路径已有标题；兜底路径加启发式，
  噪声风险 > 收益。
- **PII 脱敏规则表 / `--pages` 页码范围**：真实需求但需产品开关与 UI，待议。
- **caption 概率判定**：无法忠实复刻 veraPDF 概率函数；错误配对比缺失更有害
  （browsa 的 caption 是模型引用锚点）。
- **TOC 视觉检测**：opendataloader 自己都禁用了（注释：任何以裸数字结尾的行
  都会被当 TOC 项）。browsa 的书签 outline 路线是更稳的选择，保持。
- **超链接提取 / 表单值 / 旋转页显式处理**：grep 证实对方也没有；browsa 的
  `redactTextUrls` 刻意剥 URL，方向一致。
- **Java 引擎 / veraPDF 依赖 / hybrid 服务器 / MCP / Tagged PDF 输出**：JVM
  与常驻后端与纯客户端扩展冲突；borrowable 的只有分诊思想（已由第 1 条吸收）。

## 对方工程实践的两条旁证（方法论，非特性）

- **实验驱动阈值**：TriageProcessor 两个信号被实验禁用并在注释里写明 FP 数据
  （"19 FPs (28.4%)... Disabling reduces FP by 12 with only +1 FN"）——与
  browsa「变异验证/真机抓回归」同源。
- **silent-failure 文档**（skills/odl-pdf/references/option-interactions.md）：
  A.1「enrichment 在混合路由下静默跳过」、A.2「fallback 保住完成度丢掉质量」
  ——browsa 的 fail-open 与「fail-open 也要留痕」原则的同类表述。
