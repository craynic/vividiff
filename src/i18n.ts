import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zh from './locales/zh-CN.json';
export type LanguagePack = {
  schemaVersion: number;
  locale: string;
  nativeName: string;
  translations: Record<string, unknown>;
};
export type LanguageOption = { locale: string; nativeName: string };
export const builtins: LanguageOption[] = [
  { locale: 'en', nativeName: 'English' },
  { locale: 'zh-CN', nativeName: '简体中文' },
];
void i18n
  .use(initReactI18next)
  .init({
    resources: { en, 'zh-CN': zh },
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: ['common'],
    returnEmptyString: false,
    interpolation: { escapeValue: false },
  });
const placeholders = (s: string) =>
  [...s.matchAll(/{{\s*([^},]+)(?:,[^}]+)?\s*}}/g)]
    .map((x) => x[1].trim())
    .sort()
    .join('|');
export function validateTranslations(
  base: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(base)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    const candidate = input[key];
    if (
      typeof value === 'string' &&
      typeof candidate === 'string' &&
      candidate.trim() &&
      placeholders(value) === placeholders(candidate)
    )
      output[key] = candidate;
    else if (
      value &&
      typeof value === 'object' &&
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate)
    )
      output[key] = validateTranslations(
        value as Record<string, unknown>,
        candidate as Record<string, unknown>,
      );
  }
  // Do not mix partially translated plural groups.
  for (const key of Object.keys(base)) {
    const stem = key.replace(/_(zero|one|two|few|many|other)$/, '');
    if (stem !== key) {
      const group = Object.keys(base).filter((k) => k.startsWith(stem + '_'));
      if (group.some((k) => !(k in output))) for (const k of group) delete output[k];
    }
  }
  return output;
}
export function chooseLanguage(
  preference: string,
  languages: LanguageOption[],
  systems: readonly string[],
): string {
  const supported = languages.map((x) => x.locale);
  if (preference !== 'system') return supported.includes(preference) ? preference : 'en';
  for (const system of systems) {
    try {
      const locale = new Intl.Locale(system);
      const exact = supported.find((s) => s.toLowerCase() === locale.baseName.toLowerCase());
      if (exact) return exact;
      const match = supported.find((s) => {
        const l = new Intl.Locale(s);
        return l.language === locale.language && l.maximize().script === locale.maximize().script;
      });
      if (match) return match;
    } catch {
      /* unsupported locale */
    }
  }
  return 'en';
}
let installed: string[] = [];
export async function applyLanguages(
  packs: LanguagePack[],
  preference: string,
): Promise<LanguageOption[]> {
  for (const locale of installed) {
    for (const ns of ['common']) i18n.removeResourceBundle(locale, ns);
  }
  installed = [];
  const options = [...builtins];
  const used = new Set(builtins.map((x) => x.locale.toLowerCase()));
  for (const pack of packs) {
    try {
      const locale = Intl.getCanonicalLocales(pack.locale)[0];
      if (pack.schemaVersion !== 1 || !pack.nativeName || used.has(locale.toLowerCase())) continue;
      used.add(locale.toLowerCase());
      const translations = validateTranslations(en, pack.translations);
      for (const [ns, values] of Object.entries(translations))
        i18n.addResourceBundle(locale, ns, values, true, true);
      options.push({ locale, nativeName: pack.nativeName });
      installed.push(locale);
    } catch {
      /* server diagnostics report malformed files */
    }
  }
  const language = chooseLanguage(preference, options, navigator.languages);
  await i18n.changeLanguage(language);
  document.documentElement.lang = language;
  return options;
}
export default i18n;
