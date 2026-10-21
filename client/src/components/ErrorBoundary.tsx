import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * حاجز أخطاء لكل شاشة: خطأ في شاشة واحدة لا يُبيّض التطبيق كله.
 * يعرض رسالة عربية واضحة + زر «إعادة المحاولة» + تفاصيل قابلة للطي.
 */
interface Props {
  /** اسم الشاشة لعرضه في الرسالة */
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(_error: Error, info: ErrorInfo) {
    this.setState({ info: info.componentStack ?? null });
  }

  private retry = () => this.setState({ error: null, info: null });

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="p-6" dir="rtl">
        <div
          className="max-w-2xl mx-auto rounded-xl p-5 space-y-3"
          style={{ background: 'var(--surface-1)', border: '1px solid rgba(239,68,68,0.35)' }}
        >
          <div className="text-[15px] font-bold" style={{ color: 'var(--down)' }}>
            تعذّر عرض شاشة «{this.props.label}»
          </div>
          <div className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
            حدث خطأ غير متوقع في هذه الشاشة وحدها — بقية الشاشات تعمل طبيعياً. يمكنك إعادة المحاولة،
            وإن تكرر الخطأ فافتح التفاصيل التقنية أدناه.
          </div>
          <button
            onClick={this.retry}
            className="px-4 py-2 rounded-lg text-[12px] font-bold"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            إعادة المحاولة
          </button>
          <details className="text-[11.5px]" style={{ color: 'var(--text-3)' }}>
            <summary className="cursor-pointer">تفاصيل تقنية</summary>
            <pre
              className="num mt-2 p-2 rounded-lg overflow-auto max-h-64 text-[10.5px] leading-relaxed"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}
              dir="ltr"
            >
              {error.message}
              {info ? `\n${info}` : ''}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
