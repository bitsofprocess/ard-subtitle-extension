/*
 * Options page logic: save/load API key and show stored subtitle data.
 */
(function () {
  'use strict';

  var apiKeyInput = document.getElementById('apiKey');
  var saveBtn = document.getElementById('saveBtn');
  var statusEl = document.getElementById('status');
  var storedList = document.getElementById('storedList');
  var emptyMsg = document.getElementById('emptyMsg');

  // Load current API key on mount.
  SubtitleStorage.getApiKey().then(function (key) {
    if (key) {
      apiKeyInput.value = key;
    }
  });

  // Load stored video list.
  refreshStoredList();

  // Save button.
  saveBtn.addEventListener('click', function () {
    var key = apiKeyInput.value.trim();
    if (!key) {
      showStatus('Please enter an API key.', 'err');
      return;
    }
    if (!key.startsWith('sk-or-')) {
      showStatus('Doesn\'t look like an OpenRouter key (should start with sk-or-).', 'err');
      return;
    }

    SubtitleStorage.saveApiKey(key).then(function () {
      showStatus('API key saved ✓', 'ok');
    }).catch(function (err) {
      showStatus('Error saving: ' + err.message, 'err');
    });
  });

  function showStatus(msg, cls) {
    statusEl.textContent = msg;
    statusEl.className = cls;
  }

  function refreshStoredList() {
    SubtitleStorage.listVideoUrls().then(function (urls) {
      storedList.innerHTML = '';
      if (urls.length === 0) {
        emptyMsg.style.display = '';
        return;
      }
      emptyMsg.style.display = 'none';
      urls.forEach(function (url) {
        var li = document.createElement('li');
        var span = document.createElement('span');
        span.className = 'url';
        span.textContent = url;
        span.title = url;

        var delBtn = document.createElement('button');
        delBtn.className = 'del-btn';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', function () {
          if (confirm('Delete stored subtitles for this video?')) {
            SubtitleStorage.deleteCues(url).then(refreshStoredList);
          }
        });

        li.appendChild(span);
        li.appendChild(delBtn);
        storedList.appendChild(li);
      });
    });
  }
})();