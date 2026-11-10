import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

type Locale = 'zh' | 'en';
export type LocalizedText = readonly [english: string, chinese: string];

const STORAGE_KEY = 'sionna-rt-studio.locale';
const I18nContext = createContext<{
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (...text: LocalizedText) => string;
} | null>(null);

function initialLocale(): Locale {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const t = useCallback((english: string, chinese: string) => locale === 'zh' ? chinese : english, [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, t]);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    document.title = t('SionnaRTStudio · Wireless Digital Twin', 'SionnaRTStudio · 无线仿真实验台');
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // The switch works for this session even when storage is disabled.
    }
  }, [locale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error('I18nProvider is required');
  return context;
}
