# ADR-0009: MAIN-world 注入函数的 helper 必须内嵌

- 状态：Accepted（2026-09-20 countImages 真实事故后固化）
- 来源：AGENTS.md「countImages — a real, separate production bug」

## Context

`chrome.scripting.executeScript({func})` 只序列化**那一个函数**，在页面自己的 realm 重新求值。
`countImages` 曾是 `extractInPageWorld` 的模块级兄弟函数，真实 Chrome 里 Readability 一成功就
`ReferenceError`——只因测试 harness 手工拼接两个函数体才「看起来能过」。

## Decision

1. MAIN-world 注入函数依赖的任何 helper 必须**声明在其自身函数体内**（或按需内联复制），
   绝不引用模块级兄弟。
2. 同一约束的连带要求：内嵌 helper 的**源码文本**大括号必须自平衡（测试的 `loadSiblingFn`
   按字符数括号提取函数体），结构性大括号用 `\x7B`/`\x7D` 写。

## Consequences

- 「这个 helper 明明可以共享」在 MAIN-world 文件里不成立；重复是平台约束，不是坏味道。
- 新增注入函数的测试必须走与真实注入一致的提取方式，禁止 harness 拼接兄弟函数。
