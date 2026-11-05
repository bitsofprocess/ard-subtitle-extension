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
   * Returns the UUID string, or null if it can't be extracted.
   */
  function extractContentId() {
    try {
      var pathParts = location.pathname.split('/');
      var last = pathParts[pathParts.length - 1];
      if (!last) return null;
      var decoded = atob(last);
      // Extract the UUID-like portion: planARD_<uuid>_
      var m = decoded.match(/planARD_([a-f0-9-]+)_/);
      return m ? m[1] : decoded;
    } catch (e) {
      return null;
    }
  }

  /**
   * Check whether the raw JSON blob at least mentions the current
   * video's content ID.  If not, the data is likely stale (from a
   * previous SPA navigation) and should be re-polled.
   */
  function pageDataMatchesCurrentVideo(raw) {
    var contentId = extractContentId();
    if (!contentId) return true; // can't verify, assume OK
    return raw.indexOf(contentId) !== -1;
  }

  /**
   * Try to match a subtitle URL against the current video's content ID.
   * Tries multiple strategies: exact UUID match, last-path-segment match.
   */
  function subtitleUrlMatchesContentId(url) {
    var contentId = extractContentId();
    if (!contentId) return false;

    // Strategy 1: UUID appears directly in the URL.
    if (url.indexOf(contentId) !== -1) return true;

    // Strategy 2: the content ID as it appears in the page path
    // (base64 form) matches the last segment of the subtitle URL.
    try {
      var pathParts = location.pathname.split('/');
      var pageLastSegment = pathParts[pathParts.length - 1];
      var subPathParts = new URL(url).pathname.split('/');
      var subLastSegment = subPathParts[subPathParts.length - 1];
      if (pageLastSegment && subLastSegment &&
          pageLastSegment === subLastSegment) {
        return true;
      }
    } catch (e) { /* ignore */ }

    return false;
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

    // Try to find the subtitle URL that belongs to the current video.
    // We match by the content ID extracted from the page URL against
    // each candidate, regardless of how many there are.
    var contentId = extractContentId();
    console.log('[subtitle-discover] page content ID:', contentId);

    if (contentId) {
      for (var i = 0; i < allMatches.length; i++) {
        if (subtitleUrlMatchesContentId(allMatches[i])) {
          console.log('[subtitle-discover] matched current video at index', i, ':', allMatches[i]);
          return { url: allMatches[i], reason: null };
        }
      }
      // No match found via content ID.
      console.warn('[subtitle-discover] could NOT match any subtitle URL to current video');
      console.warn('[subtitle-discover] page content ID:', contentId);
      console.warn('[subtitle-discover] candidates:', allMatches);
      // Fall through — return the first URL anyway (best effort).
    }

    return { url: allMatches[0], reason: null };
  }

  /**
   * Find the most recently fetched subtitle URL in the performance
   * resource-timing buffer.  The ARD player fetches subtitle XML via
   * fetch()/XHR, so the URL shows up here regardless of whether
   * #fetchedContextValue was populated.
   */
  function findSubtitleUrlInPerformance() {
    try {
      var entries = performance.getEntriesByType('resource');
      var last = null;
      for (var i = 0; i < entries.length; i++) {
        if (/player-service\/subtitle\/ebutt\//.test(entries[i].name)) {
          last = entries[i].name;
        }
      }
      return last;
    } catch (e) {
      return null;
    }
  }

  /**
   * Wait for subtitle data to become available, from EITHER source:
   *   1. #fetchedContextValue populated with the current video's data, OR
   *   2. A subtitle URL appearing in the performance resource buffer
   *      (the player fetched it after CC was enabled).
   *
   * Resolves with { source: 'blob' } | { source: 'performance', url }
   * | { source: 'timeout' }.
   */
  function waitForSubtitleData(maxWaitMs) {
    if (maxWaitMs === undefined) maxWaitMs = 60000; // 60s
    var start = Date.now();

    return new Promise(function (resolve) {
      function check() {
        // Source 1: page-data blob ready + matches current video.
        var el = document.getElementById('fetchedContextValue');
        if (el) {
          var raw = (el.textContent || '').trim();
          if (raw.length >= 100 && pageDataMatchesCurrentVideo(raw)) {
            resolve({ source: 'blob' });
            return;
          }
        }

        // Source 2: subtitle URL already fetched by the player.
        var url = findSubtitleUrlInPerformance();
        if (url) {
          resolve({ source: 'performance', url: url });
          return;
        }

        if (Date.now() - start >= maxWaitMs) {
          resolve({ source: 'timeout' });
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
    var cues = SubtitleParser.parse(xml);
    // Log the first few cues so we can verify they match the current video.
    if (cues.length > 0) {
      var preview = cues.slice(0, 3).map(function (c) { return c.text; });
      console.log('[subtitle-discover] first 3 cues:', preview);
    }
    return cues;
  }

  /**
   * If the ARD player's CC button is off, click it to enable subtitles.
   * Since mid-2025, ARD only loads subtitle metadata into
   * #fetchedContextValue when CC is on, so we auto-toggle it.
   * Returns true if we clicked the button, false otherwise.
   */
  function tryEnableSubtitles() {
    try {
      var btn = document.querySelector('button[data-initiator-name*="subtitle"]');
      if (!btn) {
        console.log('[subtitle-discover] CC button not found in player');
        return false;
      }
      if (btn.getAttribute('aria-pressed') === 'true') {
        console.log('[subtitle-discover] CC already enabled');
        return false;
      }
      console.log('[subtitle-discover] CC is off — auto-enabling subtitles');
      btn.click();
      return true;
    } catch (e) {
      console.warn('[subtitle-discover] error trying to enable CC:', e.message);
      return false;
    }
  }

  /**
   * If the ARD player's CC button is on, click it to disable subtitles.
   * Called after we've captured the subtitle data, so the extension's
   * overlay doesn't compete with ARD's native subtitles.
   */
  function tryDisableSubtitles() {
    try {
      var btn = document.querySelector('button[data-initiator-name*="subtitle"]');
      if (!btn) return;
      if (btn.getAttribute('aria-pressed') !== 'true') return;
      console.log('[subtitle-discover] turning CC back off (extension overlay takes over)');
      btn.click();
    } catch (e) {
      console.warn('[subtitle-discover] error trying to disable CC:', e.message);
    }
  }

  async function handleDiscover() {
    // The subtitle URL can come from two places:
    //   1. #fetchedContextValue (page-data blob) — has content-ID matching.
    //   2. The performance resource buffer — the player fetches the
    //      subtitle XML directly, which shows up as a resource entry.
    // We try (1) first, then fall back to (2).  If neither is ready,
    // auto-enable CC and wait for either to appear.
    var subtitleUrl = null;
    var source = null;

    // Try the page-data blob first (precise content-ID matching).
    var result = extractSubtitleUrl();
    if (result.url) {
      subtitleUrl = result.url;
      source = 'page-data';
    }

    if (!subtitleUrl) {
      // The subtitle may already have been fetched (CC already on).
      subtitleUrl = findSubtitleUrlInPerformance();
      if (subtitleUrl) {
        source = 'performance';
      } else {
        // Auto-enable CC, then wait for either source.
        tryEnableSubtitles();
        console.log('[subtitle-discover] waiting for subtitle data (up to 60s)…');
        var data = await waitForSubtitleData();
        if (data.source === 'performance') {
          subtitleUrl = data.url;
          source = 'performance';
        } else if (data.source === 'blob') {
          var r2 = extractSubtitleUrl();
          if (r2.url) {
            subtitleUrl = r2.url;
            source = 'page-data';
          }
        }
      }
    }

    if (!subtitleUrl) {
      var errMsg = 'Subtitle data not found. The video may not have subtitles available, or the player has not loaded them. Try enabling subtitles (CC) in the ARD player and click "Translate This Video" again.';
      console.warn('[subtitle-discover] ' + errMsg);
      return { ok: false, error: errMsg };
    }

    console.log('[subtitle-discover] subtitle URL (' + source + '):', subtitleUrl);

    var cues = await fetchAndParse(subtitleUrl);
    console.log('[subtitle-discover] parsed', cues.length, 'cues');

    // Turn CC back off so ARD's native subtitles don't overlap with the overlay.
    tryDisableSubtitles();

    return { ok: true, cues: cues, subtitleUrl: subtitleUrl };
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