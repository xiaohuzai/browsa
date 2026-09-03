# bridge/ — browsa ⇄ 本机 agent 引擎的 Native-Messaging 桥

浏览器扩展没有 API 启动本地进程；Chrome 唯一放行的通道是
[Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)。
本目录是那个"小桥"：一个 ~100 行的哑字节泵（`hosts/nm-bridge.sh` / `.ps1`），
把 NM 帧（4 字节 LE 长度 + JSON）和引擎的 stdio 行协议互转。零网络、零守护进程、
扩展端口断开即随 Chrome 一起退出。

```text
浏览器扩展（browsa，或其他扩展）
   ↕  NM 帧（Chrome 只为 allowlist 里的扩展 ID 拉起宿主）
宿主脚本（本目录 hosts/，随用随起，用完即走）
   ↕  newline-delimited JSON
本机引擎（codex app-server / …）
```

## 安装（一次性）

前提：本机已装 codex（CLI 或桌面版任一）并登录过。

```bash
# 就在 browsa 仓库里：
node bridge/cli/agent-bridge.mjs install
```

向导会：探测本机引擎（● 已发现 / ○ 未装）→ 问启用哪些 → 问授权给谁。
因为 bridge 与扩展同仓库，**扩展 ID 自动从 manifest.json 的 pin key 推导**，
授权 browsa 就是回车一下。装完重启浏览器，browsa 设置里点 Ping 验证
（真实 app-server 握手，成功会显示引擎版本 + 模型数）。

等效非交互命令：

```bash
node bridge/cli/agent-bridge.mjs install --backend codex --allow browsa
node bridge/cli/agent-bridge.mjs --list                        # 引擎与发现状态
node bridge/cli/agent-bridge.mjs install --backend codex \
     --allow-extension <32位扩展ID>   # 授权其他扩展（app 亮 ID，桥不穷举）
node bridge/cli/agent-bridge.mjs install --backend codex --bin codex=/路径/codex
node bridge/cli/agent-bridge.mjs uninstall --backend codex
```

写进机器的只有两样：宿主脚本（`~/.local/bin/agent-bridge-<backend>`）和一份
NM manifest（`com.agentbridge.<backend>`，`allowed_origins` 列出你授权的扩展
ID；Chrome / Edge / Chromium 各一份拷贝，Windows 走 HKCU 注册表）。重跑
install 是**追加**授权，不会撤销已授权的 app。没有通配符——未授权的扩展
永远无法驱动你的引擎。

## 引擎配方（backends/）

| id | 引擎 | 引擎参数 | 协议族 | 会话续接 |
| --- | --- | --- | --- | --- |
| `codex` | `codex`（CLI 或桌面版托管副本） | `app-server --stdio` | JSON-RPC stdio | in-band（`thread/resume`） |

一个后端就是一个 JSON 配方：二进制名、发现路径、引擎参数、协议说明。
二进制不在标准位置时用 `--bin <backend>=<路径>` 显式指定。引擎需要环境变量
（如 `ARK_API_KEY`——Chrome 拉起的进程不继承 shell 导出）时，写
`~/.agent-bridge.env`，一行一个 `KEY=VALUE`。

其他扩展/应用接入：浏览器扩展照 browsa 的 `lib/codex-client.js` 说这条线
（先发控制帧 `{"argv":[...]}`，再 `initialize` → `thread/start` →
`turn/start`，审批是服务端请求、回 `{decision}`）。能直接 spawn 进程的
桌面应用不需要 NM，直接复用 backends/ 配方即可。

## 测试

```bash
npm run test:bridge        # 传输契约 + 安装器契约（16 项，无需真引擎）
node --test bridge/conformance/live-codex.test.mjs   # 真 codex 全链路（本机装了 codex 才跑）
```

真机踩过的坑都在 [docs/platform-pitfalls.md](docs/platform-pitfalls.md)——
自己写 NM 宿主前先读它。
