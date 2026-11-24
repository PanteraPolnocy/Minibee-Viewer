/**
 * Optional IM transcripts on disk. Off by default: the first login asks once,
 * the answer is remembered, and people/groups have separate switches in
 * Bee -> Settings. When on, private IMs land in avatars/<username>.txt and
 * group or conference lines in groups/<title>.txt, next to the app's other data
 * (never the OS cache). Writing is fire-and-forget; a failed write must never
 * break chat. What goes into the files (the line format, "Me", "Unknown",
 * the file names) stays English whatever the UI language: a file is a
 * record, not a screen. Only the question asked on screen is translated.
 */
const BeeChatLogs = (function () {
  'use strict';

  const t = BeeI18n.t;

  // The nearby-chat transcript's file name on disk. An identifier, not
  // wording: it stays the same in every UI language, so switching languages
  // never starts a second file (the log reader labels it in the UI language).
  const LOCAL_LOG_NAME = 'Nearby Chat';

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

  // What is asked of one log file is asked in order: a request goes out when
  // the one before it has been answered. A conversation's history is read
  // before the first new line is written, so the tail never holds lines the
  // conversation is showing as live; and a burst of lines - dozens kept
  // while the account was offline arrive in one go - lands in the file in
  // the order it was said, one at a time.
  const fileTurns = new Map<string, Promise<any>>();
  function nothing() {}
  function inTurn(kind, name, ask) {
    const key = kind + '/' + String(name).toLowerCase();
    const mine = (fileTurns.get(key) || Promise.resolve()).then(ask);
    const settled = mine.then(nothing, nothing);
    fileTurns.set(key, settled);
    settled.then(function () {
      if (fileTurns.get(key) === settled) fileTurns.delete(key);
    });
    return mine;
  }

  function appendLine(kind, name, line) {
    inTurn(kind, name, function () {
      return BeeTransport.chatLogAppend(kind, name, line);
    }).catch(nothing);
  }

  // Lines for a person whose username nobody knows yet (a first contact whose
  // name lookup is still in flight) wait for it rather than land in a file
  // named after something else. Past a generous wait the UUID names the file;
  // the log reader shows the person behind it once the name is known.
  const waiting = new Map(); // agent id -> { participant, lines, timer }
  const WAIT_FOR_NAME_MS = 30000;

  function appendLines(name, lines) {
    lines.forEach(function (line) { appendLine('avatars', name, line); });
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

  // A group file must never be named by the placeholder title (the "Group
  // chat" stand-in early messages arrive under) - separate groups would merge
  // into one file. The group-name cache, then the session id, beat that.
  function groupLogName(session) {
    const title = String(session.title || '').trim();
    if (title && !BeeState.isDefaultSessionTitle(title) && !looksUuid(title)) return title;
    const cached = typeof BeeTransport.getGroupName === 'function'
      ? BeeTransport.getGroupName(session.id)
      : '';
    return cached || String(session.id || '');
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
    const who = String(msg.fromName || (msg.outgoing ? t('logs.me') : t('common.unknown')));
    const line = '[' + stamp(msg.timestamp) + '] ' + who + ': ' + text;
    if (grouplike) {
      appendLine('groups', groupLogName(session), line);
    } else {
      logAvatarLine(session.participant, line);
    }
  }

  // When a conversation opens (by hand or by an incoming message), the last
  // few lines of its log file come back as on-screen history, so a new message
  // lands with its context instead of alone. Read-only and independent of the
  // logging switches: history shows whenever a file exists.
  const HISTORY_LINES = 10;
  const historyTried = new Set<string>();
  const historyWaiting = new Map<string, any>(); // agent id -> { session, timer }
  const HISTORY_NAME_WAIT_MS = 10000;

  // A conversation's history as its two sources gave it: the tail of the log
  // file on this device, and - for a private conversation, see
  // askGridHistory - the earlier messages the grid keeps. Neither is ever
  // written to a log file: what is shown here is only shown.
  const historyParts = new Map<string, { tail: any[]; grid: any[] | null }>();
  // Counts the logins: an answer that comes back after the conversations
  // were cleared belongs to none of the new ones.
  let epoch = 0;

  function partsOf(sessionId) {
    let parts = historyParts.get(sessionId);
    if (!parts) {
      parts = { tail: [], grid: null };
      historyParts.set(sessionId, parts);
    }
    return parts;
  }

  // The minute a log line is stamped with ("[2026-11-24 10:05] ..."), in this
  // device's time; NaN for a line with no stamp.
  const STAMPED = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})\] /;
  function lineMinute(line) {
    const m = STAMPED.exec(String(line || ''));
    if (!m) return NaN;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  }

  // The block as it is shown. The grid's messages are the fuller record
  // (every device's), so where the two sources overlap they are the ones
  // shown, and the log contributes only what is older: its lines stamped
  // with a minute before the grid's first message. A line of that message's
  // own minute or later is taken for one the grid has too - better a line
  // of context short than the same message twice.
  function historyBlock(parts) {
    if (!parts.grid || !parts.grid.length) return parts.tail;
    const first = Math.floor(parts.grid[0].timestamp / 60000) * 60000;
    const older = parts.tail.filter(function (line) { return line.minute < first; });
    return older.concat(parts.grid);
  }

  function showHistory(sessionId) {
    const parts = historyParts.get(sessionId);
    if (parts) BeeState.setImHistory(sessionId, historyBlock(parts));
  }

  function fetchHistory(session, kind, name) {
    if (typeof BeeTransport.chatLogTail !== 'function') return;
    const sessionId = session.id;
    const mine = epoch;
    inTurn(kind, name, function () {
      return BeeTransport.chatLogTail(kind, name, HISTORY_LINES);
    }).then(function (res) {
      const lines = res && Array.isArray(res.lines) ? res.lines : [];
      if (!lines.length || mine !== epoch) return;
      partsOf(sessionId).tail = lines.map(function (line, i) {
        return {
          id: 'history:' + sessionId + ':' + i, text: String(line), history: true,
          minute: lineMinute(line)
        };
      });
      showHistory(sessionId);
    }).catch(nothing);
  }

  // A private thread: the only kind the grid keeps earlier messages of.
  function isPrivate(session) {
    return !!session && (!session.type || session.type === 'p2p') &&
      !(session.participant && session.participant.isSession);
  }

  // One of the grid's messages as a history line, in the shape the log's own
  // lines have. The core hands over the name and the words (on one line);
  // the stamp is this device's time, like everything else on screen.
  function gridLine(session, row) {
    const agent = BeeState.get().agent || {};
    const who = row.outgoing
      ? String(agent.displayName || agent.name || row.fromName || t('logs.me'))
      : String(row.fromName || (session.participant && session.participant.name) || t('common.unknown'));
    const at = Number(row.timestamp) || 0;
    return {
      id: String(row.id), history: true, grid: true, timestamp: at,
      text: '[' + stamp(at) + '] ' + who + ': ' + String(row.text || '')
    };
  }

  // A private conversation was opened: the core is asked for the earlier
  // messages the grid keeps of it. Whether anything is fetched is the core's
  // decision (only with chat logs of people on, once a login, not too often
  // after a failure), and it leaves out what already stands in the
  // conversation; this only shows what comes back. `gridSettled` remembers
  // the conversations the core has nothing more to say about, `gridAsking`
  // the ones whose answer is still on its way.
  const gridSettled = new Set<string>();
  const gridAsking = new Set<string>();
  function askGridHistory(sessionId) {
    if (!sessionId || gridSettled.has(sessionId) || gridAsking.has(sessionId)) return;
    if (typeof BeeTransport.imHistory !== 'function') return;
    const session = BeeState.get().imSessions[sessionId];
    if (!isPrivate(session)) return;
    const peer = String((session.participant && session.participant.id) || '').toLowerCase();
    if (!looksUuid(peer)) return;
    const mine = epoch;
    gridAsking.add(sessionId);
    Promise.resolve(BeeTransport.imHistory(peer)).then(function (res) {
      if (mine === epoch) gridAsking.delete(sessionId);
      if (!res || mine !== epoch) return;
      if (!res.ok) {
        if (res.reason === 'done') gridSettled.add(sessionId);
        return;
      }
      gridSettled.add(sessionId);
      const now = BeeState.get().imSessions[sessionId];
      if (!now) return;
      const rows = Array.isArray(res.rows) ? res.rows : [];
      partsOf(sessionId).grid = rows.map(function (row) { return gridLine(now, row); });
      showHistory(sessionId);
    }).catch(function () {
      if (mine === epoch) gridAsking.delete(sessionId);
    });
  }

  function loadHistory(session) {
    if (!session || !session.id || session.historyLoaded || historyTried.has(session.id)) return;
    if (session.type === 'group' || session.type === 'conference') {
      historyTried.add(session.id);
      fetchHistory(session, 'groups', groupLogName(session));
      return;
    }
    const participant = session.participant;
    if (!participant || participant.isSession) return;
    const name = knownUserName(participant);
    if (name) {
      historyTried.add(session.id);
      fetchHistory(session, 'avatars', name);
      return;
    }
    // Username still resolving: wait for it like the writer does, then fall
    // back to the UUID-named file the writer would also have used.
    const id = String(participant.id || '').toLowerCase();
    if (!looksUuid(id) || historyWaiting.has(id)) return;
    historyTried.add(session.id);
    historyWaiting.set(id, {
      session: session,
      timer: setTimeout(function () { flushHistoryWaiting(id, true); }, HISTORY_NAME_WAIT_MS)
    });
    if (typeof BeeTransport.queueNameResolve === 'function') BeeTransport.queueNameResolve(id);
  }

  function flushHistoryWaiting(id, giveUp) {
    const entry = historyWaiting.get(id);
    if (!entry) return;
    const name = knownUserName(entry.session.participant) || (giveUp ? id : '');
    if (!name) return;
    clearTimeout(entry.timer);
    historyWaiting.delete(id);
    fetchHistory(entry.session, 'avatars', name);
  }

  function resetHistory() {
    historyWaiting.forEach(function (entry) { clearTimeout(entry.timer); });
    historyWaiting.clear();
    historyTried.clear();
    historyParts.clear();
    gridSettled.clear();
    gridAsking.clear();
    epoch += 1;
  }

  // One-time question, asked on the first login this install sees. The
  // answer only sets the preference; Bee -> Settings changes it any time.
  async function maybeAsk() {
    if (typeof BeeSettings === 'undefined' || BeeSettings.get('chatLogsAsked')) return;
    BeeSettings.set('chatLogsAsked', true);
    const keep = await BeeUtils.confirm({
      title: t('logs.askTitle'),
      message: t('logs.askMessage'),
      confirmLabel: t('logs.keep'),
      cancelLabel: t('logs.noThanks')
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
    const who = String(msg.fromName || (msg.outgoing ? t('logs.me') : t('common.unknown')));
    const line = '[' + stamp(msg.timestamp) + '] ' + who + ': ' + text;
    appendLine('local', LOCAL_LOG_NAME, line);
  }

  function init() {
    BeeState.on('im', logIm);
    BeeState.on('chat', logChat);
    BeeState.on('im-session-new', loadHistory);
    // A group chat or a conference that was closed can be opened again, as a
    // new tab with nothing in it: that one reads its log tail afresh.
    BeeState.on('im-session-closed', function (sessionId) {
      historyTried.delete(sessionId);
      historyParts.delete(sessionId);
      gridSettled.delete(sessionId);
    });
    // The message a history row was the stored copy of came in live, and the
    // row left the screen: it is not put back when the block is next built.
    BeeState.on('im-history-dropped', function (data) {
      const parts = data && historyParts.get(data.sessionId);
      if (!parts || !parts.grid) return;
      parts.grid = parts.grid.filter(function (row) { return row.id !== data.id; });
    });
    BeeState.on('change', function (partial) {
      if (!partial) return;
      if (partial.connected === true) void maybeAsk();
      // A conversation comes on screen: opened, or the tab it is open in shown.
      if (partial.activeImSession) askGridHistory(partial.activeImSession);
      else if (partial.activeTab === 'im') askGridHistory(BeeState.get().activeImSession);
    });
    // A name lookup landed: read and file whatever was waiting on it - the
    // history first, so that the lines about to be written are not in it.
    BeeTransport.on('names-updated', function () {
      Array.from(historyWaiting.keys()).forEach(function (id) { flushHistoryWaiting(id, false); });
      Array.from(waiting.keys()).forEach(function (id) { flushWaiting(id, false); });
    });
    // The session is going away; nothing waiting can be lost with it.
    function flushAll() {
      Array.from(waiting.keys()).forEach(function (id) { flushWaiting(id, true); });
      resetHistory();
    }
    BeeTransport.on('disconnected', flushAll);
    BeeState.on('reset', flushAll);
  }

  return { init: init };
})();

window.BeeChatLogs = BeeChatLogs;
