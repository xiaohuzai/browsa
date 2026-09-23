# ADR-0008: vendor 加载三约束（3Dmol / wasm glue / office 预热）

- 状态：Accepted（2026-09-13/18/20 各自实测得出）
- 来源：AGENTS.md 各 vendor 小节

## Context

三处「看起来可以打包/预热，实际不行」的加载约束，均有实测翻车记录。

## Decision

1. **3Dmol 的 dist 绝不过 esbuild**，只能 RAW 拷 + 经典 `<script>` 标签加载：
   dist 是含 jQuery 的 script 拼接、依赖 sloppy-mode 全局；esbuild 的 CJS 包装让 jQuery 走
   CommonJS 分支（`noGlobal=true`），3Dmol 随即 `$ is not defined`。
2. **wasm-bindgen glue 一律 RAW 拷贝**（pdf_inspector_wasm.js / docling_wasm.js 等），
   esbuild 不得触碰：glue 已是干净的 /web target ESM，只用 globalThis。
3. **office/docling wasm 不在面板 init 预热**（deliberately NOT pre-warmed）：13.4MB 二进制
   的预热成本与命中率不成比例，按需加载。

## Consequences

- build.mjs 的 RAW_COPIES 与 VENDORS 是两条管线，别「顺手统一」。
- 评审不要提「把 3Dmol/glue 也 esbuild 化」「init 时全量预热」。
