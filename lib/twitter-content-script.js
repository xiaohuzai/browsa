// lib/twitter-content-script.js
//
// Injected into twitter.com / x.com pages at document_start (MAIN world).
// Intercepts GraphQL API calls for individual tweet detail pages.
//
// Twitter uses GraphQL with rotating operation hashes in the path:
//   https://twitter.com/i/api/graphql/{HASH}/TweetDetail
//   https://twitter.com/i/api/graphql/{HASH}/TweetResultByRestId
//
// The hash changes with each deploy but the operation name suffix is stable.
// We match on the pathname pattern rather than the exact hash.

function isTwitterTweetUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : undefined);
    return (u.hostname === 'twitter.com' || u.hostname === 'x.com') &&
      u.pathname.includes('/graphql/') &&
      (u.pathname.endsWith('/TweetDetail') || u.pathname.endsWith('/TweetResultByRestId'));
  } catch (_) { return false; }
}

// Navigate Twitter GraphQL response structure to find a single tweet.
function extractTweetFromResult(result) {
  if (!result) return null;
  // Unwrap typename wrappers
  const tweet = result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
  const legacy = tweet?.legacy;
  if (!legacy?.id_str) return null;
  const user = tweet?.core?.user_results?.result?.legacy;
  return {
    tweetId: legacy.id_str,
    text: (legacy.full_text || legacy.text || '').trim(),
    author: (user?.name || '').trim(),
    screenName: (user?.screen_name || '').trim(),
    likes: legacy.favorite_count || 0,
    retweets: legacy.retweet_count || 0,
    replies: legacy.reply_count || 0,
    quotes: legacy.quote_count || 0,
    lang: legacy.lang || '',
    createdAt: legacy.created_at || '',
    rawAt: Date.now()
  };
}

function extractTwitterTweet(data) {
  try {
    // TweetResultByRestId
    const byId = data?.data?.tweetResult?.result;
    if (byId) return extractTweetFromResult(byId);

    // TweetDetail: conversation thread — take the first tweet in the first entry
    const instructions =
      data?.data?.threaded_conversation_with_injections_v2?.instructions || [];
    for (const inst of instructions) {
      if (inst.type !== 'TimelineAddEntries') continue;
      for (const entry of (inst.entries || [])) {
        const itemContent = entry?.content?.itemContent;
        if (itemContent?.itemType === 'TimelineTweet') {
          const result = itemContent?.tweet_results?.result;
          if (result) return extractTweetFromResult(result);
        }
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

function installTwitterInterceptor() {
  if (typeof window === 'undefined') return false;
  if (typeof chrome === 'undefined' || !chrome.runtime) return false;
  if (window.__browsaTwitterInterceptorInstalled) return true;
  window.__browsaTwitterInterceptorInstalled = true;

  function safeSend(tweet) {
    try { chrome.runtime.sendMessage({ type: 'TWITTER_TWEET', tweet }); } catch (_) {}
  }

  const nativeFetch = window.fetch?.bind(window);
  if (nativeFetch) {
    window.fetch = function browsaFetch(input, init) {
      const url = typeof input === 'string' ? input : (input?.url || '');
      const p = nativeFetch(input, init);
      if (isTwitterTweetUrl(url)) {
        p.then(r => r.clone().json())
          .then(data => { const t = extractTwitterTweet(data); if (t) safeSend(t); })
          .catch(() => {});
      }
      return p;
    };
  }

  // XHR fallback
  const NativeXHR = window.XMLHttpRequest;
  if (NativeXHR?.prototype) {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function(method, url) {
      this.__browsaUrl = String(url || '');
      return nativeOpen.apply(this, arguments);
    };
    NativeXHR.prototype.send = function() {
      if (isTwitterTweetUrl(this.__browsaUrl)) {
        this.addEventListener('load', function() {
          try {
            const t = extractTwitterTweet(JSON.parse(this.responseText));
            if (t) safeSend(t);
          } catch (_) {}
        });
      }
      return nativeSend.apply(this, arguments);
    };
  }

  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isTwitterTweetUrl, extractTweetFromResult, extractTwitterTweet, installTwitterInterceptor };
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  installTwitterInterceptor();
}
