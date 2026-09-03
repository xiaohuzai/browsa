// lib/sanitize-url.js — strip credential-bearing fragments from URLs that end
// up in prompt-facing page context (the URL header line, article links,
// reference lists). Pages routinely embed signed/session URLs in their links
// (…?token=…&access_token=…#access_token=…) — those secrets are of no use to
// the model and must not leak into whatever the provider logs.
//
// Scope discipline: this layer is ONLY for text sent to the model. URLs that
// browsa itself fetches (media streams, image downloads) go through
// lib/page-images.js / media-handler.js untouched — stripping a signature from
// a signed CDN URL would break the fetch.

// Query parameter names whose values are credentials if present. Matched
// whole-name, case-insensitive, separators (_ -) folded. Deliberately
// conservative about short generic names (`code`, `key` are excluded — too
// many false positives like promo codes and sort keys; `api_key`/`api_key`
// forms are covered explicitly). Over-redaction costs the model URL fidelity
// for zero security gain.
const SENSITIVE_PARAM = new RegExp(
  '^(?:' +
  'pass(?:word|wd)?|secret|private[_-]?key|sess(?:ion)?[_-]?id|sid|auth(?:oriz(?:ation)|enticate)?|' +
  'access[_-]?token|id[_-]?token|refresh[_-]?token|api[_-]?key|api[_-]?secret|apikey|token|' +
  'sig(?:nature)?|credential[s]?|client[_-]?secret|jwt|saml|ticket' +
  ')$',
  'i'
);

// Fragments (after #) that look like credential-carrying params — OAuth
// implicit-flow callbacks put access_token in the hash. A hash carrying any
// of them is dropped entirely (fragment content is never worth keeping).
const SENSITIVE_HASH = /(?:access|id|refresh)_token=|(?:^|&)(?:token|sig(?:nature)?|session[_-]?id|api[_-]?key)=/i;

export function redactUrlCredentials(url) {
  const s = String(url ?? '');
  if (!/^https?:\/\//i.test(s)) return s; // data:/blob:/relative — untouched
  let u;
  try { u = new URL(s); } catch (_) { return s; }
  // user:pass@host — drop the userinfo entirely.
  let hit = false;
  if (u.username || u.password) { u.username = ''; u.password = ''; hit = true; }
  const params = [...u.searchParams.entries()];
  for (const [k, v] of params) {
    if (v && SENSITIVE_PARAM.test(k.trim())) {
      u.searchParams.set(k, '…');
      hit = true;
    }
  }
  if (u.hash && SENSITIVE_HASH.test(u.hash)) { u.hash = ''; hit = true; }
  return hit ? u.toString() : s; // no-op → return the original string as-is
}

// Apply redaction to every http(s) URL embedded in a block of context text
// (markdown links, bare URLs in reference lists, image syntax). The pattern
// stops at whitespace and the characters that markdown/citation syntax wraps
// URLs in, so `[text](url)` and text⟨N⟩-style reference lines are handled
// without touching surrounding text.
export function redactTextUrls(text) {
  return String(text ?? '').replace(/https?:\/\/[^\s<>"'）)\]}]+/g, redactUrlCredentials);
}
