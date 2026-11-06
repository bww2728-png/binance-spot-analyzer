import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const migration = await readFile(new URL('../migrations/016_public_database_access.sql', import.meta.url), 'utf8');

test('public database migration grants only anon CRUD and leaves service-role credentials out of browser grants', () => {
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /grant select, insert, update, delete on table public\.analyses to anon/i);
  assert.equal([...migration.matchAll(/alter table public\.[a-z_]+ enable row level security/gi)].length, 17);
  assert.match(migration, /for all to anon using \(true\) with check \(true\)/i);
  assert.match(migration, /grant select, insert, update, delete on all tables in schema public to anon/i);
  assert.match(migration, /grant usage, select on all sequences in schema public to anon/i);
  assert.doesNotMatch(migration, /grant\s+all\s+privileges\s+on\s+schema/i);
  assert.doesNotMatch(migration, /grant\s+.*\s+to\s+service_role/i);
  assert.match(migration, /liquidity_manual_drawings_payload_valid/i);
  assert.match(migration, /octet_length\(payload::text\) <= 16384/i);
});
