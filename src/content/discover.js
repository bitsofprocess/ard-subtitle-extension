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
    /https:\/\/api\.ardmediathek\.de\/player-service\/subtitle\/ebutt\/[^"]+/;

  function extractSubtitleUrl() {
    var el = document.getElementById('fetchedContextValue');
    if (!el) return null;

    var data;
    try {
      data = JSON.parse(el.textContent);
    } catch (e) {
      console.warn('[subtitle-discover] failed to JSON.parse #fetchedContextValue:', e.message);
      return null;
    }

    var match = JSON.stringify(data).match(SUBTITLE_URL_RE);
    return match ? match[0] : null;
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
    var url = extractSubtitleUrl();
    if (!url) {
      return { ok: false, error: 'No subtitle URL found on this page' };
    }

    console.log('[subtitle-discover] DISCOVER request — subtitle URL:', url);

    var cues = await fetchAndParse(url);
    console.log('[subtitle-discover] parsed', cues.length, 'cues');

    return { ok: true, cues: cues, subtitleUrl: url };
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