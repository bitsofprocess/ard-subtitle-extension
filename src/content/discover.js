/*
 * Streamlined import — subtitle URL discovery + fetch + parse.
 *
 * Runs on `ardmediathek.de/video/*` pages.  Does NOT auto-run — it waits
 * for a `DISCOVER` message from the background service worker (sent when
 * the user clicks the toolbar icon).  The fetch must happen here, from the
 * content script, so it goes out under the ARD page's own origin (the
 * subtitle endpoint whitelists only `https://www.ardmediathek.de`).
 *
 * Depends on `src/parser/parser.js` (loaded first via manifest.json) for
 * `SubtitleParser`.
 */
(function () {
  'use strict';

  var SUBTITLE_URL_RE =
    /https:\/\/api\.ardmediathek\.de\/player-service\/subtitle\/ebutt\/[^"]+/g;

  /**
   * Extract the content ID from an ARD video page URL.
   * The last path segment is a base64-encoded content ID.
   * Returns the decoded ID, or null if it can't be extracted.
   */
  function extractContentId() {
    try {
      var pathParts = location.pathname.split('/');
      var last = pathParts[pathParts.length - 1];
      if (!last) return null;
      // Base64 decode (the ID is in the format "crid://ard.de/...")
      var decoded = atob(last);
      // Extract the UUID-like portion: planARD_<uuid>_
      var m = decoded.match(/planARD_([a-f0-9-]+)_/);
      return m ? m[1] : decoded;
    } catch (e) {
      return null;
    }
  }

  function extractSubtitleUrl() {
    var el = document.getElementById('fetchedContextValue');
    if (!el) {
      console.warn('[subtitle-discover] #fetchedContextValue element NOT found in page DOM');
      return { url: null, reason: 'NO_ELEMENT' };
    }

    var raw = el.textContent || '';

    // If the blob is suspiciously small, the page may not have populated
    // it yet (ARD lazy-loads page data via page-gateway after the initial
    // HTML render).  Signal that the caller should retry.
    if (raw.length < 100) {
      return { url: null, reason: 'TOO_SMALL', size: raw.length };
    }

    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.warn('[subtitle-discover] failed to JSON.parse #fetchedContextValue:', e.message);
      return { url: null, reason: 'PARSE_FAILED' };
    }

    // Find ALL subtitle URLs in the JSON (not just the first one).
    var jsonStr = JSON.stringify(data);
    var allMatches = [];
    var m;
    SUBTITLE_URL_RE.lastIndex = 0;
    while ((m = SUBTITLE_URL_RE.exec(jsonStr)) !== null) {
      allMatches.push(m[0]);
    }

    if (allMatches.length === 0) {
      console.log('[subtitle-discover] #fetchedContextValue parsed but no subtitle URL in JSON blob');
      return { url: null, reason: 'NO_MATCH' };
    }

    console.log('[subtitle-discover] found', allMatches.length, 'subtitle URL(s) in page data:', allMatches);

    // If there are multiple subtitle URLs (e.g. from related/recommended
    // episodes in the page data), try to pick the one that belongs to the
    // current video.  We match by the content ID extracted from the page
    // URL against each subtitle URL.
    if (allMatches.length > 1) {
      var contentId = extractContentId();
      console.log('[subtitle-discover] page content ID:', contentId);
      if (contentId) {
        for (var i = 0; i < allMatches.length; i++) {
          if (allMatches[i].indexOf(contentId) !== -1) {
            console.log('[subtitle-discover] matched current video at index', i, ':', allMatches[i]);
            return { url: allMatches[i], reason: null };
          }
        }
      }
      // Fallback: log a warning and use the first match.
      console.warn('[subtitle-discover] could not identify which subtitle URL belongs to current video — using first match');
    }

    return { url: allMatches[0], reason: null };
  }

  /**
   * Wait for #fetchedContextValue to be populated.  ARD lazy-loads page
   * data via an async call to page-gateway after the initial HTML render.
   * If the user clicks immediately on landing, the blob may still be
   * near-empty (~13 chars).  This polls every 300ms for up to 10s.
   * Returns true once populated, false on timeout.
   */
  function waitForPageState(maxWaitMs) {
    if (maxWaitMs === undefined) maxWaitMs = 10000;
    var start = Date.now();

    return new Promise(function (resolve) {
      var el = document.getElementById('fetchedContextValue');
      if (!el) { resolve(false); return; }

      function check() {
        var raw = (el.textContent || '').trim();
        if (raw.length >= 100) {
          resolve(true);
          return;
        }
        if (Date.now() - start >= maxWaitMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 300);
      }
      check();
    });
  }

  async function fetchAndParse(url) {
    var resp = await fetch(url);
    if (!resp.ok) {
      throw new Error('Subtitle fetch failed: HTTP ' + resp.status);
    }
    var xml = await resp.text();
    return SubtitleParser.parse(xml);
  }

  async function handleDiscover() {
    // If the page state hasn't been populated yet, wait for it.
    var raw = (document.getElementById('fetchedContextValue') || {}).textContent || '';
    if (raw.length < 100) {
      console.log('[subtitle-discover] #fetchedContextValue is ' + raw.length + ' chars — waiting for page-gateway to populate…');
      var populated = await waitForPageState();
      if (!populated) {
        console.warn('[subtitle-discover] timed out waiting for page state');
        return { ok: false, error: 'Page data not yet loaded — try again in a moment' };
      }
      console.log('[subtitle-discover] page state populated');
    }

    var result = extractSubtitleUrl();

    if (!result.url) {
      var errMsg;
      if (result.reason === 'NO_ELEMENT') {
        errMsg = 'No #fetchedContextValue element on page (not a video page, or page not fully loaded?)';
      } else if (result.reason === 'NO_MATCH') {
        errMsg = 'No subtitle URL found in page data — this video may not have subtitles available';
      } else if (result.reason === 'TOO_SMALL' || result.reason === 'TOO_SMALL_TIMEOUT') {
        errMsg = 'Page data not yet populated — try again in a moment (ARD lazy-loads page state)';
      } else {
        errMsg = 'Failed to extract subtitle URL from page';
      }
      console.warn('[subtitle-discover] ' + errMsg);
      return { ok: false, error: errMsg };
    }

    console.log('[subtitle-discover] DISCOVER request — subtitle URL:', result.url);

    var cues = await fetchAndParse(result.url);
    console.log('[subtitle-discover] parsed', cues.length, 'cues');

    return { ok: true, cues: cues, subtitleUrl: result.url };
  }

  // --- Message listener --------------------------------------------------

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.type === 'DISCOVER') {
      handleDiscover().then(sendResponse).catch(function (err) {
        console.error('[subtitle-discover] DISCOVER failed:', err.message);
        sendResponse({ ok: false, error: err.message || String(err) });
      });
      return true; // async sendResponse
    }
  });
})();