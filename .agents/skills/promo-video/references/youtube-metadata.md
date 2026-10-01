# YouTube 标题与说明维护

为当前成片生成可直接粘贴的发布文案。默认七语 zh/en/ja/ko/es/pt-br/ru；用户指定某一语言或某条短片时按其范围输出。写文案不需要重新拍摄，也不表示已上传。

## 先核对当前版本

1. 从本轮交付索引找到实际上传的 MP4、当前故事、语言及 DEMO/实录范围。章节和时长以现役工程 timeline 为准，音乐以该工程 ATTRIBUTION.md 和最终音轨为准。
2. 从当前 README/官网核对品牌 slogan、安装与配置要求、支持的能力和链接。七语 slogan 沿用各语 README；标题可以另写，品牌口号保持原文。
3. 读取上一版上传包，保留仍适用的表述，更新故事、功能、示例、音乐、链接及文件对应关系。新主片描述完整主线；单场景获客片只描述片中任务与结果。

当前 v7 样例是 [docs/youtube-promo-v7-2026-10-01.md](../../../../docs/youtube-promo-v7-2026-10-01.md)，纯文本在 `docs/youtube/v7/`。这是可修改的起点，不是未来视频的事实来源。

## 文案结构

**标题**：browsa + 一个具体用途或用户收益 + 浏览器插件身份。前置品牌与核心用途，使用当地自然表达；版本号用于文件索引，通常不写进标题。每语一个推荐标题，≤100 字符。

当前示例：`browsa｜用自己的 AI 读网页、看视频：浏览器插件演示`

**说明**按以下顺序输出，≤5000 字符：

1. 原 slogan + 一句话身份/用途：Chrome / Edge 浏览器插件，在网页旁边使用自己已有的 AI。
2. 本片展示的任务与可见结果。完整片当前为读文章并追问 → 看视频并核对时间点 → 在 browsa 切换 Agent → 回到 Agent 继续。写成简短的当地语言段落或列表，主线与亮点结合。
3. 上手条件：插件免费、开源（MIT），需连接自己的模型 API、Ollama 或受支持的 Agent；模型/API 费用取决于服务商。
4. 可直接点击的安装链接、对应语言官网、配置指南、GitHub。纯文本用完整 HTTPS URL，指南回退英语时在标签说明。
5. 与实际素材一致的简短演示说明，再放当前音乐的曲名、作者、来源链接。最后可选 1–3 个相关标签。

视频很短时默认不加时间戳。需要 YouTube 章节时，从当前成片计算，首项 0:00、至少三项、每段至少 10 秒；短章卡不直接当成平台章节。

## 本产品的关键表述

- 把“用自己的 AI”与浏览器插件身份说清楚，面向已有后端的技术读者；免费指插件，不能写成免费 AI 服务或安装即用的内置模型。
- 计算机相关案例优先：Transformer 文档、LaTeX、Mermaid、Graphviz。化学/蛋白质只作简短补充；不为凑齐能力清单增加主线负担。
- 文章与视频是两个任务。当前采访为原创虚构演示；“硅谷101”是形式参考，发布文案不称其为真实节目或真实素材。
- 切换 Agent 时用户选择带上当前对话；“同步上下文”写明此选择。Agent 端续接以受支持的 Agent 和当前验证范围为准，Codex 是片中例子。
- 拷贝消息、下载图片、保存/恢复会话按实际演示描述，不扩大为任意文件自动落盘、一键启动 CLI 或静默自动同步。
- 演示说明简短明确：UI 为原生前端，片中有示例回答、访谈、CLI 和剪辑。真实公式输出不能被写成整片在线实录；不宣传剪辑后的响应速度。
- 音乐署名读取当前工程出处记录。v7 是 `Cat Walk — Arulo / Mixkit` 与 `https://mixkit.co/`；换音乐即更新，去背景音乐版不署旧 BGM，也不凭署名保证版权检测结果。

## 链接映射

当前入口（将来变更时先核对源码与有效页面）：

- 安装：`https://chromewebstore.google.com/detail/browsa/kghjmmajnpbkljankbbjbmnhfdocaeho`
- GitHub：`https://github.com/xiaohuzai/browsa`
- 官网根：`https://xiaohuzai.github.io/browsa/`

| 文件语言 | 官网相对根路径 | 配置指南相对根路径 | 标签注明 |
| --- | --- | --- | --- |
| zh | 根页 | guide/quickstart.html | 中文 |
| en | en/ | en/guide/quickstart.html | 英文 |
| ja | ja/ | en/guide/quickstart.html | 英语指南 |
| ko | ko/ | en/guide/quickstart.html | 英语指南 |
| es | es/ | en/guide/quickstart.html | 英语指南 |
| pt-br | pt-br/ | en/guide/quickstart.html | 英语指南 |
| ru | ru/ | en/guide/quickstart.html | 英语指南 |

不要捏造五语 guide 路径。旧 YouTube 视频 URL 不是新上传片的入口，不能复制进新说明冒充新片。

## 输出与校验

每次按现役素材版本和本轮日期写：

- 总包：`docs/youtube-promo-<version>-<YYYY-MM-DD>.md`，每语包含对应 MP4、推荐标题及完整说明的可复制纯文本块。
- 每语：`docs/youtube/<version>/<slug>-title.txt` 与 `<slug>-description.txt`，UTF-8，保留真实换行。巴西葡语文件 slug 为 `pt-br`。
- 总包是同轮纯文本的汇总，内容保持一致；更新同版本时修订现役文件，新版本则建立新目录并在交付索引及 SKILL.md 切换当前样例链接。

在仓库根执行以下校验；新版替换 `version`，并按实际媒体命名调整 `media_prefix`。用户明确只需单语时修改 `slugs`。

```python
from pathlib import Path

version = 'v7'
slugs = ['zh', 'en', 'ja', 'ko', 'es', 'pt-br', 'ru']
media_prefix = f'browsa-promo-{version}-'
for slug in slugs:
    folder = Path('docs/youtube') / version
    title = (folder / f'{slug}-title.txt').read_text(encoding='utf-8').strip()
    description = (folder / f'{slug}-description.txt').read_text(encoding='utf-8').strip()
    assert '\n' not in title and 0 < len(title) <= 100, slug
    assert 0 < len(description) <= 5000, slug
    assert Path('docs/assets/promo', f'{media_prefix}{slug}.mp4').is_file(), slug
    print(f'{slug}: title={len(title)}, description={len(description)}')
```

再逐语读文案：核对 slogan、故事与实际 MP4、链接语言、音乐出处、免费范围和 Agent 携带条件；检查总包与 TXT 一致、没有占位词或字面 `\n`。长度通过不代表语义通过。向用户提供总包和独立文件的绝对路径链接；当前任务授权写文案，不自动提交或上传。
