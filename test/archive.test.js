'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inflateRawSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const archive = require('../lib/archive');

function unpack(buffer) {
  const files = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 6), 0x800);
    assert.equal(buffer.readUInt16LE(offset + 8), 8);
    const size = buffer.readUInt32LE(offset + 18),
      length = buffer.readUInt16LE(offset + 26),
      extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + length).toString();
    const start = offset + 30 + length + extra;
    const content = inflateRawSync(buffer.subarray(start, start + size));
    assert.equal(content.length, buffer.readUInt32LE(offset + 22));
    files.set(name, content.toString());
    offset = start + size;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50);
  assert.equal(buffer.readUInt16LE(buffer.length - 12), files.size);
  return files;
}
test('empty archive preserves headers, documentation and verifiable file hashes', async () => {
  const empty = {
    capturedAt: '2026-10-09T01:02:03.000Z',
    applications: [],
    works: [],
    scores: [],
    votes: [],
    files: [],
    audit: [],
    settings: {}
  };
  const { files, records } = archive.buildFiles(
    empty,
    'client',
    { deadlines: {}, retentionDays: 15 },
    { id: 'admin-fixture' }
  );
  const saved = unpack(await archive.zip(files));
  assert.equal(saved.size, 9);
  assert.match(saved.get('01-活动汇总.csv'), /2026-10-09 09:02:03/);
  assert.ok(
    [...saved.entries()]
      .filter(([name]) => name.endsWith('.csv'))
      .every(([, content]) => content.startsWith('\uFEFF'))
  );
  assert.ok(
    Object.values(records)
      .slice(1)
      .every((n) => n === 0)
  );
  const manifest = JSON.parse(saved.get('校验清单.json'));
  for (const f of manifest.files)
    assert.equal(createHash('sha256').update(saved.get(f.name)).digest('hex'), f.sha256);
});
test('PostgreSQL archives request repeatable-read before reading and refuse oversized snapshots', async () => {
  const calls = [];
  const db = {
    transaction: (fn) =>
      fn({
        dialect: 'postgres',
        query: async (sql) => {
          calls.push(sql);
          return { rows: [{ count: 100001 }] };
        }
      })
  };
  await assert.rejects(archive.capture(db), (e) => e.status === 413);
  assert.equal(calls[0], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  assert.equal(calls.length, 2);
});
