/*
 * Import page: file drop, parse, translate, save. Runs as a full tab so
 * the translation survives even if the popup is closed.
 */
(function () {
  'use strict';

  // DOM
  var dropZone = document.getElementById('dropZone');
  var fileInput = document.getElementById('fileInput');
  var fileNameEl = document.getElementById('fileName');
  var parseResult = document.getElementById('parseResult');
  var videoUrlInput = document.getElementById('videoUrl');
  var translateBtn = document.getElementById('translateBtn');
  var step2 = document.getElementById('step2');
  var progressSection = document.getElementById('progressSection');
  var progressFill = document.getElementById('progressFill');
  var progressLabel = document.getElementById('progressLabel');
  var progressTimer = document.getElementById('progressTimer');
  var logEl = document.getElementById('log');
  var doneSection = document.getElementById('doneSection');
  var noKeyWarning = document.getElementById('noKeyWarning');
  var settingsLink1 = document.getElementById('settingsLink1');

  // State
  var parsedCues = null;
  var apiKey = null;
  var timerInterval = null;
  var startTime = 0;

  // --- Init ------------------------------------------------------------

  (async function init() {
    apiKey = await SubtitleStorage.getApiKey();
    if (!apiKey) {
      noKeyWarning.style.display = '';
    }

    settingsLink1.addEventListener('click', function (e) {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  })();

  // --- File handling ---------------------------------------------------

  dropZone.addEventListener('click', function () { fileInput.click(); });

  dropZone.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', function () {
    dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    var file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  fileInput.addEventListener('change', function () {
    var file = fileInput.files[0];
    if (file) loadFile(file);
  });

  function loadFile(file) {
    if (!file.name.toLowerCase().endsWith('.xml')) {
      showParseResult('Please select an XML (.xml) file.', 'err');
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      fileNameEl.textContent = file.name;
      dropZone.classList.add('has-file');

      try {
        parsedCues = SubtitleParser.parse(reader.result);
        showParseResult(
          '✓ Parsed ' + parsedCues.length + ' cues. Ready to translate.',
          'ok'
        );
        step2.style.opacity = '1';
        translateBtn.disabled = false;
      } catch (err) {
        parsedCues = null;
        showParseResult('⚠ Parse failed: ' + err.message, 'err');
        translateBtn.disabled = true;
      }
    };
    reader.onerror = function () {
      showParseResult('⚠ Could not read file.', 'err');
    };
    reader.readAsText(file);
  }

  function showParseResult(msg, cls) {
    parseResult.textContent = msg;
    parseResult.className = cls || '';
  }

  // --- Translation -----------------------------------------------------

  translateBtn.addEventListener('click', function () {
    if (!parsedCues || parsedCues.length === 0) return;

    // Re-check API key (may have been set since page load).
    SubtitleStorage.getApiKey().then(function (key) {
      if (!key) {
        noKeyWarning.style.display = '';
        noKeyWarning.innerHTML =
          '⚠️ No OpenRouter API key set. ' +
          '<a href="#" id="settingsLink2">Open Settings</a> to add your key first.';
        document.getElementById('settingsLink2').addEventListener('click', function (e) {
          e.preventDefault();
          chrome.runtime.openOptionsPage();
        });
        return;
      }
      apiKey = key;
      noKeyWarning.style.display = 'none';
      startTranslation();
    });
  });

  async function startTranslation() {
    var videoUrl = videoUrlInput.value.trim();
    if (!videoUrl) {
      appendLog('Please enter a video URL.', 'log-err');
      return;
    }

    // Disable UI
    translateBtn.disabled = true;
    videoUrlInput.disabled = true;
    step2.style.opacity = '0.5';
    dropZone.style.pointerEvents = 'none';
    dropZone.style.opacity = '0.5';

    // Show progress
    progressSection.style.display = 'block';
    doneSection.style.display = 'none';
    logEl.style.display = 'block';
    logEl.innerHTML = '';
    startTime = Date.now();
    timerInterval = setInterval(updateTimer, 500);

    appendLog('Starting translation of ' + parsedCues.length + ' cues in ' +
      Math.ceil(parsedCues.length / SubtitleServices.config.BATCH_SIZE) +
      ' batches (concurrency=' + SubtitleServices.config.CONCURRENCY + ')…', '');

    try {
      await SubtitleServices.translateAll(
        parsedCues,
        apiKey,
        function (done, total) {
          var pct = Math.round((done / total) * 100);
          progressFill.style.width = pct + '%';
          progressLabel.textContent = 'Batch ' + done + ' / ' + total + ' (' + pct + '%)';
          appendLog('✓ Batch ' + done + ' of ' + total + ' complete', 'log-ok');
        }
      );

      // Save
      appendLog('Saving to storage…', '');
      await SubtitleStorage.saveCues(videoUrl, parsedCues);

      clearInterval(timerInterval);
      updateTimer();

      progressFill.style.width = '100%';
      progressLabel.textContent = 'All batches complete';

      doneSection.style.display = '';
      doneSection.innerHTML =
        '<div class="emoji">✅</div>' +
        '<p>' + parsedCues.length + ' cues translated and saved.</p>' +
        '<p style="font-size:0.75rem;">Close this tab and open the video. ' +
        'The overlay will show when the content script detects stored subtitles.</p>';

      appendLog('✓ All done! ' + parsedCues.length + ' cues saved.', 'log-ok');
    } catch (err) {
      clearInterval(timerInterval);
      appendLog('✗ FAILED: ' + err.message, 'log-err');
      translateBtn.disabled = false;
      videoUrlInput.disabled = false;
      step2.style.opacity = '1';
      dropZone.style.pointerEvents = '';
      dropZone.style.opacity = '1';
    }
  }

  // --- Helpers ---------------------------------------------------------

  function updateTimer() {
    var elapsed = Math.floor((Date.now() - startTime) / 1000);
    var min = Math.floor(elapsed / 60);
    var sec = elapsed % 60;
    progressTimer.textContent = min + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function appendLog(msg, cls) {
    var div = document.createElement('div');
    div.textContent = msg;
    div.className = cls || '';
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }
})();