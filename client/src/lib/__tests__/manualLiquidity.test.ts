import { beforeEach, describe, expect, it, vi } from 'vitest';

const drawing = {
  id: 'drawing-1',
  type: 'line' as const,
  anchors: [{ time: 1_700_000_000, price: 68_000 }, { time: 1_700_000_060, price: 68_100 }],
  color: '#f23645',
  label: 'BSL touch',
  note: '',
  created_at: 1_700_000_000
};
const drawingResponse = { symbol: 'BTCUSDT', timeframe: '15m', drawings: [drawing] };

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

describe('server-proxied manual drawing storage', () => {
  it('lists drawings through the Express API scoped by symbol and timeframe', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(drawingResponse));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchManualDrawings } = await loadModule();

    await expect(fetchManualDrawings('btcusdt', '15m')).resolves.toEqual({ symbol: 'BTCUSDT', timeframe: '15m', drawings: [drawing] });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/manual-liquidity/drawings?symbol=BTCUSDT&timeframe=15m');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('saves a drawing through Express and confirms the server representation before success', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ saved: true, drawing }));
    vi.stubGlobal('fetch', fetchMock);
    const { saveManualDrawing } = await loadModule();

    await expect(saveManualDrawing('BTCUSDT', '15m', drawing)).resolves.toEqual({ saved: true, drawing });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/manual-liquidity/drawings');
    expect((options as RequestInit).method).toBe('PUT');
    expect(JSON.parse(String((options as RequestInit).body))).toMatchObject({ drawing_id: drawing.id, symbol: 'BTCUSDT', timeframe: '15m', ...drawing });
  });

  it('deletes a drawing through Express only within the exact symbol and timeframe', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: true, drawingId: 'drawing-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const { deleteManualDrawing } = await loadModule();

    await expect(deleteManualDrawing('BTCUSDT', '15m', 'drawing-1')).resolves.toEqual({ ok: true, drawingId: 'drawing-1' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/manual-liquidity/drawings/drawing-1?symbol=BTCUSDT&timeframe=15m');
    expect((options as RequestInit).method).toBe('DELETE');
  });

  it('does not report success after API, network, validation, or malformed response failure', async () => {
    const apiFailure = vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'database offline' }, 503));
    vi.stubGlobal('fetch', apiFailure);
    const first = await loadModule();
    await expect(first.fetchManualDrawings('BTCUSDT', '15m')).rejects.toThrow('database offline');
    expect(apiFailure).toHaveBeenCalledTimes(1);

    const networkFailure = vi.fn().mockRejectedValueOnce(new TypeError('network down'));
    vi.stubGlobal('fetch', networkFailure);
    const second = await loadModule();
    await expect(second.saveManualDrawing('BTCUSDT', '15m', drawing)).rejects.toThrow('network down');
    expect(networkFailure).toHaveBeenCalledTimes(1);

    const malformed = vi.fn().mockResolvedValueOnce(jsonResponse({ drawings: [] }));
    vi.stubGlobal('fetch', malformed);
    const third = await loadModule();
    await expect(third.fetchManualDrawings('BTCUSDT', '15m')).rejects.toThrow('لا يطابق الرمز');
    await expect(third.fetchManualDrawings('BTC USDT', '15m')).rejects.toThrow('الرمز أو الفريم غير صالحين');
    expect(malformed).toHaveBeenCalledTimes(1);
  });

  it('never sends a request to a database REST endpoint or asks for a runtime public config', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(drawingResponse));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchManualDrawings } = await loadModule();
    await fetchManualDrawings('BTCUSDT', '15m');
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/^\/api\/manual-liquidity\//);
      expect(String(url)).not.toContain('/rest/v1');
      expect(String(url)).not.toContain('/config');
    }
  });
});
