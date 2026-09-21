---
name: cws-listing
description: 生成 Chrome Web Store 商店填写项（CWS listing 更新包）。当用户要发新版本、填商店、更新商店描述、生成 cws 填写项 / 提交包 / listing，或提到 Developer Dashboard、What's new、权限理由、商店审核时使用——按当前最新版本自动产出可整段粘贴的完整填写包。
---

# CWS 商店填写项生成

**目标**：对着最新代码状态，产出一份新的 `store-assets/cws-update-vX.Y.Z.md`——按 Dashboard 页签顺序、每个文本框给完整可粘贴内容（↻ 有变化 / ✅ 照抄 / — 不用动），用户核对后照抄提交即可。

## 铁律（先读，全是真金白银的教训）

1. **基线文本只认 `store-assets/` 下最新的 `cws-submit-v*.md` / `cws-update-v*.md`**，绝不用 `docs/cws-listing.md`（初版策略文档，文首已自我作废）。
2. **0.35.1 曾因「产品说明关键词过多」被拒**：不列站点清单、不堆模型名；品牌名只在基线文本原有句子里出现（各一次），**不新增**；名称与简短说明一律不加品牌名。What's new 里站点名 ≤1 次、在完整句子里，并在脚注给零风险替换行。
2b. **What's new 兼作老用户触达位 + 评分引导纪律（2026-09-21）**：CWS 已裁撤精选徽章（2026-08-20 公告，自荐通道同日关闭），替代的质量信号是**近期评论加权**的新评分体系——What's new 是老用户更新时唯一会主动看到的文案位。做法：**功能版**（新能力落地，非补丁版；一年一两次）的 What's new 末尾加一条中性评分行（EN 例：`• browsa is free & open source — if it has been useful, a store rating helps others find it.`），中文对应措辞；**绝不出现激励措辞**（解锁功能/抽奖换好评是红线），补丁版一律不带。
3. **描述必须与实物一致**：新用户可见行为不写进描述，审核员会当「文档不符」打回；反过来，描述里不能出现产品没有的行为。
4. **不加收费/限额类免责表述**（2026-09 已从全站清理，勿回流）；面向用户文案无行话、无歧义宣称。
5. **版本号不擅自 bump**——manifest/package.json 的 bump 是用户动作；本技能产出文案包，版本沿用用户给定的目标版本（没给就问或用 manifest 当前值提醒确认）。
6. 字符限制核验后标注：名称 ≤75、简短说明 ≤132、What's new 单语 ≤500、**测试说明（访问权限页）≤500**（2026-09-19 Dashboard 实测；0.38.2 基线文档的 ~2300 字符长版粘不进去，v0.38.5 起改精简版——无 Key 测试路径 + 提取/隐藏副本/cookies/本地数据四要素全保留，逐权限细节留给权限理由框）。其他字段也别假设上限，产出前逐一核验。
7. **同一 item 上传新包替换，绝不删件**（删件丢评分与安装量）。
8. 不确定的事实（线上当前文案与文档有出入、minimum_chrome_version 变化、权限增减）**标 ⚠ 请用户拍板**，不擅自定。

## 工作流

### 第一步：定基线与事实

```bash
ls store-assets/cws-update-v*.md store-assets/cws-submit-v*.md   # 取版本号最大的做基线
git tag | sort -V | tail -3                                      # 代码线最新版本
```

**版本事实源是 git tag，不是分支上的 manifest.json**——版本号只在 release 时由
`release.yml`（手动 dispatch 输入版本 → `npm version` bump → `chore: release vX.Y.Z` 提交 + tag）
写入，日常分支的 manifest 停在旧值是常态（`git diff v<BASE>..HEAD -- manifest.json`
里 version 字段显示"回退"属正常，**权限 / host_permissions / minimum_chrome_version
的 diff 才是有意义的变化**）。另外区分两个版本：**商店线上版本**（基线文档头部读 +
⚠ 与用户确认，因为最新 tag 可能还没提交商店、或在审中——出现没有商店文档的 tag
就是这个缺口）与**代码最新 tag**；目标版本 = 用户给定，没给就建议「最新 tag +1 个补丁位」并让用户确认。

