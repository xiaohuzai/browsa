# test/AGENTS.md — 测试基建规则

> 作用域：`test/*`。命令与内存约束见仓库根 `AGENTS.md` 的 Commands 节。

## 总则

- Node 内建 test runner；import 扩展模块前先 mock `chrome` 全局。测试分两类：对 `handle()` 的静态分析/集成测试，与 import 真模块、驱动真 DOM 事件的 jsdom 执行测试（用真 vendor bundle：marked/DOMPurify/katex/highlight.js，不用替身）。没有真浏览器——jsdom 顶 DOM；唯一例外是 `WebAssembly.instantiate`（`test/lib-pdf-inspector-wasm.test.mjs` 对真 `.wasm` 做真执行测试）。
- `sidepanel.js` 零导出（模块加载即 `init()`），其测试加载真 `sidepanel.html` 进 jsdom、mock `init()` 需要的 `chrome.*`、import 真 `sidepanel.js`、用模拟点击/按键/端口消息驱动——浏览器式黑盒（`lib-sidepanel-streaming` / `lib-sidepanel-resume-streaming` / `lib-sidepanel-status-dot`）。
- **`test/helpers/chrome-mock.mjs` 的 `makeStorageArea(initial, {clone})` 是唯一 storage 桩实现**，勿在测试文件里手写；内存版 mock 必须 `structuredClone` 读写（真 storage 每读反序列化新对象，返回活引用会让 `appendToHistory` 的原地 push 污染 sendHistory）。
- **jsdom 收尾**：结束一回合而不发 DONE/停止/关卡，会泄漏回合端口的 20s `SW_PING` setInterval 挂死 `node --test`——每个 detail-thread/流式测试必须拆回合。流式渲染测试在流中结束时必须 `render.destroy()`（泄漏的 pacer 会污染后续测试的解析计数）。
- 大 buffer 禁令与并发约束见根文件 Commands 节。
- **lockstep 纪律**：改任何「跨层数据搬运」相关代码后，重跑形状 lockstep 接线测试（`chat-rebuild-channels`、`attach-site-images`、`site-synthesizers` 等），别只跑单元套件——落库桩测试喂手工结果时，提取侧丢字段照样绿（2026-10-15 知乎回归的真实教训）。
- 行为测试优先于源码 pin；保留的源码 pin（subchat 的 DONE 行正则等）改代码必改 pin。
