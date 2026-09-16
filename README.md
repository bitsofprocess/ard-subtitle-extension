# ARD Subtitle Translator

Chrome extension that overlays clickable German subtitles (with English translations) over ARD Mediathek videos.

Import a subtitle XML, translate via LLM, and watch with synced original text overlaid on the video. Hover over a cue to reveal the English translation. Click any word for a gloss popup.

## How it works

1. **Import** — open the extension, drop a TTML subtitle XML (from ARD's "Untertitel" download), paste the video URL, and click Translate.
2. **Translate** — cues are batched and sent to OpenRouter's `gpt-4o-mini`, which returns a numbered list of English translations.
3. **Overlay** — on the matching video page, a content script syncs the active cue to `video.currentTime` and renders it as a positioned overlay with clickable words.

## Tech stack

- Plain JavaScript (no framework, no build step, no TypeScript)
- UMD module pattern (works in both browser `<script>` and Node `require()` for tests)
- Chrome Manifest V3
- OpenRouter API (`openai/gpt-4o-mini`)
- Node `--test` runner + `node:assert`

## Project structure

```
src/
  parser/parser.js         TTML (EBU-TT-D) parser → {start, end, text} cues
  services/prompt.js       System prompt, numbered-list builder, response parser
  services/api.js          OpenRouter fetch with exponential backoff
  services/translate.js    Batch orchestrator (split/retry/concurrency)
  services/validate.js     Stub (logic merged into prompt.js)
  storage/storage.js       chrome.storage.local wrapper
  import/                  Full-tab translation UI
  options/                 API key settings page
  popup/                   Extension launcher
  content/content.js       Video overlay (sync, render, click, hover)
test/
  parser.test.js           9 tests
  translate.test.js        9 tests
sample.xml                 Real ARD Mediathek fixture (Babylon Berlin S05 E01)
```

## Setup

```bash
# Install dev dependency (only needed for tests)
npm install
```

### Load the extension

1. Open `brave://extensions` (or `chrome://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** → select the project directory
4. Click the extension icon → ⚙️ Settings → paste your OpenRouter API key → Save

### Translate subtitles

1. Download a subtitle XML from ARD Mediathek (the "UT" / Untertitel option)
2. Click the extension icon → **Open Translator**
3. Drop the XML, paste the video URL, click **Translate**
4. Wait for the progress bar to finish

### Watch

1. Go to the video page in ARD Mediathek
2. Turn **OFF** the site's built-in CC/subtitle button
3. German subtitles appear at the bottom, synced to the video
4. **Hover** over a cue to see the English translation
5. **Click** any word to see a gloss popup with the full translation

## Tests

```bash
npm test   # 18 tests, zero dependencies beyond @xmldom/xmldom
```

## Configuration

| Key | Default | Where |
|-----|---------|-------|
| Model | `openai/gpt-4o-mini` | `SubtitleServices.config.MODEL` in `src/services/translate.js` |
|Batch size | 20 | `S.config.BATCH_SIZE` |
| Concurrency | 3 | `S.config.CONCURRENCY` |

## API key

Stored in `chrome.storage.local` under key `openrouter_api_key`. Set via the options page, never committed.