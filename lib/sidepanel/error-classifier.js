// lib/sidepanel/error-classifier.js — map raw LLM/network error text to a
// friendly i18n key so appendError() can lead with a human headline and keep
// the raw message collapsed below (Cherry Studio's ErrorBlock pattern:
// classified title on top, 3-line-clamped detail underneath).
//
// Pure string-in/string-out with no chrome.* dependency so it unit-tests in
// plain Node. Returns { key } for a known class, or null when nothing
// matched — callers then fall back to rendering the raw text alone instead
// of inventing a headline (honest-by-default, no fake classification).

const PATTERNS = [
  // Order matters: first match wins. Keep each regex anchored to the most
  // specific signal available in real provider/background error strings.
  { key: 'errAuth', re: /\b(401|403)\b|unauthorized|forbidden|invalid.{0,12}api.?key|invalid_api_key|incorrect api key|authentication/i },
  { key: 'errRateLimit', re: /\b429\b|rate.?limit|too many requests|quota exceeded|insufficient_quota/i },
  { key: 'errModel', re: /model.{0,24}(not found|does not exist|not exist|decommissioned)|invalid model|model_not_found|unknown model/i },
  { key: 'errTimeout', re: /timeout|timed?\s*out|etimedout|deadline exceeded/i },
  { key: 'errNetwork', re: /failed to fetch|networkerror|network error|econnrefused|econnreset|getaddrinfo|enotfound|dns|err_connection|ssl|certificate|cors/i },
  { key: 'errServer', re: /\b5\d{2}\b|internal server error|bad gateway|service unavailable|overloaded|server error/i },
];

export function classifyErrorText(text) {
  const t = String(text || '');
  if (!t) return null;
  for (const { key, re } of PATTERNS) {
    if (re.test(t)) return { key };
  }
  return null;
}
