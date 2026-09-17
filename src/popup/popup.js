/*
 * Popup: context-aware launcher.
 *
 * - On an ARD video page → "Translate This Video" button (streamlined import).
 * - On any other page   → "Open Translator" button (manual import fallback).
 *
 * The streamlined flow sends a message to the background service worker,
 * which does the subtitle URL discovery → fetch → translation → overlay
 * injection.  Progress is shown on the extension badge.
 */
(function () {
  'use strict';

  var actionsEl = document.getElementById('actions');
  var statusEl = document.getElementById('status');

  // --- Detect the active tab --------------------------------------------

  async function getActiveTab() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  function isArdVideoPage(tab) {
    return tab && tab.url && /ardmediathek\.de\/video\//.test(tab.url);
  }

  // --- Render the right UI ----------------------------------------------

  async function render() {
    var tab = await getActiveTab();
    if (isArdVideoPage(tab)) {
      renderStreamlined(tab);
    } else {
      renderManual();
    }
  }

  function renderStreamlined(tab) {
    actionsEl.innerHTML = '';

    var btn = document.createElement('button');
    btn.id = 'translateBtn';
    btn.textContent = 'Translate This Video';
    btn.title = 'Auto-detect subtitle file and run translation';
    actionsEl.appendChild(btn);

    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Translating…';
      statusEl.textContent = '';

      chrome.runtime.sendMessage({ type: 'START_IMPORT', tabId: tab.id, url: tab.url }).then(function () {
        // The background worker handles everything.
        // Close the popup so the user sees the video page + badge.
        window.close();
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Translate This Video';
        statusEl.textContent = 'Error: ' + (err.message || String(err));
      });
    });

    // Show stored-subtitle count.
    renderStoredCount();
  }

  function renderManual() {
    actionsEl.innerHTML = '';

    var btn = document.createElement('button');
    btn.id = 'openBtn';
    btn.textContent = 'Open Translator';
    btn.title = 'Manually drop a subtitle XML file, paste a URL, and translate';
    actionsEl.appendChild(btn);

    btn.addEventListener('click', function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/import/import.html') });
    });

    renderStoredCount();
  }

  // --- Stored info (shared) ---------------------------------------------

  async function renderStoredCount() {
    try {
      var urls = await SubtitleStorage.listVideoUrls();
      if (urls.length === 0) {
        statusEl.textContent = 'No stored subtitles yet.';
      } else {
        statusEl.textContent = urls.length + ' video(s) with stored subtitles.';
      }
    } catch (e) {
      /* ignore */
    }
  }

  // --- Settings link ----------------------------------------------------

  document.getElementById('settingsLink').addEventListener('click', function (e) {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // --- Start ------------------------------------------------------------

  render();
})();