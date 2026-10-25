export function summarizeOpportunityHistory(rows, eventCount, { truncated = false } = {}) {
  const events = Array.isArray(rows) ? rows : [];
  const ids = new Set();
  let invalidRows = 0;

  for (const row of events) {
    try {
      const metadata = typeof row?.meta === 'string' ? JSON.parse(row.meta || '{}') : (row?.meta ?? {});
      const id = metadata?.opportunity?.id;
      if (id == null || String(id).length === 0) invalidRows += 1;
      else ids.add(String(id));
    } catch {
      invalidRows += 1;
    }
  }

  const validEventCount = Number.isSafeInteger(eventCount) && eventCount >= 0 ? eventCount : null;
  return {
    eventCount: validEventCount,
    uniqueOpportunityCount: ids.size,
    uniqueCountComplete: validEventCount != null && !truncated && invalidRows === 0 && events.length === validEventCount,
    scannedEvents: events.length
  };
}
