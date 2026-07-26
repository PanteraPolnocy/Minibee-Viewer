/**
 * News panel: the Linden blog, the SL calendar, grid status, and the blogger network.
 *
 */
const FSNews = (function () {
  'use strict';

  const DEFAULT_TAB = 'linden';
  const PANES = {
    linden: 'news-pane-linden',
    calendar: 'news-pane-calendar',
    status: 'news-pane-status',
    blogs: 'news-pane-blogs'
  };
  // Feed subtab -> the key the Rust side knows it by.
  const FEEDS = { linden: 'linden-news', status: 'grid-status', blogs: 'blogs' };
  const FRAMES = {
    calendar: 'https://calendar.google.com/calendar/u/0/newembed?src=c_kphtklo9degke40dpk7nr6cclc@group.calendar.google.com'
  };

  let activeTab = DEFAULT_TAB;
  const loaded = {};   // subtab -> true once its content is in place
  const items = {};    // feed key -> parsed items, so switching tabs is instant

  function openExternal(url) {
    if (typeof FSSlurl !== 'undefined' && FSSlurl.openExternalUrl) {
      FSSlurl.openExternalUrl(url);
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  // Feed dates arrive as whatever the publisher used (RFC 822, ISO 8601, ...), so
  // show a local date when it parses and the raw string when it doesn't.
  function formatDate(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString();
  }

  function metaLine(item) {
    const parts = [];
    const date = formatDate(item.published);
    if (date) parts.push(date);
    if (item.author) parts.push(item.author);
    const cats = Array.isArray(item.categories) ? item.categories.slice(0, 3) : [];
    if (cats.length) parts.push(cats.join(', '));
    return parts.join(' · ');
  }

  function renderItems(tab) {
    const list = document.getElementById('news-list-' + tab);
    if (!list) return;
    const rows = items[FEEDS[tab]] || [];
    list.innerHTML = '';
    if (!rows.length) {
      list.innerHTML = '<p class="news-empty">Nothing to show.</p>';
      return;
    }
    rows.forEach(function (item) {
      const card = document.createElement('article');
      card.className = 'news-item';

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'news-item__head';
      head.setAttribute('aria-expanded', 'false');
      head.innerHTML =
        (item.image
          ? '<img class="news-item__thumb" src="' + FSUtils.escapeHtml(item.image) +
            '" alt="" loading="lazy" decoding="async">'
          : '') +
        '<span class="news-item__headings">' +
          '<span class="news-item__title">' + FSUtils.escapeHtml(item.title || 'Untitled') + '</span>' +
          '<span class="news-item__meta">' + FSUtils.escapeHtml(metaLine(item)) + '</span>' +
          (item.summary
            ? '<span class="news-item__summary">' + FSUtils.escapeHtml(item.summary) + '</span>'
            : '') +
        '</span>';
      card.appendChild(head);

      const body = document.createElement('div');
      body.className = 'news-item__body';
      body.hidden = true;
      card.appendChild(body);

      head.addEventListener('click', function () {
        const open = head.getAttribute('aria-expanded') === 'true';
        head.setAttribute('aria-expanded', open ? 'false' : 'true');
        card.classList.toggle('news-item--open', !open);
        body.hidden = open;
        // Build the full text on first open only.
        if (!open && !body.dataset.built) {
          body.dataset.built = '1';
          const text = String(item.text || item.summary || '').trim();
          text.split('\n').forEach(function (para) {
            if (!para.trim()) return;
            const p = document.createElement('p');
            p.className = 'news-item__para';
            p.textContent = para;
            body.appendChild(p);
          });
          if (item.link) {
            const actions = document.createElement('div');
            actions.className = 'news-item__actions';
            const open2 = document.createElement('button');
            open2.type = 'button';
            open2.className = 'btn btn--secondary btn--sm';
            open2.textContent = 'Read on the web';
            open2.addEventListener('click', function () { openExternal(item.link); });
            actions.appendChild(open2);
            body.appendChild(actions);
          }
        }
      });

      list.appendChild(card);
    });
  }

  function loadFeed(tab, force) {
    const key = FEEDS[tab];
    if (!key) return;
    if (loaded[tab] && !force) return;
    const list = document.getElementById('news-list-' + tab);
    if (list) list.innerHTML = '<p class="news-empty">Loading…</p>';
    if (typeof FSBridge === 'undefined' || !FSBridge.invoke) {
      if (list) list.innerHTML = '<p class="news-empty">Native bridge unavailable.</p>';
      return;
    }
    loaded[tab] = true;
    FSBridge.invoke('bridge_feed', { feed: key }).then(function (res) {
      if (!res || res.error) {
        loaded[tab] = false;
        if (list) {
          list.innerHTML = '<p class="news-empty">' +
            FSUtils.escapeHtml((res && res.error) || 'Could not load this feed.') + '</p>';
        }
        return;
      }
      items[key] = res.items || [];
      renderItems(tab);
    }).catch(function (err) {
      loaded[tab] = false;
      if (list) {
        list.innerHTML = '<p class="news-empty">' +
          FSUtils.escapeHtml((err && err.message) || 'Could not load this feed.') + '</p>';
      }
    });
  }

  function loadFrame(tab) {
    if (loaded[tab]) return;
    const host = document.getElementById('news-frame-' + tab);
    const url = FRAMES[tab];
    if (!host || !url) return;
    loaded[tab] = true;
    host.innerHTML = '';

    const note = document.createElement('p');
    note.className = 'news-empty news-frame__note';
    note.textContent = 'Loading…';
    host.appendChild(note);

    const frame = document.createElement('iframe');
    frame.className = 'news-frame__iframe';
    frame.setAttribute('title', tab === 'calendar' ? 'Second Life calendar' : 'Blogger network');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('loading', 'lazy');
    // Let the page run and navigate, but keep it out of our origin.
    frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms allow-same-origin');
    frame.src = url;
    frame.addEventListener('load', function () { note.hidden = true; });
    host.appendChild(frame);

    // A site that refuses framing often never fires a useful load event, so say so
    // after a grace period instead of leaving a blank rectangle.
    window.setTimeout(function () {
      if (!note.hidden) {
        note.textContent = 'This page would not load in the app. Use "Open in browser" above.';
      }
    }, 6000);
  }

  function setTab(tab) {
    activeTab = PANES[tab] ? tab : DEFAULT_TAB;
    document.querySelectorAll('[data-news-tab]').forEach(function (btn) {
      const on = btn.dataset.newsTab === activeTab;
      btn.classList.toggle('settings-tab--active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Object.keys(PANES).forEach(function (key) {
      const pane = document.getElementById(PANES[key]);
      if (pane) pane.hidden = key !== activeTab;
    });
    if (FEEDS[activeTab]) loadFeed(activeTab, false);
    else loadFrame(activeTab);
  }

  function activate() {
    setTab(activeTab);
  }

  function init() {
    document.querySelectorAll('[data-news-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () { setTab(btn.dataset.newsTab); });
    });
    document.querySelectorAll('[data-news-refresh]').forEach(function (btn) {
      btn.addEventListener('click', function () { loadFeed(btn.dataset.newsRefresh, true); });
    });
    document.querySelectorAll('[data-news-open]').forEach(function (btn) {
      btn.addEventListener('click', function () { openExternal(btn.dataset.newsOpen); });
    });
  }

  return { init: init, activate: activate };
})();

window.FSNews = FSNews;
