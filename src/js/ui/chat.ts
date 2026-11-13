/**
 * Nearby chat panel - renders the message stream along with the dialogs and prompts that come through it.
 */
const BeeChat = (function () {
  'use strict';

  const t = BeeI18n.t;
  const th = BeeI18n.html;

  let resetChatInputHeight = function () {};

  const CHAT_TYPE_CLASS = {
    whisper: 'msg__name--whisper',
    shout: 'msg__name--shout',
    system: 'msg__name--system'
  };

  // What a script's text box receives when it is sent empty. A protocol
  // value the script reads, not wording: it stays the same in every
  // language, and the card shows it through choiceLabel().
  const EMPTY_TEXT_REPLY = '(empty)';

  // A card remembers its answer as a token ('ignored', 'accepted', ...): the
  // state stays language-neutral and a language switch needs no re-saving.
  // The token reads in the UI language here; a script dialog's own button
  // label - the script's words - passes through as it is.
  function choiceLabel(token) {
    switch (String(token || '')) {
      case 'ignored': return t('chat.choiceIgnored');
      case 'openedPage': return t('chat.choiceOpenedPage');
      case 'teleporting': return t('chat.choiceTeleporting');
      case 'shownOnMap': return t('chat.choiceShownOnMap');
      case 'accepted': return t('chat.choiceAccepted');
      case 'declined': return t('chat.choiceDeclined');
      case 'kept': return t('chat.choiceKept');
      case 'discarded': return t('chat.choiceDiscarded');
      case 'joined': return t('chat.choiceJoined');
      case EMPTY_TEXT_REPLY: return t('chat.choiceEmpty');
      default: return String(token || '');
    }
  }

  function youChose(token) {
    return t('chat.youChose', { choice: choiceLabel(token) });
  }

  // The note under an answered permission card; 'allowed' / 'denied' is the
  // token the card stores.
  function permissionNote(response) {
    if (response === 'allowed') return t('chat.permissionAllowed');
    if (response === 'denied') return t('chat.permissionDenied');
    return '';
  }

  function resolveScriptDialog(msg, el, responseLabel, sendReply?) {
    if (!msg || !msg.dialog || msg.dialog.resolved) return;
    const dialog = msg.dialog;
    const finish = function () {
      BeeState.patchMessage(msg.id, {
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
          note.textContent = youChose(responseLabel);
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
    return BeeTransport.replyScriptDialog(
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
      if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) {
        BeeUtils.showToast(t('chat.dialogReplyFailed'), 'warning');
      }
    });
  }

  function resolveScriptPermission(msg, el, granted) {
    if (!msg || !msg.permission || msg.permission.resolved) return;
    const perm = msg.permission;
    const responseLabel = granted ? 'allowed' : 'denied';
    const finish = function () {
      BeeState.patchMessage(msg.id, {
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
          note.textContent = permissionNote(responseLabel);
          note.hidden = false;
        }
      }
    };

    return BeeTransport.replyScriptPermission(
      perm.taskId,
      perm.itemId,
      granted ? perm.questions : 0
    ).then(function (result) {
      if (!result || !result.sent) {
        throw new Error('send failed');
      }
      finish();
    }).catch(function () {
      if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) {
        BeeUtils.showToast(t('chat.permissionReplyFailed'), 'warning');
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
          // The label is what the script receives as the reply, so it is
          // not UI wording.
          resolveScriptDialog(msg, el, text || EMPTY_TEXT_REPLY).catch(function () {});
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
        resolveScriptDialog(msg, el, 'ignored', false).catch(function () {});
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
      ? t('chat.groupLine', { name: dialog.ownerName || t('common.unknown') })
      : (dialog.ownerName ? t('chat.ownerLine', { name: dialog.ownerName }) : '');

    let actionsHtml = '';
    if (dialog.isTextBox) {
      actionsHtml =
        '<label class="script-dialog__field-label">' + t('chat.yourReply') + '</label>' +
        '<textarea class="script-dialog__input" rows="3" maxlength="512"' +
          (dialog.resolved ? ' disabled' : '') + '></textarea>' +
        '<div class="script-dialog__actions">' +
          '<button type="button" class="btn btn--primary script-dialog__submit"' +
            (dialog.resolved ? ' disabled' : '') + '>' + t('chat.submit') + '</button>' +
          '<button type="button" class="btn btn--ghost script-dialog__ignore"' +
            (dialog.resolved ? ' disabled' : '') + '>' + t('chat.ignore') + '</button>' +
        '</div>';
    } else {
      const buttons = dialog.buttons || [];
      const buttonHtml = buttons.map(function (label, index) {
        return '<button type="button" class="btn btn--secondary script-dialog__btn"' +
          ' data-dialog-button="1" data-dialog-index="' + index + '"' +
          ' data-dialog-label="' + BeeUtils.escapeHtml(label) + '"' +
          (dialog.resolved ? ' disabled' : '') + '>' +
          BeeUtils.escapeHtml(label) + '</button>';
      }).join('');
      actionsHtml =
        (buttonHtml
          ? '<div class="script-dialog__actions script-dialog__actions--buttons">' + buttonHtml + '</div>'
          : '<p class="script-dialog__hint">' +
            t('chat.noButtons') + '</p>') +
        '<button type="button" class="script-dialog__ignore script-dialog__ignore--link"' +
          (dialog.resolved ? ' disabled' : '') + '>' + t('chat.ignore') + '</button>';
    }

    const body = BeeUtils.escapeHtml(dialog.message || msg.text || '').replace(/\n/g, '<br>');
    const responseNote = dialog.resolved && dialog.response
      ? BeeUtils.escapeHtml(youChose(dialog.response))
      : '';

    const oo = objectOwnerAttrs(dialog.ownerId, dialog.isGroup);
    el.innerHTML =
      '<div class="script-dialog__header">' +
        '<span class="script-dialog__badge">' + t('chat.badgeScript') + '</span>' +
        '<div class="script-dialog__titles">' +
          '<span class="script-dialog__object' + oo.cls + '"' + oo.attrs + '>' +
            BeeUtils.escapeHtml(dialog.objectName || msg.fromName || t('chat.object')) + '</span>' +
          (ownerLine ? '<span class="script-dialog__owner">' + BeeUtils.escapeHtml(ownerLine) + '</span>' : '') +
        '</div>' +
        '<span class="msg__time">' + BeeUtils.escapeHtml(BeeUtils.formatTime(msg.timestamp)) + '</span>' +
      '</div>' +
      '<div class="msg__body script-dialog__body">' + body + '</div>' +
      actionsHtml +
      '<p class="script-dialog__response"' + (responseNote ? '' : ' hidden') + '>' +
        responseNote + '</p>';

    bindScriptDialog(el, msg);
    bindObjectOwner(el);
    return el;
  }

  // Clicking an object's title opens the owner's profile - the avatar, or the group when it's group-owned.
  const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
  function objectOwnerAttrs(ownerId, isGroup) {
    const id = String(ownerId || '').trim();
    if (!id || id === ZERO_UUID) return { cls: '', attrs: '' };
    return {
      cls: ' script-dialog__object--link',
      attrs: ' data-owner-id="' + BeeUtils.escapeHtml(id) + '"' +
        ' data-owner-group="' + (isGroup ? '1' : '0') + '"' +
        ' title="' + BeeUtils.escapeHtml(t('chat.viewOwnerProfile')) + '"'
    };
  }
  function bindObjectOwner(el) {
    if (!el || !el.querySelectorAll) return;
    el.querySelectorAll('.script-dialog__object--link').forEach(function (node) {
      node.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        const id = node.dataset.ownerId;
        if (!id || typeof BeeProfile === 'undefined') return;
        if (node.dataset.ownerGroup === '1') BeeProfile.openGroup(id);
        else BeeProfile.openAvatar(id);
      });
    });
  }

  function resolveInteractivePrompt(msg, el, action, responseLabel?) {
    if (!msg || !msg.prompt || msg.prompt.resolved) return Promise.resolve();
    const prompt = msg.prompt;
    const finish = function (label) {
      BeeState.patchMessage(msg.id, {
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
          note.textContent = youChose(label);
          note.hidden = false;
        }
      }
    };

    if (prompt.type === 'load-url') {
      if (action === 'open') {
        const opener = (typeof BeeSlurl !== 'undefined' && BeeSlurl.openExternalUrlPrompted)
          ? BeeSlurl.openExternalUrlPrompted(prompt.url)
          : Promise.resolve(false);
        return opener.then(function (opened) {
          if (!opened) {
            if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) {
              BeeUtils.showToast(t('chat.blockedUrl'), 'warning');
            }
            return;
          }
          finish('openedPage');
        });
      }
      finish('ignored');
      return Promise.resolve();
    }

    if (prompt.type === 'script-teleport') {
      if (action === 'teleport') {
        const pos = prompt.position || { x: 128, y: 128, z: 25 };
        // The core always names the region (a stand-in when the sim gave
        // none); an empty name makes the teleport fail with its own message.
        const regionName = prompt.regionName || '';
        return BeeTransport.teleportTo({
          regionName: regionName,
          x: pos.x,
          y: pos.y,
          z: pos.z
        }).then(function () {
          finish('teleporting');
        }).catch(function (err) {
          if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) {
            BeeUtils.showToast(BeeUtils.errText(err) || t('teleport.failed'), 'error');
          }
        });
      }
      if (action === 'show-map') {
        const pos = prompt.position || { x: 128, y: 128, z: 25 };
        if (typeof BeeMap !== 'undefined' && BeeMap.showLocation) {
          BeeMap.showLocation({
            regionName: prompt.regionName || '',
            x: pos.x,
            y: pos.y,
            z: pos.z
          });
        }
        finish('shownOnMap');
        return Promise.resolve();
      }
      finish('ignored');
      return Promise.resolve();
    }

    if (prompt.type === 'calling-card') {
      if (action === 'accept') {
        return BeeTransport.acceptCallingCard(prompt.transactionId).then(function (result) {
          if (!result || !result.sent) throw new Error('send failed');
          finish('accepted');
        }).catch(function () {
          if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) {
            BeeUtils.showToast(t('chat.acceptFriendshipFailed'), 'warning');
          }
        });
      }
      if (action === 'decline') {
        return BeeTransport.declineCallingCard(prompt.transactionId).then(function (result) {
          if (!result || !result.sent) throw new Error('send failed');
          finish('declined');
        }).catch(function () {
          if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) {
            BeeUtils.showToast(t('chat.declineFriendshipFailed'), 'warning');
          }
        });
      }
      finish('ignored');
      return Promise.resolve();
    }

    if (prompt.type === 'inventory-offer' || prompt.type === 'group-notice-attachment') {
      if ((action === 'accept' || action === 'decline') &&
          typeof BeeBridge !== 'undefined' && BeeBridge.invoke) {
        const fromNotice = prompt.type === 'group-notice-attachment';
        return BeeBridge.invoke('sl_inventory_offer_respond', {
          fromId: prompt.fromId,
          transactionId: prompt.transactionId,
          accept: action === 'accept',
          fromTask: !!prompt.fromTask,
          kind: fromNotice ? 'group-notice' : null,
          // The grid has already copied a resident's offer into inventory; a
          // decline has to move that item to Trash itself, so it needs the id.
          itemId: prompt.itemId || null
        }).then(function () {
          finish(action === 'accept' ? (fromNotice ? 'kept' : 'accepted')
            : (fromNotice ? 'discarded' : 'declined'));
        }).catch(function () {
          if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) {
            BeeUtils.showToast(t('chat.inventoryOfferFailed'), 'warning');
          }
        });
      }
      finish('ignored');
      return Promise.resolve();
    }

    if (prompt.type === 'group-invitation') {
      if ((action === 'accept' || action === 'decline') &&
          typeof BeeBridge !== 'undefined' && BeeBridge.invoke) {
        const tx = String(prompt.transactionId || '');
        // An invitation that waited offline has no transaction id to answer
        // with over the IM path (the reference viewer needs a cap for those).
        if (!tx || /^0+$/.test(tx.replace(/-/g, ''))) {
          if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) {
            BeeUtils.showToast(t('chat.inviteNotAnswerable'), 'warning', 6000);
          }
          return Promise.resolve();
        }
        const fee = Number(prompt.fee) || 0;
        const groupLabel = prompt.groupName || t('chat.thisGroup');
        const sure = (action === 'accept' && fee > 0 && typeof BeeUtils !== 'undefined' && BeeUtils.confirm)
          ? BeeUtils.confirm({
              title: t('chat.joinGroupTitle'),
              message: t('chat.joinCost', { name: groupLabel, fee: BeeI18n.formatNumber(fee) }),
              confirmLabel: t('chat.join')
            })
          : Promise.resolve(true);
        return sure.then(function (ok) {
          if (!ok) return;
          return BeeBridge.invoke('sl_group_invitation_respond', {
            groupId: prompt.groupId,
            transactionId: tx,
            accept: action === 'accept'
          }).then(function () {
            finish(action === 'accept' ? 'joined' : 'declined');
          });
        }).catch(function () {
          if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) {
            BeeUtils.showToast(t('chat.groupInviteFailed'), 'warning');
          }
        });
      }
      finish('ignored');
      return Promise.resolve();
    }

    if (prompt.type === 'friendship-offer') {
      if (action === 'accept') {
        return BeeTransport.acceptFriendship(prompt.transactionId, prompt.fromId, prompt.fromName).then(function (result) {
          if (!result || !result.sent) throw new Error('send failed');
          finish('accepted');
        }).catch(function () {
          if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) {
            BeeUtils.showToast(t('chat.acceptFriendshipFailed'), 'warning');
          }
        });
      }
      if (action === 'decline') {
        return BeeTransport.declineFriendship(prompt.transactionId).then(function (result) {
          if (!result || !result.sent) throw new Error('send failed');
          finish('declined');
        }).catch(function () {
          if (typeof BeeUtils !== 'undefined' && BeeUtils.showToast) {
            BeeUtils.showToast(t('chat.declineFriendshipFailed'), 'warning');
          }
        });
      }
      finish('ignored');
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

    if (prompt.type === 'calling-card' || prompt.type === 'friendship-offer' ||
        prompt.type === 'inventory-offer' || prompt.type === 'group-notice-attachment' ||
        prompt.type === 'group-invitation') {
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

    let badge = t('chat.badgePrompt');
    let badgeClass = '';
    let body = '';
    let actions = '';

    if (prompt.type === 'load-url') {
      badge = t('chat.badgeWeb');
      badgeClass = 'script-dialog__badge--web';
      const ownerLine = prompt.ownerName
        ? (prompt.ownerIsGroup
          ? t('chat.ownerGroupLine', { name: prompt.ownerName })
          : t('chat.ownerLine', { name: prompt.ownerName }))
        : (prompt.ownerId ? t('chat.ownerResolving') : '');
      const message = String(prompt.message || msg.text || '').trim();
      const url = String(prompt.url || '').trim();
      body =
        (message ? '<p class="script-dialog__body">' + BeeUtils.escapeHtml(message) + '</p>' : '') +
        (url
          ? '<p class="interactive-prompt__url"><span class="interactive-prompt__url-label">' +
            t('chat.urlLabel') + '</span> ' +
            BeeUtils.escapeHtml(url) + '</p>'
          : '');
      actions =
        '<div class="script-dialog__actions script-dialog__actions--buttons">' +
          '<button type="button" class="btn btn--primary interactive-prompt__open"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('chat.openPage') + '</button>' +
          '<button type="button" class="btn btn--ghost interactive-prompt__ignore"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('chat.ignore') + '</button>' +
        '</div>';
      const ooUrl = objectOwnerAttrs(prompt.ownerId, prompt.ownerIsGroup);
      el.innerHTML =
        '<div class="script-dialog__header">' +
          '<span class="script-dialog__badge ' + badgeClass + '">' + badge + '</span>' +
          '<div class="script-dialog__titles">' +
            '<span class="script-dialog__object' + ooUrl.cls + '"' + ooUrl.attrs + '>' +
              BeeUtils.escapeHtml(prompt.objectName || msg.fromName || t('chat.object')) + '</span>' +
            (ownerLine ? '<span class="script-dialog__owner">' + BeeUtils.escapeHtml(ownerLine) + '</span>' : '') +
          '</div>' +
          '<span class="msg__time">' + BeeUtils.escapeHtml(BeeUtils.formatTime(msg.timestamp)) + '</span>' +
        '</div>' +
        body + actions +
        '<p class="script-dialog__response"' +
          ((prompt.resolved && prompt.response) ? '' : ' hidden') + '>' +
          BeeUtils.escapeHtml(prompt.resolved && prompt.response ? youChose(prompt.response) : '') +
        '</p>';
      bindInteractivePrompt(el, msg);
      bindObjectOwner(el);
      return el;
    }

    if (prompt.type === 'script-teleport') {
      badge = t('chat.badgeMap');
      badgeClass = 'script-dialog__badge--map';
      const pos = prompt.position || { x: 128, y: 128, z: 25 };
      const locationLine = (prompt.regionName || t('chat.region')) + ' (' +
        Math.round(pos.x) + ', ' + Math.round(pos.y) + ', ' + Math.round(pos.z) + ')';
      body = '<p class="script-dialog__body">' +
        t('chat.teleportQuestion') + '</p>' +
        '<p class="interactive-prompt__location">' + BeeUtils.escapeHtml(locationLine) + '</p>';
      actions =
        '<div class="script-dialog__actions script-dialog__actions--buttons">' +
          '<button type="button" class="btn btn--primary interactive-prompt__teleport"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('chat.teleport') + '</button>' +
          '<button type="button" class="btn btn--ghost interactive-prompt__show-map"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('chat.showOnMap') + '</button>' +
          '<button type="button" class="btn btn--ghost interactive-prompt__ignore"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('chat.ignore') + '</button>' +
        '</div>';
      el.innerHTML =
        '<div class="script-dialog__header">' +
          '<span class="script-dialog__badge ' + badgeClass + '">' + badge + '</span>' +
          '<div class="script-dialog__titles">' +
            '<span class="script-dialog__object">' +
              BeeUtils.escapeHtml(prompt.objectName || msg.fromName || t('chat.object')) + '</span>' +
          '</div>' +
          '<span class="msg__time">' + BeeUtils.escapeHtml(BeeUtils.formatTime(msg.timestamp)) + '</span>' +
        '</div>' +
        body + actions +
        '<p class="script-dialog__response"' +
          ((prompt.resolved && prompt.response) ? '' : ' hidden') + '>' +
          BeeUtils.escapeHtml(prompt.resolved && prompt.response ? youChose(prompt.response) : '') +
        '</p>';
      bindInteractivePrompt(el, msg);
      return el;
    }

    if (prompt.type === 'calling-card') {
      badge = t('chat.badgeFriend');
      badgeClass = 'script-dialog__badge--friend';
      body = '<p class="script-dialog__body">' +
        th('chat.callingCardOffer', { name: prompt.fromName || msg.fromName || t('chat.someone') }) +
        '</p>';
      actions =
        '<div class="script-dialog__actions script-dialog__actions--buttons">' +
          '<button type="button" class="btn btn--primary interactive-prompt__accept"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('common.accept') + '</button>' +
          '<button type="button" class="btn btn--secondary interactive-prompt__decline"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('common.decline') + '</button>' +
          '<button type="button" class="btn btn--ghost interactive-prompt__ignore"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('chat.ignore') + '</button>' +
        '</div>';
      el.innerHTML =
        '<div class="script-dialog__header">' +
          '<span class="script-dialog__badge ' + badgeClass + '">' + badge + '</span>' +
          '<div class="script-dialog__titles">' +
            '<span class="script-dialog__object">' +
              BeeUtils.escapeHtml(prompt.fromName || msg.fromName || t('chat.resident')) + '</span>' +
          '</div>' +
          '<span class="msg__time">' + BeeUtils.escapeHtml(BeeUtils.formatTime(msg.timestamp)) + '</span>' +
        '</div>' +
        body + actions +
        '<p class="script-dialog__response"' +
          ((prompt.resolved && prompt.response) ? '' : ' hidden') + '>' +
          BeeUtils.escapeHtml(prompt.resolved && prompt.response ? youChose(prompt.response) : '') +
        '</p>';
      bindInteractivePrompt(el, msg);
      return el;
    }

    if (prompt.type === 'group-invitation') {
      const inviter = prompt.fromName || msg.fromName || t('chat.someone');
      const group = prompt.groupName || t('chat.aGroup');
      const fee = Number(prompt.fee) || 0;
      const note = String(prompt.message || '').trim();
      body = '<p class="script-dialog__body">' +
          th('chat.groupInvite', { inviter: inviter, group: group }) +
          (fee > 0
            ? ' ' + th('chat.groupInviteFee', { fee: BeeI18n.formatNumber(fee) })
            : '') +
        '</p>' +
        (note ? '<p class="script-dialog__body script-dialog__body--quote">' + BeeUtils.escapeHtml(note) + '</p>' : '');
      actions =
        '<div class="script-dialog__actions script-dialog__actions--buttons">' +
          '<button type="button" class="btn btn--primary interactive-prompt__accept"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('chat.join') + '</button>' +
          '<button type="button" class="btn btn--secondary interactive-prompt__decline"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('common.decline') + '</button>' +
          '<button type="button" class="btn btn--ghost interactive-prompt__ignore"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('chat.ignore') + '</button>' +
        '</div>';
      el.innerHTML =
        '<div class="script-dialog__header">' +
          '<span class="script-dialog__badge script-dialog__badge--group">' + t('chat.badgeGroup') + '</span>' +
          '<div class="script-dialog__titles">' +
            '<span class="script-dialog__object">' + BeeUtils.escapeHtml(group) + '</span>' +
          '</div>' +
          '<span class="msg__time">' + BeeUtils.escapeHtml(BeeUtils.formatTime(msg.timestamp)) + '</span>' +
        '</div>' +
        body + actions +
        '<p class="script-dialog__response"' +
          ((prompt.resolved && prompt.response) ? '' : ' hidden') + '>' +
          BeeUtils.escapeHtml(prompt.resolved && prompt.response ? youChose(prompt.response) : '') +
        '</p>';
      bindInteractivePrompt(el, msg);
      return el;
    }

    if (prompt.type === 'inventory-offer') {
      const giver = prompt.fromName || msg.fromName || t('chat.someone');
      const item = prompt.itemName || t('chat.anItem');
      const line = prompt.fromTask
        ? th('chat.objectOffer', { giver: giver, item: item })
        : th('chat.inventoryOffer', { giver: giver, item: item });
      body = '<p class="script-dialog__body">' + line + '</p>';
      actions =
        '<div class="script-dialog__actions script-dialog__actions--buttons">' +
          '<button type="button" class="btn btn--primary interactive-prompt__accept"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('common.accept') + '</button>' +
          '<button type="button" class="btn btn--secondary interactive-prompt__decline"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('common.decline') + '</button>' +
          '<button type="button" class="btn btn--ghost interactive-prompt__ignore"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('chat.ignore') + '</button>' +
        '</div>';
      el.innerHTML =
        '<div class="script-dialog__header">' +
          '<span class="script-dialog__badge script-dialog__badge--item">' + t('chat.badgeItem') + '</span>' +
          '<div class="script-dialog__titles">' +
            '<span class="script-dialog__object">' +
              BeeUtils.escapeHtml(prompt.fromName || msg.fromName || t('chat.resident')) + '</span>' +
          '</div>' +
          '<span class="msg__time">' + BeeUtils.escapeHtml(BeeUtils.formatTime(msg.timestamp)) + '</span>' +
        '</div>' +
        body + actions +
        '<p class="script-dialog__response"' +
          ((prompt.resolved && prompt.response) ? '' : ' hidden') + '>' +
          BeeUtils.escapeHtml(prompt.resolved && prompt.response ? youChose(prompt.response) : '') +
        '</p>';
      bindInteractivePrompt(el, msg);
      return el;
    }

    if (prompt.type === 'friendship-offer') {
      const who = prompt.fromName || msg.fromName || t('chat.someone');
      body = '<p class="script-dialog__body">' +
        th('chat.friendshipOffer', { name: who }) + '</p>';
      actions =
        '<div class="script-dialog__actions script-dialog__actions--buttons">' +
          '<button type="button" class="btn btn--primary interactive-prompt__accept"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('common.accept') + '</button>' +
          '<button type="button" class="btn btn--secondary interactive-prompt__decline"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('common.decline') + '</button>' +
          '<button type="button" class="btn btn--ghost interactive-prompt__ignore"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('chat.ignore') + '</button>' +
        '</div>';
      el.innerHTML =
        '<div class="script-dialog__header">' +
          '<span class="script-dialog__badge script-dialog__badge--friend">' + t('chat.badgeFriend') + '</span>' +
          '<div class="script-dialog__titles">' +
            '<span class="script-dialog__object">' +
              BeeUtils.escapeHtml(prompt.fromName || msg.fromName || t('chat.resident')) + '</span>' +
          '</div>' +
          '<span class="msg__time">' + BeeUtils.escapeHtml(BeeUtils.formatTime(msg.timestamp)) + '</span>' +
        '</div>' +
        body + actions +
        '<p class="script-dialog__response"' +
          ((prompt.resolved && prompt.response) ? '' : ' hidden') + '>' +
          BeeUtils.escapeHtml(prompt.resolved && prompt.response ? youChose(prompt.response) : '') +
        '</p>';
      bindInteractivePrompt(el, msg);
      return el;
    }

    el.innerHTML = '<p class="msg__body">' +
      BeeUtils.escapeHtml(BeeI18n.textOf(msg) || t('chat.interactivePrompt')) + '</p>';
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
        // Each line comes from the core with its key (BeeI18n.fromCore).
        return '<li>' + BeeUtils.escapeHtml(BeeI18n.fromCore(line)) + '</li>';
      }).join('') + '</ul>'
      : '<p class="script-dialog__hint">' +
        t('chat.permissionRequested') + '</p>';

    const ownerLine = perm.objectOwner ? t('chat.ownerLine', { name: perm.objectOwner }) : '';
    const responseNote = perm.resolved && perm.response
      ? permissionNote(perm.response)
      : '';

    el.innerHTML =
      '<div class="script-dialog__header">' +
        '<span class="script-dialog__badge script-dialog__badge--permission">' +
          t('chat.badgePermission') + '</span>' +
        '<div class="script-dialog__titles">' +
          '<span class="script-dialog__object">' +
            BeeUtils.escapeHtml(perm.objectName || msg.fromName || t('chat.object')) + '</span>' +
          (ownerLine ? '<span class="script-dialog__owner">' + BeeUtils.escapeHtml(ownerLine) + '</span>' : '') +
        '</div>' +
        '<span class="msg__time">' + BeeUtils.escapeHtml(BeeUtils.formatTime(msg.timestamp)) + '</span>' +
      '</div>' +
      (perm.hasCaution
        ? '<p class="script-permission__warning">' +
          t('chat.permissionCaution') + '</p>'
        : '') +
      listHtml +
      '<div class="script-dialog__actions script-dialog__actions--buttons">' +
        '<button type="button" class="btn btn--primary script-permission__allow"' +
          (perm.resolved ? ' disabled' : '') + '>' + t('chat.allow') + '</button>' +
        '<button type="button" class="btn btn--ghost script-permission__deny"' +
          (perm.resolved ? ' disabled' : '') + '>' + t('chat.deny') + '</button>' +
      '</div>' +
      '<p class="script-dialog__response"' + (responseNote ? '' : ' hidden') + '>' +
        BeeUtils.escapeHtml(responseNote) + '</p>';

    bindScriptPermission(el, msg);
    return el;
  }

  function renderPaymentEvent(msg) {
    const el = document.createElement('div');
    el.className = 'msg msg--event msg--payment';
    el.dataset.id = msg.id;
    const balance = msg.payment && msg.payment.balance !== undefined && msg.payment.balance !== null
      ? BeeUtils.formatLindenBalance(msg.payment.balance)
      : '';
    el.innerHTML =
      '<div class="msg__meta">' +
        '<span class="msg__name msg__name--system">' + t('chat.payment') + '</span>' +
        '<span class="msg__time">' + BeeUtils.escapeHtml(BeeUtils.formatTime(msg.timestamp)) + '</span>' +
      '</div>' +
      '<p class="msg__body">' + BeeUtils.escapeHtml(BeeI18n.textOf(msg)) + '</p>' +
      (balance
        ? '<p class="event-payment__balance">' + th('chat.balance', { balance: balance }) + '</p>'
        : '');
    return el;
  }

  function renderMotdMessage(msg) {
    const el = document.createElement('div');
    el.className = 'msg msg--motd';
    el.dataset.id = msg.id;

    const meta = document.createElement('div');
    meta.className = 'msg__meta';

    const name = document.createElement('span');
    name.className = 'msg__name msg__name--motd';
    name.textContent = String(msg.fromName || 'Linden Lab');

    const label = document.createElement('span');
    label.className = 'msg__motd-label';
    label.textContent = t('chat.motd');

    const time = document.createElement('span');
    time.className = 'msg__time';
    time.textContent = String(BeeUtils.formatTime(msg.timestamp));

    meta.appendChild(name);
    meta.appendChild(label);
    meta.appendChild(time);

    const bodyEl = document.createElement('p');
    bodyEl.className = 'msg__body';
    // The message of the day nearly always carries a URL, so it has to go
    // through the link scanner - plain text nodes would leave it unclickable.
    BeeSlurl.appendLinkified(bodyEl, BeeI18n.textOf(msg), { breaks: true });

    el.appendChild(meta);
    el.appendChild(bodyEl);

    BeeSlurl.bindLinks(el);

    return el;
  }

  // A group notice: group + sender header, subject, body, and - when the
  // notice carries an inventory attachment - Keep/Discard buttons.
  function renderGroupNotice(msg) {
    const el = document.createElement('div');
    el.className = 'msg msg--script-dialog msg--group-notice';
    const prompt = msg.prompt;
    if (prompt && prompt.resolved) el.classList.add('msg--resolved');
    el.dataset.id = msg.id;

    // Raw, not escaped: the header/subject below are set via textContent, which
    // escapes on its own. Only `attachment` is still assembled as HTML.
    const sender = String(msg.fromName || '');
    const subject = String(msg.subject || '');
    const bodyText = String(msg.text || '');

    let attachment = '';
    if (prompt) {
      attachment =
        '<p class="group-notice__attachment">' +
          th('chat.attachment', { item: prompt.itemName || t('chat.item') }) +
        '</p>' +
        '<div class="script-dialog__actions script-dialog__actions--buttons">' +
          '<button type="button" class="btn btn--primary interactive-prompt__accept"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('chat.keep') + '</button>' +
          '<button type="button" class="btn btn--secondary interactive-prompt__decline"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('chat.discard') + '</button>' +
          '<button type="button" class="btn btn--ghost interactive-prompt__ignore"' +
            (prompt.resolved ? ' disabled' : '') + '>' + t('chat.ignore') + '</button>' +
        '</div>' +
        '<p class="script-dialog__response"' +
          ((prompt.resolved && prompt.response) ? '' : ' hidden') + '>' +
          BeeUtils.escapeHtml(prompt.resolved && prompt.response ? youChose(prompt.response) : '') +
        '</p>';
    }

    const header = document.createElement('div');
    header.className = 'script-dialog__header';

    const badge = document.createElement('span');
    badge.className = 'script-dialog__badge script-dialog__badge--notice';
    badge.textContent = t('chat.badgeNotice');
    header.appendChild(badge);

    const titles = document.createElement('div');
    titles.className = 'script-dialog__titles';

    const groupNode = document.createElement('span');
    groupNode.className = 'script-dialog__object group-notice__group';
    groupNode.textContent = msg.groupName || t('chat.groupNotice');
    titles.appendChild(groupNode);

    if (sender) {
      const owner = document.createElement('span');
      owner.className = 'script-dialog__owner';
      owner.textContent = t('chat.fromLine', { name: msg.fromName || '' });
      titles.appendChild(owner);
    }
    header.appendChild(titles);

    const time = document.createElement('span');
    time.className = 'msg__time';
    time.textContent = BeeUtils.formatTime(msg.timestamp);
    header.appendChild(time);

    el.appendChild(header);

    if (subject) {
      const subjectEl = document.createElement('p');
      subjectEl.className = 'group-notice__subject';
      subjectEl.textContent = msg.subject || '';
      el.appendChild(subjectEl);
    }

    if (bodyText) {
      const bodyEl = document.createElement('p');
      bodyEl.className = 'script-dialog__body';
      const segments = BeeSlurl.scanLinks(bodyText);
      segments.forEach(function (seg) {
        if (seg.type === 'text') {
          const parts = String(seg.text || '').split('\n');
          for (let i = 0; i < parts.length; i++) {
            if (parts[i]) bodyEl.appendChild(document.createTextNode(parts[i]));
            if (i < parts.length - 1) bodyEl.appendChild(document.createElement('br'));
          }
          return;
        }
        const a = document.createElement('a');
        a.href = '#';
        if (seg.kind === 'slurl') {
          a.className = 'slurl-link';
          a.setAttribute('data-slurl', String(seg.url || ''));
          BeeSlurl.markAppLink(a, seg);
        } else {
          a.className = 'chat-link chat-link--' + (seg.trusted ? 'trusted' : 'external');
          a.setAttribute('data-url', String(seg.url || ''));
          a.setAttribute('data-trusted', seg.trusted ? '1' : '0');
        }
        a.title = String(seg.url || '');
        a.textContent = String(seg.label || '');
        bodyEl.appendChild(a);
      });
      el.appendChild(bodyEl);
    }

    if (attachment) {
      const attachmentWrap = document.createElement('div');
      attachmentWrap.innerHTML = attachment;
      while (attachmentWrap.firstChild) el.appendChild(attachmentWrap.firstChild);
    }

    BeeSlurl.bindLinks(el);
    if (prompt && !prompt.resolved) bindInteractivePrompt(el, msg);
    const groupEl = el.querySelector<HTMLElement>('.group-notice__group');
    if (groupEl && msg.groupId && typeof BeeProfile !== 'undefined') {
      groupEl.classList.add('msg__name--link');
      groupEl.title = t('chat.viewGroupProfile');
      groupEl.addEventListener('click', function () {
        BeeProfile.openGroup(msg.groupId);
      });
    }
    return el;
  }

  // An estate or region message (the Rust core routes an IM addressed to
  // everyone, and region-sourced chat, as kind 'region-message'): a framed
  // card under the sender's name, the way the MOTD is framed, since it is
  // the estate speaking to everyone present and not one more chat line.
  function renderRegionMessage(msg) {
    const el = document.createElement('div');
    el.className = 'msg msg--motd msg--region';
    el.dataset.id = msg.id;

    const meta = document.createElement('div');
    meta.className = 'msg__meta';

    const name = document.createElement('span');
    name.className = 'msg__name msg__name--region';
    name.textContent = String(msg.fromName || t('chat.estate'));
    const senderId = String(msg.fromId || '');
    const isAvatar = senderId && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(senderId);
    if (isAvatar) {
      name.setAttribute('data-agent-id', senderId);
      name.setAttribute('data-label', String(msg.fromName || ''));
      if (typeof BeeProfile !== 'undefined') {
        name.classList.add('msg__name--link');
        name.title = t('chat.viewProfile');
        name.addEventListener('click', function () {
          BeeProfile.openAvatar(senderId);
        });
      }
    }

    const label = document.createElement('span');
    label.className = 'msg__motd-label';
    label.textContent = msg.scope === 'estate'
      ? t('chat.estateMessage')
      : t('chat.regionMessage');

    const time = document.createElement('span');
    time.className = 'msg__time';
    time.textContent = String(BeeUtils.formatTime(msg.timestamp));

    meta.appendChild(name);
    meta.appendChild(label);
    meta.appendChild(time);

    const bodyEl = document.createElement('p');
    bodyEl.className = 'msg__body';
    BeeSlurl.appendLinkified(bodyEl, BeeI18n.textOf(msg), { breaks: true });

    el.appendChild(meta);
    el.appendChild(bodyEl);
    BeeSlurl.bindLinks(el);
    return el;
  }

  // A radar range report from the Rust core: a system line reading
  // "12:34 <name> entered radar range (12 m)." or "... left radar range
  // (104 m).", the name a profile link. A report
  // posted before the name resolved carries
  // none; the link then starts as the placeholder BeeSlurl.refreshAppLinks
  // relabels the moment the name lands.
  //
  // The words come from the report's fields (`radar.event`, `radar.range`),
  // not from the English `text` the core also sends, so they follow the UI
  // language. A leave without a range is someone gone from the sweep
  // altogether (left the region, logged out).
  function radarLineText(msg) {
    const radar = msg.radar;
    if (!radar || !radar.event) return BeeI18n.textOf(msg);
    const metres = radar.range == null ? null : Math.round(Number(radar.range));
    if (radar.event === 'leave') {
      return metres == null
        ? t('radar.leftRegion')
        : t('radar.leftRange', { metres: metres });
    }
    return t('radar.enteredRange', { metres: metres });
  }

  function renderRadarLine(msg) {
    const el = document.createElement('div');
    el.className = 'msg msg--system msg--radar';
    if (msg.radar && msg.radar.event === 'leave') el.classList.add('msg--radar-leave');
    el.dataset.id = msg.id;
    const body = document.createElement('p');
    body.className = 'msg__body';
    // The core dates the line with the crossing itself (an arrival may wait
    // for its name), so this is when it happened, not when it was shown.
    const time = document.createElement('span');
    time.className = 'msg__time';
    time.textContent = String(BeeUtils.formatTime(msg.timestamp));
    body.appendChild(time);
    body.appendChild(document.createTextNode(' '));
    const id = String(msg.fromId || '');
    if (id) {
      const url = 'secondlife:///app/agent/' + id + '/about';
      const seg = BeeSlurl.scanLinks(url).find(function (s) { return s.type === 'link'; });
      const link = document.createElement('a');
      link.setAttribute('href', '#');
      link.className = 'slurl-link';
      link.setAttribute('title', url);
      link.setAttribute('data-slurl', url);
      if (seg) BeeSlurl.markAppLink(link, seg);
      else link.setAttribute('data-agent-link', id);
      // The last fallback is BeeSlurl's placeholder, the same line:
      // refreshAppLinks finds the links still to relabel by that text.
      link.textContent = String(msg.fromName || '') || (seg && seg.label) ||
        t('slurl.residentProfile');
      body.appendChild(link);
      body.appendChild(document.createTextNode(' '));
    }
    body.appendChild(document.createTextNode(radarLineText(msg)));
    el.appendChild(body);
    BeeSlurl.bindLinks(el);
    return el;
  }

  function renderMessage(msg) {
    if (msg.kind === 'group-notice') {
      return renderGroupNotice(msg);
    }
    if (msg.kind === 'motd') {
      return renderMotdMessage(msg);
    }
    if (msg.kind === 'region-message') {
      return renderRegionMessage(msg);
    }
    if (msg.kind === 'radar') {
      return renderRadarLine(msg);
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
      const body = document.createElement('p');
      body.className = 'msg__body';
      // A system line is the core's: its words come with a key where the
      // core gave them one.
      const segments = BeeSlurl.scanLinks(BeeI18n.textOf(msg));
      segments.forEach(function (seg) {
        if (seg.type === 'text') {
          body.appendChild(document.createTextNode(String(seg.text || '')));
          return;
        }
        const link = document.createElement('a');
        link.setAttribute('href', '#');
        if (seg.kind === 'slurl') {
          link.className = 'slurl-link';
          link.setAttribute('title', String(seg.url || ''));
          link.setAttribute('data-slurl', String(seg.url || ''));
          BeeSlurl.markAppLink(link, seg);
        } else {
          link.className = 'chat-link chat-link--' + (seg.trusted ? 'trusted' : 'external');
          link.setAttribute('title', String(seg.url || ''));
          link.setAttribute('data-url', String(seg.url || ''));
          link.setAttribute('data-trusted', seg.trusted ? '1' : '0');
        }
        link.textContent = String(seg.label || '');
        body.appendChild(link);
      });
      el.appendChild(body);
      BeeSlurl.bindLinks(el);
      return el;
    }

    const isObject = msg.source === 'object';
    const nameClass = CHAT_TYPE_CLASS[volume] || (isObject ? 'msg__name--object' : '');
    // An emote ("/me waves", flagged by the core) reads as the speaker's
    // name run straight into the action, in italics and without the
    // "shouts"/"whispers" verb.
    const isEmote = !!msg.emote;
    if (isEmote) el.classList.add('msg--emote');
    const label = isEmote ? ''
      : volume === 'whisper' ? t('chat.whispers')
        : volume === 'shout' ? t('chat.shouts') : '';
    const bodyText = isEmote
      ? String(msg.fromName || '') + String(msg.text || '').slice(3)
      : msg.text;
    const speakerId = msg.fromId || '';
    // Give the avatar thumbnail to agents only - an object's UUID isn't an avatar.
    const meta = document.createElement('div');
    meta.className = 'msg__meta';

    if (speakerId && !isObject) {
      const avatar = document.createElement('span');
      avatar.className = 'msg__avatar avatar-thumb avatar-thumb--chat';
      avatar.setAttribute('data-agent-id', String(speakerId));
      avatar.setAttribute('data-resolve-image', '0');
      avatar.setAttribute('data-label', String(msg.fromName || ''));
      meta.appendChild(avatar);
    }

    const name = document.createElement('span');
    name.className = 'msg__name ' + nameClass;
    // Right-clicking a speaker's name offers their profile and copies
    // (objects have no profile, so only agents get the id).
    if (speakerId && !isObject) {
      name.setAttribute('data-agent-id', String(speakerId));
      name.setAttribute('data-label', String(msg.fromName || ''));
    }
    name.appendChild(document.createTextNode(String(msg.fromName || '')));
    if (label) {
      name.appendChild(document.createTextNode(' '));
      const volumeEl = document.createElement('span');
      volumeEl.className = 'msg__volume';
      volumeEl.textContent = label;
      name.appendChild(volumeEl);
    }
    meta.appendChild(name);

    const time = document.createElement('span');
    time.className = 'msg__time';
    time.textContent = String(BeeUtils.formatTime(msg.timestamp));
    meta.appendChild(time);

    const body = document.createElement('p');
    body.className = 'msg__body';
    const segments = BeeSlurl.scanLinks(bodyText);
    segments.forEach(function (seg) {
      if (seg.type === 'text') {
        body.appendChild(document.createTextNode(String(seg.text || '')));
        return;
      }
      const link = document.createElement('a');
      link.setAttribute('href', '#');
      if (seg.kind === 'slurl') {
        link.className = 'slurl-link';
        link.setAttribute('title', String(seg.url || ''));
        link.setAttribute('data-slurl', String(seg.url || ''));
        BeeSlurl.markAppLink(link, seg);
      } else {
        link.className = 'chat-link chat-link--' + (seg.trusted ? 'trusted' : 'external');
        link.setAttribute('title', String(seg.url || ''));
        link.setAttribute('data-url', String(seg.url || ''));
        link.setAttribute('data-trusted', seg.trusted ? '1' : '0');
      }
      link.textContent = String(seg.label || '');
      body.appendChild(link);
    });

    el.appendChild(meta);
    el.appendChild(body);

    BeeSlurl.bindLinks(el);

    const thumb = el.querySelector('.msg__avatar[data-agent-id]');
    if (thumb) BeeAvatarThumb.refresh(thumb);
    if (typeof BeeProfile !== 'undefined') {
      const nameEl = el.querySelector<HTMLElement>('.msg__name');
      if (nameEl && isObject && msg.ownerId) {
        // For an object, the name links through to its owner rather than to an
        // avatar profile keyed by the object's own UUID.
        nameEl.classList.add('msg__name--link');
        nameEl.title = t('chat.viewOwnerProfile');
        nameEl.addEventListener('click', function () {
          // A group-owned object's owner is the group (object IMs say so).
          if (msg.ownerIsGroup && typeof BeeProfile.openGroup === 'function') BeeProfile.openGroup(msg.ownerId);
          else BeeProfile.openAvatar(msg.ownerId);
        });
      } else if (nameEl && !isObject && speakerId) {
        nameEl.classList.add('msg__name--link');
        nameEl.title = t('chat.viewProfile');
        nameEl.addEventListener('click', function () {
          BeeProfile.openAvatar(speakerId);
        });
      }
    }

    return el;
  }

  // Matches the state layer's transcript cap, so the live DOM can't outgrow
  // the array it renders.
  const MAX_TRANSCRIPT_NODES = 1000;

  function trimList(list) {
    while (list.childElementCount > MAX_TRANSCRIPT_NODES && list.firstElementChild) {
      list.removeChild(list.firstElementChild);
    }
  }

  function appendMessage(msg, scroll?, listId?) {
    const list = document.getElementById(listId || 'chat-messages');
    if (!list) return;
    // Respect where the user is reading: only auto-scroll when they're already
    // pinned to the bottom (or a caller explicitly forces it).
    const pinned = (list.scrollHeight - list.scrollTop - list.clientHeight) < 40;
    list.appendChild(renderMessage(msg));
    trimList(list);
    if (scroll === false) return;
    if (scroll === true || pinned) list.scrollTop = list.scrollHeight;
  }

  function updateMessage(msg, listId?) {
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

  // `filter` (optional) keeps only matching messages - the Events subtabs use it.
  function renderAllTo(listId, filter?) {
    const list = document.getElementById(listId || 'chat-messages');
    if (!list) return;
    list.innerHTML = '';
    let messages = listId === 'event-messages'
      ? BeeState.get().eventMessages
      : BeeState.get().chatMessages;
    if (typeof filter === 'function') messages = messages.filter(filter);
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
    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    const text = input.value.trim();
    if (!text || !BeeState.gridOnline()) return;

    const volume = (document.getElementById('chat-volume') as HTMLSelectElement).value || 'normal';

    BeeTransport.sendChat(text, { type: volume });
    input.value = '';
    resetChatInputHeight();
    input.focus();
  }

  function init() {
    document.getElementById('chat-form').addEventListener('submit', handleSubmit);

    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
      resetChatInputHeight = BeeUtils.bindAutoGrowTextarea(chatInput, { maxRows: 3 });
    }

    BeeState.on('chat', function (msg) {
      if (BeeState.get().activeTab === 'chat') {
        appendMessage(msg);
      }
    });

    BeeState.on('chat-updated', function (msg) {
      if (BeeState.get().activeTab === 'chat') {
        updateMessage(msg);
      }
    });

    BeeState.on('reset', function () {
      const list = document.getElementById('chat-messages');
      if (list) list.innerHTML = '';
    });

    // The transcript is rebuilt from the state whenever the tab opens; a
    // language switch while it is on screen rebuilds it in the new words.
    BeeI18n.onChange(function () {
      if (BeeState.get().activeTab === 'chat') renderAll();
    });

    // A mention renders as "Resident profile" until the name arrives; the
    // moment it does, every such link on the page (chat, IM, events) is
    // relabelled in place. Group links do the same as group names resolve.
    if (typeof BeeSlurl.refreshAppLinks === 'function') {
      const refreshLinks = function () { BeeSlurl.refreshAppLinks(document); };
      BeeTransport.on('names-updated', refreshLinks);
      BeeTransport.on('group-names', refreshLinks);
      if (typeof BeeProfiles !== 'undefined' && BeeProfiles.onChange) {
        BeeProfiles.onChange(function (evt) {
          if (evt && (evt.kind === 'group' || evt.kind === 'membership')) refreshLinks();
        });
      }
    }
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
