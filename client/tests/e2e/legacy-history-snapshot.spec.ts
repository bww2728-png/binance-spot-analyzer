import { expect, test } from '@playwright/test';

const startTime = Date.UTC(2025, 0, 1);
const intervalSeconds = 60 * 60;
const candles = Array.from({ length: 96 }, (_, index) => {
  const time = startTime / 1000 + index * intervalSeconds;
  const base = 99 + Math.sin(index / 6) * 1.5;
  const open = base;
  const close = base + Math.sin(index) * 0.4;
  return [time, open, Math.max(open, close) + 0.8, Math.min(open, close) - 0.8, close, 120 + index] as const;
});
const zoneAvailableAt = candles[80][0];
const snapshotRequests: string[] = [];
const zone = {
  id: 'fixture-zone-1',
  kind: 'horizontal_bsl',
  state: 'confirmed',
  direction: 'above',
  referenceLevel: 100,
  referenceAlt: null,
  liquidityLevel: 100.4,
  zoneBox: { high: 101, low: 99.5 },
  bodyBox: null,
  createdAt: candles[76][0],
  confirmedAt: zoneAvailableAt,
  detectedAt: zoneAvailableAt,
  sweptAt: null,
  invalidatedAt: null,
  invalidation: null,
  availableAt: zoneAvailableAt,
  availableAtBasis: 'pivot_confirm',
  confidence: 0.8,
  touches: 2,
  timeframe: '1h',
  engine: 'legacy',
  touchPoints: [
    { index: 72, time: candles[72][0], price: 101, availableAt: candles[75][0] },
    { index: 76, time: candles[76][0], price: 101, availableAt: zoneAvailableAt }
  ],
  trendline: null,
  staircase: null,
  finalBreak: null,
  breakSteps: [],
  atr: 1,
  distanceAtr: 1,
  prominenceAtr: 1,
  reasons: ['fixture'],
  premium: null,
  form: 'pivots',
  fvgs: [],
  structureEventKeys: [],
  source: 'legacy_engine'
};
const snapshot = {
  engineKey: 'legacy',
  engine: 'Legacy Liquidity Engine',
  symbol: 'BTCUSDT',
  timeframe: '1h',
  startTime,
  endTime: candles.at(-1)![0] * 1000 + 3_600_000,
  snapshotTime: candles.at(-1)![0] * 1000 + 3_600_000,
  warmupStartTime: startTime,
  warmupBars: 0,
  source: 'binance_spot_rest',
  bars: candles.length,
  totalZones: 1,
  zones: [zone],
  quality: {
    sourceUnit: 'milliseconds',
    intervalMs: 3_600_000,
    receivedRows: candles.length,
    acceptedBars: candles.length,
    incompleteBars: 0,
    gapCount: 0,
    missingBars: 0,
    gaps: [],
    firstOpenTime: startTime,
    lastOpenTime: candles.at(-1)![0] * 1000
  },
  meta: { rightBars: 3, computeMs: 4, computedAt: Date.now() },
  candles,
  cached: false
};

const health = {
  ok: true,
  up: 1,
  uptimeSec: 1,
  mem: { rssMb: 1, heapUsedMb: 1, limitMb: null, headroomMb: null },
  lagMs: { p50: 0, p95: 0, p99: 0, max: 0 },
  persist: { persistFailures: 0, persistWrites: 0, lastPersistError: null },
  engines: [],
  marks: {},
  market: { connected: true, streams: 0, priceAgeMs: null, stalePriceRatio: null, analyzedSymbols: 0, analyzedPriced: 0, silentConns: 0 },
  dataFresh: { ok: true, reason: '' }
};

