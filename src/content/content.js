/*
 * Content script: subtitle overlay for video pages.
 *
 *  1. Finds the <video> element and a suitable container inside the player.
 *  2. Loads stored (parsed + translated) cues from chrome.storage.local.
 *  3. Syncs the active cue to video.currentTime (+ user offset).
 *  4. Renders the cue as clickable word spans.
 *  5. Clicking a word shows the lemma + contextual gloss in a popup.
 *  6. Full-sentence translation revealed on hover.
 *  7. Fullscreen support — overlay moves into the fullscreen element.
 */

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────
  var video = null;
  var cues = null;
  var activeCueIdx = -1;
  var syncRaf = null;

  // ── Overlay positioning ─────────────────────────────────────────────

  function repositionOverlay() {
    var overlay = document.getElementById('__subtitle_translator_overlay__');
    if (!overlay || !video) return;
    if (!document.body.contains(overlay)) return;

    // Position against the <video> element's rect so the overlay
    // exactly covers the video viewport, not a larger player wrapper.
    var r = video.getBoundingClientRect();
    overlay.style.position = 'fixed';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    overlay.style.zIndex = '2147483640';
  }

  // ── Selectors (tried in order for video & container) ────────────────

  var VIDEO_SELECTORS = [
    'video',                                     // plain <video>
    '[data-ctrl-enter] video',                   // ARD player
    '.vjs-tech',                                 // Video.js players
    '.hls-player video',                         // common HLS wrappers
    '.plyr video',                               // Plyr player
    '.media-player video',                       // generic
  ];



  function createOverlay() {
    var ol = document.createElement('div');
    ol.id = '__subtitle_translator_overlay__';
    ol.innerHTML =
      '<style>' +
      '  #__subtitle_translator_overlay__ {' +
      '    display: flex;' +
      '    flex-direction: column;' +
      '    align-items: center;' +
      '    justify-content: flex-end;' +
      '    padding-bottom: 8%;' +
      '    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif;' +
      '    pointer-events: none;' +
      '    user-select: none;' +
      '  }' +
      '  #__st_cue__ {' +
      '    display: none;' +
      '    background: rgba(0,0,0,0.7);' +
      '    border-radius: 6px;' +
      '    padding: 8px 16px;' +
      '    max-width: 95%;' +
      '    line-height: 1.7;' +
      '    font-size: 26px;' +
      '    text-shadow: 1px 1px 3px rgba(0,0,0,0.8);' +
      '    pointer-events: auto;' +
      '  }' +
      '  /* Show English translation on hover */ ' +
      '  #__st_cue__:hover .__st_translation__ { display: block; }' +
      '  .__st_word__ {' +
      '    color: #fff;' +
      '    cursor: pointer;' +
      '    transition: color 0.15s, background 0.15s;' +
      '    border-radius: 3px;' +
      '    padding: 1px 2px;' +
      '    pointer-events: auto;' +
      '  }' +
      '  .__st_word__:hover { color: #e94560; background: rgba(255,255,255,0.25); }' +
      '  .__st_translation__ {' +
      '    display: none;' +
      '    color: #ccc;' +
      '    font-style: italic;' +
      '    font-size: 0.85em;' +
      '    margin-bottom: 4px;' +
      '    padding-bottom: 4px;' +
      '    border-bottom: 1px solid rgba(255,255,255,0.15);' +
      '  }' +
      '  #__st_gloss__ {' +
      '    display: none;' +
      '    position: absolute;' +
      '    background: #1a1a2e;' +
      '    border: 1px solid #e94560;' +
      '    border-radius: 6px;' +
      '    padding: 10px 14px;' +
      '    min-width: 120px;' +
      '    max-width: 260px;' +
      '    text-align: left;' +
      '    font-size: 13px;' +
      '    line-height: 1.4;' +
      '    z-index: 9999;' +
      '    box-shadow: 0 4px 16px rgba(0,0,0,0.6);' +
      '    pointer-events: auto;' +
      '  }' +
      '  #__st_gloss__ .__st_gloss_w { color: #e94560; font-weight: 700; margin-bottom: 4px; }' +
      '  #__st_gloss__ .__st_gloss_lemma { color: #a0a0b0; font-size: 0.85em; }' +
      '  #__st_gloss__ .__st_gloss_gloss { color: #e0e0e0; margin-top: 4px; }' +
      '</style>' +
      '<div id="__st_cue__"></div>' +
      '<div id="__st_gloss__"></div>';

    return ol;
  }

  // ── Cue lookup ───────────────────────────────────────────────────────

  // Binary-search for the cue whose [start, end) contains `timeSeconds`.
  function findActiveCue(timeSec) {
    if (!cues || cues.length === 0) return -1;
    var lo = 0;
    var hi = cues.length - 1;

    // binary search for the last cue with start <= timeSec
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      if (cues[mid].start <= timeSec) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    // Check if timeSec falls within [start, end) of the found cue.
    if (lo >= 0 && lo < cues.length &&
        timeSec >= cues[lo].start && timeSec < cues[lo].end) {
      return lo;
    }
    return -1;
  }

  // ── Rendering ────────────────────────────────────────────────────────

  function renderCue(cueIdx) {
    var cueEl = document.getElementById('__st_cue__');

    if (cueIdx < 0 || !cues || cueIdx >= cues.length) {
      cueEl.innerHTML = '';
      cueEl.style.display = 'none';
      return;
    }

    cueEl.style.display = 'inline-block';
    cueEl.innerHTML = '';

    var cue = cues[cueIdx];

    // Full-sentence translation (revealed on hover via CSS).
    if (cue.translation) {
      var tDiv = document.createElement('div');
      tDiv.className = '__st_translation__';
      tDiv.textContent = cue.translation;
      cueEl.appendChild(tDiv);
    }

    // Split cue text into lines (for speaker-change <br/> in source) and
    // then into words.  We keep a running token index that maps to cue.tokens.
    var lines = cue.text.split('\n');
    var tokenIdx = 0;

    for (var li = 0; li < lines.length; li++) {
      if (li > 0) {
        cueEl.appendChild(document.createElement('br'));
      }

      var line = lines[li];
      // Split on word boundaries: sequences of non-whitespace.
      var parts = [];
      var re = /(\S+)|(\s+)/g;
      var m;
      while ((m = re.exec(line)) !== null) {
        if (m[1] !== undefined) {
          parts.push({ type: 'word', text: m[1] });
        } else {
          parts.push({ type: 'space', text: m[2] });
        }
      }

      for (var pi = 0; pi < parts.length; pi++) {
        var part = parts[pi];
        if (part.type === 'space') {
          cueEl.appendChild(document.createTextNode(part.text));
        } else {
          var span = document.createElement('span');
          span.className = '__st_word__';
          span.textContent = part.text;
          span.dataset.tokenIdx = tokenIdx;
          span.addEventListener('click', (function (idx, event) {
            onWordClick(event, cueIdx, idx);
          }).bind(null, tokenIdx));
          cueEl.appendChild(span);
          tokenIdx++;
        }
      }
    }
  }

  // ── Gloss popup ──────────────────────────────────────────────────────

  function onWordClick(event, cueIdx, tokenIdx) {
    event.stopPropagation();

    var cue = cues[cueIdx];
    if (!cue) return;

    var glossEl = document.getElementById('__st_gloss__');

    // Pause so the viewer can read the gloss.
    if (video && !video.paused) {
      video.pause();
    }

    // Show sentence-level translation (per-word glosses are Phase 4).
    var word = cue.tokens
      ? (cue.tokens[tokenIdx] ? cue.tokens[tokenIdx].w : event.target.textContent)
      : event.target.textContent;

    glossEl.innerHTML =
      '<div class="__st_gloss_w">' + escapeHTML(word) + '</div>' +
      '<div class="__st_gloss_gloss">' +
        (cue.translation && cue.translation !== cue.text
          ? escapeHTML(cue.translation)
          : '(no translation yet — re-run import page)') +
      '</div>';

    positionGloss(event, glossEl);
  }

  function positionGloss(event, glossEl) {
    var overlay = document.getElementById('__subtitle_translator_overlay__');
    var overlayRect = overlay.getBoundingClientRect();
    var spanRect = event.target.getBoundingClientRect();

    var left = spanRect.left - overlayRect.left + spanRect.width / 2;
    var top = spanRect.top - overlayRect.top - 8;

    glossEl.style.display = '';
    glossEl.style.left = '0px';
    glossEl.style.top = '-9999px';

    var glossRect = glossEl.getBoundingClientRect();
    var pw = overlayRect.width;

    var desiredLeft = left - glossRect.width / 2;
    if (desiredLeft < 4) desiredLeft = 4;
    if (desiredLeft + glossRect.width > pw - 4) desiredLeft = pw - glossRect.width - 4;

    var desiredTop = top - glossRect.height;
    if (desiredTop < 4) {
      desiredTop = spanRect.bottom - overlayRect.top + 8;
    }

    glossEl.style.left = desiredLeft + 'px';
    glossEl.style.top = desiredTop + 'px';
  }

  function hideGloss() {
    var glossEl = document.getElementById('__st_gloss__');
    if (glossEl) glossEl.style.display = 'none';
  }

  function escapeHTML(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Sync loop ────────────────────────────────────────────────────────

  var lastRenderedIdx = -1;

  function sync() {
    if (!video || !cues) {
      syncRaf = requestAnimationFrame(sync);
      return;
    }

    var t = video.currentTime;
    var idx = findActiveCue(t);

    if (idx !== lastRenderedIdx) {
      lastRenderedIdx = idx;
      renderCue(idx);
    }

    syncRaf = requestAnimationFrame(sync);
  }

  // ── Fullscreen ──────────────────────────────────────────────────────

  function onFullscreenChange() {
    var fsEl = document.fullscreenElement;
    var overlay = document.getElementById('__subtitle_translator_overlay__');
    if (!overlay) return;

    if (fsEl) {
      // Move overlay INTO the fullscreen element so it renders on top.
      try {
        fsEl.appendChild(overlay);
        overlay.style.position = 'absolute';
        overlay.style.left = '0px';
        overlay.style.top = '0px';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
      } catch (e) { /* ignore */ }
    } else {
      // Back to body + fixed positioning over the video.
      try { document.body.appendChild(overlay); } catch (e) { /* ignore */ }
      repositionOverlay();
    }
  }

  // ── Boot / teardown ──────────────────────────────────────────────────

  /**
   * Look up stored cues for `url`.  Normalises the URL to ignore query
   * params (ARD passes ?startTime=0 etc.).
   */
  function normalizeUrl(url) {
    try {
      var u = new URL(url);
      // Strip common noisy params.
      u.searchParams.delete('startTime');
      u.searchParams.delete('t');
      u.searchParams.delete('autoplay');
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  async function loadCues() {
    var normalized = normalizeUrl(location.href);
    cues = await SubtitleStorage.getCues(normalized);

    // If no exact match, try stored keys that start with the same origin+path.
    if (!cues || cues.length === 0) {
      var allUrls = await SubtitleStorage.listVideoUrls();
      for (var i = 0; i < allUrls.length; i++) {
        if (normalized.indexOf(normalizeUrl(allUrls[i])) === 0 ||
            normalizeUrl(allUrls[i]).indexOf(normalized) === 0) {
          cues = await SubtitleStorage.getCues(allUrls[i]);
          if (cues && cues.length > 0) break;
        }
      }
    }

    if (cues && cues.length > 0) {
      console.log('[subtitle-translator] loaded ' + cues.length + ' cues');
      return true;
    }
    return false;
  }

  function wireGlossDismiss() {
    // Click anywhere in the overlay (but not on a word) → dismiss gloss.
    document.getElementById('__subtitle_translator_overlay__').addEventListener('click', function (e) {
      if (e.target.id === '__subtitle_translator_overlay__' ||
          e.target.id === '__st_cue__') {
        hideGloss();
      }
    });

    // Global click (outside overlay) → dismiss gloss.
    document.addEventListener('click', function (e) {
      var overlay = document.getElementById('__subtitle_translator_overlay__');
      if (overlay && !overlay.contains(e.target)) {
        hideGloss();
      }
    });
  }

  async function tryBoot() {
    // Already set up.
    if (document.getElementById('__subtitle_translator_overlay__')) return;

    // 1. Find video.
    for (var i = 0; i < VIDEO_SELECTORS.length; i++) {
      video = document.querySelector(VIDEO_SELECTORS[i]);
      if (video) break;
    }
    if (!video) return; // no video on page yet

    // 2. Check for stored cues.
    var hasCues = await loadCues();
    if (!hasCues) return;

    // 3. Inject overlay onto document.body (fixed over the video) to
    //    avoid overflow:hidden clipping inside the player.
    var overlay = createOverlay();
    document.body.appendChild(overlay);
    repositionOverlay();

    // Keep position in sync on resize.
    window.addEventListener('resize', repositionOverlay);
    // Fullscreen: move overlay into the fullscreen element.
    document.addEventListener('fullscreenchange', onFullscreenChange);

    // 4. Wire gloss dismissal.
    wireGlossDismiss();

    // 5. Start sync loop.
    sync();
  }

  // ── Entry point ──────────────────────────────────────────────────────

  // Wait for the page to settle, then try to boot.
  function scheduleBoot() {
    // Debounce — video players sometimes replace <video> elements during init.
    if (scheduleBoot._timer) clearTimeout(scheduleBoot._timer);
    scheduleBoot._timer = setTimeout(tryBoot, 600);
  }

  // Try on load.
  if (document.readyState === 'complete') {
    scheduleBoot();
  } else {
    window.addEventListener('load', scheduleBoot);
  }

  // Watch for DOM mutations that might indicate a video player was injected
  // after page load (common on SPAs and some players).
  var domObserver = new MutationObserver(function () {
    if (!video || !document.body.contains(video)) {
      // Video disappeared (navigation) — reset.
      video = null;
      activeCueIdx = -1;
      cues = null;
      var old = document.getElementById('__subtitle_translator_overlay__');
      if (old) old.remove();
      scheduleBoot();
    }
  });
  domObserver.observe(document.body, { childList: true, subtree: true });

  // Watch for URL changes (SPA navigation).
  var lastUrl = location.href;
  var urlCheckInterval = setInterval(function () {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      video = null;
      activeCueIdx = -1;
      cues = null;
      var old = document.getElementById('__subtitle_translator_overlay__');
      if (old) old.remove();
      scheduleBoot();
    }
  }, 1500);

})();