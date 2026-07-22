/**
 * Nearby chat panel.
 */
const FSChat = (function () {
  'use strict';

  const CHAT_TYPE_CLASS = {
    whisper: 'msg__name--whisper',
    shout: 'msg__name--shout',
    system: 'msg__name--system'
  };

  function resolveScriptDialog(msg, el, responseLabel, sendReply) {
    if (!msg || !msg.dialog || msg.dialog.resolved) return;
    const dialog = msg.dialog;
    const finish = function () {
      FSState.patchMessage(msg.id, {
        dialog: {
          resolved: true,
          response: responseLabel || ''
        }
      });
      if (el) {
        el.classList.add('msg--resolved');
        el.querySelectorAll('button, textarea, input').forEach(function (node) {
          node.disabled = true;
        });
        const note = el.querySelector('.script-dialog__response');
        if (note && responseLabel) {
          note.textContent = 'You chose: ' + responseLabel;
          note.hidden = false;
        }
      }
    };

    if (sendReply === false) {
      finish();
      return Promise.resolve();
    }

    const label = responseLabel || '';
    const index = dialog.isTextBox ? 0 : (sendReply && sendReply.index !== undefined ? sendReply.index : 0);
    return FSTransport.replyScriptDialog(
      dialog.objectId,
      index,
      label,
      dialog.chatChannel
    ).then(function (result) {
      if (!result || !result.sent) {
        throw new Error('send failed');
      }
      finish();
    }).catch(function () {
      if (typeof FSUtils !== 'undefined' && FSUtils.showToast) {
        FSUtils.showToast('Could not send script dialog reply.', 'warning');
      }
    });
  }

  function resolveScriptPermission(msg, el, granted) {
    if (!msg || !msg.permission || msg.permission.resolved) return;
    const perm = msg.permission;
    const responseLabel = granted ? 'Allowed' : 'Denied';
    const finish = function () {
      FSState.patchMessage(msg.id, {
        permission: {
          resolved: true,
          response: responseLabel
        }
      });
      if (el) {
        el.classList.add('msg--resolved');
        el.querySelectorAll('button').forEach(function (node) {
          node.disabled = true;
        });
        const note = el.querySelector('.script-dialog__response');
        if (note) {
          note.textContent = 'You ' + responseLabel.toLowerCase() + ' this request.';
          note.hidden = false;
        }
      }
    };

    return FSTransport.replyScriptPermission(
      perm.taskId,
      perm.itemId,
      granted ? perm.questions : 0
    ).then(function (result) {
      if (!result || !result.sent) {
        throw new Error('send failed');
      }
      finish();
    }).catch(function () {
      if (typeof FSUtils !== 'undefined' && FSUtils.showToast) {
        FSUtils.showToast('Could not send permission reply.', 'warning');
      }
    });
  }

  function bindScriptDialog(el, msg) {
    const dialog = msg.dialog;
    if (!dialog || dialog.resolved) return;

    if (dialog.isTextBox) {
      const input = el.querySelector('.script-dialog__input');
      const submit = el.querySelector('.script-dialog__submit');
      if (submit && input) {
        submit.addEventListener('click', function () {
          if (dialog.resolved) return;
          const text = input.value;
          resolveScriptDialog(msg, el, text || '(empty)').catch(function () {});
        });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit.click();
          }
        });
      }
    } else {
      el.querySelectorAll('[data-dialog-button]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (dialog.resolved) return;
          const index = parseInt(btn.dataset.dialogIndex, 10);
          const label = btn.dataset.dialogLabel || btn.textContent || '';
          resolveScriptDialog(msg, el, label, { index: index }).catch(function () {});
        });
      });
    }

    const ignore = el.querySelector('.script-dialog__ignore');
    if (ignore) {
      ignore.addEventListener('click', function () {
        if (dialog.resolved) return;
        resolveScriptDialog(msg, el, 'Ignored', false).catch(function () {});
      });
    }
  }

  function renderScriptDialog(msg) {
    const dialog = msg.dialog || {};
    const el = document.createElement('div');
    el.className = 'msg msg--script-dialog';
    if (dialog.resolved) el.classList.add('msg--resolved');
    el.dataset.id = msg.id;

    const ownerLine = dialog.isGroup
      ? ('Group: ' + (dialog.ownerName || 'Unknown'))
      : (dialog.ownerName ? ('Owner: ' + dialog.ownerName) : '');

    let actionsHtml = '';
    if (dialog.isTextBox) {
      actionsHtml =
        '<label class="script-dialog__field-label">Your reply</label>' +
        '<textarea class="script-dialog__input" rows="3" maxlength="512"' +
          (dialog.resolved ? ' disabled' : '') + '></textarea>' +
        '<div class="script-dialog__actions">' +
          '<button type="button" class="btn btn--primary script-dialog__submit"' +
            (dialog.resolved ? ' disabled' : '') + '>Submit</button>' +
          '<button type="button" class="btn btn--ghost script-dialog__ignore"' +
            (dialog.resolved ? ' disabled' : '') + '>Ignore</button>' +
        '</div>';
    } else {
      const buttons = dialog.buttons || [];
      const buttonHtml = buttons.map(function (label, index) {
        return '<button type="button" class="btn btn--secondary script-dialog__btn"' +
          ' data-dialog-button="1" data-dialog-index="' + index + '"' +
          ' data-dialog-label="' + FSUtils.escapeHtml(label) + '"' +
          (dialog.resolved ? ' disabled' : '') + '>' +
          FSUtils.escapeHtml(label) + '</button>';
      }).join('');
      actionsHtml =
        (buttonHtml
          ? '<div class="script-dialog__actions script-dialog__actions--buttons">' + buttonHtml + '</div>'
          : '<p class="script-dialog__hint">No buttons were provided. You can ignore this dialog.</p>') +
        '<button type="button" class="script-dialog__ignore script-dialog__ignore--link"' +
          (dialog.resolved ? ' disabled' : '') + '>Ignore</button>';
    }

    const body = FSUtils.escapeHtml(dialog.message || msg.text || '').replace(/\n/g, '<br>');
    const responseNote = dialog.resolved && dialog.response
      ? ('You chose: ' + FSUtils.escapeHtml(dialog.response))
      : '';

    const oo = objectOwnerAttrs(dialog.ownerId, dialog.isGroup);
    el.innerHTML =
      '<div class="script-dialog__header">' +
        '<span class="script-dialog__badge">Script</span>' +
        '<div class="script-dialog__titles">' +
          '<span class="script-dialog__object' + oo.cls + '"' + oo.attrs + '>' +
            FSUtils.escapeHtml(dialog.objectName || msg.fromName || 'Object') + '</span>' +
          (ownerLine ? '<span class="script-dialog__owner">' + FSUtils.escapeHtml(ownerLine) + '</span>' : '') +
        '</div>' +
        '<span class="msg__time">' + FSUtils.escapeHtml(FSUtils.formatTime(msg.timestamp)) + '</span>' +
      '</div>' +
      '<div class="msg__body script-dialog__body">' + body + '</div>' +
      actionsHtml +
      '<p class="script-dialog__response"' + (responseNote ? '' : ' hidden') + '>' +
        responseNote + '</p>';

    bindScriptDialog(el, msg);
    bindObjectOwner(el);
    return el;
  }

  // Clickable object title → owner profile (avatar, or group when group-owned).
  const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
  function objectOwnerAttrs(ownerId, isGroup) {
    const id = String(ownerId || '').trim();
    if (!id || id === ZERO_UUID) return { cls: '', attrs: '' };
    return {
      cls: ' script-dialog__object--link',
      attrs: ' data-owner-id="' + FSUtils.escapeHtml(id) + '"' +
        ' data-owner-group="' + (isGroup ? '1' : '0') + '"' +
        ' title="View owner profile"'
    };
  }
  function bindObjectOwner(el) {
    if (!el || !el.querySelectorAll) return;
    el.querySelectorAll('.script-dialog__object--link').forEach(function (node) {
      node.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        const id = node.dataset.ownerId;
        if (!id || typeof FSProfile === 'undefined') return;
        if (node.dataset.ownerGroup === '1') FSProfile.openGroup(id);
        else FSProfile.openAvatar(id);
      });
    });
  }

  function isAllowedExternalUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return false;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw;
    try {
      const parsed = new URL(withScheme);
      return ['http:', 'https:', 'mailto:', 'secondlife:', 'x-secondlife:'].indexOf(parsed.protocol) >= 0;
    } catch (_e) {
      return false;
    }
  }

  function resolveInteractivePrompt(msg, el, action, responseLabel) {
    if (!msg || !msg.prompt || msg.prompt.resolved) return Promise.resolve();
    const prompt = msg.prompt;
    const finish = function (label) {
      FSState.patchMessage(msg.id, {
        prompt: {
          resolved: true,
          response: label || responseLabel || ''
        }
      });
      if (el) {
        el.classList.add('msg--resolved');
        el.querySelectorAll('button, textarea, input, a.interactive-prompt__link').forEach(function (node) {
          node.disabled = true;
          if (node.tagName === 'A') node.classList.add('interactive-prompt__link--disabled');
        });
        const note = el.querySelector('.script-dialog__response');
        if (note && label) {
          note.textContent = 'You chose: ' + label;
          note.hidden = false;
        }
      }
    };

    if (prompt.type === 'load-url') {
      if (action === 'open') {
        if (!isAllowedExternalUrl(prompt.url)) {
          if (typeof FSUtils !== 'undefined' && FSUtils.showToast) {
            FSUtils.showToast('Blocked unsafe or invalid URL.', 'warning');
          }
          return Promise.resolve();
        }
        window.open(prompt.url, '_blank', 'noopener,noreferrer');
        finish('Opened page');
        return Promise.resolve();
      }
      finish('Ignored');
      return Promise.resolve();
    }

    if (prompt.type === 'script-teleport') {
      if (action === 'teleport') {
        const pos = prompt.position || { x: 128, y: 128, z: 25 };
        const regionName = prompt.regionName || 'Region';
        return FSTransport.teleportTo({
          regionName: regionName,
          x: pos.x,
          y: pos.y,
          z: pos.z
        }).then(function () {
          finish('Teleporting');
        }).catch(function (err) {
          if (typeof FSUtils !== 'undefined' && FSUtils.showToast) {
            FSUtils.showToast(err.message || 'Teleport failed', 'error');
          }
        });
      }
      if (action === 'show-map') {
        const pos = prompt.position || { x: 128, y: 128, z: 25 };
        if (typeof FSMap !== 'undefined' && FSMap.showLocation) {
          FSMap.showLocation({
            regionName: prompt.regionName || 'Region',
            x: pos.x,
            y: pos.y,
            z: pos.z
          });
        }
        finish('Shown on map');
        return Promise.resolve();
      }
      finish('Ignored');
      return Promise.resolve();
    }

    if (prompt.type === 'calling-card') {
      if (action === 'accept') {
        return FSTransport.acceptCallingCard(prompt.transactionId).then(function (result) {
          if (!result || !result.sent) throw new Error('send failed');
          finish('Accepted');
        }).catch(function () {
          if (typeof FSUtils !== 'undefined' && FSUtils.showToast) {
            FSUtils.showToast('Could not accept friendship offer.', 'warning');
          }
        });
      }
      if (action === 'decline') {
        return FSTransport.declineCallingCard(prompt.transactionId).then(function (result) {
          if (!result || !result.sent) throw new Error('send failed');
          finish('Declined');
        }).catch(function () {
          if (typeof FSUtils !== 'undefined' && FSUtils.showToast) {
            FSUtils.showToast('Could not decline friendship offer.', 'warning');
          }
        });
      }
      finish('Ignored');
      return Promise.resolve();
    }

    return Promise.resolve();
  }

  function bindInteractivePrompt(el, msg) {
    const prompt = msg.prompt;
    if (!prompt || prompt.resolved) return;

    if (prompt.type === 'load-url') {
      const openBtn = el.querySelector('.interactive-prompt__open');
      const ignore = el.querySelector('.interactive-prompt__ignore');
      if (openBtn) {
        openBtn.addEventListener('click', function () {
          if (prompt.resolved) return;
          resolveInteractivePrompt(msg, el, 'open').catch(function () {});
        });
      }
      if (ignore) {
        ignore.addEventListener('click', function () {
          if (prompt.resolved) return;
          resolveInteractivePrompt(msg, el, 'ignore').catch(function () {});
        });
      }
      return;
    }

    if (prompt.type === 'script-teleport') {
      const showMap = el.querySelector('.interactive-prompt__show-map');
      const teleportBtn = el.querySelector('.interactive-prompt__teleport');
      const ignore = el.querySelector('.interactive-prompt__ignore');
      if (teleportBtn) {
        teleportBtn.addEventListener('click', function () {
          if (prompt.resolved) return;
          resolveInteractivePrompt(msg, el, 'teleport').catch(function () {});
        });
      }
      if (showMap) {
        showMap.addEventListener('click', function () {
          if (prompt.resolved) return;
          resolveInteractivePrompt(msg, el, 'show-map').catch(function () {});
        });
      }
      if (ignore) {
        ignore.addEventListener('click', function () {
          if (prompt.resolved) return;
          resolveInteractivePrompt(msg, el, 'ignore').catch(function () {});
        });
      }
      return;
    }

    if (prompt.type === 'calling-card') {
      const accept = el.querySelector('.interactive-prompt__accept');
      const decline = el.querySelector('.interactive-prompt__decline');
      const ignore = el.querySelector('.interactive-prompt__ignore');
      if (accept) {
        accept.addEventListener('click', function () {
          if (prompt.resolved) return;
          resolveInteractivePrompt(msg, el, 'accept').catch(function () {});
        });
      }
      if (decline) {
        decline.addEventListener('click', function () {
          if (prompt.resolved) return;
          resolveInteractivePrompt(msg, el, 'decline').catch(function () {});
        });
      }
      if (ignore) {
        ignore.addEventListener('click', function () {
          if (prompt.resolved) return;
          resolveInteractivePrompt(msg, el, 'ignore').catch(function () {});
        });
      }
    }
  }

  function renderInteractivePrompt(msg) {
    const prompt = msg.prompt || {};
    const el = document.createElement('div');
    el.className = 'msg msg--script-dialog msg--interactive-prompt';
    if (prompt.resolved) el.classList.add('msg--resolved');
    el.dataset.id = msg.id;

    let badge = 'Prompt';
    let badgeClass = '';
    let body = '';
    let actions = '';

    if (prompt.type === 'load-url') {
      badge = 'Web';
      badgeClass = 'script-dialog__badge--web';
      const ownerSuffix = prompt.ownerIsGroup ? ' (group)' : '';
      const ownerLine = prompt.ownerName
        ? ('Owner: ' + prompt.ownerName + ownerSuffix)
        : (prompt.ownerId ? 'Owner: (resolving name...)' : '');
      const message = String(prompt.message || msg.text || '').trim();
      const url = String(prompt.url || '').trim();
      body =
        (message ? '<p class="script-dialog__body">' + FSUtils.escapeHtml(message) + '</p>' : '') +
        (url
          ? '<p class="interactive-prompt__url"><span class="interactive-prompt__url-label">URL:</span> ' +
            FSUtils.escapeHtml(url) + '</p>'
          : '');
      actions =
        '<div class="script-dialog__actions script-dialog__actions--buttons">' +
          '<button type="button" class="btn btn--primary interactive-prompt__open"' +
            (prompt.resolved ? ' disabled' : '') + '>Open page</button>' +
          '<button type="button" class="btn btn--ghost interactive-prompt__ignore"' +
            (prompt.resolved ? ' disabled' : '') + '>Ignore</button>' +
        '</div>';
      const ooUrl = objectOwnerAttrs(prompt.ownerId, prompt.ownerIsGroup);
      el.innerHTML =
        '<div class="script-dialog__header">' +
          '<span class="script-dialog__badge ' + badgeClass + '">' + badge + '</span>' +
          '<div class="script-dialog__titles">' +
            '<span class="script-dialog__object' + ooUrl.cls + '"' + ooUrl.attrs + '>' +
              FSUtils.escapeHtml(prompt.objectName || msg.fromName || 'Object') + '</span>' +
            (ownerLine ? '<span class="script-dialog__owner">' + FSUtils.escapeHtml(ownerLine) + '</span>' : '') +
          '</div>' +
          '<span class="msg__time">' + FSUtils.escapeHtml(FSUtils.formatTime(msg.timestamp)) + '</span>' +
        '</div>' +
        body + actions +
        '<p class="script-dialog__response"' +
          ((prompt.resolved && prompt.response) ? '' : ' hidden') + '>' +
          FSUtils.escapeHtml(prompt.resolved && prompt.response ? ('You chose: ' + prompt.response) : '') +
        '</p>';
      bindInteractivePrompt(el, msg);
      bindObjectOwner(el);
      return el;
    }

    if (prompt.type === 'script-teleport') {
      badge = 'Map';
      badgeClass = 'script-dialog__badge--map';
      const pos = prompt.position || { x: 128, y: 128, z: 25 };
      const locationLine = (prompt.regionName || 'Region') + ' (' +
        Math.round(pos.x) + ', ' + Math.round(pos.y) + ', ' + Math.round(pos.z) + ')';
      body = '<p class="script-dialog__body">Teleport to this location or show it on the map?</p>' +
        '<p class="interactive-prompt__location">' + FSUtils.escapeHtml(locationLine) + '</p>';
      actions =
        '<div class="script-dialog__actions script-dialog__actions--buttons">' +
          '<button type="button" class="btn btn--primary interactive-prompt__teleport"' +
            (prompt.resolved ? ' disabled' : '') + '>Teleport</button>' +
          '<button type="button" class="btn btn--ghost interactive-prompt__show-map"' +
            (prompt.resolved ? ' disabled' : '') + '>Show on map</button>' +
          '<button type="button" class="btn btn--ghost interactive-prompt__ignore"' +
            (prompt.resolved ? ' disabled' : '') + '>Ignore</button>' +
        '</div>';
      el.innerHTML =
        '<div class="script-dialog__header">' +
          '<span class="script-dialog__badge ' + badgeClass + '">' + badge + '</span>' +
          '<div class="script-dialog__titles">' +
            '<span class="script-dialog__object">' +
              FSUtils.escapeHtml(prompt.objectName || msg.fromName || 'Object') + '</span>' +
          '</div>' +
          '<span class="msg__time">' + FSUtils.escapeHtml(FSUtils.formatTime(msg.timestamp)) + '</span>' +
        '</div>' +
        body + actions +
        '<p class="script-dialog__response"' +
          ((prompt.resolved && prompt.response) ? '' : ' hidden') + '>' +
          FSUtils.escapeHtml(prompt.resolved && prompt.response ? ('You chose: ' + prompt.response) : '') +
        '</p>';
      bindInteractivePrompt(el, msg);
      return el;
    }

    if (prompt.type === 'calling-card') {
      badge = 'Friend';
      badgeClass = 'script-dialog__badge--friend';
      body = '<p class="script-dialog__body">' +
        FSUtils.escapeHtml(prompt.fromName || msg.fromName || 'Someone') +
        ' has offered you a friendship card.</p>';
      actions =
        '<div class="script-dialog__actions script-dialog__actions--buttons">' +
          '<button type="button" class="btn btn--primary interactive-prompt__accept"' +
            (prompt.resolved ? ' disabled' : '') + '>Accept</button>' +
          '<button type="button" class="btn btn--secondary interactive-prompt__decline"' +
            (prompt.resolved ? ' disabled' : '') + '>Decline</button>' +
          '<button type="button" class="btn btn--ghost interactive-prompt__ignore"' +
            (prompt.resolved ? ' disabled' : '') + '>Ignore</button>' +
        '</div>';
      el.innerHTML =
        '<div class="script-dialog__header">' +
          '<span class="script-dialog__badge ' + badgeClass + '">' + badge + '</span>' +
          '<div class="script-dialog__titles">' +
            '<span class="script-dialog__object">' +
              FSUtils.escapeHtml(prompt.fromName || msg.fromName || 'Resident') + '</span>' +
          '</div>' +
          '<span class="msg__time">' + FSUtils.escapeHtml(FSUtils.formatTime(msg.timestamp)) + '</span>' +
        '</div>' +
        body + actions +
        '<p class="script-dialog__response"' +
          ((prompt.resolved && prompt.response) ? '' : ' hidden') + '>' +
          FSUtils.escapeHtml(prompt.resolved && prompt.response ? ('You chose: ' + prompt.response) : '') +
        '</p>';
      bindInteractivePrompt(el, msg);
      return el;
    }

    el.innerHTML = '<p class="msg__body">' + FSUtils.escapeHtml(msg.text || 'Interactive prompt') + '</p>';
    return el;
  }

  function bindScriptPermission(el, msg) {
    const perm = msg.permission;
    if (!perm || perm.resolved) return;
    const allow = el.querySelector('.script-permission__allow');
    const deny = el.querySelector('.script-permission__deny');
    if (allow) {
      allow.addEventListener('click', function () {
        if (perm.resolved) return;
        resolveScriptPermission(msg, el, true).catch(function () {});
      });
    }
    if (deny) {
      deny.addEventListener('click', function () {
        if (perm.resolved) return;
        resolveScriptPermission(msg, el, false).catch(function () {});
      });
    }
  }

  function renderScriptPermission(msg) {
    const perm = msg.permission || {};
    const el = document.createElement('div');
    el.className = 'msg msg--script-dialog msg--script-permission';
    if (perm.hasCaution) el.classList.add('msg--script-permission-caution');
    if (perm.resolved) el.classList.add('msg--resolved');
    el.dataset.id = msg.id;

    const lines = perm.lines || [];
    const listHtml = lines.length
      ? '<ul class="script-permission__list">' + lines.map(function (line) {
        return '<li>' + FSUtils.escapeHtml(line) + '</li>';
      }).join('') + '</ul>'
      : '<p class="script-dialog__hint">This object requested script permissions.</p>';

    const ownerLine = perm.objectOwner ? ('Owner: ' + perm.objectOwner) : '';
    const responseNote = perm.resolved && perm.response
      ? ('You ' + perm.response.toLowerCase() + ' this request.')
      : '';

    el.innerHTML =
      '<div class="script-dialog__header">' +
        '<span class="script-dialog__badge script-dialog__badge--permission">Permission</span>' +
        '<div class="script-dialog__titles">' +
          '<span class="script-dialog__object">' + FSUtils.escapeHtml(perm.objectName || msg.fromName || 'Object') + '</span>' +
          (ownerLine ? '<span class="script-dialog__owner">' + FSUtils.escapeHtml(ownerLine) + '</span>' : '') +
        '</div>' +
        '<span class="msg__time">' + FSUtils.escapeHtml(FSUtils.formatTime(msg.timestamp)) + '</span>' +
      '</div>' +
      (perm.hasCaution
        ? '<p class="script-permission__warning">Review carefully before allowing.</p>'
        : '') +
      listHtml +
      '<div class="script-dialog__actions script-dialog__actions--buttons">' +
        '<button type="button" class="btn btn--primary script-permission__allow"' +
          (perm.resolved ? ' disabled' : '') + '>Allow</button>' +
        '<button type="button" class="btn btn--ghost script-permission__deny"' +
          (perm.resolved ? ' disabled' : '') + '>Deny</button>' +
      '</div>' +
      '<p class="script-dialog__response"' + (responseNote ? '' : ' hidden') + '>' +
        FSUtils.escapeHtml(responseNote) + '</p>';

    bindScriptPermission(el, msg);
    return el;
  }

  function renderPaymentEvent(msg) {
    const el = document.createElement('div');
    el.className = 'msg msg--event msg--payment';
    el.dataset.id = msg.id;
    const balance = msg.payment && msg.payment.balance !== undefined && msg.payment.balance !== null
      ? FSUtils.formatLindenBalance(msg.payment.balance)
      : '';
    el.innerHTML =
      '<div class="msg__meta">' +
        '<span class="msg__name msg__name--system">Payment</span>' +
        '<span class="msg__time">' + FSUtils.escapeHtml(FSUtils.formatTime(msg.timestamp)) + '</span>' +
      '</div>' +
      '<p class="msg__body">' + FSUtils.escapeHtml(msg.text) + '</p>' +
      (balance ? '<p class="event-payment__balance">Balance: ' + FSUtils.escapeHtml(balance) + '</p>' : '');
    return el;
  }

  function renderMotdMessage(msg) {
    const el = document.createElement('div');
    el.className = 'msg msg--motd';
    el.dataset.id = msg.id;
    const body = FSSlurl.linkify(msg.text, FSUtils.escapeHtml).replace(/\n/g, '<br>');
    el.innerHTML =
      '<div class="msg__meta">' +
        '<span class="msg__name msg__name--motd">' + FSUtils.escapeHtml(msg.fromName || 'Linden Lab') + '</span>' +
        '<span class="msg__motd-label">Message of the day</span>' +
        '<span class="msg__time">' + FSUtils.escapeHtml(FSUtils.formatTime(msg.timestamp)) + '</span>' +
      '</div>' +
      '<p class="msg__body">' + body + '</p>';

    FSSlurl.bindLinks(el);

    return el;
  }

  function renderMessage(msg) {
    if (msg.kind === 'motd') {
      return renderMotdMessage(msg);
    }
    if (msg.kind === 'payment' && msg.payment) {
      return renderPaymentEvent(msg);
    }
    if (msg.kind === 'script-permission' && msg.permission) {
      return renderScriptPermission(msg);
    }
    if (msg.kind === 'script-dialog' && msg.dialog) {
      return renderScriptDialog(msg);
    }
    if (msg.kind === 'interactive-prompt' && msg.prompt) {
      return renderInteractivePrompt(msg);
    }

    const el = document.createElement('div');
    const isSystem = msg.type === 'system' || msg.source === 'system';
    const isOutgoing = msg.outgoing;
    const volume = msg.type || 'normal';

    el.className = 'msg ' + (
      isSystem ? 'msg--system' :
      isOutgoing ? 'msg--outgoing' : 'msg--incoming'
    );
    if (!isSystem && (volume === 'whisper' || volume === 'shout')) {
      el.classList.add('msg--' + volume);
    }
    el.dataset.id = msg.id;

    if (isSystem) {
      el.innerHTML = '<p class="msg__body">' + FSSlurl.linkify(msg.text, FSUtils.escapeHtml) + '</p>';
      FSSlurl.bindLinks(el);
      return el;
    }

    const isObject = msg.source === 'object';
    const nameClass = CHAT_TYPE_CLASS[volume] || (isObject ? 'msg__name--object' : '');
    const label = volume === 'whisper' ? 'whispers' : volume === 'shout' ? 'shouts' : '';
    const speakerId = msg.fromId || '';
    // Only agents get an avatar thumbnail; an object's UUID is not an avatar.
    const avatarHtml = (speakerId && !isObject)
      ? '<span class="msg__avatar avatar-thumb avatar-thumb--chat" data-agent-id="' +
        FSUtils.escapeHtml(speakerId) + '" data-resolve-image="0" data-label="' +
        FSUtils.escapeHtml(msg.fromName || '') + '"></span>'
      : '';

    el.innerHTML =
      '<div class="msg__meta">' +
        avatarHtml +
        '<span class="msg__name ' + nameClass + '">' + FSUtils.escapeHtml(msg.fromName) +
          (label ? ' <span class="msg__volume">' + label + '</span>' : '') +
        '</span>' +
        '<span class="msg__time">' + FSUtils.escapeHtml(FSUtils.formatTime(msg.timestamp)) + '</span>' +
      '</div>' +
      '<p class="msg__body">' + FSSlurl.linkify(msg.text, FSUtils.escapeHtml) + '</p>';

    FSSlurl.bindLinks(el);

    const thumb = el.querySelector('.msg__avatar[data-agent-id]');
    if (thumb) FSAvatarThumb.refresh(thumb);
    if (typeof FSProfile !== 'undefined') {
      const nameEl = el.querySelector('.msg__name');
      if (nameEl && isObject && msg.ownerId) {
        // An object's name links to its owner, not an avatar profile keyed by
        // the object's own UUID.
        nameEl.classList.add('msg__name--link');
        nameEl.title = 'View owner profile';
        nameEl.addEventListener('click', function () {
          FSProfile.openAvatar(msg.ownerId);
        });
      } else if (nameEl && !isObject && speakerId) {
        nameEl.classList.add('msg__name--link');
        nameEl.title = 'View profile';
        nameEl.addEventListener('click', function () {
          FSProfile.openAvatar(speakerId);
        });
      }
    }

    return el;
  }

  function appendMessage(msg, scroll, listId) {
    const list = document.getElementById(listId || 'chat-messages');
    if (!list) return;
    // Preserve the user's scrollback: only auto-scroll if they're already at the
    // bottom (or a caller explicitly forces it).
    const pinned = (list.scrollHeight - list.scrollTop - list.clientHeight) < 40;
    list.appendChild(renderMessage(msg));
    if (scroll === false) return;
    if (scroll === true || pinned) list.scrollTop = list.scrollHeight;
  }

  function updateMessage(msg, listId) {
    const list = document.getElementById(listId || 'chat-messages');
    if (!list || !msg || !msg.id) return;
    const existing = list.querySelector('[data-id="' + msg.id + '"]');
    if (!existing) {
      appendMessage(msg, false, listId);
      return;
    }
    const next = renderMessage(msg);
    existing.replaceWith(next);
  }

  function renderAllTo(listId) {
    const list = document.getElementById(listId || 'chat-messages');
    if (!list) return;
    list.innerHTML = '';
    const messages = listId === 'event-messages'
      ? FSState.get().eventMessages
      : FSState.get().chatMessages;
    messages.forEach(function (msg) {
      appendMessage(msg, false, listId);
    });
    list.scrollTop = list.scrollHeight;
  }

  function renderAll() {
    renderAllTo('chat-messages');
  }

  function handleSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text || !FSState.gridOnline()) return;

    const volume = document.getElementById('chat-volume').value || 'normal';

    FSTransport.sendChat(text, { type: volume });
    input.value = '';
    input.focus();
  }

  function init() {
    document.getElementById('chat-form').addEventListener('submit', handleSubmit);

    FSState.on('chat', function (msg) {
      if (FSState.get().activeTab === 'chat') {
        appendMessage(msg);
      }
    });

    FSState.on('chat-updated', function (msg) {
      if (FSState.get().activeTab === 'chat') {
        updateMessage(msg);
      }
    });

    FSState.on('reset', function () {
      const list = document.getElementById('chat-messages');
      if (list) list.innerHTML = '';
    });
  }

  return {
    init: init,
    renderAll: renderAll,
    renderAllTo: renderAllTo,
    renderMessage: renderMessage,
    appendMessage: appendMessage,
    updateMessage: updateMessage
  };
})();
