/**
 * ★2 (وضع الظل — **لا يُفعَّل ولا يقرأه أي قرار**): معرّف منطقة سيولة ثابت + قياسه.
 *
 * العيب المؤكد (A4): المعرّف الحالي `cluster-<kind>-<i>-<price>` يحمل ترتيب العنقود `i`،
 * وترتيب العنقود يتغيّر كلما ظهرت قمة أو قاع جديد قبله. فمنطقة لم يتغيّر سعرها ولا
 * نوعها ولا فريمها يتغيّر معرّفها بين دورتين، ويُبقي `mergeZones` النسختين معاً مع أن
 * المنطقة واحدة — وهذا يضخّم المخزون، ويفقد محرك Fabio حالة «سويب» عندما يتغيّر
 * المعرّف، ويجعل الاستعادة بعد إعادة التشغيل شبه عديمة الفائدة.
 *
 * الحل المقترح: معرّف من **محتوى المنطقة** لا من موضعها في الترتيب:
 *   `<النوع>|<الفريم>|<شبكة السعر عند مستوى المرجع>`
 * فلا يتغيّر المعرّف إذا لم يتغيّر النوع والفريم والمستوى.
 *
 * لكن الشبكة نفسها لها حدّ: منطقة تنزلق سعرياً عبر حدّ الشبكة يتغيّر معرّفها. فليست
 * هناك شبكة «مثالية» — ولذلك **تُقارن شبكات متعددة بالقياس** على بيانات حقيقية،
 * ويُختار العرض الأقل دوراناً. هذا الملف يقيس فقط، ولا يستبدل معرّفاً ولا يغيّر دمجاً.
 */

/** نوع المنطقة بالصيغة القياسية للشبكة */
function kindOf(zone) {
  return String(zone?.kind ?? 'unknown');
}

/** مستوى المرجع المستخدم في الشبكة: مستوى السيولة إن وُجد، وإلا المرجع */
function levelOf(zone) {
  const level = Number(zone?.liquidityLevel ?? zone?.referenceLevel);
  return Number.isFinite(level) && level !== 0 ? level : null;
}

/**
 * معرّف مرشَّح من المحتوى وحده.
 * @param {object} zone منطقة المحرك
 * @param {number} grid عرض خلية الشبكة **نسبياً** (‎0.002 = 0.2% مطابق لنسبة العنقدة)
 */
export function candidateZoneId(zone, grid = 0.002) {
  const level = levelOf(zone);
  if (level == null) return null;
  const step = Math.max(1e-6, Number(grid) || 0.002);
  /**
   * التقريب بمنطق «أقرب مضاعف» لا «أرضية القسمة»: الأرضية تُنشئ فرقاً كاملاً بين
   * خليتين متجاورتين لمستويين يفصلهما جزء من ألف، فينفجر الدوران عند الحدود.
   */
  const bucket = Math.round(level / (level * step)) || 0;
  return `z|${kindOf(zone)}|${String(zone?.timeframe ?? '')}|${bucket}`;
}

/** نسخة من المنطقة بمعرّف مرشَّح — يُستخدم لإعادة تشغيل منطق المطابقة نفسه بلا تكراره */
export function withCandidateId(zone, grid = 0.002) {
  const id = candidateZoneId(zone, grid);
  return id == null ? zone : { ...zone, id };
}

/**
 * يقيس دوران المعرّف **للمرشَّح** بعينه بنفس منطق `idStability` المُختبَر:
 * المطابقة بالتقارب والنوع (لا بالمعرّف)، ثم هل ثبت المعرّف بعد الاستبدال؟
 *
 * @param {Array} prev مناطق التشغيل الأقدم
 * @param {Array} next مناطق التشغيل الأحدث (نفس المنطقة مادياً عند التقارب)
 * @param {Function} idStability دالة القياس المُختبَرة (تُمرَّر لتبقى الوحدة نقية)
 * @param {number[]} grids شبكات مرشَّحة
 */
export function measureCandidateGrids({ prev = [], next = [], tolerancePct = 0.002, grids = [0.001, 0.002, 0.004], idStability }) {
  if (typeof idStability !== 'function' || !prev.length || !next.length) return [];
  return grids.map((grid) => {
    const before = prev.map(z => withCandidateId(z, grid));
    const after = next.map(z => withCandidateId(z, grid));
    const r = idStability(before, after, tolerancePct, 0);
    return {
      grid,
      matched: r.matched,
      churned: r.churned,
      keepRate: r.matched === 0 ? null : Number(((r.matched - r.churned) / r.matched).toFixed(4)),
      churnRate: r.churnRate
    };
  });
}

/**
 * مجمّع تراكمي لدوران المرشَّح: مرجَّح بعدد المناطق المُطابَقة، ومقسّم بالشبكة.
 * تقرير فقط — يُعرض في الفحص الصحي ليقرر المستخدم أي شبكة تُعتمد.
 */
export function createCandidateCollector() {
  let samples = 0;
  let zonesSeen = 0;
  const byGrid = new Map();
  return {
    add(sample) {
      if (!sample) return;
      samples += 1;
      zonesSeen = Math.max(zonesSeen, Number(sample.zonesFull) || 0);
      const base = { before: sample.zonesTrimmed ?? 0, after: sample.zonesFull ?? 0 };
      for (const row of sample.grids ?? []) {
        const key = row.grid;
        const acc = byGrid.get(key) ?? { grid: key, matched: 0, churned: 0, frames: 0 };
        acc.matched += row.matched;
        acc.churned += row.churned;
        acc.frames += 1;
        byGrid.set(key, acc);
      }
      void base;
    },
    summary() {
      return {
        samples,
        grids: [...byGrid.values()].map(a => ({
          grid: a.grid,
          matched: a.matched,
          churned: a.churned,
          keepRate: a.matched === 0 ? null : Number(((a.matched - a.churned) / a.matched).toFixed(4)),
          frames: a.frames
        })).sort((x, y) => x.grid - y.grid),
        note: 'قياس ★2 فقط: لم يُستبدل أي معرّف ولا تغيّر أي دمج. التفعيل يتطلب موافقة صريحة.'
      };
    }
  };
}
