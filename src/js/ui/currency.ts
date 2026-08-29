/**
 * Buy L$ - opened from the balance in the top bar (or the session menu on
 * narrow screens).
 *
 * The same flow as the reference viewer: an amount is priced through the
 * grid's currency helper (which may adjust it and hands back a confirm
 * token), the estimate and resulting balance are shown, and the purchase
 * echoes the quote back. Every purchase is confirmed first - the helper's
 * token only decides whether that confirmation must include the account
 * password. Accounts without a payment method get pointed at the billing
 * page instead; helper errors surface as "Unable to Buy" with the server's
 * own message.
 */
const BeeCurrency = (function () {
  'use strict';

  const PAYMENT_SETUP_URL = 'https://secondlife.com/my/lindex/buy.php?associate_for_viewer=1';
  const PAYMENT_METHOD_URL = 'https://www.secondlife.com/my/account/payment_method_management.php';
  const CURRENCY_HISTORY_URL = 'https://www.secondlife.com/my/account/currency.php';
  // How long after the last keystroke the price is (re)fetched.
  const QUOTE_DEBOUNCE_MS = 1200;

  let bound = false;
  let quote = null;        // the helper's answer: { amount, estimate, usdCents, localCost, confirm }
  let quoteSeq = 0;        // bumped on every amount edit / close, so stale replies drop
  let busy = false;        // a purchase is in flight
  let paymentOkFor = '';   // agent id whose payment-info pre-check already passed

  function el(id) { return document.getElementById(id); }
  function dlg() { return el('buy-currency-dialog') as HTMLDialogElement | null; }
  function amountInput() { return el('buy-currency-amount') as HTMLInputElement | null; }

  function isLindenGrid() {
    const grid = String(BeeState.get().grid || '');
    return grid === 'agni' || grid === 'aditi';
  }

  function currentAmount() {
    const input = amountInput();
    const n = input ? parseInt(input.value, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function setStatus(text) {
    const status = el('buy-currency-status');
    if (!status) return;
    status.textContent = text || '';
    status.hidden = !text;
  }

  function render() {
    const s = BeeState.get();
    const balance = typeof s.lindenBalance === 'number' ? s.lindenBalance : null;
    const amount = currentAmount();
    const haveQuote = !!(quote && quote.amount === amount && amount > 0);

    const balanceEl = el('buy-currency-balance');
    if (balanceEl) balanceEl.textContent = BeeUtils.formatLindenBalance(balance);
    const est = el('buy-currency-estimate');
    if (est) {
      est.textContent = !amount ? '—'
        : haveQuote ? (quote.estimate || '—')
          : 'Estimating...';
    }
    const total = el('buy-currency-total');
    if (total) {
      total.textContent = (balance === null || !amount)
        ? BeeUtils.formatLindenBalance(balance)
        : BeeUtils.formatLindenBalance(balance + amount);
    }
    const submit = el('buy-currency-submit') as HTMLButtonElement | null;
    if (submit) submit.disabled = busy || !haveQuote;

    // The exchange-rate hint and account links only make sense when the helper
    // actually priced in local currency, and the links are Linden-grid pages.
    const intl = !!(quote && quote.localCost);
    const note = el('buy-currency-note');
    if (note) note.hidden = !intl;
    const links = el('buy-currency-links');
    if (links) links.hidden = !(intl && isLindenGrid());
  }

  // Invalidate the current quote: any reply still in flight, or any purchase
  // not yet past its confirmation, dies against the bumped sequence.
  function resetQuote() {
    quote = null;
    quoteSeq++;
  }

  function closeDialog() {
    resetQuote();
    const d = dlg();
    if (d) BeeUtils.dismissDialog(d);
  }

  function refreshBalance() {
    if (typeof BeeBridge !== 'undefined' && BeeBridge.invoke) {
      BeeBridge.invoke('sl_request_balance').catch(function () {});
    }
  }

  function cannotBuy(message) {
    closeDialog();
    BeeUtils.alert({
      title: 'Unable to Buy',
      message: message || 'The billing service is unavailable right now.'
    });
  }

  async function requestQuote() {
    const d = dlg();
    if (!d || !d.open || busy) return;
    const amount = currentAmount();
    if (!amount) return;
    const seq = quoteSeq;
    try {
      const r = await BeeBridge.invoke('sl_currency_quote', { amount: amount });
      if (seq !== quoteSeq) return;
      if (!r || r.ok !== true) {
        cannotBuy(r && r.error);
        return;
      }
      quote = r;
      // The helper's figure wins when it rounds or clamps the amount.
      const input = amountInput();
      if (input && r.amount && r.amount !== amount) input.value = String(r.amount);
      render();
    } catch (err) {
      if (seq !== quoteSeq) return;
      cannotBuy(BeeUtils.errText(err));
    }
  }

  // Ask for the account password; resolves null on cancel. An empty entry
  // re-prompts rather than passing - the helper demanded a credential.
  function promptPassword(action) {
    return new Promise(function (resolve) {
      const pd = el('buy-currency-password-dialog') as HTMLDialogElement | null;
      const form = el('buy-currency-password-form') as HTMLFormElement | null;
      const input = el('buy-currency-password') as HTMLInputElement | null;
      const cancel = el('buy-currency-password-cancel');
      const text = el('buy-currency-password-text');
      if (!pd || !form || !input || typeof pd.showModal !== 'function') {
        resolve(null);
        return;
      }
      if (text) text.textContent = action;
      input.value = '';
      let settled = false;
      function done(result) {
        if (settled) return;
        settled = true;
        form.removeEventListener('submit', onSubmit);
        if (cancel) cancel.removeEventListener('click', onCancel);
        pd.removeEventListener('cancel', onDialogCancel);
        input.value = '';
        BeeUtils.dismissDialog(pd);
        resolve(result);
      }
      function onSubmit(e) {
        e.preventDefault();
        if (!input.value) {
          input.focus();
          return;
        }
        done(input.value);
      }
      function onCancel() { done(null); }
      function onDialogCancel(e) { e.preventDefault(); done(null); }
      form.addEventListener('submit', onSubmit);
      if (cancel) cancel.addEventListener('click', onCancel);
      pd.addEventListener('cancel', onDialogCancel);
      pd.showModal();
      input.focus();
    });
  }

  async function submitBuy() {
    if (busy) return;
    const amount = currentAmount();
    if (!amount || !quote || quote.amount !== amount) return;
    const purchase = quote;
    const seq = quoteSeq;
    const action = 'Buy L$ ' + amount.toLocaleString('en-US') +
      (purchase.estimate ? ' for approx. ' + purchase.estimate : '') + '?';

    // Always confirm before charging. The helper's token picks the strength:
    // "password" means the account password, anything else a plain confirm.
    let password = '';
    if (purchase.confirm === 'password') {
      const entered = await promptPassword(action);
      if (entered === null) return;
      password = String(entered);
    } else {
      const ok = await BeeUtils.confirm({ title: 'Confirm purchase', message: action, confirmLabel: 'Buy now' });
      if (!ok) return;
    }
    // The dialog may have been closed (disconnect, session loss) while the
    // confirmation sat open; a purchase must not outlive its dialog.
    const d = dlg();
    if (seq !== quoteSeq || !d || !d.open) return;

    busy = true;
    setStatus('Contacting the billing service...');
    render();
    let result = null;
    let failure = '';
    try {
      result = await BeeBridge.invoke('sl_currency_buy', {
        amount: amount,
        confirm: purchase.confirm || '',
        usdCents: purchase.usdCents != null ? purchase.usdCents : null,
        localCost: purchase.localCost || null,
        password: password || null
      });
    } catch (err) {
      failure = BeeUtils.errText(err);
    }
    busy = false;
    setStatus('');
    closeDialog();
    refreshBalance();
    if (result && result.ok === true) {
      BeeUtils.alert({
        title: 'Thank you for your payment!',
        message: 'Your L$ balance will be updated when processing completes. ' +
          'If processing takes more than 20 minutes, your transaction may be cancelled ' +
          'and the purchase amount credited back to your billing account.'
      });
    } else {
      cannotBuy((result && result.error) || failure);
    }
  }

  function bind() {
    if (bound) return;
    bound = true;
    const input = amountInput();
    if (input) {
      const debounced = BeeUtils.debounce(requestQuote, QUOTE_DEBOUNCE_MS);
      input.addEventListener('input', function () {
        resetQuote();
        render();
        debounced();
      });
    }
    const form = el('buy-currency-form') as HTMLFormElement | null;
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        submitBuy();
      });
    }
    const cancel = el('buy-currency-cancel');
    if (cancel) cancel.addEventListener('click', closeDialog);
    const d = dlg();
    if (d) d.addEventListener('cancel', function () { resetQuote(); });
    const payment = el('buy-currency-payment-link');
    if (payment) payment.addEventListener('click', function () { BeeSlurl.openExternalUrl(PAYMENT_METHOD_URL); });
    const history = el('buy-currency-history-link');
    if (history) history.addEventListener('click', function () { BeeSlurl.openExternalUrl(CURRENCY_HISTORY_URL); });
    BeeState.on('change', function (partial) {
      const open = dlg();
      if (!open || !open.open) return;
      if (partial.lindenBalance !== undefined) render();
      if (partial.connected === false || partial.sessionLost) closeDialog();
    });
  }

  function openDialog() {
    const d = dlg();
    if (!d || typeof d.showModal !== 'function') return;
    bind();
    resetQuote();
    busy = false;
    setStatus('');
    const input = amountInput();
    if (input) input.value = '';
    render();
    if (!d.open) d.showModal();
    if (input) input.focus();
    refreshBalance();
  }

  // Whether this account can buy at all: the grid marks accounts that have a
  // payment method (or transaction history) on file in the profile flags.
  // Unknown counts as yes - the helper is the real authority and will refuse.
  async function hasPaymentInfo(selfId) {
    let profile = BeeProfiles.getAvatarProfile(selfId);
    if (!profile || !profile.flags) {
      // Bounded wait: the flags ride the UDP profile reply, which can be slow
      // or lost, and a balance tap must not hang on it.
      profile = await Promise.race([
        BeeProfiles.fetchAvatarProfile(selfId).catch(function () { return null; }),
        new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 4000); })
      ]);
    }
    const flags = profile && profile.flags;
    if (!flags) return true;
    return !!(flags.transacted || flags.identified);
  }

  async function open() {
    const s = BeeState.get();
    if (!s.connected || s.sessionLost || !s.agent || !s.agent.id) return;
    // A passed check holds for the session; a failed one is re-checked each
    // time, so adding a payment method on the website takes effect on return.
    if (isLindenGrid() && paymentOkFor !== s.agent.id) {
      if (!(await hasPaymentInfo(s.agent.id))) {
        const go = await BeeUtils.confirm({
          title: 'Buy L$',
          message: 'Add a payment method to buy Linden dollars and enjoy more of Second Life.',
          confirmLabel: 'Get started',
          cancelLabel: 'Later'
        });
        if (go) BeeSlurl.openExternalUrl(PAYMENT_SETUP_URL);
        return;
      }
      paymentOkFor = s.agent.id;
    }
    openDialog();
  }

  function init() {
    const badge = el('balance-badge');
    if (badge) badge.addEventListener('click', function () { open(); });
  }

  return { init: init, open: open };
})();
