import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPendingManualMutation,
  listPendingManualMutations,
  queueManualMutation
} from '../manualDrawingOutbox';

const drawing = {
  id: 'drawing-outbox-1',
  type: 'line' as const,
  anchors: [{ time: 1_700_000_000, price: 68_000 }, { time: 1_700_000_060, price: 68_100 }],
  color: '#f23645',
  label: 'pending save',
  note: '',
  created_at: 1_700_000_000
};

beforeEach(async () => {
  const pending = await listPendingManualMutations('BTCUSDT', '15m');
  await Promise.all(pending.map((record) => clearPendingManualMutation(record.symbol, record.timeframe, record.drawingId)));
});

describe('manual drawing outbox', () => {
  it('keeps one deterministic pending mutation per chart and retries the latest state', async () => {
    await queueManualMutation({ operation: 'save', symbol: 'BTCUSDT', timeframe: '15m', drawing, drawingId: drawing.id });
    await queueManualMutation({ operation: 'save', symbol: 'BTCUSDT', timeframe: '15m', drawing: { ...drawing, label: 'latest' }, drawingId: drawing.id });

    const pending = await listPendingManualMutations('BTCUSDT', '15m');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ operation: 'save', drawingId: drawing.id, drawing: { label: 'latest' } });
  });

  it('scopes pending work by symbol and timeframe and replaces save with delete', async () => {
    await queueManualMutation({ operation: 'save', symbol: 'BTCUSDT', timeframe: '15m', drawing, drawingId: drawing.id });
    await queueManualMutation({ operation: 'delete', symbol: 'BTCUSDT', timeframe: '15m', drawing: null, drawingId: drawing.id });
    await queueManualMutation({ operation: 'save', symbol: 'ETHUSDT', timeframe: '15m', drawing, drawingId: 'e-1' });

    expect(await listPendingManualMutations('BTCUSDT', '15m')).toMatchObject([{ operation: 'delete', drawingId: drawing.id }]);
    expect(await listPendingManualMutations('ETHUSDT', '15m')).toMatchObject([{ operation: 'save', drawingId: 'e-1' }]);
    expect(await listPendingManualMutations('BTCUSDT', '1h')).toEqual([]);
  });

  it('clears only the delivered mutation after a successful retry', async () => {
    await queueManualMutation({ operation: 'save', symbol: 'BTCUSDT', timeframe: '15m', drawing, drawingId: drawing.id });
    await clearPendingManualMutation('BTCUSDT', '15m', drawing.id);
    expect(await listPendingManualMutations('BTCUSDT', '15m')).toEqual([]);
  });
});
