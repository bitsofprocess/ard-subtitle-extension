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

  var ns = g.SubtitleStorage || {};
  ns.getApiKey = getApiKey;
  ns.saveApiKey = saveApiKey;
  ns.getCues = getCues;
  ns.saveCues = saveCues;
  ns.listVideoUrls = listVideoUrls;
  ns.deleteCues = deleteCues;
  g.SubtitleStorage = ns;
})();