/**
 * عامل فحص السيولة التاريخي — ينقل حساب scanHistory خارج حلقة الأحداث.
 *
 * العلة المُصلَحة (مقيسة بالتنميط): scanHistory ينادي كشف المناطق مرة لكل شمعة
 * (O(n²)) وداخله كشف بصري + BOCPD، فاستهلك ~59% من زمن المعالج بشكل متزامن
 * يُجمّد حلقة الأحداث حتى 3.9 ثانية. الأثر: تأخّر معالجة بث الشموع، فتقادمت أسعار
 * القرار، وتأخّرت طلبات HTTP وفحوص الصحة.
 *
 * الحل: نفس الدالة تُستدعى في خيط منفصل ونُعيد نتيجتها كما هي — بلا أي تغيير في
 * الحساب أو الشروط. النتيجة مطابقة حرفياً لما كان ينتجه الخيط الرئيسي.
 */
import { parentPort } from 'node:worker_threads';
import { scanHistory, detectLiquidityZones } from '../liquidity-zones/engine.mjs';

parentPort.on('message', (msg) => {
  const { id, op, payload } = msg ?? {};
  try {
    let result;
    if (op === 'scanHistory') {
      result = scanHistory(payload);
    } else if (op === 'detectLiquidityZones') {
      result = detectLiquidityZones(payload);
    } else {
      throw new Error(`عملية غير معروفة: ${op}`);
    }
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
});
