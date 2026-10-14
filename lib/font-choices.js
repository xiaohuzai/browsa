// 正文字体选择（2026-10-14）：设置页「正文字体」的候选表。storage 存 key
// （fontFamily），stack 由 options.js（保存/回填）与 sidepanel.js（应用为
// --msg-font-family，图形渲染经 render.js panelFontFamily() 跟手）共读。
// **三档是用户拍板的收窄（2026-10-14），勿再扩**：预设只收三大系统都有内置
// 字形的族（楷体部分 Linux 缺字形、Inter/思源这类多数机器没装的字体列了会
// 「点了没反应」，自定义栈是工程面）——每档西文在前、CJK 字形显式列全、
// 泛型族兜底，非拉丁语言用户同样各档有效。'system' 刻意不携带 stack——apply
// 侧移除内联 var，让 sidepanel.css :root 的默认（= body 字体栈，lockstep
// 钉死）兜底，永远存在一条不折腾的出路。
export const MSG_FONT_CHOICES = [
  { key: 'system', stack: null },
  {
    key: 'serif',
    stack: 'Georgia, "Times New Roman", "Songti SC", SimSun, "Noto Serif CJK SC", "Noto Serif CJK JP", "Noto Serif CJK KR", serif',
  },
  {
    key: 'mono',
    stack: 'ui-monospace, "SF Mono", "Cascadia Code", Consolas, "Noto Sans Mono CJK SC", "Noto Sans Mono CJK KR", monospace',
  },
];

export function msgFontStackOf(key) {
  return MSG_FONT_CHOICES.find((c) => c.key === key)?.stack ?? null;
}
