'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// --- chrome.storage.local mock ------------------------------------------
// Must be installed before require()'ing storage.js.

function createMockStore() {
  var store = {};

  return {
    get: async function (keys) {
      if (keys === null) {
        // Return everything.
        var copy = {};
        for (var k in store) { if (store.hasOwnProperty(k)) copy[k] = store[k]; }
        return copy;
      }
      if (Array.isArray(keys)) {
        var result = {};
        for (var i = 0; i < keys.length; i++) {
          if (store.hasOwnProperty(keys[i])) result[keys[i]] = store[keys[i]];
        }
        return result;
      }
      if (typeof keys === 'string') {
        var r = {};
        if (store.hasOwnProperty(keys)) r[keys] = store[keys];
        return r;
      }
      // Object form.
      var res = {};
      var ks = Object.keys(keys);
      for (var j = 0; j < ks.length; j++) {
        if (store.hasOwnProperty(ks[j])) res[ks[j]] = store[ks[j]];
        else res[ks[j]] = keys[ks[j]]; // default value
      }
      return res;
    },
    set: async function (obj) {
      var ks = Object.keys(obj);
      for (var i = 0; i < ks.length; i++) {
        store[ks[i]] = obj[ks[i]];
      }
    },
    remove: async function (keys) {
      if (typeof keys === 'string') keys = [keys];
      for (var i = 0; i < keys.length; i++) {
        delete store[keys[i]];
      }
    },
    _dump: function () { return store; },
    _reset: function () { store = {}; }
  };
}

var mockStore = createMockStore();
globalThis.chrome = {
  storage: {
    local: mockStore
  }
};

// Now load storage.js — it attaches to globalThis.SubtitleStorage.
require('../src/storage/storage.js');
var S = globalThis.SubtitleStorage;

// --- Tests --------------------------------------------------------------

const VIDEO_URL = 'https://www.ardmediathek.de/video/normalized';

test('getGlosses returns empty object when nothing stored', async () => {
  mockStore._reset();
  var result = await S.getGlosses(VIDEO_URL);
  assert.deepEqual(result, {});
});

test('saveGlosses stores and getGloss retrieves', async () => {
  mockStore._reset();
  await S.saveGlosses(VIDEO_URL, { '5:2': { lemma: 'die Tür', gloss: 'the door', related: [], note: '', model: 'gpt-4o-mini', v: 1 } });
  var entry = await S.getGloss(VIDEO_URL, 5, 2);
  assert.deepEqual(entry, { lemma: 'die Tür', gloss: 'the door', related: [], note: '', model: 'gpt-4o-mini', v: 1 });
});

test('saveGlosses merges — existing entries are NOT overwritten', async () => {
  mockStore._reset();
  // Write first entry.
  await S.saveGlosses(VIDEO_URL, { '0:0': { lemma: 'Ich', gloss: 'I', related: [], note: '', model: 'gpt-4o-mini', v: 1 } });
  // Write second batch that includes a duplicate key.
  await S.saveGlosses(VIDEO_URL, { '0:0': { lemma: 'SHOULD NOT OVERWRITE', gloss: 'x', related: [], note: '', model: 'gpt-4o-mini', v: 1 }, '1:0': { lemma: 'bin', gloss: 'am', related: [], note: '', model: 'gpt-4o-mini', v: 1 } });

  var e0 = await S.getGloss(VIDEO_URL, 0, 0);
  assert.equal(e0.lemma, 'Ich'); // original preserved

  var e1 = await S.getGloss(VIDEO_URL, 1, 0);
  assert.equal(e1.lemma, 'bin'); // new key added
});

test('getGlosses returns all entries', async () => {
  mockStore._reset();
  await S.saveGlosses(VIDEO_URL, {
    '0:0': { lemma: 'a', gloss: 'A', related: [], note: '', model: 'x', v: 1 },
    '0:1': { lemma: 'b', gloss: 'B', related: [], note: '', model: 'x', v: 1 }
  });
  var all = await S.getGlosses(VIDEO_URL);
  assert.equal(Object.keys(all).length, 2);
});

test('getGloss returns null for missing entry', async () => {
  mockStore._reset();
  var entry = await S.getGloss(VIDEO_URL, 99, 99);
  assert.equal(entry, null);
});

test('saveGlosses write queue — concurrent saves both survive', async () => {
  mockStore._reset();

  // Launch two concurrent saves.
  var p1 = S.saveGlosses(VIDEO_URL, { '0:0': { lemma: 'first', gloss: 'f', related: [], note: '', model: 'x', v: 1 } });
  var p2 = S.saveGlosses(VIDEO_URL, { '0:1': { lemma: 'second', gloss: 's', related: [], note: '', model: 'x', v: 1 } });

  await Promise.all([p1, p2]);

  var all = await S.getGlosses(VIDEO_URL);
  assert.equal(Object.keys(all).length, 2);
  assert.equal(all['0:0'].lemma, 'first');
  assert.equal(all['0:1'].lemma, 'second');
});

test('gloss key format uses colon separator', async () => {
  mockStore._reset();
  await S.saveGlosses(VIDEO_URL, { '10:5': { lemma: 'test', gloss: 't', related: [], note: '', model: 'x', v: 1 } });
  var all = await S.getGlosses(VIDEO_URL);
  assert.ok('10:5' in all);
});

test('glosses for different video URLs are isolated', async () => {
  mockStore._reset();
  await S.saveGlosses(VIDEO_URL, { '0:0': { lemma: 'a', gloss: 'A', related: [], note: '', model: 'x', v:1 } });
  await S.saveGlosses(VIDEO_URL + '?other', { '0:0': { lemma: 'b', gloss: 'B', related: [], note: '', model: 'x', v:1 } });

  var a = await S.getGloss(VIDEO_URL, 0, 0);
  var b = await S.getGloss(VIDEO_URL + '?other', 0, 0);
  assert.equal(a.lemma, 'a');
  assert.equal(b.lemma, 'b');
});