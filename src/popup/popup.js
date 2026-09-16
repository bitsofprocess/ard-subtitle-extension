/*
 * Popup: minimal launcher that opens the full translator page in a tab.
 */
(function () {
  'use strict';

  document.getElementById('openBtn').addEventListener('click', function () {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/import/import.html') });
  });

  document.getElementById('settingsLink').addEventListener('click', function (e) {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Show quick status of stored data.
  (async function () {
    try {
      var urls = await SubtitleStorage.listVideoUrls();
      var info = document.getElementById('storedInfo');
      if (urls.length === 0) {
        info.textContent = 'No stored subtitles yet.';
      } else {
        info.textContent = urls.length + ' video(s) with stored subtitles.';
      }
    } catch (e) {
      // ignore
    }
  })();
})();