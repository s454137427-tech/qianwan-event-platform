const test = require('node:test');
const assert = require('node:assert');
const { downloadName } = require('../lib/storage');

test('keeps chinese characters and the extension', () => {
  assert.equal(downloadName('01-科技节-张三.mp4'), '01-科技节-张三.mp4');
});

test('drops apostrophes that would break the RFC 5987 prefix', () => {
  assert.equal(downloadName("O'Brien's film.mp4"), 'OBriens film.mp4');
});

test('replaces characters reserved by windows and macOS', () => {
  assert.equal(downloadName('a/b:c*d?.mp4'), 'a_b_c_d_.mp4');
});

test('truncates long titles but never the extension', () => {
  const name = downloadName('长'.repeat(200) + '.mp4');
  assert.ok(name.endsWith('.mp4'), name.slice(-8));
  assert.ok(name.length <= 100, String(name.length));
});

test('falls back to a safe name when nothing usable is given', () => {
  assert.equal(downloadName(''), 'work');
  assert.equal(downloadName(null), 'work');
  assert.equal(downloadName("'''"), 'work');
});
