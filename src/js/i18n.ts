/**
 * UI language. The words live in lang/<code>.json among the bundled assets,
 * never in the code: a module asks for a line by key, `t('radar.range')`,
 * and gets it in the language in effect, else in English (lang/en.json ships
 * with every build and is loaded first whatever the language), else the key
 * itself, which is how a missing line shows up instead of hiding.
 *
 *   const t = BeeI18n.t;                 // inside the module's IIFE
 *   el.textContent = t('radar.count', { count: n });
 *   el.innerHTML = BeeI18n.html('chat.joined', { name: name });
 *
 * `{name}` placeholders are filled from the second argument; `html()` escapes
 * the values (the template in the file is ours). A line that bends with a
 * number is an object of CLDR plural forms in the file, picked by `count`:
 * English has `one` and `other`, Polish also `few` and `many`.
 *
 * Never call t() while a script is being evaluated (top-level constants):
 * the files are loaded by BeeApp.init, after the scripts. Tables of labels
 * hold functions and translate when they render.
 *
 * Markup carries keys instead of words: data-i18n="key" on an element whose
 * text is the line (the HTML holds no text there), data-i18n-html for a
 * line with markup in it, and data-i18n-title, -placeholder, -aria-label,
 * -alt, -value for attributes (left out of the HTML). apply() fills them
 * after every load and leaves alone anything a script has rewritten since.
 *
 * Lines the Rust core writes arrive with their key alongside (`text` with
 * `textKey` and `textArgs` next to it, or a `{ key, text, args }` object; a
 * command's rejection carries that object as JSON text). The core fills
 * `text` from the same en.json, so the English is always there too.
 * localize() renders a whole event payload in place as it arrives
 * (sl-bridge.ts); field(), textOf() and fromCore() render one line.
 *
 * en() is a line in English whatever the language: for comparing against
 * a stand-in the grid or an older session left in English.
 *
 * `npm run lang:check` (scripts/sync-lang.mjs) keeps the files honest: every
 * key the code and markup use is in en.json, nothing in en.json is unused,
 * and each translation covers en.json with the same placeholders.
 */
