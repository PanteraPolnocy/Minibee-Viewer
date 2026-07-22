/**
 * Minimal LLSD XML parser for capability and display-name responses.
 */
const FSLLSD = (function () {
  'use strict';

  function textContent(el) {
    if (!el) return '';
    return (el.textContent || '').trim();
  }

  function parseValue(node) {
    if (!node || !node.childNodes) return null;
    if (node.nodeType === 1) {
      const selfTag = node.tagName.toLowerCase();
      if (selfTag === 'map') return parseMap(node);
      if (selfTag === 'array') return parseArray(node);
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === 'string') return textContent(child);
      if (tag === 'integer' || tag === 'int') return parseInt(textContent(child), 10);
      if (tag === 'real' || tag === 'double') return parseFloat(textContent(child));
      if (tag === 'boolean') {
        const v = textContent(child).toLowerCase();
        return v === '1' || v === 'true';
      }
      if (tag === 'uuid') return textContent(child);
      if (tag === 'uri') return textContent(child);
      if (tag === 'binary') {
        // Honor the encoding attribute (default base64); a non-base64 encoding
        // isn't something we decode — return empty, matching the Rust codec.
        const enc = (child.getAttribute && child.getAttribute('encoding')) || 'base64';
        if (String(enc).toLowerCase() !== 'base64') return new Uint8Array(0);
        const b64 = textContent(child).replace(/\s+/g, '');
        if (!b64) return new Uint8Array(0);
        try {
          const bin = atob(b64);
          const out = new Uint8Array(bin.length);
          for (let j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j);
          return out;
        } catch (_e) {
          return new Uint8Array(0);
        }
      }
      if (tag === 'date') return textContent(child);
      if (tag === 'undef') return null;
      if (tag === 'map') return parseMap(child);
      if (tag === 'array') return parseArray(child);
    }
    return textContent(node);
  }

  function parseMap(mapEl) {
    const out = {};
    let child = mapEl.firstChild;
    while (child) {
      if (child.nodeType === 1 && child.tagName.toLowerCase() === 'key') {
        const key = textContent(child);
        let sib = child.nextSibling;
        while (sib && sib.nodeType !== 1) sib = sib.nextSibling;
        // Wrap so scalars get typed the same way array elements do.
        if (sib) out[key] = parseValue(wrapValue(sib));
      }
      child = child.nextSibling;
    }
    return out;
  }

  function parseArray(arrayEl) {
    const out = [];
    let child = arrayEl.firstChild;
    while (child) {
      // Every element counts, including undef/uri/date — skipping any would
      // shift the indices of everything after it.
      if (child.nodeType === 1) {
        out.push(parseValue(wrapValue(child)));
      }
      child = child.nextSibling;
    }
    return out;
  }

  function wrapValue(el) {
    const fake = document.implementation.createDocument('', '', null).createElement('v');
    fake.appendChild(el.cloneNode(true));
    return fake;
  }

  function parseJson(value) {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      return value.map(parseJson);
    }
    if (typeof value === 'object') {
      const out = {};
      Object.keys(value).forEach(function (key) {
        out[key] = parseJson(value[key]);
      });
      return out;
    }
    return value;
  }

  function parse(body, contentType) {
    const text = String(body || '').trim();
    if (!text) return {};
    const ct = String(contentType || '').toLowerCase();
    if (ct.indexOf('json') >= 0 || text.charAt(0) === '{' || text.charAt(0) === '[') {
      return parseJson(JSON.parse(text));
    }
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('Invalid LLSD XML');
    }
    const llsd = doc.getElementsByTagName('llsd')[0];
    if (!llsd) return parseValue(doc.documentElement);
    for (let i = 0; i < llsd.childNodes.length; i++) {
      const child = llsd.childNodes[i];
      if (child.nodeType === 1) return parseValue(child);
    }
    return {};
  }

  function arrayXml(strings) {
    let inner = '';
    strings.forEach(function (s) {
      inner += '<string>' + String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</string>';
    });
    return '<?xml version="1.0"?><llsd><array>' + inner + '</array></llsd>';
  }

  function arrayXmlCompact(strings) {
    let inner = '';
    strings.forEach(function (s) {
      inner += '<string>' + String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</string>';
    });
    return '<llsd><array>' + inner + '</array></llsd>';
  }

  function arrayJson(strings) {
    return JSON.stringify(strings || []);
  }

  function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  }

  function valueXml(value) {
    if (value === null || value === undefined) return '<undef/>';
    if (typeof value === 'boolean') {
      return '<boolean>' + (value ? 'true' : 'false') + '</boolean>';
    }
    if (typeof value === 'number') {
      if (Number.isInteger(value)) return '<integer>' + value + '</integer>';
      return '<real>' + value + '</real>';
    }
    if (typeof value === 'bigint') {
      return '<integer>' + value.toString() + '</integer>';
    }
    if (Array.isArray(value)) {
      let inner = '';
      value.forEach(function (item) {
        inner += valueXml(item);
      });
      return '<array>' + inner + '</array>';
    }
    if (typeof value === 'object') {
      let inner = '';
      Object.keys(value).forEach(function (key) {
        inner += '<key>' + xmlEscape(key) + '</key>' + valueXml(value[key]);
      });
      return '<map>' + inner + '</map>';
    }
    return '<string>' + xmlEscape(value) + '</string>';
  }

  function mapXml(obj) {
    return '<?xml version="1.0"?><llsd>' + valueXml(obj || {}) + '</llsd>';
  }

  function bytesToUint32(bytes) {
    if (!bytes || bytes.length < 4) return 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getUint32(0, false);
  }

  function bytesFromLooseValue(value) {
    if (value instanceof Uint8Array) return value;
    if (Array.isArray(value) && value.length >= 4) {
      return new Uint8Array(value.map(function (n) { return Number(n) & 0xFF; }));
    }
    if (value && typeof value === 'object') {
      const keys = Object.keys(value).filter(function (k) { return /^\d+$/.test(k); })
        .sort(function (a, b) { return Number(a) - Number(b); });
      if (keys.length >= 4) {
        return new Uint8Array(keys.map(function (k) { return Number(value[k]) & 0xFF; }));
      }
    }
    return null;
  }

  function uint32FromValue(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback || 0;
    if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
    const bytes = bytesFromLooseValue(value);
    if (bytes) return bytesToUint32(bytes);
    const text = String(value).trim();
    if (/^b64"/i.test(text)) {
      try {
        const b64 = text.replace(/^b64"/i, '').replace(/"$/, '');
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return bytesToUint32(out);
      } catch (_e) { /* ignore */ }
    }
    if (/^0x[0-9a-f]+$/i.test(text)) return parseInt(text, 16) >>> 0;
    const n = Number(text);
    if (!Number.isFinite(n)) return fallback || 0;
    return n >>> 0;
  }

  function uint32FromParcelFlagsXml(rawBody) {
    const text = String(rawBody || '');
    if (!text) return 0;
    const patterns = [
      /<key>\s*ParcelFlags\s*<\/key>\s*<binary[^>]*>([^<]+)<\/binary>/gi,
      /<key>\s*parcel_flags\s*<\/key>\s*<binary[^>]*>([^<]+)<\/binary>/gi,
      /<key>\s*ParcelFlags\s*<\/key>\s*<integer>([^<]+)<\/integer>/gi,
      /<key>\s*parcel_flags\s*<\/key>\s*<integer>([^<]+)<\/integer>/gi
    ];
    let best = 0;
    for (let p = 0; p < patterns.length; p++) {
      const re = patterns[p];
      let match;
      while ((match = re.exec(text)) !== null) {
        const token = String(match[1] || '').replace(/\s+/g, '');
        if (!token) continue;
        let v = 0;
        if (/^\d+$/.test(token) || /^0x/i.test(token)) {
          v = uint32FromValue(token, 0);
        } else {
          try {
            const bin = atob(token);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            v = bytesToUint32(bytes);
          } catch (_e) { /* ignore */ }
        }
        if (v) best = v;
      }
    }
    return best;
  }

  return {
    parse: parse,
    arrayXml: arrayXml,
    arrayXmlCompact: arrayXmlCompact,
    arrayJson: arrayJson,
    mapXml: mapXml,
    uint32FromValue: uint32FromValue,
    uint32FromParcelFlagsXml: uint32FromParcelFlagsXml
  };
})();
