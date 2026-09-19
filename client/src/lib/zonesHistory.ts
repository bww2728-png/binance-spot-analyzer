import type { EventLog, ZoneHistoryGroup, ZoneHistoryVersion, LiquidityZone } from './types';

/** مرآة لـ server/archive.mjs — تجميع أحداث liquidity_zone إلى سلاسل نسخ لكل منطقة. */
export function groupZoneHistory(events: EventLog[]): ZoneHistoryGroup[] {
  const groups = new Map<string, { eventId: number; ts: number; zone: LiquidityZone }[]>();
  for (const e of events ?? []) {
    let zone: LiquidityZone | null = null;
    try {
      const z = e.meta ? (JSON.parse(e.meta) as LiquidityZone) : null;
      if (z && typeof z.id === 'string' && z.source !== 'auto') zone = z;
    } catch { /* تجاهل */ }
    if (!zone) continue;
    const chain = groups.get(zone.id) ?? [];
    chain.push({ eventId: e.id, ts: Number(e.ts ?? 0), zone });
    groups.set(zone.id, chain);
  }

  const out: ZoneHistoryGroup[] = [];
  for (const [zoneId, chain] of groups) {
    chain.sort((a, b) => a.ts - b.ts || a.eventId - b.eventId);
    const versions = chain.map((v, i) => ({
      ...v,
      action: (i === 0 ? 'create' : v.zone.active === false ? 'delete' : 'edit') as ZoneHistoryVersion['action']
    }));
    const lastVersion = versions[versions.length - 1];
    out.push({
      zoneId,
      symbol: String(lastVersion.zone.symbol ?? '').toUpperCase(),
      versions,
      deleted: lastVersion.zone.active === false,
      lastVersion
    });
  }

  out.sort((a, b) => (b.lastVersion.ts - a.lastVersion.ts) || (b.lastVersion.eventId - a.lastVersion.eventId));
  return out;
}