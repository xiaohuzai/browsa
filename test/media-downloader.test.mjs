// test/media-downloader.test.mjs
// Tests for extFromMime - maps a stream's MIME type to a file extension.
// (The fetch+blob download itself runs in the page's MAIN world, see
// background.js's DOWNLOAD_MEDIA case - not unit-testable here.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extFromMime } from '../lib/handlers/media-downloader.js';

test('extFromMime: maps common audio/video mime types', () => {
  assert.equal(extFromMime('audio/mpeg'), 'mp3');
  assert.equal(extFromMime('audio/aac'), 'aac');
  assert.equal(extFromMime('audio/webm'), 'webm');
  assert.equal(extFromMime('audio/ogg'), 'ogg');
  assert.equal(extFromMime('audio/wav'), 'wav');
  assert.equal(extFromMime('audio/mp4'), 'mp4');
  assert.equal(extFromMime('video/mp4'), 'mp4');
  assert.equal(extFromMime('video/quicktime'), 'mp4');
});

test('extFromMime: strips parameters and is case-insensitive', () => {
  assert.equal(extFromMime('video/mp4; codecs="avc1"'), 'mp4');
  assert.equal(extFromMime('AUDIO/MPEG'), 'mp3');
  assert.equal(extFromMime('audio/mp4'), 'mp4');  // mp4 covers both aac+mpeg audio
});

test('extFromMime: unknown/empty -> ""', () => {
  assert.equal(extFromMime('application/octet-stream'), '');
  assert.equal(extFromMime(''), '');
  assert.equal(extFromMime(null), '');
  assert.equal(extFromMime(undefined), '');
});