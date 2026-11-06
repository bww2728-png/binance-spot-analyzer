import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = { url: 'https://supabase.test.invalid', anonKey: 'public-anon-key' };
const drawing = {
  id: 'drawing-1',
  type: 'line' as const,
  anchors: [{ time: 1_700_000_000, price: 68_000 }, { time: 1_700_000_060, price: 68_100 }],
  color: '#f23645',
  label: 'BSL touch',
  note: '',
  created_at: 1_700_000_000
};
const row = { drawing_id: drawing.id, symbol: 'BTCUSDT', timeframe: '15m', drawing_type: 'line', payload: drawing, created_at: drawing.created_at, updated_at: drawing.created_at };

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

async function loadModule() {
  vi.resetModules();
  return import('../manualLiquidity');
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('public manual drawing storage', () => {
  it('reads the runtime public config and lists drawings scoped by symbol and timeframe', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config))
      .mockResolvedValueOnce(jsonResponse([row]));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchManualDrawings } = await loadModule();

    await expect(fetchManualDrawings('btcusdt', '15m')).resolves.toEqual({ symbol: 'BTCUSDT', timeframe: '15m', drawings: [drawing] });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/manual-liquidity/config');
    const [url, options] = fetchMock.mock.calls[1];
    expect(String(url)).toContain('symbol=eq.BTCUSDT');
    expect(String(url)).toContain('timeframe=eq.15m');
    expect(String(url)).toContain('limit=5000');
    expect((options as RequestInit).headers).toMatchObject({ apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}` });
  });

  it('uses idempotent scoped upsert and confirms database representation before success', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config))
      .mockResolvedValueOnce(jsonResponse([row]));
    vi.stubGlobal('fetch', fetchMock);
    const { saveManualDrawing } = await loadModule();

    await expect(saveManualDrawing('BTCUSDT', '15m', drawing)).resolves.toMatchObject({ saved: true, drawing });
    const [url, options] = fetchMock.mock.calls[1];
    expect(String(url)).toContain('on_conflict=symbol%2Ctimeframe%2Cdrawing_id');
    expect((options as RequestInit).method).toBe('POST');
    expect((options as RequestInit).headers).toMatchObject({ Prefer: 'resolution=merge-duplicates,return=representation' });
    expect(JSON.parse(String((options as RequestInit).body))).toMatchObject({ drawing_id: 'drawing-1', symbol: 'BTCUSDT', timeframe: '15m' });
  });

  it('deletes a drawing only within the exact symbol and timeframe', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { deleteManualDrawing } = await loadModule();

    await expect(deleteManualDrawing('BTCUSDT', '15m', 'drawing-1')).resolves.toEqual({ ok: true, drawingId: 'drawing-1' });
    const [url, options] = fetchMock.mock.calls[1];
    expect(String(url)).toContain('drawing_id=eq.drawing-1');
    expect(String(url)).toContain('symbol=eq.BTCUSDT');
    expect(String(url)).toContain('timeframe=eq.15m');
    expect((options as RequestInit).method).toBe('DELETE');
  });

  it('does not contact Supabase or report success after config, network, or input failure', async () => {
    const configFailure = vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'missing anon key' }, 503));
    vi.stubGlobal('fetch', configFailure);
    const first = await loadModule();
    await expect(first.fetchManualDrawings('BTCUSDT', '15m')).rejects.toThrow('missing anon key');
    expect(configFailure).toHaveBeenCalledTimes(1);

    const dbFailure = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config))
      .mockResolvedValueOnce(jsonResponse({ message: 'database offline' }, 503));
    vi.stubGlobal('fetch', dbFailure);
    const second = await loadModule();
    await expect(second.saveManualDrawing('BTCUSDT', '15m', drawing)).rejects.toThrow('database offline');
    expect(dbFailure).toHaveBeenCalledTimes(2);
    await expect(second.fetchManualDrawings('BTC USDT', '15m')).rejects.toThrow('الرمز أو الفريم غير صالحين');
    expect(dbFailure).toHaveBeenCalledTimes(2);
  });
});
