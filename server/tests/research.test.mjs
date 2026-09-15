import test from 'node:test';
import assert from 'node:assert/strict';

const { extractFacts, verdictGate, researchConfidence, researchSummary, FACT_KEYS, CONFIDENCE_THRESHOLD } =
  await import('../researchCore.mjs');
const { pickCoinId, pickCoinIdFromMarkets, tickerMatchesBinanceBase, createRateLimiter } =
  await import('../research.mjs');

test('مطابقة الرموز عبر /coins/markets: رمز حرفي واحد يعاد مباشرة', () => {
  const markets = [{ id: 'magic-eden', symbol: 'ME', market_cap_rank: 120 }];
  assert.equal(pickCoinIdFromMarkets(markets, 'ME'), 'magic-eden');
});

test('مطابقة الرموز عبر /coins/markets: الأدنى رتبة سوقية يفوز', () => {
  const markets = [
    { id: 'obscure', symbol: 'XYZ', market_cap_rank: 900 },
    { id: 'prominent', symbol: 'XYZ', market_cap_rank: 30 }
  ];
  assert.equal(pickCoinIdFromMarkets(markets, 'XYZ'), 'prominent');
});

test('مطابقة الرموز عبر /coins/markets: رموز غير متطابقة → null', () => {
  const markets = [{ id: 'other', symbol: 'VELO', market_cap_rank: 657 }];
  assert.equal(pickCoinIdFromMarkets(markets, 'VELODROME'), null);
});

test('مطابقة الرموز عبر /coins/markets: مرشحان بلا رتبة → غموض → null', () => {
  const markets = [
    { id: 'a', symbol: 'XX', market_cap_rank: null },
    { id: 'b', symbol: 'XX', market_cap_rank: null }
  ];
  assert.equal(pickCoinIdFromMarkets(markets, 'XX'), null);
});

test('مطابقة الرموز عبر /coins/markets: نتيجة فارغة أو غير مصفوفة → null', () => {
  assert.equal(pickCoinIdFromMarkets([], 'ME'), null);
  assert.equal(pickCoinIdFromMarkets(null, 'ME'), null);
});

test('تحقق تيكارز بينانس: base مطابق + سوق بينانس + coin_id → true', () => {
  const res = { tickers: [{ base: 'VELODROME', market: { identifier: 'binance' }, coin_id: 'velodrome-finance', is_anomaly: false }] };
  assert.equal(tickerMatchesBinanceBase(res, 'VELODROME'), true);
  assert.equal(tickerMatchesBinanceBase(res, 'velodrome'), true);
});

test('تحقق تيكارز بينانس: base مختلف أو شاذ أو بلا coin_id → false', () => {
  const res = { tickers: [{ base: 'VELO', market: { identifier: 'binance' }, coin_id: 'velodrome-finance', is_anomaly: false }] };
  assert.equal(tickerMatchesBinanceBase(res, 'VELODROME'), false);
  const anomaly = { tickers: [{ base: 'VELODROME', market: { identifier: 'binance' }, coin_id: 'x', is_anomaly: true }] };
  assert.equal(tickerMatchesBinanceBase(anomaly, 'VELODROME'), false);
  const noId = { tickers: [{ base: 'VELODROME', market: { identifier: 'binance' }, coin_id: null, is_anomaly: false }] };
  assert.equal(tickerMatchesBinanceBase(noId, 'VELODROME'), false);
  const otherMarket = { tickers: [{ base: 'VELODROME', market: { identifier: 'bybit' }, coin_id: 'velodrome-finance', is_anomaly: false }] };
  assert.equal(tickerMatchesBinanceBase(otherMarket, 'VELODROME'), false);
  assert.equal(tickerMatchesBinanceBase(null, 'VELODROME'), false);
});

test('عملة ميم رسمية: ميم + مضاربة + بلا منفعة بثقة عالية', () => {
  const f = extractFacts({
    categories: ['Meme', 'BNB Chain Ecosystem'],
    description: 'A community-driven token celebrating internet culture.'
  });
  assert.equal(f.is_memecoin.value, true);
  assert.equal(f.is_memecoin.confidence, 0.95);
  assert.equal(f.pure_speculation.value, true);
  assert.equal(f.has_utility.value, false);
  assert.ok(f.is_memecoin.confidence >= CONFIDENCE_THRESHOLD);
});

