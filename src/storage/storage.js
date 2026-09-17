/*
 * chrome.storage.local wrapper.
 *
 * In the browser this attaches to `window.SubtitleStorage`. It is NOT
 * needed in Node tests, so it's a plain browser script.
 */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : this;

  var STORAGE_KEY_API_KEY = 'openrouter_api_key';
  var STORAGE_PREFIX_CUES = 'cues:';   // cues:<videoUrl>
  var STORAGE_PREFIX_GLOSSES = 'glosses:'; // glosses:<videoUrl>
  var STORAGE_KEY_DISPLAY_GERMAN = 'display_german';
  var STORAGE_KEY_DISPLAY_ENGLISH = 'display_english';

  /**
   * Get the stored OpenRouter API key.
   * @returns {Promise<string|null>}
   */
  async function getApiKey() {
    var result = await chrome.storage.local.get(STORAGE_KEY_API_KEY);
    return result[STORAGE_KEY_API_KEY] || null;
  }

  /**
   * Save the OpenRouter API key.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async function saveApiKey(key) {
    var obj = {};
    obj[STORAGE_KEY_API_KEY] = key;
    await chrome.storage.local.set(obj);
  }

  /**
   * Get parsed+translated cues for a video URL.
   * @param {string} videoUrl
   * @returns {Promise<Object[]|null>}
   */
  async function getCues(videoUrl) {
    var storageKey = STORAGE_PREFIX_CUES + videoUrl;
    var result = await chrome.storage.local.get(storageKey);
    return result[storageKey] || null;
  }

  /**
   * Save parsed+translated cues for a video URL.
   * @param {string} videoUrl
   * @param {Object[]} cues
   * @returns {Promise<void>}
   */
  async function saveCues(videoUrl, cues) {
    var obj = {};
    obj[STORAGE_PREFIX_CUES + videoUrl] = cues;
    await chrome.storage.local.set(obj);
  }

  /**
   * List all stored video URLs.
   * @returns {Promise<string[]>}
   */
  async function listVideoUrls() {
    var all = await chrome.storage.local.get(null);
    var urls = [];
    for (var key in all) {
      if (all.hasOwnProperty(key) && key.indexOf(STORAGE_PREFIX_CUES) === 0) {
        urls.push(key.slice(STORAGE_PREFIX_CUES.length));
      }
    }
    return urls;
  }

  /**
   * Delete stored cues for a video URL.
   * @param {string} videoUrl
   * @returns {Promise<void>}
   */
  async function deleteCues(videoUrl) {
    await chrome.storage.local.remove(STORAGE_PREFIX_CUES + videoUrl);
  }

  // ── Gloss cache ──────────────────────────────────────────────────
  //
  // Glosses are stored under a separate key so we never rewrite the
  // full cue array on every click.  Key = "glosses:<videoUrl>".
  // Value = { "<cueIndex>:<tokenIndex>": { lemma, gloss, related, note, model, v: 1 } }
  //
  // Writes are serialised through a per-URL promise queue so
  // concurrent saves cannot overwrite each other.

  var _glossWriteQueues = {};  // url → Promise chain

  /**
   * Get ALL gloss entries for a video URL.
   * @returns {Promise<Object>}
   */
  async function getGlosses(videoUrl) {
    var result = await chrome.storage.local.get(STORAGE_PREFIX_GLOSSES + videoUrl);
    return result[STORAGE_PREFIX_GLOSSES + videoUrl] || {};
  }

  /**
   * Get a single gloss entry (or null).
   */
  async function getGloss(videoUrl, cueIndex, tokenIndex) {
    var key = cueIndex + ':' + tokenIndex;
    var all = await getGlosses(videoUrl);
    return all[key] || null;
  }

  /**
   * Merge entries into the gloss map.  Existing entries are never
   * replaced — first writer wins.  All writes for the same URL are
   * serialised so concurrent calls cannot overwrite each other.
   *
   * @param {Object} entries — { "cueIdx:tokIdx": { lemma, gloss, ... } }
   */
  async function saveGlosses(videoUrl, entries) {
    var storageKey = STORAGE_PREFIX_GLOSSES + videoUrl;

    // Build a promise chain per URL.
    var prev = _glossWriteQueues[videoUrl] || Promise.resolve();

    var next = prev.then(async function () {
      var result = await chrome.storage.local.get(storageKey);
      var current = result[storageKey] || {};

      // Merge: only add keys that don't already exist.
      var changed = false;
      var keys = Object.keys(entries);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!(k in current)) {
          current[k] = entries[k];
          changed = true;
        }
      }

      if (changed) {
        var obj = {};
        obj[storageKey] = current;
        await chrome.storage.local.set(obj);
      }
    }).catch(function (err) {
      // Clear the queue on error so subsequent writes aren't blocked.
      delete _glossWriteQueues[videoUrl];
      throw err;
    });

    _glossWriteQueues[videoUrl] = next;
    return next;
  }

  /**
   * Get display preference for German (original language).
   * @returns {Promise<boolean>}
   */
  async function getDisplayGerman() {
    var result = await chrome.storage.local.get(STORAGE_KEY_DISPLAY_GERMAN);
    // Default: true (show German) if not set.
    return result[STORAGE_KEY_DISPLAY_GERMAN] !== undefined ? result[STORAGE_KEY_DISPLAY_GERMAN] : true;
  }

  /**
   * Save display preference for German.
   */
  async function setDisplayGerman(show) {
    var obj = {};
    obj[STORAGE_KEY_DISPLAY_GERMAN] = !!show;
    await chrome.storage.local.set(obj);
  }

  /**
   * Get display preference for English translation.
   * @returns {Promise<boolean>}
   */
  async function getDisplayEnglish() {
    var result = await chrome.storage.local.get(STORAGE_KEY_DISPLAY_ENGLISH);
    // Default: true (show English) if not set.
    return result[STORAGE_KEY_DISPLAY_ENGLISH] !== undefined ? result[STORAGE_KEY_DISPLAY_ENGLISH] : true;
  }

  /**
   * Save display preference for English.
   */
  async function setDisplayEnglish(show) {
    var obj = {};
    obj[STORAGE_KEY_DISPLAY_ENGLISH] = !!show;
    await chrome.storage.local.set(obj);
  }

  var ns = g.SubtitleStorage || {};
  ns.getApiKey = getApiKey;
  ns.saveApiKey = saveApiKey;
  ns.getCues = getCues;
  ns.saveCues = saveCues;
  ns.listVideoUrls = listVideoUrls;
  ns.deleteCues = deleteCues;
  ns.getGlosses = getGlosses;
  ns.getGloss = getGloss;
  ns.saveGlosses = saveGlosses;
  ns.getDisplayGerman = getDisplayGerman;
  ns.setDisplayGerman = setDisplayGerman;
  ns.getDisplayEnglish = getDisplayEnglish;
  ns.setDisplayEnglish = setDisplayEnglish;
  g.SubtitleStorage = ns;
})();