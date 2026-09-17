/*
 * Background service worker — two responsibilities:
 *
 *   1. Gloss requests from content.js (existing, unchanged).
 *   2. Streamlined import: triggered by the popup's "Translate This Video"
 *      button, which sends a START_IMPORT message.  The worker discovers
 *      the subtitle URL, fetches/parses it via the content script, runs
 *      the existing translation pipeline, saves to storage, and tells the
 *      content script to inject the overlay.
 *
 * Uses importScripts() to load the shared modules.  All modules are UMD
 * and attach to globalThis / self.
 */

importScripts(
  '../storage/storage.js',
  '../services/api.js',
  '../services/prompt.js',
  '../services/validate.js',
  '../services/tokenize.js',
  '../services/gloss.js',
  '../services/translate.js'
);

// --- Config -------------------------------------------------------------

SubtitleServices.config = SubtitleServices.config || {};
SubtitleServices.config.GLOSS_MODEL = SubtitleServices.config.GLOSS_MODEL || 'openai/gpt-4o-mini';

// --- In-flight deduplication --------------------------------------------

var inFlight = {};           // "cueIndex:tokenIndex" → Promise  (gloss)
var translateInFlight = {};  // tabId → Promise                   (import)

// --- Message handler ---------------------------------------------------

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type === 'GET_GLOSS') {
    handleGetGloss(message).then(sendResponse).catch(function (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    });
    return true;
  }

  if (message.type === 'START_IMPORT') {
    handleStartImport(message).then(function () {
      sendResponse({ ok: true });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    });
    return true;
  }

  return false;
});

// =======================================================================
//  Streamlined import — triggered by popup (START_IMPORT)
// =======================================================================

/**
 * Kick off the streamlined-import flow for the tab whose info was
 * passed from the popup.  Does NOT await — the popup closes immediately
 * and progress is shown on the badge.
 */
async function handleStartImport(msg) {
  var tabId = msg.tabId;
  var tabUrl = msg.url;

  if (!tabId || !tabUrl) {
    throw new Error('Missing tabId or url in START_IMPORT message');
  }

  if (translateInFlight[tabId]) return;

  translateInFlight[tabId] = runImport({ id: tabId, url: tabUrl }).finally(function () {
    delete translateInFlight[tabId];
  });
}

/**
 * Strip common noisy query params so the same video matches regardless
 * of share tracking params (same logic as content.js's normalizeUrl).
 */
function normalizeUrl(url) {
  try {
    var u = new URL(url);
    u.searchParams.delete('startTime');
    u.searchParams.delete('t');
    u.searchParams.delete('autoplay');
    return u.toString();
  } catch (e) {
    return url;
  }
}

function setProgress(tabId, text, color) {
  chrome.action.setBadgeText({ text: text, tabId: tabId }).catch(function () { /* ignore */ });
  chrome.action.setBadgeBackgroundColor({ color: color || '#e94560', tabId: tabId }).catch(function () { /* ignore */ });
}

function clearBadgeLater(tabId, delay) {
  if (delay === undefined) delay = 2500;
  setTimeout(function () {
    chrome.action.setBadgeText({ text: '', tabId: tabId }).catch(function () { /* ignore */ });
  }, delay);
}

async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    throw new Error('sendMessage to tab ' + tabId + ' failed: ' + (err.message || String(err)));
  }
}

async function runImport(tab) {
  var normalizedUrl = normalizeUrl(tab.url);

  setProgress(tab.id, '...', '#e94560');

  // 1. Check API key.
  var apiKey = await SubtitleStorage.getApiKey();
  if (!apiKey) {
    setProgress(tab.id, 'KEY', '#ff0000');
    clearBadgeLater(tab.id, 3000);
    console.error('[streamlined-import] No API key set');
    return;
  }

  // 2. Already translated?  Try exact match, then fuzzy (same logic as content.js).
  console.log('[streamlined-import] checking storage for:', normalizedUrl);
  try {
    var existing = await SubtitleStorage.getCues(normalizedUrl);

    if (!existing || existing.length === 0) {
      // Fuzzy fallback — the page URL may have extra query params that
      // normalizeUrl didn't strip (ARD adds tracking params dynamically).
      var allUrls = await SubtitleStorage.listVideoUrls();
      for (var i = 0; i < allUrls.length; i++) {
        if (normalizedUrl.indexOf(normalizeUrl(allUrls[i])) === 0 ||
            normalizeUrl(allUrls[i]).indexOf(normalizedUrl) === 0) {
          existing = await SubtitleStorage.getCues(allUrls[i]);
          if (existing && existing.length > 0) break;
        }
      }
    }

    if (existing && existing.length > 0) {
      console.log('[streamlined-import] cues already stored, skipping translation');
      setProgress(tab.id, '✓', '#2ecc71');
      clearBadgeLater(tab.id);
      await sendToContent(tab.id, { type: 'CUES_READY' });
      return;
    }
  } catch (e) { /* ignore storage errors, proceed to translate */ }

  // 3. Discover subtitle URL + fetch + parse (content script).
  var discoverResp;
  try {
    discoverResp = await sendToContent(tab.id, { type: 'DISCOVER' });
  } catch (err) {
    setProgress(tab.id, '✗', '#ff0000');
    clearBadgeLater(tab.id, 3000);
    console.error('[streamlined-import] DISCOVER message failed:', err.message);
    return;
  }

  if (!discoverResp || !discoverResp.ok) {
    var errMsg = (discoverResp && discoverResp.error) || 'Unknown error';
    setProgress(tab.id, '✗', '#ff0000');
    clearBadgeLater(tab.id, 3000);
    console.error('[streamlined-import] discovery failed:', errMsg);
    return;
  }

  var cues = discoverResp.cues;
  console.log('[streamlined-import] received', cues.length, 'cues from discover');

  // 4. Translate.
  try {
    await SubtitleServices.translateAll(
      cues,
      apiKey,
      function (done, total) {
        var pct = Math.round((done / total) * 100);
        setProgress(tab.id, pct + '%', '#e94560');
        console.log('[streamlined-import] batch ' + done + '/' + total + ' (' + pct + '%)');
      }
    );
  } catch (err) {
    setProgress(tab.id, '✗', '#ff0000');
    clearBadgeLater(tab.id, 4000);
    console.error('[streamlined-import] translation failed:', err.message);
    return;
  }

  // 5. Save to storage.
  console.log('[streamlined-import] saving', cues.length, 'cues…');
  await SubtitleStorage.saveCues(normalizedUrl, cues);

  setProgress(tab.id, '✓', '#2ecc71');
  clearBadgeLater(tab.id);

  // 6. Tell the content script to load the overlay.
  try {
    await sendToContent(tab.id, { type: 'CUES_READY' });
    console.log('[streamlined-import] overlay injected');
  } catch (err) {
    console.warn('[streamlined-import] CUES_READY message failed (page may have navigated):', err.message);
  }
}

