import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, createEnsureSettings } from '../services/settingsDefaults.mjs';

/** مستودع وهمي يسجّل النداءات */
const repoOf = (handlers) => {
  const calls = { get: 0, create: 0, created: [] };
  return {
    calls,
    repo: {
      async get() {
        calls.get += 1;
        return handlers.get(calls.get);
      },
      async create(row) {
        calls.create += 1;
        calls.created.push(row);
        return handlers.create(row, calls.create);
      }
    }
  };
};

test('ensureSettings: الصف الموجود يُعاد كما هو بلا كتابة', async () => {
  const row = { id: 1, quote: 'USDT', notify_timeout_min: 45, sound_enabled: false, sort_config: '{"a":1}' };
  const { repo, calls } = repoOf({ get: () => [row], create: () => { throw new Error('should not create'); } });
  const ensure = createEnsureSettings(repo);
  assert.deepEqual(await ensure(), row);
  assert.equal(calls.create, 0, 'لا إنشاء عند وجود الصف');
  assert.equal(calls.get, 1);
});

test('ensureSettings: الصف الغائب يُنشأ بالقيم الافتراضية المطابقة للمخطط', async () => {
  const { repo, calls } = repoOf({
    get: (n) => (n === 1 ? [] : [{ ...DEFAULT_SETTINGS }]),
    create: (row) => [{ ...row }]
  });
  const ensure = createEnsureSettings(repo);
  const out = await ensure();
  assert.equal(calls.create, 1);
  assert.deepEqual(calls.created[0], { ...DEFAULT_SETTINGS });
  assert.equal(out.id, 1);
  assert.equal(out.quote, 'USDT');
  assert.equal(out.notify_timeout_min, 30);
  assert.equal(out.sound_enabled, true);
  assert.equal(out.sort_config, '{}');
});

test('ensureSettings: PostgREST يعيد مصفوفة فارغة بعد الإنشاء ⇒ يُقرأ الصف ثانية', async () => {
  const created = { ...DEFAULT_SETTINGS, quote: 'BTC' };
  const { repo, calls } = repoOf({
    get: (n) => (n === 1 ? [] : [created]),
    create: () => []
  });
  const enable = createEnsureSettings(repo);
  const out = await enable();
  assert.equal(calls.get, 2, 'قراءة تعويضية بعد إنشاء بلا تمثيل');
  assert.deepEqual(out, created);
});

test('ensureSettings: سباق إنشاء متزامن (23505) ⇒ يُقرأ صف الطرف الآخر', async () => {
  const other = { ...DEFAULT_SETTINGS, notify_timeout_min: 60 };
  const { repo, calls } = repoOf({
    get: (n) => (n === 1 ? [] : [other]),
    create: () => { throw new Error('duplicate key value violates unique constraint "settings_pkey"'); }
  });
  const ensure = createEnsureSettings(repo);
  const out = await ensure();
  assert.equal(calls.create, 1);
  assert.equal(out.notify_timeout_min, 60, 'صف الطرف الآخر هو المعتمد');
});

test('ensureSettings: خطأ غير سباق يُرمى كما هو (لا إخفاء عطل حقيقي)', async () => {
  const { repo } = repoOf({
    get: () => [],
    create: () => { throw new Error('permission denied for table settings'); }
  });
  const ensure = createEnsureSettings(repo);
  await assert.rejects(() => ensure(), /permission denied/);
});

test('ensureSettings: القيم الافتراضية مجمّدة ولا تتأثر بمن عدّلها', async () => {
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  assert.throws(() => { DEFAULT_SETTINGS.quote = 'ETH'; }, TypeError);
  assert.equal(DEFAULT_SETTINGS.quote, 'USDT');
});

test('ensureSettings: مستودع ناقص يُرفض بوضوح لا بانهيار لاحق', () => {
  assert.throws(() => createEnsureSettings(null), TypeError);
  assert.throws(() => createEnsureSettings({ get: async () => [] }), TypeError);
});