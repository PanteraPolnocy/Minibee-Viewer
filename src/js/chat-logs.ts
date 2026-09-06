/**
 * Optional IM transcripts on disk. Off by default: the first login asks once,
 * the answer is remembered, and people/groups have separate switches in
 * Bee -> Settings. When on, private IMs land in avatars/<username>.txt and
 * group or conference lines in groups/<title>.txt, next to the app's other data
 * (never the OS cache). Writing is fire-and-forget; a failed write must never
 * break chat.
 */
const BeeChatLogs = (function () {
  'use strict';

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function stamp(ts) {
    const d = ts ? new Date(ts) : new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function looksUuid(s) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
  }

  // A person's file is named by username - "alice.wonder", "panterapolnocy" -
  // never by display name: that is a label they chose to be seen as, it
  // changes, and it need not be unique. One spelling only, or the same person
  // ends up with several files: SL's own username form (lowercase, dot-joined,
  // no "Resident" surname) folds "Alice Wonder", "alice.wonder" and
  // "Bob Resident" into one name each.
  function canonicalUserName(name) {
    const user = String(name || '').trim().toLowerCase().replace(/\s+/g, '.');
    return user.replace(/\.resident$/, '');
  }

  // The username on record for a participant, or '' while nobody knows it.
  // GetDisplayNames (the name cache) is authoritative; the legacy name the IM
  // packet itself carried (participant.userName) covers the moment before the
  // lookup lands. participant.name is never used: it is the display label.
  function knownUserName(participant) {
    const info = typeof BeeTransport.getCachedNameInfo === 'function'
      ? BeeTransport.getCachedNameInfo(participant.id)
      : null;
    const cached = info ? String(info.userName || '').trim() : '';
    if (cached && !looksUuid(cached)) return canonicalUserName(cached);
    const own = String(participant.userName || participant.legacyName || '').trim();
    const isLabel = !!(info && info.displayName && own.toLowerCase() === String(info.displayName).toLowerCase());
    if (own && !looksUuid(own) && !isLabel) return canonicalUserName(own);
    return '';
  }

  // Lines for a person whose username nobody knows yet (a first contact whose
  // name lookup is still in flight) wait for it rather than land in a file
  // named after something else. Past a generous wait the UUID names the file;
  // the log manager shows the person behind it once the name is known.
  const waiting = new Map(); // agent id -> { participant, lines, timer }
  const WAIT_FOR_NAME_MS = 30000;

  function appendLines(name, lines) {
    lines.reduce(function (prev, line) {
      return prev.then(function () { return BeeTransport.chatLogAppend('avatars', name, line); });
    }, Promise.resolve()).catch(function () {});
  }

  function flushWaiting(id, giveUp) {
    const entry = waiting.get(id);
    if (!entry) return;
    const name = knownUserName(entry.participant) || (giveUp ? id : '');
    if (!name) return;
    clearTimeout(entry.timer);
    waiting.delete(id);
    appendLines(name, entry.lines);
  }

  function logAvatarLine(participant, line) {
    if (!participant) return;
    const name = knownUserName(participant);
    if (name) {
      appendLines(name, [line]);
      return;
    }
    const id = String(participant.id || '').toLowerCase();
    if (!looksUuid(id)) return;
    let entry = waiting.get(id);
    if (!entry) {
      entry = {
        participant: participant,
        lines: [],
        timer: setTimeout(function () { flushWaiting(id, true); }, WAIT_FOR_NAME_MS)
      };
      waiting.set(id, entry);
      if (typeof BeeTransport.queueNameResolve === 'function') BeeTransport.queueNameResolve(id);
    }
    entry.lines.push(line);
  }

  // A group file must never be named by the placeholder title ("Group chat")
  // that early messages arrive under - separate groups would merge into one
  // file. The group-name cache, then the session id, beat that.
  function groupLogName(session) {
    const title = String(session.title || '').trim();
    if (title && title !== 'Group chat' && title !== 'Conference' && !looksUuid(title)) return title;
    const cached = typeof BeeTransport.getGroupName === 'function'
      ? BeeTransport.getGroupName(session.id)
      : '';
    return cached || String(session.id || 'Group chat');
  }

  function logIm(payload) {
    if (typeof BeeSettings === 'undefined' || !payload || !payload.message) return;
    const msg = payload.message;
    const text = String(msg.text || '');
    if (!text.trim()) return;
    const session = BeeState.get().imSessions[payload.sessionId];
    if (!session) return;
    const grouplike = session.type === 'group' || session.type === 'conference';
    // People and groups have their own switches.
    if (!BeeSettings.get(grouplike ? 'chatLogsGroups' : 'chatLogsAvatars')) return;
    const who = String(msg.fromName || (msg.outgoing ? 'Me' : 'Unknown'));
    const line = '[' + stamp(msg.timestamp) + '] ' + who + ': ' + text;
    if (grouplike) {
      BeeTransport.chatLogAppend('groups', groupLogName(session), line).catch(function () {});
    } else {
      logAvatarLine(session.participant, line);
    }
  }

  // One-time question, asked on the first login this install sees. The
  // answer only sets the preference; Bee -> Settings changes it any time.
  async function maybeAsk() {
    if (typeof BeeSettings === 'undefined' || BeeSettings.get('chatLogsAsked')) return;
    BeeSettings.set('chatLogsAsked', true);
    const keep = await BeeUtils.confirm({
      title: 'Keep chat logs?',
      message: 'Minibee can keep your IM conversations as plain text files on this device ' +
        '(one file per person or group). It costs a little disk space and speed. ' +
        'People and groups have separate switches in Bee -> Settings, any time.',
      confirmLabel: 'Keep logs',
      cancelLabel: 'No, thanks'
    });
    BeeSettings.set('chatLogsAvatars', !!keep);
    BeeSettings.set('chatLogsGroups', !!keep);
  }

  // Nearby chat, behind its own switch. Only actual conversation lines land
  // in the file - system lines and the interactive cards (dialogs, offers,
  // payments) are viewer furniture, not chat.
  function logChat(msg) {
    if (typeof BeeSettings === 'undefined' || !BeeSettings.get('chatLogsLocal') || !msg) return;
    if (msg.type === 'system' || msg.source === 'system') return;
    if (msg.kind === 'script-dialog' || msg.kind === 'script-permission' ||
        msg.kind === 'interactive-prompt' || msg.kind === 'payment' || msg.kind === 'motd' ||
        msg.kind === 'group-notice') {
      return;
    }
    const text = String(msg.text || '');
    if (!text.trim()) return;
    const who = String(msg.fromName || (msg.outgoing ? 'Me' : 'Unknown'));
    const line = '[' + stamp(msg.timestamp) + '] ' + who + ': ' + text;
    BeeTransport.chatLogAppend('local', 'Nearby Chat', line).catch(function () {});
  }

  function init() {
    BeeState.on('im', logIm);
    BeeState.on('chat', logChat);
    BeeState.on('change', function (partial) {
      if (partial && partial.connected === true) void maybeAsk();
    });
    // A name lookup landed: file whatever was waiting on it.
    BeeTransport.on('names-updated', function () {
      Array.from(waiting.keys()).forEach(function (id) { flushWaiting(id, false); });
    });
    // The session is going away; nothing waiting can be lost with it.
    function flushAll() {
      Array.from(waiting.keys()).forEach(function (id) { flushWaiting(id, true); });
    }
    BeeTransport.on('disconnected', flushAll);
    BeeState.on('reset', flushAll);
  }

  return { init: init };
})();

window.BeeChatLogs = BeeChatLogs;