// =======================================================================
//  Gloss handler (existing, unchanged)
// =======================================================================

async function handleGetGloss(msg) {
  var videoUrl = msg.videoUrl;
  var cueIndex = msg.cueIndex;
  var tokenIndex = msg.tokenIndex;

  if (videoUrl == null || cueIndex == null || tokenIndex == null) {
    return { ok: false, error: 'Missing required fields: videoUrl, cueIndex, tokenIndex' };
  }

  var cached = await SubtitleStorage.getGloss(videoUrl, cueIndex, tokenIndex);
  if (cached) {
    return { ok: true, gloss: cached, cached: true };
  }

  var dedupeKey = cueIndex + ':' + tokenIndex;
  if (inFlight[dedupeKey]) {
    try {
      var result = await inFlight[dedupeKey];
      return result;
    } catch (e) { /* fall through */ }
  }

  var promise = fetchGloss(videoUrl, cueIndex, tokenIndex);
  inFlight[dedupeKey] = promise;

  try {
    var result = await promise;
    return result;
  } finally {
    delete inFlight[dedupeKey];
  }
}

async function fetchGloss(videoUrl, cueIndex, tokenIndex) {
  var cues = await SubtitleStorage.getCues(videoUrl);
  if (!cues || cues.length === 0) {
    return { ok: false, error: 'No cues found for this video URL' };
  }

  var cue = cues[cueIndex];
  if (!cue) {
    return { ok: false, error: 'Invalid cueIndex: ' + cueIndex };
  }

  var apiKey = await SubtitleStorage.getApiKey();
  if (!apiKey) {
    return { ok: false, error: 'NO_API_KEY' };
  }

  var tokenCount = SubtitleServices.tokenize(cue.text).length;

  var messages = SubtitleServices.buildGlossMessages({
    cues: cues,
    cueIndex: cueIndex,
    tokenIndex: tokenIndex
  });

  var S = SubtitleServices;
  var lastErr;

  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      var raw = await callLLM(messages, apiKey, {
        model: S.config.GLOSS_MODEL,
        temperature: 0,
        max_tokens: 120
      });

      var parsed = S.parseGlossResponse(raw, tokenCount, tokenIndex);

      var entries = {};
      var key = cueIndex + ':' + tokenIndex;
      entries[key] = {
        lemma: parsed.lemma,
        gloss: parsed.gloss,
        related: parsed.related,
        note: parsed.note,
        model: S.config.GLOSS_MODEL,
        v: 1
      };
      await SubtitleStorage.saveGlosses(videoUrl, entries);

      return { ok: true, gloss: entries[key], cached: false };
    } catch (err) {
      lastErr = err;
      console.warn('[background] gloss fetch attempt ' + attempt + '/3 failed: ' + err.message);
      if (attempt < 3) {
        await new Promise(function (r) { setTimeout(r, 500 * attempt); });
      }
    }
  }

  return { ok: false, error: lastErr ? lastErr.message : 'Unknown error' };
}

async function callLLM(messages, apiKey, opts) {
  var S = SubtitleServices;
  var origModel = S.config.MODEL;

  S.config.MODEL = opts.model || S.config.GLOSS_MODEL || 'openai/gpt-4o-mini';

  var response;
  try {
    response = await S.withRetry(function () {
      var body = {
        model: opts.model || S.config.GLOSS_MODEL,
        messages: messages,
        temperature: opts.temperature !== undefined ? opts.temperature : 0,
        max_tokens: opts.max_tokens || 120
      };

      return fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
    });
  } finally {
    if (origModel !== undefined) S.config.MODEL = origModel;
  }

  if (!response.ok) {
    var errorBody = '';
    try { errorBody = await response.text(); } catch (e) { /* ignore */ }
    var err = new Error('OpenRouter API error ' + response.status + ': ' + errorBody);
    err.status = response.status;
    throw err;
  }

  var data = await response.json();

  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error('Unexpected OpenRouter response structure');
  }

  return data.choices[0].message.content;
}