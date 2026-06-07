// lib/page-extractor.js
// Extracts page context from the active tab. The user can choose the mode:
//   - 'full'       : send full HTML (truncated to MAX_HTML_CHARS)
//   - 'selected'   : send only the user's text selection
//   - 'screenshot' : send a data: URL PNG of the visible tab
//   - 'summary'    : ask the model to summarize first (we do this client-side by
//                    just sending a meta instruction to summarize before answering)
//
// Returns: { text?: string, imageDataUrl?: string, meta: { url, title, ... } }

const MAX_HTML_CHARS = 60_000; // 60KB cap to avoid blowing context
const MAX_TEXT_CHARS = 20_000;

export async function extractActiveTab({ mode = 'full' } = {}) {
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
    const html = document.documentElement ? document.documentElement.outerHTML : '';
    return { html, selection: sel };
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
        result.text = `[No text selected — falling back to full page]\n\n${truncate(stripHtml(page.html), MAX_TEXT_CHARS)}`;
        result.fallback = true;
      } else {
        result.text = truncate(sel, MAX_TEXT_CHARS);
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
      result.text = truncate(stripHtml(page.html), MAX_TEXT_CHARS);
      break;
    }
  }

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