async function mockApplicationApis(page: import('@playwright/test').Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/health/deep') return route.fulfill({ json: health });
    if (url.pathname === '/api/liquidity-history/snapshot') {
      snapshotRequests.push(url.search);
      return route.fulfill({ json: snapshot });
    }
    if (url.pathname === '/api/liquidity-zones/status') return route.fulfill({ json: {
      live: { busy: false, rotation: 0, pairsDone: 0, pairsTotal: 0, total: 0 },
      history: { busy: false, rotation: 0, pairsDone: 0, pairsTotal: 0, total: 0 },
      adjustment: { tolerancePct: 0, examples: 0 },
      updatedAt: null,
      error: null
    } });
    if (url.pathname === '/api/liquidity-zones/live') return route.fulfill({ json: { results: [], total: 0, rotation: 0 } });
    if (url.pathname === '/api/settings') return route.fulfill({ json: { quote: 'USDT', sound_enabled: false } });
    if (url.pathname === '/api/barcode-scans' || url.pathname === '/api/shariah') return route.fulfill({ json: [] });
    if (url.pathname === '/api/symbols/meta') return route.fulfill({ json: { last_updated: 1 } });
    return route.fulfill({ json: {} });
  });
  await page.route('https://api.binance.com/**', (route) => route.fulfill({ json: [] }));
}

test('loads and renders a legacy historical snapshot, selects its zone, and resizes', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
  await page.routeWebSocket('**/ws', async (socket) => { await socket.close({ code: 1000, reason: 'test isolation' }); });
  await mockApplicationApis(page);
  await page.goto('/#/liquidityZones');
  const screenError = page.getByText('تعذّر عرض شاشة «مناطق السيولة القديمة»');
  const snapshotEntry = page.getByRole('button', { name: 'الشارت التاريخي للمحرك القديم' });
  await Promise.race([
    snapshotEntry.waitFor({ state: 'visible' }),
    screenError.waitFor({ state: 'visible' })
  ]);
  if (await screenError.isVisible()) {
    await page.getByText('تفاصيل تقنية').click();
    throw new Error(await page.locator('pre').innerText());
  }
  await snapshotEntry.click();

  await expect(page.getByRole('heading', { name: 'الشارت التاريخي — المحرك القديم' })).toBeVisible();
  await page.getByLabel('من تاريخ UTC').fill('2025-01-01');
  await page.getByLabel('إلى تاريخ UTC').fill('2025-01-04');
  await page.getByRole('button', { name: 'تحميل اللقطة التاريخية' }).click();
  await expect(page.getByText(/على الشارت 3/)).toBeVisible();
  expect(snapshotRequests).toHaveLength(1);
  const requestedSnapshot = new URLSearchParams(snapshotRequests[0]);
  expect(requestedSnapshot.get('symbol')).toBe('BTCUSDT');
  expect(requestedSnapshot.get('timeframe')).toBe('1h');
  expect(requestedSnapshot.get('startTime')).toBe(String(startTime));
  expect(requestedSnapshot.get('endTime')).toBe(String(startTime + candles.length * 3_600_000));
  await expect(page.getByText('مناطق المحرك')).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();

  const chart = page.locator('canvas').first();
  await expect(chart).toHaveScreenshot('legacy-history-snapshot-chart.png');
  const initialBounds = await chart.boundingBox();
  expect(initialBounds).not.toBeNull();
  await page.mouse.click(initialBounds!.x + initialBounds!.width * 0.92, initialBounds!.y + initialBounds!.height * 0.24);
  await expect(page.getByText('بيانات المنطقة كما وصلت من المحرك')).toBeVisible();
  await page.locator('details').last().locator('summary').click();
  await expect(page.locator('pre').filter({ hasText: 'fixture-zone-1' })).toBeVisible();

  await page.setViewportSize({ width: 1120, height: 900 });
  await expect(page.getByText(/على الشارت 3/)).toBeVisible();
  const resizedBounds = await chart.boundingBox();
  expect(resizedBounds).not.toBeNull();
  expect(resizedBounds!.width).toBeLessThan(initialBounds!.width);
  expect(pageErrors).toEqual([]);
});
