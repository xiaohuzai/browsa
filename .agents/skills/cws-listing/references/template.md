# cws-update 文档骨架（照此生成，内容来自基线 + 本版必改项）

> 生成时删除本提示块。`↻`=有变化；`✅`=照抄一遍最稳；`—`=不用动。

```markdown
# browsa vX.Y.Z · CWS 更新填写包（完整照抄版 · YYYY-MM-DD）

> 用途：把已上线的 item（ID `kghjmmajnpbkljankbbjbmnhfdocaeho`，商店线上 **vBASE**）
> 更新到 **vX.Y.Z**。本文按 Dashboard 左侧页签顺序排列，每个文本框给的都是完整内容：
> 全选删除 → 整段粘贴即可。标记：↻ = 有变化；✅ = 照抄一遍最稳；— = 不用动。
>
> 版本事实：vBASE → vX.Y.Z 的 manifest 全量差异只有 …（逐条列出；**零新增权限、零新数据流**
> 或如实列出变化；minimum_chrome_version 是否变化单列）。
> （若有）⚠ 代码线 vA.B.C / vA.B.D 已发布但无商店文档，本包一并覆盖其变更。
>
> 与线上相比，本次文案有 N 处**必须**更新（逐条列出理由——都是描述新行为，不写会被审核员当成文档不符）。
>
> ⚠ 历史约束（0.35.1 曾因「产品说明关键词过多」被拒）：不列站点清单、不堆模型名。
> 品牌名只在原有句子里各出现一次，不新增；名称与简短说明不加品牌名。
> （若有）⚠ 一处需要你拍板：<minimum_chrome_version 变化 / 线上文案出入等>

---

## 1. 文件包 ↻

上传 **vX.Y.Z 的 release 包**（CI 打包，已剥 `key` 字段）：

​```
https://github.com/xiaohuzai/browsa/releases/download/vX.Y.Z/browsa-vX.Y.Z.zip
​```

发布后先确认链接可用（未发布时是 404）：`gh release view vX.Y.Z --json assets -q '.assets[].name'`
同一 item 直接上传新包替换，**不要删件**（删件会丢评分与安装量）。

---

## 2. 商品详情 · EN（主 listing）

### 名称 ✅ / —
（≤75 字符；现役：`browsa – AI Sidebar · Chat with Pages · ChatGPT · Claude · Ollama`）

### 简短说明 ✅ / —（限 132 字符，标注本句字符数）
（现役：`AI sidebar that chats with pages, videos and PDFs. Your keys, your models, your agent. Open source. No account.`）

### 详细说明 ↻（整段替换）
（小节结构沿用基线：开场一段 → ── 分隔线小节 💬 CHAT WITH ANYTHING / 🎬 VIDEO NOTES / 📄 PDFs / 🤖 AGENTS / 🎨 RICH RENDERING / 🔒 PRIVACY → 结尾 CTA；本版新增行为补进对应小节）

### 分类 —（Productivity 主；Tools 次）

## 3. 商品详情 · 中文（简体）locale

### 名称 ✅ / —    ### 简短说明 ✅ / —（标注字符数）    ### 详细说明 ↻（整段替换）
（语义对齐 EN，不逐字翻译；不留英文行话）

## 4. 「此版本中的新功能」（What's new in this version）↻

### EN（≤500 字符，标注实际字符数）
（bullet 列表，每条一句话说行为；站点名 ≤1 次时在文下给零风险替换行）

### 中文（简体）（标注字符数）

## 5. 隐私权 ✅（无数据流变化时逐项照抄）

### 5.1 隐私政策 URL
​```
https://xiaohuzai.github.io/browsa/privacy.html
​```
### 5.2 单一用途说明
（现役：`An AI sidebar that chats with the page you're viewing via the user's own configured model or agent.`）
### 5.3 数据用途问卷
| 问卷项 | 答案 |
|---|---|
| 遵守数据用途政策（认证勾选） | 勾 |
| 是否使用远程代码 | 否（全部 JS/WASM 都在包内） |
| 是否收集或使用用户个人数据 | 否（开发者无服务器、无 analytics；Key 与历史只存本地 chrome.storage.local；页面内容只发往用户自己配置的端点） |

## 6. 权限理由 ↻ / ✅（逐字照抄基线的 12 个框；仅权限或注入行为变化时改写对应框）

## 7. 访问权限 → 测试说明 ↻ / ✅（整段替换；提取/注入行为披露必须与实物一致）

## 8. 分发 —（公开、全球、免费，沿用现有设置）

## 9. 截图 ↻ / ✅
（逐张列 zh 区 cws-1..5 / EN 区 cws-en-1..5：不变或需重渲染；重渲染源 `dev-preview/banners/*.html`，`node dev-preview/banners/render.mjs`；旧图备份 `_backup-*`。可选：宣传视频字段——`store-assets/promo/browsa-promo-62s.mp4` 传 YouTube 后填链接）

## 10. 提交顺序（Dashboard 手动操作）
1. 打开 Developer Dashboard → 商品 kghjmmajnpbkljankbbjbmnhfdocaeho
2. 软件包 → 上传 zip（§1，先确认链接可下载）
3. 商品详情 EN → 名称/简短说明/详细说明（§2）
4. 商品详情 EN → What's new（§4 EN）
5. 商品详情 中文（简体）→ 同上（§3 / §4 中文）
6. 截图（§9，只重传有变化的）
7. 分类 / 隐私权 / 测试说明 / 分发（§5-§8）
8. 提交审核
（注意事项：审核期间商店继续展示旧版；无权限变化≠秒过，文案与行为一致最重要；被拒优先换 What's new 零风险替换行重提，别删件）

---

## 附：本次更新包含的用户可见变更（供你核对，不必填表）

| PR | 用户可见变化 |
|---|---|
| #N | 人话描述（内部优化不进表） |
```