test('عملة إقراض رسمية: إقراض بفائدة محسومة', () => {
  const f = extractFacts({
    categories: ['Lending', 'Decentralized Finance (DeFi)'],
    description: 'Decentralized money market for lending and borrowing assets.'
  });
  assert.equal(f.has_lending_interest.value, true);
  assert.equal(f.has_lending_interest.confidence, 0.9);
});

test('عملة خصوصية قسرية: إخفاء عالٍ', () => {
  const f = extractFacts({
    categories: ['Privacy Coins'],
    description: 'Private transactions by default.'
  });
  assert.equal(f.privacy_concern.value, true);
  assert.equal(f.privacy_concern.confidence, 0.95);
});

test('بنية تحتية معلنة لا تسقط في شبهة الخصوصية من كلماتها العامة', () => {
  const f = extractFacts({
    categories: ['Layer 2', 'Infrastructure'],
    description: 'A scaling platform for anonymous transactions processing.'
  });
  assert.equal(f.privacy_concern.value, null);
  assert.equal(f.has_utility.value, true);
});

test('وصف فارغ بلا تصنيفات: كل الحقائق مجهولة — الغياب ليس دليلاً', () => {
  const f = extractFacts({ categories: [], description: '' });
  for (const k of FACT_KEYS) {
    assert.equal(f[k].value, null, `${k} يجب أن يبقى مجهولاً`);
  }
});

test('بوابة الثقة: حقيقة 0.7 تُهمل ولا تدخل الحكم', () => {
  const raw = extractFacts({ categories: ['Stablecoin'], description: 'A digital dollar.' });
  const gated = verdictGate(raw);
  assert.equal(raw.is_asset_backed.value, true);
  assert.equal(raw.is_asset_backed.confidence, 0.75);
  assert.equal(gated.is_asset_backed, null, '0.75 < 0.85 — يجب أن يُهمل');
  const other = extractFacts({ categories: ['Stablecoin'], description: 'Backed by reserves with proof of reserves.' });
  assert.equal(verdictGate(other).is_asset_backed, true);
});

test('حتمية كاملة: نفس المدخل يعطي نفس المخرجات حرفياً', () => {
  const input = { categories: ['Meme', 'Lending'], description: 'Gambling casino lending with APY.' };
  const a = extractFacts(input);
  const b = extractFacts(input);
  assert.deepEqual(a, b);
  assert.deepEqual(verdictGate(a), verdictGate(b));
  assert.equal(researchConfidence(a), researchConfidence(b));
});

test('ملخص البحث يعيد العدد الصحيح قبل/بعد البوابة', () => {
  const raw = extractFacts({ categories: ['Meme'], description: '' });
  const gated = verdictGate(raw);
  const s = researchSummary(raw, gated);
  /* ثلاث حقائق محسومة (ميم 0.95، مضاربة 0.9، بلا منفعة 0.8) — البوابة تهمل 0.8 دون 0.85 */
  assert.equal(s.resolvedRaw, 3);
  assert.equal(s.resolvedGated, 2);
});

test('مطابقة الرمز: رمز صريح متساوٍ فقط، والأبرز سوقياً أولاً', () => {
  const res = {
    coins: [
      { id: 'prominent-match', symbol: 'XYZ', market_cap_rank: 5 },
      { id: 'obscure-match', symbol: 'xyz', market_cap_rank: 120 },
      { id: 'other', symbol: 'XYZ2', market_cap_rank: 1 }
    ]
  };
  assert.equal(pickCoinId(res, 'XYZ'), 'prominent-match');
  assert.equal(pickCoinId({ coins: [] }, 'XYZ'), null);
  assert.equal(pickCoinId({}, 'XYZ'), null);
});

test('محدد المعدل: لا يمر طلبان خلال فترة أقصر من النافذة', async () => {
  const limiter = createRateLimiter(120);
  const t0 = Date.now();
  await limiter.acquire();
  await limiter.acquire();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 110, `الفرق الفعلي ${elapsed}ms يجب أن يوافق النافذة`);
});