从基线文档头部读「线上版本」事实；然后收集：

```bash
# manifest 差异（version 字段忽略，看权限/最低 Chrome 版本）
git diff v<CODE_BASE>..HEAD -- manifest.json
# 代码线基线 tag 之后全部 squash PR（一行为一个 PR，「附：用户可见变更」表的原料）
git log v<CODE_BASE>..HEAD --oneline --merges | grep -v 回灌
```

注意代码基线 tag 可能比商店基线新（tag 发了版但没提交商店）——PR 区间从**商店基线对应
的 tag**算起，上一轮没进商店文档的 tag 里 PR 也要纳入。逐个 PR 对照 README / AGENTS.md
判断**用户可见性**：内部优化（提示词压缩、测试、docs）不进表；用户可见的进「附」表并写成人话。拿不准的标注。

### 第二步：判定必改项（↻）

- 描述（EN+zh 详细说明）：新增能力 → 补进对应小节；行为变化 → 原位改写。小节结构沿用基线（CHAT WITH ANYTHING / VIDEO NOTES / PDFs / AGENTS / RICH RENDERING / PRIVACY…），不重排。
- What's new（EN+zh）：本版用户可见变更的 bullet 列表，每条一句话、说行为不说实现。
- 权限理由：仅当权限/注入行为变化时改（如后台 tab 行为要写进 `tabs` 理由）。
- 隐私问卷：仅当数据流变化时改（无新数据流则 ✅）。
- 截图：仅当被拍界面变了才重渲染（源在 `dev-preview/banners/*.html`，`node dev-preview/banners/render.mjs`；旧图备份 `_backup-*`）。宣传视频字段（可选，**只收 YouTube 链接**）：上传用 `store-assets/promo/browsa-promo-62s-1440p-master.mp4`——**别传 3.3MB 展示版**（~431kbps 源经 YouTube 重转码后小字发糊；1440p 上传还吃到 VP9/AV1 高码率档，2026-09-19 实证）；可见性 ≥ 不公开（私密连嵌入都拉不到，oEmbed 200 = 可访问）、**别勾「设为首映」**；换视频流程 = 新传 → 确认 1440p 就绪 → Dashboard 换链接（搭版本审核，不单独多审）→ 再删旧片（顺序反了商店挂死链）。官网 zh 区保持自托管 mp4（大陆访客打不开 YouTube），仓库不放 masters。
- 分类 / 分发 / 单一用途 / 隐私政策 URL：通常 — 不动。

### 第三步：产出填写包

读 `references/template.md`，按其骨架生成新文档。硬性格式：

- 文件名 `store-assets/cws-update-vX.Y.Z.md`，标题行含日期与「完整照抄版」。
- 文首：用途（线上版本 → 目标版本）、**版本事实段**（manifest 全量差异概括：权限是否增减、数据流是否变化、minimum_chrome_version 是否变化）、必改项清单、⚠ 拍板项、⚠ 被拒史约束提醒。
- 每个文本框一个代码块给**完整内容**（整段替换式，不做行内 diff），标注字符数与 ↻/✅/—。
- 末尾两节：**提交顺序**（1-12 步，按 Dashboard 页签）+ **附：本次更新包含的用户可见变更**（PR 号 → 人话表格）。
- EN 与 zh_CN 的名称/简短说明/详细说明/What's new 成对产出，语义对齐不是逐字翻译（zh 不留英文行话）。

### 第四步：交付

- 给用户一段「本次要粘贴哪些框、哪些不动」的摘要（引用文档节数），把 ⚠ 拍板项单列。
- release 包链接模式：`https://github.com/xiaohuzai/browsa/releases/download/vX.Y.Z/browsa-vX.Y.Z.zip`，提醒发布后先 `gh release view vX.Y.Z --json assets` 确认可下载（未发布是 404）。
- 提醒：审核期间商店继续展示旧版；被拒优先换 What's new 的零风险替换行重提，别删件。
