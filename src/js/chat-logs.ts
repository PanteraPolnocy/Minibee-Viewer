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
      ? (session.title || 'Group chat')
      : ((session.participant && session.participant.name) || 'Unknown');
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

  function init() {
    BeeState.on('im', logIm);
    BeeState.on('change', function (partial) {
      if (partial && partial.connected === true) void maybeAsk();
    });
  }

  return { init: init };
})();

window.BeeChatLogs = BeeChatLogs;
