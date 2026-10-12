import { describe, it, expect } from 'vitest';
import { builtins, chooseLanguage, validateTranslations } from './i18n';
import en from './locales/en.json';
import zh from './locales/zh-CN.json';
describe('localization', () => {
  it('follows supported system language, English is only fallback', () => {
    expect(chooseLanguage('system', builtins, ['zh-CN'])).toBe('zh-CN');
    expect(chooseLanguage('system', builtins, ['fr-FR'])).toBe('en');
    expect(chooseLanguage('en', builtins, ['zh-CN'])).toBe('en');
  });
  it('matches loaded language files', () => {
    expect(
      chooseLanguage('system', [...builtins, { locale: 'fr', nativeName: 'Français' }], ['fr-CA']),
    ).toBe('fr');
    expect(chooseLanguage('missing', builtins, [])).toBe('en');
  });
  it('does not map Traditional Chinese to Simplified Chinese', () => {
    expect(chooseLanguage('system', builtins, ['zh-TW'])).toBe('en');
  });
  it('allows partial resources and removes bad interpolation', () => {
    expect(
      validateTranslations(
        { cancel: 'Cancel', count: '{{count}} items', blank: 'Blank' },
        { cancel: 'Annuler', count: 'broken', blank: '' },
      ),
    ).toEqual({ cancel: 'Annuler' });
  });
  it('validates plural groups atomically', () => {
    expect(
      validateTranslations(
        { x_one: '{{count}} item', x_other: '{{count}} items' },
        { x_one: '{{count}} chose' },
      ),
    ).toEqual({});
  });
  it('ships complete matching translations', () => {
    expect(Object.keys(en.common).sort()).toEqual(Object.keys(zh.common).sort());
    expect(validateTranslations(en, zh)).toEqual(zh);
  });
});
