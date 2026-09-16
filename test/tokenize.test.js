'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { tokenize, stripMarkers, isClickable } = require('../src/services/tokenize.js');

// --- stripMarkers -------------------------------------------------------

test('stripMarkers removes leading/trailing punctuation', () => {
  assert.equal(stripMarkers('Hallo.'), 'Hallo');
  assert.equal(stripMarkers(',aber'), 'aber');
  assert.equal(stripMarkers('"nein"'), 'nein');
});

test('stripMarkers removes asterisk markers', () => {
  assert.equal(stripMarkers('*Tür'), 'Tür');
  assert.equal(stripMarkers('zu.*'), 'zu');
  assert.equal(stripMarkers('*knallt*'), 'knallt');
});

test('stripMarkers keeps hyphens and apostrophes', () => {
  assert.equal(stripMarkers('E-Mail'), 'E-Mail');
  assert.equal(stripMarkers("gibt's"), "gibt's");
  assert.equal(stripMarkers('High-five'), 'High-five');
});

test('stripMarkers handles quotes', () => {
  assert.equal(stripMarkers('\u201EHand\u201C'), 'Hand');       // „Hand"
  assert.equal(stripMarkers('\u00ABBonjour\u00BB'), 'Bonjour'); // «Bonjour»
});

test('stripMarkers handles pure punctuation', () => {
  assert.equal(stripMarkers('\u2013'), '');  // en-dash
  assert.equal(stripMarkers('...'), '');
  assert.equal(stripMarkers('?'), '');
});

// --- isClickable --------------------------------------------------------

test('isClickable returns false for empty strings', () => {
  assert.equal(isClickable(''), false);
});

test('isClickable returns false for pure numbers', () => {
  assert.equal(isClickable('123'), false);
  assert.equal(isClickable('0'), false);
});

test('isClickable returns true for normal words', () => {
  assert.equal(isClickable('Hallo'), true);
  assert.equal(isClickable('E-Mail'), true);
  assert.equal(isClickable('gibt\'s'), true);
});

// --- tokenize -----------------------------------------------------------

test('tokenize basic sentence', () => {
  const result = tokenize('Ich fange morgen an.');
  assert.equal(result.length, 4);
  assert.deepEqual(result[0], { i: 0, raw: 'Ich', word: 'Ich', line: 0, clickable: true });
  assert.deepEqual(result[1], { i: 1, raw: 'fange', word: 'fange', line: 0, clickable: true });
  assert.deepEqual(result[2], { i: 2, raw: 'morgen', word: 'morgen', line: 0, clickable: true });
  assert.deepEqual(result[3], { i: 3, raw: 'an.', word: 'an', line: 0, clickable: true });
});

test('tokenize punctuation stripping', () => {
  const result = tokenize('Ja, nein!');
  assert.equal(result.length, 2);
  assert.equal(result[0].raw, 'Ja,');
  assert.equal(result[0].word, 'Ja');
  assert.equal(result[1].raw, 'nein!');
  assert.equal(result[1].word, 'nein');
});

test('tokenize asterisk markers for italics', () => {
  const result = tokenize('*Tür knallt zu.*');
  assert.equal(result.length, 3);
  assert.equal(result[0].raw, '*Tür');
  assert.equal(result[0].word, 'Tür');
  assert.equal(result[1].raw, 'knallt');
  assert.equal(result[1].word, 'knallt');
  assert.equal(result[2].raw, 'zu.*');
  assert.equal(result[2].word, 'zu');
});

test('tokenize multi-line cue indices continue across lines', () => {
  const result = tokenize('Ich fange\nmorgen an.');
  // Line 0: "Ich" (i=0), "fange" (i=1)
  // Line 1: "morgen" (i=2), "an." (i=3)
  assert.equal(result.length, 4);
  assert.equal(result[0].i, 0);
  assert.equal(result[0].line, 0);
  assert.equal(result[1].i, 1);
  assert.equal(result[1].line, 0);
  assert.equal(result[2].i, 2);
  assert.equal(result[2].line, 1);
  assert.equal(result[3].i, 3);
  assert.equal(result[3].line, 1);
});

test('tokenize hyphenated compound words', () => {
  const result = tokenize('Die E-Mail-Adresse.');
  assert.equal(result.length, 2);
  assert.equal(result[1].raw, 'E-Mail-Adresse.');
  assert.equal(result[1].word, 'E-Mail-Adresse');
  assert.equal(result[1].clickable, true);
});

test('tokenize quotes', () => {
  const result = tokenize('\u201EHand\u201C und \u00ABFu\u00DF\u00BB');
  assert.equal(result.length, 3);
  assert.equal(result[0].raw, '\u201EHand\u201C');
  assert.equal(result[0].word, 'Hand');
  assert.equal(result[2].raw, '\u00ABFu\u00DF\u00BB');
  assert.equal(result[2].word, 'Fu\u00DF');
});

test('tokenize punctuation-only token is not clickable', () => {
  const result = tokenize('Hallo \u2013 Welt');
  assert.equal(result.length, 3);
  // The en-dash token
  assert.equal(result[1].raw, '\u2013');
  assert.equal(result[1].word, '');
  assert.equal(result[1].clickable, false);
});

test('tokenize empty string returns empty array', () => {
  const result = tokenize('');
  assert.deepEqual(result, []);
});

test('tokenize numeric token is not clickable', () => {
  const result = tokenize('Kapitel 5 beginnt');
  assert.equal(result.length, 3);
  assert.equal(result[1].raw, '5');
  assert.equal(result[1].clickable, false);
});