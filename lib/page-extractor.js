// lib/page-extractor.js
// Extracts page context from the active tab. The user can choose the mode:
//   - 'full'       : send full HTML (truncated to MAX_HTML_CHARS)
//   - 'selected'   : send only the user's text selection
//   - 'screenshot' : send a data: URL PNG of the visible tab
//   - 'summary'    : ask the model to summarize first (we do this client-side by
//                    just sending a meta instruction to summarize before answering)
//
// Returns: { text?: string, imageDataUrl?: string, meta: { url, title, ... } }

// Default caps. Most LLMs (and Hermes) take 128K-200K context, so 500K chars is
// safely within reason. Users can override per-provider in the options page.
const DEFAULT_MAX_HTML_CHARS = 500_000;  // 500KB
const DEFAULT_MAX_TEXT_CHARS = 500_000;  // 500KB
// Hard ceiling — even if a user configures something silly, we never feed
// more than this to a single chat turn.
const ABSOLUTE_MAX = 2_000_000;          // 2MB hard cap

export async function extractActiveTab({ mode = 'full', maxHtmlChars, maxTextChars } = {}) {
  // Resolve limits: caller-provided > DEFAULT > ABSOLUTE_MAX ceiling
  const htmlCap = Math.min(maxHtmlChars ?? DEFAULT_MAX_HTML_CHARS, ABSOLUTE_MAX);
  const textCap = Math.min(maxTextChars ?? DEFAULT_MAX_TEXT_CHARS, ABSOLUTE_MAX);

  const tab = await getActiveTab();
  if (!tab) throw new Error('No active tab');
  if (!tab.id) throw new Error('Active tab has no id');
  if (!/^https?:/.test(tab.url || '')) {
    throw new Error(`Cannot extract from non-http(s) URL: ${tab.url}`);
  }

  const meta = {
    url: tab.url,
    title: tab.title,
    favIconUrl: tab.favIconUrl || ''
  };

  // Inject a content script that runs in the page's main world (not the isolated
  // content-script world) so we can read window.getSelection() and document directly.
  // The 'function' arg is auto-serialized and executed in the page.
  // We always read DOM (even for screenshot mode) to get title/url as text fallback.
  const injection = async () => {
    const sel = window.getSelection ? String(window.getSelection() || '') : '';
    // OuterHTML can be huge; cap it at htmlCap before serializing to avoid
    // wasting memory in the page context.
    const raw = document.documentElement ? document.documentElement.outerHTML : '';
    const html = raw.length > htmlCap ? raw.slice(0, htmlCap) : raw;
    return { html, selection: sel, htmlWasTruncated: raw.length > htmlCap, rawLength: raw.length };
  };

  let page;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injection,
      world: 'MAIN' // see raw page DOM, not sandboxed content script world
    });
    page = res?.result || { html: '', selection: '' };
  } catch (e) {
    throw new Error(`Failed to read page DOM: ${e.message}`);
  }

  const result = { meta, mode };

  switch (mode) {
    case 'selected': {
      const sel = (page.selection || '').trim();
      if (!sel) {
        // Fallback to full if nothing selected
        result.text = `[No text selected — falling back to full page]\n\n${truncate(stripHtml(page.html), textCap)}`;
        result.fallback = true;
      } else {
        result.text = truncate(sel, textCap);
      }
      break;
    }
    case 'screenshot': {
      const dataUrl = await captureVisibleTab(tab.id);
      result.imageDataUrl = dataUrl;
      result.text = `(screenshot of "${meta.title}")`;
      break;
    }
    case 'full':
    default: {
      result.text = truncate(stripHtml(page.html), textCap);
      break;
    }
  }

  // Surface truncation in the result so the UI can warn the user.
  result.truncated = {
    rawHtmlLength: page.rawLength || 0,
    htmlCap,
    textCap,
    textLength: (result.text || '').length
  };

  return result;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function captureVisibleTab(tabId) {
  // chrome.tabs.captureVisibleTab requires <all_urls> or activeTab + scripting.
  // activeTab grants temporary host permission when user invokes the extension
  // (e.g. clicks the action button). Since this is called from a user gesture
  // (clicking "send"), activeTab should be sufficient.
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
}

// Best-effort HTML→text. Keeps it readable, not pixel-perfect.
function stripHtml(html) {
  if (!html) return '';
  let s = html;
  // Drop script/style/noscript/svg/iframe content
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  // Normalize block-level tags to newlines
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|br|section|article|header|footer|nav)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, ' ');
  // Decode common entities
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse whitespace
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n\n').trim();
  return s;
}

function truncate(s, max) {
  if (!s) return s;
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[... truncated at ${max} chars ...]`;
}

/**
 * Build the messages array for a chat turn. Adds a system-style "user attachment"
 * prefix so the model understands the context.
 */
export function buildMessages({ history, userText, pageContext, withImage }) {
  const messages = [];

  if (pageContext) {
    const { meta, mode, text, imageDataUrl, fallback } = pageContext;
    const header =
      `[Page context attached by browsa]\n` +
      `URL: ${meta.url}\n` +
      `Title: ${meta.title}\n` +
      `Mode: ${mode}${fallback ? ' (fallback)' : ''}\n` +
      `---`;

    if (withImage && imageDataUrl) {
      // Multimodal: pass image alongside text
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `${header}\n\n${text || ''}` },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      });
    } else {
      messages.push({ role: 'user', content: `${header}\n\n${text || ''}` });
    }
  }

  // Append conversation history (skip the last user message we just added if any)
  if (history && history.length) {
    for (const m of history) {
      // Avoid duplicating the page-context message we just pushed
      if (pageContext && messages.length && m === messages[0]) continue;
      messages.push(m);
    }
  }

  // Final user instruction
  messages.push({ role: 'user', content: userText || '(no instruction; just respond to the page context)' });

  return messages;
}
