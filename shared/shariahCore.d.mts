/**
 * تعريفات أنواع وحدة التصنيف الشرعي المشتركة (shared/shariahCore.mjs).
 * المصدر الوحيد للمنطق والبيانات هو ملف .mjs — هذا الملف للأنواع فقط
 * حتى يعمل الخادم (JS خالص) والواجهة (TypeScript) على قاعدة واحدة بلا نسختين.
 */

export type ShariahVerdict = 'halal' | 'haram' | 'uncertain';
export type EvidenceType = 'quran' | 'hadith' | 'principle';

export interface EvidenceItem {
  id: string;
  type: EvidenceType;
  /** النص الشرعي الكامل */
  text: string;
  /** المرجع: سورة:آية أو الراوي/الكتاب/الرقم */
  ref: string;
  /** درجة الصحة */
  grade: string;
  topic: 'riba' | 'maysir' | 'gharar' | 'trade' | 'general';
}

/** نسخة مختزنة من الدليل (بلا topic لتوافق الصف المخزن) */
export type StoredEvidence = Omit<EvidenceItem, 'topic'>;

export interface ShariahFacts {
  has_utility: boolean | null;
  is_memecoin: boolean | null;
  has_lending_interest: boolean | null;
  has_fixed_yield: boolean | null;
  linked_haram_activity: boolean | null;
  is_asset_backed: boolean | null;
  pure_speculation: boolean | null;
  privacy_concern: boolean | null;
}

export interface CriterionHit {
  id: string;
  label: string;
  reason: string;
  evidenceIds: string[];
  effect: 'haram' | 'halal' | 'uncertain';
  severity: number;
}

export interface ShariahAssessment {
  verdict: ShariahVerdict;
  headline: string;
  reasons: string[];
  evidence: EvidenceItem[];
  hits: CriterionHit[];
  fiqh_dispute: string | null;
  disclaimer: string;
}

export interface FactQuestion {
  key: keyof ShariahFacts;
  label: string;
  hint: string;
}

export type FactAnswers = Partial<Record<keyof ShariahFacts, boolean | null>>;

export const EVIDENCE: EvidenceItem[];
export const FACT_QUESTIONS: FactQuestion[];
export const DEFAULT_FACTS: Record<string, ShariahFacts>;

export function evaluateShariah(facts: ShariahFacts, symbol: string): ShariahAssessment;
export function factsFromAnswers(answers: FactAnswers): ShariahFacts;
export function factsForSymbol(symbol: string): ShariahFacts;
