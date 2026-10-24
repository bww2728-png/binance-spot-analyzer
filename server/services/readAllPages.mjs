export async function readAllPages(readPage, { pageSize = 1000, maxRows = 50_000 } = {}) {
  const rows = [];
  let beforeId = null;

  for (;;) {
    const remaining = maxRows - rows.length;
    if (remaining <= 0) {
      const probe = await readPage({ beforeId, limit: 1 });
      if (!Array.isArray(probe)) throw new Error('Paged reader returned a non-array result');
      return { rows: rows.reverse(), truncated: probe.length > 0, pages: Math.ceil(rows.length / pageSize) };
    }

    const requested = Math.min(pageSize, remaining);
    const page = await readPage({ beforeId, limit: requested });
    if (!Array.isArray(page)) throw new Error('Paged reader returned a non-array result');
    if (page.length > requested) throw new Error('Paged reader exceeded the requested page size');
    rows.push(...page);

    if (rows.length >= maxRows) {
      const lastId = Number(page.at(-1)?.id);
      if (!Number.isFinite(lastId)) throw new Error('Paged reader returned a row without a numeric id');
      const probe = await readPage({ beforeId: lastId, limit: 1 });
      if (!Array.isArray(probe)) throw new Error('Paged reader returned a non-array result');
      return { rows: rows.reverse(), truncated: probe.length > 0, pages: Math.ceil(rows.length / pageSize) };
    }

    if (page.length < requested) return { rows: rows.reverse(), truncated: false, pages: Math.ceil(rows.length / pageSize) };
    const lastId = Number(page.at(-1)?.id);
    if (!Number.isFinite(lastId)) throw new Error('Paged reader returned a row without a numeric id');
    if (beforeId !== null && lastId >= beforeId) throw new Error('Paged reader cursor did not move backward');
    beforeId = lastId;
  }
}
