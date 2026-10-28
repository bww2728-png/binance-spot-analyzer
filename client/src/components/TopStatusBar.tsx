import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';

/**
 * شريط الحالة العلوي — بديل مختصر بعد حذف لوحة التحكم وشاشة الإعدادات:
 * صحة الخادم، آخر تحديث للأسعار، عدد الفرص الحية، مُبدِّل الاقتباس، زر الصوت.
 */
export default function TopStatusBar() {
  const liveOppTick = useStore(s => s.liveOppTick);
  const liveOppSocketState = useStore(s => s.liveOppSocketState);
  const settings = useStore(s => s.settings);
  const saveSettings = useStore(s => s.saveSettings);
  const soundEnabled = useStore(s => s.soundEnabled);
  const pushToast = useStore(s => s.pushToast);
  const pricesUpdatedAt = useStore(s => s.pricesUpdatedAt);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const priceAge = pricesUpdatedAt ? Math.max(0, Math.round((now - pricesUpdatedAt) / 1000)) : null;
  const socketConnected = liveOppSocketState === 'connected';
  const socketState = socketConnected ? 'متصل' : liveOppSocketState === 'connecting' ? 'جار الاتصال' : 'منقطع';
  const socketColor = socketConnected ? '#26a69a' : liveOppSocketState === 'connecting' ? '#ffb74d' : '#ef5350';

  const oppCount = liveOppTick ? Object.keys(liveOppTick.opportunities).length : null;
  const quote = settings?.quote ?? 'USDT';

  const changeQuote = async (next: string) => {
    if (next === quote) return;
    if (!confirm(`سيتم إعادة تحميل الأزواج على "${next}". متابعة؟`)) return;
    try {
      await saveSettings({ quote: next });
      pushToast(`تم تحويل الاقتباس إلى ${next} — جارٍ إعادة المزامنة`);
    } catch (e) {
      pushToast(`فشل تغيير الاقتباس: ${String(e)}`);
    }
  };

  return (
    <div className="top-status-bar" role="status" style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      padding: '4px 12px', fontSize: 12, borderBottom: '1px solid var(--border, #2a2e39)',
      background: 'var(--bg-panel, transparent)'
    }}>
      <span title="حالة اتصال بث الفرص الحية على الخادم">
        <span style={{ color: socketColor }}>●</span>{' '}
        اتصال الفرص: {socketState}
      </span>
      <span title="عمر آخر سعر وصل من السوق">
        الأسعار: {priceAge == null ? '—' : priceAge < 60 ? `قبل ${priceAge} ثانية` : `قبل ${Math.round(priceAge / 60)} دقيقة`}
      </span>
      {oppCount != null && (
        <span title="عدد الفرص المنشورة حالياً في محرك الفرص الحية">فرص: {oppCount}</span>
      )}
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title="عملة التسعير المعتمدة في كل النظام">
        الاقتباس:
        <select
          value={quote}
          onChange={(e) => void changeQuote(e.target.value)}
          style={{ background: 'inherit', color: 'inherit', border: '1px solid var(--border, #2a2e39)', borderRadius: 6, padding: '1px 4px' }}
        >
          {['USDT', 'FDUSD', 'USDC', 'BTC', 'ETH', 'BNB'].map(q => <option key={q} value={q}>{q}</option>)}
        </select>
      </label>
      <button
        onClick={() => void saveSettings({ sound_enabled: soundEnabled ? 0 : 1 })}
        title={soundEnabled ? 'إيقاف الصوت' : 'تشغيل الصوت'}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 13 }}
      >
        {soundEnabled ? '🔊' : '🔇'}
      </button>
    </div>
  );
}
