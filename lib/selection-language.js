// UI locales plus the German/French reply options already offered by Settings.
// Shared selection-language policy for inline answers and right-click prompts.
export const SELECTION_LANGUAGES = { en: 'English', zh: 'Simplified Chinese', ja: 'Japanese', ko: 'Korean', es: 'Spanish', pt: 'Brazilian Portuguese', ru: 'Russian', de: 'German', fr: 'French' };

export function selectionLanguage(lang, fallback = 'en') {
  const base = String(lang || '').toLowerCase().split(/[-_]/)[0];
  return SELECTION_LANGUAGES[base] ? base : fallback;
}

export function selectionTargetLanguage(text, lang, autoTranslate = true) {
  const target = selectionLanguage(lang, 'zh');
  if (!autoTranslate) return target;
  const source = String(text || '');
  // Only script-identifiable cases switch automatically. Latin-script
  // languages cannot be inferred reliably from a short selection.
  const kana = /[\u3040-\u30ff]/.test(source);
  const korean = /[\uac00-\ud7af]/.test(source);
  const cyrillic = /[\u0400-\u04ff]/.test(source);
  const cjk = (source.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const latin = (source.match(/[A-Za-z]/g) || []).length;
  const mostlyCjk = cjk > 0 && cjk >= latin;
  if (target === 'zh' && mostlyCjk && !kana && !korean) return 'en';
  if (target === 'en' && !mostlyCjk && !cyrillic) return 'zh';
  if ((target === 'ja' && kana) || (target === 'ko' && korean) || (target === 'ru' && cyrillic)) return 'en';
  return target;
}

export function buildSelectionActionPrompt(action, text, replyLanguage, uiLanguage) {
  const lang = selectionLanguage(replyLanguage || uiLanguage);
  const name = SELECTION_LANGUAGES[lang];
  const preview = String(text || '').slice(0, 400) + (String(text || '').length > 400 ? '…' : '');
  const instructions = {
    explain: `Explain the following. Reply in ${name}:`,
    translate: `Translate the following into ${SELECTION_LANGUAGES[selectionTargetLanguage(text, lang, !replyLanguage)]}:`,
    summarize: `Summarize the following. Reply in ${name}:`,
  };
  return instructions[action] ? `${instructions[action]}\n\n"${preview}"` : '';
}
