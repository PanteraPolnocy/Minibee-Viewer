/**
 * Optional IM transcripts on disk. Off by default: the first login asks once,
 * the answer is remembered, and people/groups have separate switches in
 * Bee -> Settings. When on, private IMs land in avatars/<name>.txt and group
 * or conference lines in groups/<title>.txt, next to the app's other data
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

  // The file should carry a person's name, not a UUID. Right after login the
  // session participant can still be unresolved; the name cache usually knows
  // better by the time a message lands.
  function avatarLogName(participant) {
    if (!participant) return 'Unknown';
    let name = String(participant.userName || participant.legacyName || participant.name || '');
    if (!name || looksUuid(name)) {
      const info = typeof BeeTransport.getCachedNameInfo === 'function'
        ? BeeTransport.getCachedNameInfo(participant.id)
        : null;
      name = (info && (info.userName || info.label || info.displayName)) || name;
    }
    return name && !looksUuid(name) ? name : String(participant.id || 'Unknown');
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
    const kind = grouplike ? 'groups' : 'avatars';
    const target = grouplike
      ? groupLogName(session)
      : avatarLogName(session.participant);
    const who = String(msg.fromName || (msg.outgoing ? 'Me' : 'Unknown'));
    const line = '[' + stamp(msg.timestamp) + '] ' + who + ': ' + text;
    BeeTransport.chatLogAppend(kind, target, line).catch(function () {});
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
  }

  return { init: init };
})();

window.BeeChatLogs = BeeChatLogs;
