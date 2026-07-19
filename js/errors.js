/**
 * Client-side diagnostic log (Log tab + optional chat mirror).
 */
const FSErrors = (function () {
  'use strict';

  const MAX = 200;
  const entries = [];
  const listeners = [];

  function emit() {
    listeners.forEach(function (fn) { fn(entries.slice()); });
  }

  function log(source, message, options) {
    const opts = options || {};
    const text = String(message || '').trim();
    if (!text) return;
    const row = {
      id: FSUtils.uuid(),
      source: String(source || 'app'),
      text: text,
      level: opts.level || 'info',
      timestamp: Date.now()
    };
    entries.push(row);
    if (entries.length > MAX) entries.shift();
    emit();
    if (opts.chat) {
      FSTransport.emit('chat', {
        id: FSUtils.uuid(),
        fromId: '00000000-0000-0000-0000-000000000000',
        fromName: 'System',
        text: '[' + row.source + '] ' + text,
        type: 'system',
        source: 'system',
        channel: 0,
        timestamp: row.timestamp
      });
    }
  }

  function error(source, message, alsoChat) {
    log(source, message, { level: 'error', chat: alsoChat !== false });
  }

  function warn(source, message, alsoChat) {
    log(source, message, { level: 'warn', chat: !!alsoChat });
  }

  function info(source, message, alsoChat) {
    log(source, message, { level: 'info', chat: !!alsoChat });
  }

  function clear() {
    entries.length = 0;
    emit();
  }

  function on(fn) {
    listeners.push(fn);
  }

  function list() {
    return entries.slice();
  }

  return {
    log: log,
    error: error,
    warn: warn,
    info: info,
    clear: clear,
    on: on,
    list: list
  };
})();
