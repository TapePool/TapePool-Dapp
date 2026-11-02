import { Html } from './html';

export type Lang = 'en' | 'cn';

const STORE_KEY = 'tp-lang'; // shared with the landing page

let current: Lang = 'en';

export function getLang(): Lang {
  return current;
}

/** English or Chinese text, whichever language is active. */
export function t(en: string, cn: string): string {
  return current === 'cn' ? cn : en;
}

/** The same for markup. */
export function th(en: Html, cn: Html): Html {
  return current === 'cn' ? cn : en;
}

export function setLang(lang: Lang, persist = true): void {
  current = lang;
  if (persist) {
    try {
      localStorage.setItem(STORE_KEY, lang);
    } catch {
      /* storage can be blocked */
    }
  }
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'cn' ? 'zh-CN' : 'en';
}

/** `?lang=` wins, then the stored choice, then English. */
export function initLang(search: string): Lang {
  const q = new URLSearchParams(search).get('lang');
  let lang: Lang = 'en';
  if (q === 'cn' || q === 'en') lang = q;
  else {
    try {
      if (localStorage.getItem(STORE_KEY) === 'cn') lang = 'cn';
    } catch {
      /* storage can be blocked */
    }
  }
  setLang(lang, false);
  return lang;
}
