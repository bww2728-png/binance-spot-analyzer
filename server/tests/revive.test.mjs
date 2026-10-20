import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviveDecision, REVIVE_COOLDOWN_MS, REVIVE_MAX } from '../services/revive.mjs';

/**
 * قرار الإحياء: لا يكفي كشف تعليق المحرك — بلا إحياء تبقى كل الدورات التالية موقوفة
 * إلى الأبد، وهو ما يمنع تشغيلاً طويلاً بلا مراقبة. لكن الإحياء بلا حدّ يخفي العطل.
 */

const stalled = (sinceMs) => ({ stalled: true, sinceCycleMs: sinceMs });
const alive = () => ({ stalled: false, sinceCycleMs: 100 });
const T = 1_800_000_000_000;

test('محرك يعمل: لا إحياء، ويُسقط سجل المحاولات عند عودته', () => {
  const d = reviveDecision(alive(), { at: T - 1000, count: 3 }, T);
  assert.equal(d.action, 'idle');
  assert.equal(d.record.count, 0, 'سجل المحاولات يُصفَّر بعد العودة للعمل');
});

test('محرك معلق بلا محاولات سابقة: يُحيا فوراً', () => {
  const d = reviveDecision(stalled(600_000), undefined, T);
  assert.equal(d.action, 'revive');
  assert.equal(d.record.count, 1);
  assert.equal(d.record.at, T);
});

test('لا إحياء متكرر قبل انقضاء المهلة (منع المطرقة)', () => {
  const rec = { at: T, count: 1 };
  const early = reviveDecision(stalled(700_000), rec, T + 60_000);
  assert.equal(early.action, 'skip', 'بعد دقيقة لا إحياء آخر');
  assert.equal(early.record.count, 1, 'لا استهلاك لمحاولة');
  const later = reviveDecision(stalled(1_200_000), rec, T + REVIVE_COOLDOWN_MS);
  assert.equal(later.action, 'revive', 'بعد المهلة يُسمح بمحاولة');
  assert.equal(later.record.count, 2);
});

test('سقف المحاولات: يتوقف عن المحاولة ويُنبّه مرة كل ساعة', () => {
  const rec = { at: T, count: REVIVE_MAX };
  const d = reviveDecision(stalled(3_600_000), rec, T + 60_000);
  assert.equal(d.action, 'exhausted');
  assert.equal(d.warn, false, 'لا إنذار متكرر قبل الساعة');
  const warn = reviveDecision(stalled(7_200_000), rec, T + 61 * 60_000);
  assert.equal(warn.action, 'exhausted');
  assert.equal(warn.warn, true, 'إنذار صريح بعد ساعة بلا نجاح');
});

test('يمكن تعطيل الإحياء تلقائياً (تحكّم تشغيلي)', () => {
  const d = reviveDecision(stalled(600_000), undefined, T, { enabled: false });
  assert.equal(d.action, 'skip');
});

test('لا انهيار على حالة مفقودة (حلقة لم تُسجَّل بعد)', () => {
  assert.equal(reviveDecision(null, undefined, T).action, 'idle');
  assert.equal(reviveDecision(undefined, undefined, T).action, 'idle');
});
