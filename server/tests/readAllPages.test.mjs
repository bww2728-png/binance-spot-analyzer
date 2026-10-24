import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAllPages, readAllPagesComplete } from '../services/readAllPages.mjs';

test('readAllPages: reads each descending cursor page once and returns chronological rows', async () => {
  const source = Array.from({ length: 7 }, (_, index) => ({ id: 7 - index }));
  const cursors = [];
  const result = await readAllPages(async ({ beforeId, limit }) => {
    cursors.push(beforeId);
    return source.filter(row => beforeId === null || row.id < beforeId).slice(0, limit);
  }, { pageSize: 3, maxRows: 20 });
  assert.deepEqual(result.rows.map(row => row.id), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(result.truncated, false);
  assert.equal(result.pages, 3);
  assert.deepEqual(cursors, [null, 5, 2]);
});

test('readAllPages: reports truncation when rows remain beyond the configured cap', async () => {
  const source = Array.from({ length: 6 }, (_, index) => ({ id: 6 - index }));
  const result = await readAllPages(async ({ beforeId, limit }) =>
    source.filter(row => beforeId === null || row.id < beforeId).slice(0, limit),
  { pageSize: 2, maxRows: 4 });
  assert.deepEqual(result.rows.map(row => row.id), [3, 4, 5, 6]);
  assert.equal(result.truncated, true);
  assert.equal(result.pages, 2);
});

test('readAllPages: propagates read failures and rejects unstable cursors', async () => {
  await assert.rejects(readAllPages(async () => { throw new Error('database unavailable'); }), /database unavailable/);
  let calls = 0;
  await assert.rejects(readAllPages(async () => {
    calls += 1;
    return [{ id: calls === 1 ? 4 : 5 }];
  }, { pageSize: 1, maxRows: 3 }), /cursor did not move backward/);
});

test('readAllPagesComplete: returns complete pages and rejects a capped partial history', async () => {
  const source = Array.from({ length: 6 }, (_, index) => ({ id: 6 - index }));
  const readPage = async ({ beforeId, limit }) =>
    source.filter(row => beforeId === null || row.id < beforeId).slice(0, limit);

  assert.deepEqual(
    await readAllPagesComplete(readPage, { pageSize: 2, maxRows: 6 }),
    [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }]
  );
  await assert.rejects(
    readAllPagesComplete(readPage, { pageSize: 2, maxRows: 4 }),
    /complete-history limit/
  );
});