const BeeI18n = (function () {
  'use strict';

  const DEFAULT = 'en';
  // Menu order; every code has src/lang/<code>.json. The names are in their
  // own language on purpose: that is how someone looking for theirs finds it.
  const LANGUAGES: Array<[string, string]> = [
    ['en', 'English'],
    ['cs', 'Čeština'],
    ['da', 'Dansk'],
    ['de', 'Deutsch'],
    ['es', 'Español'],
    ['fr', 'Français'],
    ['hu', 'Magyar'],
    ['it', 'Italiano'],
    ['ja', '日本語'],
    ['nl', 'Nederlands'],
    ['no', 'Norsk'],
    ['pl', 'Polski'],
    ['pt', 'Português'],
    ['ro', 'Română'],
    ['ru', 'Русский'],
    ['sv', 'Svenska'],
    ['tr', 'Türkçe'],
    ['uk', 'Українська'],
    ['zh', '正體中文']
  ];
  // Intl tags. Numbers always follow the UI language; dates and times follow
  // the device while the UI is English (an English UI on a Polish device
  // keeps its 24-hour clock) and the language otherwise.
  const NUMBER_LOCALE: Record<string, string> = {
    en: 'en-US', cs: 'cs-CZ', da: 'da-DK', de: 'de-DE', es: 'es-ES', fr: 'fr-FR',
    hu: 'hu-HU', it: 'it-IT', ja: 'ja-JP', nl: 'nl-NL', no: 'nb-NO', pl: 'pl-PL',
    pt: 'pt-BR', ro: 'ro-RO', ru: 'ru-RU', sv: 'sv-SE', tr: 'tr-TR', uk: 'uk-UA',
    zh: 'zh-TW'
  };
  const DATE_LOCALE: Record<string, string | undefined> = {
    en: undefined, cs: 'cs-CZ', da: 'da-DK', de: 'de-DE', es: 'es-ES', fr: 'fr-FR',
    hu: 'hu-HU', it: 'it-IT', ja: 'ja-JP', nl: 'nl-NL', no: 'nb-NO', pl: 'pl-PL',
    pt: 'pt-BR', ro: 'ro-RO', ru: 'ru-RU', sv: 'sv-SE', tr: 'tr-TR', uk: 'uk-UA',
    zh: 'zh-TW'
  };
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'value'];

  let lang = DEFAULT;
  let english: Record<string, any> | null = null;   // lang/en.json, read once
  let englishLoading: Promise<void> | null = null;
  let dict: Record<string, any> = {};               // the chosen language's file; empty for English
  const englishRules = pluralRules(DEFAULT);
  let rules = englishRules;
  const listeners = new Set<(code: string) => void>();
  // Per element and slot ('text', 'html' or an attribute name): what apply()
  // wrote there last, so a later pass can tell a script's rewrite apart.
  const remembered = new WeakMap<Element, Record<string, { written: string | undefined }>>();

  function pluralRules(code) {
    try { return new Intl.PluralRules(code); } catch (_e) { return null; }
  }

  function known(code) {
    return LANGUAGES.some(function (entry) { return entry[0] === code; });
  }

  async function fetchDictionary(code) {
    const res = await fetch('lang/' + code + '.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a dictionary');
    return data;
  }

  // lang/en.json, once. It ships with every build; a build without it is
  // broken, and the keys then stand in for the words, which at least says
  // what is missing. A failed read is not remembered, so the next load()
  // tries again.
  function ensureEnglish() {
    if (english) return Promise.resolve();
    if (!englishLoading) {
      englishLoading = fetchDictionary(DEFAULT).then(function (words) {
        english = words;
      }, function () {
        englishLoading = null;
      });
    }
    return englishLoading;
  }

  // Switch to `code`, retranslate the markup and tell the listeners. An
  // unknown code, or a file that cannot be read, means English. Resolves to
  // the language in effect.
  async function load(code) {
    await ensureEnglish();
    let next = known(code) ? String(code) : DEFAULT;
    let words = {};
    if (next !== DEFAULT) {
      try {
        words = await fetchDictionary(next);
      } catch (_e) {
        next = DEFAULT;
      }
    }
    lang = next;
    dict = words;
    rules = pluralRules(lang) || englishRules;
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = lang;
    }
    apply();
    // The markup holds keys, not words: it stays hidden until the first
    // pass has filled it (index.html, .i18n-pending).
    if (typeof document !== 'undefined' && document.documentElement && document.documentElement.classList) {
      document.documentElement.classList.remove('i18n-pending');
    }
    listeners.forEach(function (fn) {
      try { fn(lang); } catch (_e) { /* one listener's trouble is not another's */ }
    });
    return lang;
  }

  // --- lookup ---------------------------------------------------------------

  // The string behind `entry`: itself, or for an object of plural forms the
  // one `params.count` selects under `pr` (then `other`, then anything).
  // Null when there is nothing usable.
  function pick(entry, params, pr) {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return null;
    const n = params && params.count != null ? Number(params.count) : NaN;
    let form = 'other';
    if (Number.isFinite(n) && pr) {
      try { form = pr.select(n); } catch (_e) { form = 'other'; }
    }
    if (typeof entry[form] === 'string') return entry[form];
    if (typeof entry.other === 'string') return entry.other;
    const keys = Object.keys(entry);
    for (let i = 0; i < keys.length; i++) {
      if (typeof entry[keys[i]] === 'string') return entry[keys[i]];
    }
    return null;
  }

  // `{name}` -> params.name. A placeholder with no value stays visible, so a
  // missing argument shows up instead of vanishing.
  function fill(template, params, escape) {
    if (!params || template.indexOf('{') === -1) return template;
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, function (whole, name) {
      if (!Object.prototype.hasOwnProperty.call(params, name)) return whole;
      const value = params[name];
      const text = value == null ? '' : String(value);
      return escape ? BeeUtils.escapeHtml(text) : text;
    });
  }

  // The line for `key`, filled in: the UI language's, else English, else null.
  function line(key, params, escape) {
    let text = pick(dict[key], params, rules);
    if (text === null && english) text = pick(english[key], params, englishRules);
    return text === null ? null : fill(text, params, escape);
  }

  /** The line for `key` in the current language, else in English, else the key. */
  function t(key: string, params?: Record<string, unknown>): string {
    const text = line(key, params, false);
    return text === null ? String(key) : text;
  }

  /** Like t(), for a line with markup in it: the parameter values are escaped. */
  function html(key: string, params?: Record<string, unknown>): string {
    const text = line(key, params, true);
    return text === null ? String(key) : text;
  }

  /** The English line for `key`, whatever the UI language (else the key). */
  function en(key: string, params?: Record<string, unknown>): string {
    const text = english ? pick(english[key], params, englishRules) : null;
    return text === null ? String(key) : fill(text, params, false);
  }

  /** Whether some loaded file has a line for `key`. */
  function has(key) {
    return typeof dict[key] !== 'undefined' || !!(english && typeof english[key] !== 'undefined');
  }

  // --- lines written by the core -------------------------------------------

  /** `obj[name]`, rendered through `obj[name + 'Key']` / `obj[name + 'Args']` when the core put them there. */
  function field(obj, name) {
    if (!obj || typeof obj !== 'object') return '';
    const text = obj[name];
    const plain = text == null ? '' : String(text);
    const key = obj[name + 'Key'];
    if (typeof key !== 'string' || !key) return plain;
    const args = obj[name + 'Args'];
    const rendered = line(key, args && typeof args === 'object' ? args : undefined, false);
    return rendered === null ? plain : rendered;
  }

  /** The `text` of a message or event payload. */
  function textOf(obj) {
    return field(obj, 'text');
  }

  // A `{ key, text, args }` line, or its JSON text (the shape a command's
  // rejection carries), or an ordinary string.
  function fromCore(value) {
    if (value == null) return '';
    if (typeof value === 'string') {
      if (value.charCodeAt(0) === 123 && value.indexOf('"key"') !== -1) {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === 'object') return fromCore(parsed);
        } catch (_e) { /* a string that merely starts with a brace */ }
      }
      return value;
    }
    if (typeof value === 'object') {
      const plain = typeof value.text === 'string' ? value.text : '';
      if (typeof value.key === 'string' && value.key) {
        const rendered = line(value.key, value.args && typeof value.args === 'object' ? value.args : undefined, false);
        return rendered === null ? (plain || value.key) : rendered;
      }
      return plain;
    }
    return String(value);
  }

  /**
   * Render, in place, every line of a core payload that came with its key:
   * a field `x` beside `xKey`/`xArgs`, and `{ key, text, args }` objects,
   * nested objects and arrays included. Run once as each event arrives, so
   * every consumer - the cards, the logs, the notifications - gets the UI
   * language without asking. The keys stay, for a later re-render.
   */
  function localize(payload, depth?) {
    const level = depth || 0;
    if (!payload || typeof payload !== 'object' || level > 5) return payload;
    if (Array.isArray(payload)) {
      payload.forEach(function (item) { localize(item, level + 1); });
      return payload;
    }
    if (typeof payload.key === 'string' && payload.key && typeof payload.text === 'string' &&
        payload.args && typeof payload.args === 'object') {
      payload.text = fromCore(payload);
    }
    Object.keys(payload).forEach(function (name) {
      const value = payload[name];
      if (typeof value === 'string') {
        const key = payload[name + 'Key'];
        if (typeof key === 'string' && key) payload[name] = field(payload, name);
      } else if (value && typeof value === 'object') {
        localize(value, level + 1);
      }
    });
    return payload;
  }

  // --- marked-up HTML --------------------------------------------------------

  function slotOf(el, name) {
    let slots = remembered.get(el);
    if (!slots) {
      slots = {};
      remembered.set(el, slots);
    }
    if (!slots[name]) slots[name] = { written: undefined };
    return slots[name];
  }

  // A markup line is a plain string (no plural forms, no placeholders).
  function markupLine(key) {
    const own = dict[key];
    if (typeof own === 'string') return own;
    const en = english ? english[key] : undefined;
    return typeof en === 'string' ? en : null;
  }

  // The element's own text: its first text node with something in it.
  function ownTextNode(el) {
    const nodes = el.childNodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeType === 3 && /\S/.test(n.nodeValue || '')) return n;
    }
    return null;
  }

  function applyText(el, key) {
    const next = markupLine(key);
    if (next === null) return;
    const s = slotOf(el, 'text');
    const node = ownTextNode(el);
    if (node) {
      const data = node.nodeValue || '';
      const lead = /^\s*/.exec(data)[0];
      const body = data.slice(lead.length);
      const trail = /\s*$/.exec(body)[0];
      const core = body.slice(0, body.length - trail.length);
      if (s.written !== undefined && core !== s.written) return; // a script rewrote it; theirs stands
      if (core !== next) node.nodeValue = lead + next + trail;
    } else {
      // The markup holds no words (the usual case); after a first pass, no
      // text at all means a script emptied the element, and that stands.
      if (s.written !== undefined) return;
      el.insertBefore(document.createTextNode(next), el.firstChild);
    }
    s.written = next;
  }

  function applyHtml(el, key) {
    const next = markupLine(key);
    if (next === null) return;
    const s = slotOf(el, 'html');
    const current = el.innerHTML;
    if (s.written !== undefined && current !== s.written) return;
    if (current !== next) el.innerHTML = next;
    s.written = el.innerHTML; // the browser's serialisation, which is what is compared next time
  }

  function applyAttr(el, attr, key) {
    const next = markupLine(key);
    if (next === null) return;
    const s = slotOf(el, attr);
    const current = el.getAttribute(attr) || '';
    if (s.written !== undefined && current !== s.written) return;
    if (current !== next) el.setAttribute(attr, next);
    s.written = next;
  }

  /** Fill the marked-up elements under `root` (the document by default). */
  function apply(root?) {
    if (typeof document === 'undefined') return;
    const scope = root || document;
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    scope.querySelectorAll('[data-i18n]').forEach(function (el) {
      applyText(el, el.getAttribute('data-i18n'));
    });
    scope.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      applyHtml(el, el.getAttribute('data-i18n-html'));
    });
    ATTRS.forEach(function (attr) {
      const marker = 'data-i18n-' + attr;
      scope.querySelectorAll('[' + marker + ']').forEach(function (el) {
        applyAttr(el, attr, el.getAttribute(marker));
      });
    });
  }

  // --- numbers, dates, bookkeeping -------------------------------------------

  /** A number with the UI language's digit grouping (1,234 / 1 234). */
  function formatNumber(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return String(n);
    try {
      return v.toLocaleString(NUMBER_LOCALE[lang] || NUMBER_LOCALE[DEFAULT]);
    } catch (_e) {
      return String(v);
    }
  }

  /** The Intl locale for dates and times: undefined (the device's) in English. */
  function dateLocale() {
    return DATE_LOCALE[lang];
  }

  /** Called with the code after every load(); returns the unsubscribe. */
  function onChange(fn) {
    listeners.add(fn);
    return function () { listeners.delete(fn); };
  }

  function current() {
    return lang;
  }

  function languages() {
    return LANGUAGES.map(function (entry) { return [entry[0], entry[1]] as [string, string]; });
  }

  // The English words are wanted whatever the language; start on them while
  // the rest of the scripts load.
  if (typeof fetch === 'function') void ensureEnglish();

  return {
    DEFAULT: DEFAULT,
    languages: languages,
    load: load,
    lang: current,
    t: t,
    html: html,
    en: en,
    has: has,
    field: field,
    textOf: textOf,
    fromCore: fromCore,
    localize: localize,
    apply: apply,
    formatNumber: formatNumber,
    dateLocale: dateLocale,
    onChange: onChange
  };
})();
