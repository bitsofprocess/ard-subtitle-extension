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

    var match = JSON.stringify(data).match(SUBTITLE_URL_RE);
    if (!match) {
      console.log('[subtitle-discover] #fetchedContextValue parsed but no subtitle URL in JSON blob');
      return { url: null, reason: 'NO_MATCH' };
    }

    return { url: match[0], reason: null };
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