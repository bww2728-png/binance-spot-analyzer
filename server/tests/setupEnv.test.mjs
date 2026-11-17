import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEnvText } from '../tools/setup-env.mjs';

test('setup-env never asserts service-role migration success on its own', () => {
  const text = buildEnvText('', {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_test',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
    SUPABASE_SERVICE_ROLE_CONFIRMED: '0'
  });
  assert.match(text, /^SUPABASE_SERVICE_ROLE_CONFIRMED=0$/m);
  assert.doesNotMatch(text, /^SUPABASE_SERVICE_ROLE_CONFIRMED=1$/m);
});

test('setup-env preserves an already confirmed value without inventing one', () => {
  const existing = 'SUPABASE_SERVICE_ROLE_CONFIRMED=1\nCUSTOM_OPTION=keep\n';
  const text = buildEnvText(existing, {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_test',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
    SUPABASE_SERVICE_ROLE_CONFIRMED: '1'
  });
  assert.match(text, /^SUPABASE_SERVICE_ROLE_CONFIRMED=1$/m);
  assert.match(text, /^CUSTOM_OPTION=keep$/m);
});
