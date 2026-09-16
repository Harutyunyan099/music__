/* muzzz — application shell: routing, views, search, player UI */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function h(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '0:00';
    var total = Math.floor(seconds);
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var secs = total % 60;
    return (hours ? hours + ':' + (minutes < 10 ? '0' : '') : '') + minutes + ':' + (secs < 10 ? '0' : '') + secs;
  }

  function hashCode(str) {
    var value = 2166136261;
    for (var i = 0; i < str.length; i++) { value ^= str.charCodeAt(i); value = Math.imul(value, 16777619); }
    return (value >>> 0).toString(36);
  }

  var ADMIN_HASH = 'jrv83x';            // Narek :: harutyunyan2009

  var App = {
    route: 'home',
    local: [],
    registry: new Map(),
    search: { query: '', order: 'relevance', items: [], token: '', loading: false, error: null, done: false },
    searchTimer: null,
    searchAbort: null,
    npOpen: false,
    isAdmin: false,

    /* ------------------------------------------------------------- setup */

    init: function () {
      this.isAdmin = !!localStorage.getItem('muzzz:admin');
      this.applyTheme(Store.prefs.theme);
      this.applyLang(Store.prefs.lang, true);

      Player.volume = Store.prefs.volume;
      Player.muted = Store.prefs.muted;
      Player.onEnded = function (auto) { App.waveNext(auto, true); };
      Player.onError = function (reason) { App.playerError(reason); };
      Player.on(function (what) { App.onPlayerEvent(what); });
      Store.onChange(function () { App.refreshCurrentView(); App.syncPlayerUI(); });

      this.bind();
      this.loadLocal().then(function () {
        Wave.init(App.local);
        App.go(location.hash.replace('#', '') || 'home');
      });
      Api.status().then(function () { App.refreshCurrentView(); });
    },

    loadLocal: function () {
      return fetch('songs.json', { cache: 'no-store' })
        .then(function (response) { return response.ok ? response.json() : { songs: [] }; })
        .catch(function () { return { songs: [] }; })
        .then(function (data) {
          var list = (data.songs || []).map(function (song) {
            return {
              id: 'local:' + song.id,
              source: 'local',
              title: song.title,
              artist: song.artist,
              artwork: song.cover || 'placeholder.svg',
              duration: song.duration || 0,
              src: song.src,
              genre: song.genre || ''
            };
          });
          return Store.db.all().catch(function () { return []; }).then(function (uploads) {
            (uploads || []).forEach(function (item) {
              list.push({
                id: 'upload:' + item.id,
                source: 'local',
                title: item.title,
                artist: item.artist,
                artwork: 'placeholder.svg',
                duration: item.duration || 0,
                src: URL.createObjectURL(item.blob),
                upload: true
              });
            });
            App.local = list
              .filter(function (track) { return !Store.hiddenLocal.has(track.id); })
              .map(function (track) {
                var over = Store.overrides[track.id];
                if (over) { if (over.title) track.title = over.title; if (over.artist) track.artist = over.artist; }
                return track;
              });
            App.local.forEach(function (track) { App.registry.set(track.id, track); });
          });
        });
    },

    reg: function (tracks) {
      (tracks || []).forEach(function (track) { App.registry.set(track.id, track); });
      return tracks;
    },

    /* ----------------------------------------------------------- routing */

    go: function (route) {
      this.route = route;
      location.hash = route;
      $$('.nav__item').forEach(function (item) {
        item.classList.toggle('is-active', item.dataset.route === route);
        item.setAttribute('aria-current', item.dataset.route === route ? 'page' : 'false');
      });
      $('#view').scrollTop = 0;
      this.renderView();
      document.body.classList.remove('nav-open');
    },

    refreshCurrentView: function () {
      if (document.hidden) return;
      this.renderView();
    },

    renderView: function () {
      var view = $('#view');
      var builder = this.views[this.route] || this.views.home;
      view.innerHTML = builder.call(this);
      if (this.route === 'search') {
        var input = $('#search-input');
        if (input && document.activeElement !== input) input.value = this.search.query;
      }
      this.syncCards();
    },

    /* ------------------------------------------------------- components */

    card: function (track, options) {
      options = options || {};
      this.registry.set(track.id, track);
      var inCollection = Store.inCollection(track.id);
      var fav = Store.isFavorite(track.id);
      return '<article class="card" data-id="' + h(track.id) + '">' +
        '<div class="card__art">' +
          '<img src="' + h(track.artwork || 'placeholder.svg') + '" alt="" loading="lazy" ' +
            'onerror="this.src=\'placeholder.svg\'">' +
          '<button class="card__play" data-action="play" data-id="' + h(track.id) + '" ' +
            'aria-label="' + h(t('play')) + '">' + this.icon('play') + '</button>' +
          (track.duration ? '<span class="card__time">' + fmtTime(track.duration) + '</span>' : '') +
        '</div>' +
        '<div class="card__body">' +
          '<h3 class="card__title" title="' + h(track.title) + '">' + h(track.title) + '</h3>' +
          '<p class="card__artist">' + h(track.artist) + '</p>' +
        '</div>' +
        '<div class="card__actions">' +
          '<button class="chip-btn' + (fav ? ' is-on' : '') + '" data-action="fav" data-id="' + h(track.id) + '" ' +
            'aria-label="' + h(fav ? t('fav_on') : t('fav_off')) + '">' + this.icon(fav ? 'heart-on' : 'heart') + '</button>' +
          (options.removable
            ? '<button class="chip-btn" data-action="remove" data-id="' + h(track.id) + '" aria-label="' + h(t('remove')) + '">' + this.icon('trash') + '</button>'
            : '<button class="chip-btn' + (inCollection ? ' is-on' : '') + '" data-action="add" data-id="' + h(track.id) + '" ' +
              'aria-label="' + h(inCollection ? t('added') : t('add')) + '">' + this.icon(inCollection ? 'check' : 'plus') + '</button>') +
        '</div>' +
      '</article>';
    },

    row: function (track, options) {
      options = options || {};
      this.registry.set(track.id, track);
      var fav = Store.isFavorite(track.id);
      var inCollection = Store.inCollection(track.id);
      return '<li class="row" data-id="' + h(track.id) + '" data-action="play">' +
        '<span class="row__art"><img src="' + h(track.artwork || 'placeholder.svg') + '" alt="" loading="lazy" ' +
          'onerror="this.src=\'placeholder.svg\'"><span class="row__play">' + this.icon('play') + '</span></span>' +
        '<span class="row__text"><span class="row__title">' + h(track.title) + '</span>' +
        '<span class="row__artist">' + h(track.artist) + '</span></span>' +
        '<span class="row__time">' + (track.duration ? fmtTime(track.duration) : '') + '</span>' +
        '<span class="row__actions">' +
          '<button class="chip-btn' + (fav ? ' is-on' : '') + '" data-action="fav" data-id="' + h(track.id) + '" aria-label="' + h(t('fav_off')) + '">' + this.icon(fav ? 'heart-on' : 'heart') + '</button>' +
          (options.removable
            ? '<button class="chip-btn" data-action="remove" data-id="' + h(track.id) + '" aria-label="' + h(t('remove')) + '">' + this.icon('trash') + '</button>'
            : '<button class="chip-btn' + (inCollection ? ' is-on' : '') + '" data-action="add" data-id="' + h(track.id) + '" aria-label="' + h(t('add')) + '">' + this.icon(inCollection ? 'check' : 'plus') + '</button>') +
        '</span>' +
      '</li>';
    },

    section: function (title, body, options) {
      options = options || {};
      if (!body) return '';
      return '<section class="section">' +
        '<header class="section__head"><h2>' + h(title) + '</h2>' +
        (options.route ? '<button class="link-btn" data-action="goto" data-route="' + h(options.route) + '">' + h(t('see_all')) + '</button>' : '') +
        '</header>' + body + '</section>';
    },

    grid: function (tracks, options) {
      if (!tracks.length) return '';
      return '<div class="grid">' + tracks.map(function (track) { return App.card(track, options); }).join('') + '</div>';
    },

    list: function (tracks, options) {
      if (!tracks.length) return '';
      return '<ol class="rows">' + tracks.map(function (track) { return App.row(track, options); }).join('') + '</ol>';
    },

    empty: function (title, text, action) {
      return '<div class="empty">' +
        '<div class="empty__art">' + this.icon('note') + '</div>' +
        '<h3>' + h(title) + '</h3><p>' + h(text) + '</p>' +
        (action ? '<button class="btn btn--primary" data-action="goto" data-route="' + h(action.route) + '">' + h(action.label) + '</button>' : '') +
      '</div>';
    },

    skeletons: function (count) {
      var out = '';
      for (var i = 0; i < count; i++) out += '<div class="card card--skeleton"><div class="sk sk--art"></div><div class="sk sk--line"></div><div class="sk sk--line sk--short"></div></div>';
      return '<div class="grid">' + out + '</div>';
    },

    icon: function (name) {
      return '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
    },

    /* --------------------------------------------------------------- views */

    views: {
      home: function () {
        var out = '<header class="hero">' +
          '<p class="hero__eyebrow">muzzz</p>' +
          '<h1>' + h(t('hello')) + '</h1>' +
          '<p class="hero__sub">' + h(t('hello_sub')) + '</p>' +
          '<div class="hero__actions">' +
            '<button class="btn btn--primary" data-action="goto" data-route="wave">' + this.icon('wave') + ' ' + h(t('sec_wave')) + '</button>' +
            '<button class="btn" data-action="goto" data-route="search">' + this.icon('search') + ' ' + h(t('nav_search')) + '</button>' +
          '</div>' +
        '</header>';

        if (Store.recent.length) out += this.section(t('sec_recent'), this.grid(this.reg(Store.recent.slice(0, 6))), { route: 'recent' });
        if (Store.favorites.length) out += this.section(t('sec_favorites'), this.grid(this.reg(Store.favorites.slice(0, 6))), { route: 'favorites' });
        if (Store.collection.length) out += this.section(t('sec_collection'), this.grid(this.reg(Store.collection.slice(0, 6))), { route: 'collection' });
        if (Wave.upNext.length) out += this.section(t('sec_recommended'), this.grid(Wave.upNext.slice(0, 6)));
        if (this.local.length) out += this.section(t('sec_local'), this.grid(this.local.slice(0, 12)));

        if (!Store.hasTaste() && !this.local.length) {
          out += this.empty(t('empty_wave_title'), t('empty_wave_text'), { route: 'search', label: t('discover') });
        }
        return out;
      },

      search: function () {
        var state = this.search;
        var out = '<header class="view-head"><h1>' + h(t('nav_search')) + '</h1></header>' +
          '<div class="searchbar">' +
            '<span class="searchbar__icon">' + this.icon('search') + '</span>' +
            '<input id="search-input" type="search" autocomplete="off" spellcheck="false" ' +
              'placeholder="' + h(t('search_ph')) + '" value="' + h(state.query) + '" aria-label="' + h(t('nav_search')) + '">' +
            '<button class="searchbar__clear" data-action="search-clear" aria-label="' + h(t('cancel')) + '"' + (state.query ? '' : ' hidden') + '>' + this.icon('close') + '</button>' +
          '</div>' +
          '<div class="filters">' +
            ['relevance', 'viewCount', 'date'].map(function (order) {
              var label = order === 'relevance' ? t('order_relevance') : (order === 'viewCount' ? t('order_views') : t('order_date'));
              return '<button class="chip' + (state.order === order ? ' is-on' : '') + '" data-action="order" data-order="' + order + '">' + h(label) + '</button>';
            }).join('') +
          '</div>';

        if (Api.available === false) {
          out += this.errorBox('no_key');
          return out;
        }
        if (state.error) { out += this.errorBox(state.error); return out; }
        if (state.loading && !state.items.length) return out + this.skeletons(8);
        if (!state.query) {
          out += '<div class="hint">' + h(t('search_hint')) + '</div>';
          if (this.local.length) out += this.section(t('sec_local'), this.grid(this.local.slice(0, 12)));
          return out;
        }
        if (!state.items.length) return out + this.empty(t('empty_search_title'), t('empty_search_text'));

        out += '<p class="results-note">' + h(t('search_results', { q: state.query })) + '</p>';
        out += this.grid(this.reg(state.items));
        if (state.loading) out += this.skeletons(4);
        else if (state.token) out += '<div class="more"><button class="btn" data-action="more">' + h(t('load_more')) + '</button></div>';
        return out;
      },

      wave: function () {
        var track = Player.context === 'wave' ? Player.track : null;
        if (!Wave.hasSignals() && !track) {
          return '<header class="view-head"><h1>' + h(t('sec_wave')) + '</h1></header>' +
            this.empty(t('empty_wave_title'), t('empty_wave_text'), { route: 'search', label: t('discover') });
        }

        var reason = Wave.reasonFor(track);
        var reasonText = !reason ? '' :
          reason.type === 'artist' ? t('wave_reason_artist', { a: reason.artist }) :
          reason.type === 'library' ? t('wave_reason_library') : t('wave_reason_discover');

        var out = '<section class="wave' + (Player.playing && track ? ' is-live' : '') + '">' +
          '<div class="wave__bars" aria-hidden="true">' + Array.from({ length: 18 }).map(function (_, i) {
            return '<i style="--i:' + i + '"></i>';
          }).join('') + '</div>' +
          '<div class="wave__inner">' +
            '<p class="wave__eyebrow">' + h(t('sec_wave')) + '</p>' +
            '<h1>' + h(t('wave_title')) + '</h1>' +
            '<p class="wave__sub">' + h(t('wave_sub')) + '</p>';

        if (track) {
          out += '<div class="wave__now">' +
            '<img class="wave__art" src="' + h(track.artwork || 'placeholder.svg') + '" alt="" onerror="this.src=\'placeholder.svg\'">' +
            '<div class="wave__meta">' +
              (reasonText ? '<p class="wave__reason">' + h(reasonText) + '</p>' : '') +
              '<h2>' + h(track.title) + '</h2>' +
              '<p class="wave__artist">' + h(track.artist) + '</p>' +
              '<div class="wave__controls">' +
                '<button class="btn btn--primary" data-action="wave-toggle">' + this.icon(Player.playing ? 'pause' : 'play') + ' ' + h(Player.playing ? t('pause') : t('play')) + '</button>' +
                '<button class="btn" data-action="wave-next">' + this.icon('next') + ' ' + h(t('wave_skip')) + '</button>' +
                '<button class="chip-btn' + (Store.isFavorite(track.id) ? ' is-on' : '') + '" data-action="fav" data-id="' + h(track.id) + '" aria-label="' + h(t('fav_off')) + '">' + this.icon(Store.isFavorite(track.id) ? 'heart-on' : 'heart') + '</button>' +
                '<button class="chip-btn' + (Store.inCollection(track.id) ? ' is-on' : '') + '" data-action="add" data-id="' + h(track.id) + '" aria-label="' + h(t('add')) + '">' + this.icon(Store.inCollection(track.id) ? 'check' : 'plus') + '</button>' +
                '<button class="chip-btn" data-action="wave-block" aria-label="' + h(t('wave_block')) + '" title="' + h(t('wave_block')) + '">' + this.icon('block') + '</button>' +
              '</div>' +
            '</div>' +
          '</div>';
        } else {
          out += '<div class="wave__start"><button class="btn btn--primary btn--big" data-action="wave-start">' +
            this.icon('play') + ' ' + h(t('wave_start')) + '</button></div>';
        }

        out += '</div></section>';

        if (Wave.loading && !Wave.upNext.length) out += '<p class="results-note">' + h(t('wave_building')) + '</p>';
        if (Wave.upNext.length) out += this.section(t('up_next'), this.list(Wave.upNext.slice(0, 6)));
        return out;
      },

      collection: function () {
        var out = '<header class="view-head"><h1>' + h(t('nav_collection')) + '</h1></header>';
        if (!Store.collection.length && !this.local.length) {
          return out + this.empty(t('empty_collection_title'), t('empty_collection_text'), { route: 'search', label: t('discover') });
        }
        if (Store.collection.length) out += this.section(t('sec_collection'), this.list(this.reg(Store.collection), { removable: true }));
        if (this.local.length) out += this.section(t('sec_local'), this.list(this.local));
        return out;
      },

      favorites: function () {
        var out = '<header class="view-head"><h1>' + h(t('nav_favorites')) + '</h1></header>';
        if (!Store.favorites.length) return out + this.empty(t('empty_fav_title'), t('empty_fav_text'), { route: 'search', label: t('discover') });
        return out + this.grid(this.reg(Store.favorites));
      },

      recent: function () {
        var out = '<header class="view-head"><h1>' + h(t('nav_recent')) + '</h1>' +
          (Store.recent.length ? '<button class="link-btn" data-action="clear-recent">' + h(t('clear_recent')) + '</button>' : '') +
          '</header>';
        if (!Store.recent.length) return out + this.empty(t('empty_recent_title'), t('empty_recent_text'), { route: 'search', label: t('discover') });
        return out + this.list(this.reg(Store.recent));
      }
    },

    errorBox: function (reason) {
      var key = { no_key: 'err_no_key', quota: 'err_quota', network: 'err_network', bad_key: 'err_bad_key' }[reason] || 'err_generic';
      return '<div class="notice">' + this.icon('alert') + '<p>' + h(t(key)) + '</p>' +
        (reason === 'no_key' ? '' : '<button class="btn" data-action="retry">' + h(t('retry')) + '</button>') + '</div>';
    },

    /* -------------------------------------------------------------- search */

    runSearch: function (reset) {
      var state = this.search;
      if (!state.query) { state.items = []; state.token = ''; this.renderView(); return; }
      if (this.searchAbort) this.searchAbort.abort();
      this.searchAbort = new AbortController();

      if (reset) { state.items = []; state.token = ''; }
      state.loading = true;
      state.error = null;
      this.renderView();

      Api.search(state.query, { pageToken: state.token, order: state.order, signal: this.searchAbort.signal })
        .then(function (payload) {
          var tracks = (payload.items || []).map(Api.toTrack);
          state.items = state.items.concat(tracks.filter(function (track) {
            return !state.items.some(function (existing) { return existing.id === track.id; });
          }));
          state.token = payload.nextPageToken || '';
          state.loading = false;
          App.renderView();
        })
        .catch(function (error) {
          if (error.name === 'AbortError') return;
          state.loading = false;
          state.error = error.reason || 'generic';
          App.renderView();
        });
    },

    /* -------------------------------------------------------------- wave */

    waveStart: function () {
      Player.context = 'wave';
      Wave.start().then(function (track) {
        if (!track) { App.toast(t('err_generic')); return; }
        Player.play(track, { queue: [track], index: 0, context: 'wave' });
        App.renderView();
      });
    },

    waveNext: function (auto, fromEnded) {
      Wave.next().then(function (track) {
        if (!track) { App.toast(t('err_generic')); return; }
        Player.play(track, { queue: [track], index: 0, context: 'wave' });
        if (App.route === 'wave') App.renderView();
      });
    },

    waveBlock: function () {
      var track = Player.track;
      if (!track) return;
      this.toast(t('t_skipped'));
      Wave.skip(track).then(function (next) {
        if (next) Player.play(next, { queue: [next], index: 0, context: 'wave' });
        if (App.route === 'wave') App.renderView();
      });
    },

    /* ------------------------------------------------------------ actions */

    trackById: function (id) { return this.registry.get(id); },

    action: function (name, element) {
      var id = element ? element.dataset.id : null;
      var track = id ? this.trackById(id) : null;

      switch (name) {
        case 'play':
          if (!track) return;
          if (Player.track && Player.track.id === track.id) { Player.toggle(); return; }
          this.playFromContext(track);
          return;

        case 'add':
          if (!track) return;
          if (Store.inCollection(track.id)) { this.toast(t('t_exists')); return; }
          Store.addToCollection(track);
          this.toast(t('t_added'));
          return;

        case 'remove':
          if (!track) return;
          Store.removeFromCollection(track.id);
          this.toast(t('t_removed'));
          return;

        case 'fav':
          if (!track) return;
          this.toast(Store.toggleFavorite(track) ? t('t_fav_on') : t('t_fav_off'));
          return;

        case 'goto': this.go(element.dataset.route); return;
        case 'order':
          this.search.order = element.dataset.order;
          this.runSearch(true);
          return;
        case 'more': this.runSearch(false); return;
        case 'retry': this.runSearch(true); return;
        case 'search-clear':
          this.search.query = '';
          this.search.items = [];
          this.renderView();
          var input = $('#search-input');
          if (input) input.focus();
          return;
        case 'clear-recent': Store.clearRecent(); this.toast(t('t_cleared')); return;

        case 'wave-start': this.waveStart(); return;
        case 'wave-next': this.waveNext(false); return;
        case 'wave-toggle': Player.toggle(); return;
        case 'wave-block': this.waveBlock(); return;

        case 'player-toggle': Player.toggle(); return;
        case 'player-next': Player.next(false); return;
        case 'player-prev': Player.prev(); return;
        case 'player-mute': Player.toggleMute(); return;
        case 'np-open': this.openNp(true); return;
        case 'np-close': this.openNp(false); return;
        case 'settings': this.openModal('settings'); return;
        case 'admin': this.openAdmin(); return;
        default: return;
      }
    },

    /** Playing from a view also builds the queue from what is visible there. */
    playFromContext: function (track) {
      var pool = [];
      if (this.route === 'search') pool = this.search.items;
      else if (this.route === 'collection') pool = Store.collection.concat(this.local);
      else if (this.route === 'favorites') pool = Store.favorites;
      else if (this.route === 'recent') pool = Store.recent;
      else if (this.route === 'wave') pool = [track].concat(Wave.upNext);
      else pool = Store.recent.concat(Store.favorites, Store.collection, this.local);

      var unique = [];
      pool.concat([track]).forEach(function (item) {
        if (item && !unique.some(function (u) { return u.id === item.id; })) unique.push(item);
      });
      var index = unique.findIndex(function (item) { return item.id === track.id; });
      Player.play(track, { queue: unique, index: index, context: this.route === 'wave' ? 'wave' : 'list' });
    },

    /* ----------------------------------------------------------- player UI */

    onPlayerEvent: function (what) {
      if (what === 'track') {
        this.syncPlayerUI();
        this.syncCards();
        if (this.route === 'wave') this.renderView();
      } else if (what === 'time') {
        this.syncProgress();
      } else if (what === 'sleep') {
        this.syncPlayerUI();
      } else {
        this.syncPlayerUI();
        if (this.route === 'wave') this.renderView();
      }
    },

    syncPlayerUI: function () {
      var track = Player.track;
      document.body.classList.toggle('has-track', !!track);
      document.body.classList.toggle('is-playing', Player.playing);
      document.body.classList.toggle('is-loading', Player.loading);
      document.body.classList.toggle('is-youtube', !!track && track.source === 'youtube');
      document.body.classList.toggle('is-muted', Player.muted);

      if (!track) return;
      $('#bar-title').textContent = track.title;
      $('#bar-artist').textContent = track.artist;
      $('#bar-img').src = track.artwork || 'placeholder.svg';
      $('#np-title').textContent = track.title;
      $('#np-artist').textContent = track.artist;
      $('#np-img').src = track.artwork || 'placeholder.svg';

      var fav = Store.isFavorite(track.id);
      $$('[data-action="fav"][data-player]').forEach(function (button) {
        button.classList.toggle('is-on', fav);
        button.dataset.id = track.id;
        button.innerHTML = App.icon(fav ? 'heart-on' : 'heart');
      });
      var inCollection = Store.inCollection(track.id);
      $$('[data-action="add"][data-player]').forEach(function (button) {
        button.classList.toggle('is-on', inCollection);
        button.dataset.id = track.id;
        button.innerHTML = App.icon(inCollection ? 'check' : 'plus');
      });

      $('#volume').value = Math.round((Player.muted ? 0 : Player.volume) * 100);
      this.syncProgress();
      this.positionYouTube();
      this.renderQueue();
    },

    syncProgress: function () {
      var duration = Player.duration || 0;
      var fraction = duration ? Player.position / duration : 0;
      $('#bar-progress').style.setProperty('--p', (fraction * 100).toFixed(2));
      $('#np-progress').style.setProperty('--p', (fraction * 100).toFixed(2));
      $('#bar-now').textContent = fmtTime(Player.position);
      $('#bar-total').textContent = fmtTime(duration);
      $('#np-now').textContent = fmtTime(Player.position);
      $('#np-total').textContent = fmtTime(duration);
    },

    syncCards: function () {
      var current = Player.track ? Player.track.id : null;
      $$('.card, .row').forEach(function (node) {
        node.classList.toggle('is-current', node.dataset.id === current);
      });
    },

    renderQueue: function () {
      var box = $('#queue-list');
      if (!box) return;
      var items = Player.context === 'wave' ? Wave.upNext : Player.queue.slice(Player.index + 1);
      box.innerHTML = items.length
        ? items.slice(0, 20).map(function (track) {
            return '<li class="qrow" data-action="play" data-id="' + h(track.id) + '">' +
              '<img src="' + h(track.artwork || 'placeholder.svg') + '" alt="" onerror="this.src=\'placeholder.svg\'">' +
              '<span><b>' + h(track.title) + '</b><i>' + h(track.artist) + '</i></span></li>';
          }).join('')
        : '<li class="qrow qrow--empty">' + h(t('empty_recent_text')) + '</li>';
      items.forEach(function (track) { App.registry.set(track.id, track); });
    },

    playerError: function (reason) {
      if (reason === 'embed_blocked') this.toast(t('err_embed'));
      else if (reason === 'local_file') this.toast(t('err_local'));
      else if (reason === 'yt_api') { this.toast(t('err_network')); return; }
      else this.toast(t('err_video'));
      // an unplayable video should not stop the stream, a broken local file should not loop
      if (reason === 'video' || reason === 'embed_blocked') {
        setTimeout(function () { Player.next(true); }, 1500);
      }
    },

    openNp: function (open) {
      this.npOpen = open;
      document.body.classList.toggle('np-open', open);
      this.positionYouTube();
      if (open) this.renderQueue();
    },

    /** Keeps the YouTube iframe alive while it visually docks into the UI. */
    positionYouTube: function () {
      var host = $('#yt-host');
      var track = Player.track;
      if (!track || track.source !== 'youtube') {
        host.classList.remove('is-live');
        return;
      }
      host.classList.add('is-live');
      var target = this.npOpen ? $('#np-art') : $('#bar-art');
      if (!target) return;
      var rect = target.getBoundingClientRect();
      host.style.left = rect.left + 'px';
      host.style.top = rect.top + 'px';
      host.style.width = rect.width + 'px';
      host.style.height = rect.height + 'px';
      host.style.borderRadius = (this.npOpen ? 22 : 10) + 'px';
    },

    /* ------------------------------------------------------ modals, admin */

    openModal: function (name) {
      if (name === 'settings') this.renderSettings();
      var dialog = $('#modal-' + name);
      if (dialog && !dialog.open) dialog.showModal();
    },

    renderSettings: function () {
      var eq = Store.prefs.eq;
      $('#settings-body').innerHTML =
        '<div class="setting"><span>' + h(t('lang')) + '</span>' +
          '<div class="segmented">' + ['hy', 'en', 'ru'].map(function (lang) {
            return '<button data-action="lang" data-lang="' + lang + '" class="' + (Store.prefs.lang === lang ? 'is-on' : '') + '">' +
              (lang === 'hy' ? 'ՀԱՅ' : lang.toUpperCase()) + '</button>';
          }).join('') + '</div></div>' +
        '<div class="setting"><span>' + h(t('theme')) + '</span>' +
          '<div class="segmented">' +
            '<button data-action="theme" data-theme="night" class="' + (Store.prefs.theme === 'night' ? 'is-on' : '') + '">' + h(t('theme_night')) + '</button>' +
            '<button data-action="theme" data-theme="day" class="' + (Store.prefs.theme === 'day' ? 'is-on' : '') + '">' + h(t('theme_day')) + '</button>' +
          '</div></div>' +
        '<div class="setting setting--col"><span>' + h(t('eq_title')) + '</span>' +
          ['bass', 'mid', 'treble'].map(function (band) {
            var label = band === 'bass' ? t('eq_low') : (band === 'mid' ? t('eq_mid') : t('eq_high'));
            return '<label class="slider"><i>' + h(label) + '</i>' +
              '<input type="range" min="-10" max="10" step="1" value="' + eq[band] + '" data-eq="' + band + '">' +
              '<b>' + (eq[band] > 0 ? '+' : '') + eq[band] + '</b></label>';
          }).join('') +
          '<label class="check"><input type="checkbox" data-eq="loud"' + (eq.loud ? ' checked' : '') + '><span>' + h(t('eq_loud')) + '</span></label>' +
        '</div>' +
        '<div class="setting setting--col"><span>' + h(t('sleep')) + '</span>' +
          '<div class="chips">' + [['0', t('sleep_off')], ['15', t('sleep_min', { n: 15 })], ['30', t('sleep_min', { n: 30 })], ['60', t('sleep_min', { n: 60 })], ['end', t('sleep_end')]]
            .map(function (pair) { return '<button class="chip" data-action="sleep" data-value="' + pair[0] + '">' + h(pair[1]) + '</button>'; }).join('') +
          '</div></div>' +
        '<button class="btn btn--ghost" data-action="admin">' + h(t('admin')) + '</button>';
    },

    openAdmin: function () {
      $('#modal-settings').close();
      if (!this.isAdmin) { $('#login-error').hidden = true; $('#modal-login').showModal(); return; }
      this.renderAdmin();
      $('#modal-admin').showModal();
    },

    renderAdmin: function () {
      $('#admin-list').innerHTML = this.local.map(function (track) {
        return '<div class="arow" data-id="' + h(track.id) + '">' +
          '<img src="' + h(track.artwork || 'placeholder.svg') + '" alt="" onerror="this.src=\'placeholder.svg\'">' +
          '<span class="arow__fields">' +
            '<input value="' + h(track.title) + '" data-field="title">' +
            '<input value="' + h(track.artist) + '" data-field="artist">' +
          '</span>' +
          '<button class="chip-btn" data-admin-del="' + h(track.id) + '" aria-label="' + h(t('remove')) + '">' + App.icon('trash') + '</button>' +
        '</div>';
      }).join('');
      var restore = $('#admin-restore');
      restore.hidden = Store.hiddenLocal.size === 0;
      restore.textContent = t('admin_restore', { n: Store.hiddenLocal.size });
    },

    addUploads: function (files) {
      var list = Array.prototype.filter.call(files, function (file) {
        return /^audio\//.test(file.type) || /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i.test(file.name);
      });
      if (!list.length) return;

      var jobs = list.map(function (file) {
        var id = file.name + ':' + file.size;
        var url = URL.createObjectURL(file);
        return new Promise(function (resolve) {
          var probe = new Audio();
          probe.preload = 'metadata';
          var done = function (duration) { resolve({ file: file, id: id, url: url, duration: duration }); };
          probe.onloadedmetadata = function () { done(isFinite(probe.duration) ? probe.duration : 0); };
          probe.onerror = function () { done(0); };
          setTimeout(function () { done(0); }, 4000);
          probe.src = url;
        }).then(function (info) {
          var base = file.name.replace(/\.[a-z0-9]+$/i, '').replace(/_+/g, ' ');
          var parts = base.split(/\s+-\s+/);
          var record = {
            id: info.id, name: file.name, blob: file,
            title: parts.length > 1 ? parts.slice(1).join(' - ') : base,
            artist: parts.length > 1 ? parts[0] : 'Unknown',
            duration: info.duration, addedAt: Date.now()
          };
          return Store.db.put(record).catch(function () {}).then(function () { return record; });
        });
      });

      Promise.all(jobs).then(function () {
        App.loadLocal().then(function () {
          Wave.init(App.local);
          App.renderAdmin();
          App.refreshCurrentView();
          App.toast(t('t_added'));
        });
      });
    },

    /* --------------------------------------------------------- theme, lang */

    applyTheme: function (theme) {
      Store.prefs.theme = theme;
      Store.savePrefs();
      document.documentElement.dataset.theme = theme;
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = theme === 'day' ? '#f3f4f7' : '#07070b';
    },

    applyLang: function (lang, silent) {
      Store.prefs.lang = lang;
      Store.savePrefs();
      document.documentElement.lang = lang;
      $$('[data-i18n]').forEach(function (node) { node.textContent = t(node.dataset.i18n); });
      $$('[data-i18n-aria]').forEach(function (node) { node.setAttribute('aria-label', t(node.dataset.i18nAria)); });
      if (!silent) { this.renderView(); this.renderSettings(); }
    },

    toast: function (message) {
      var node = $('#toast');
      node.textContent = message;
      node.classList.add('is-on');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(function () { node.classList.remove('is-on'); }, 2600);
    },

    /* ---------------------------------------------------------------- bind */

    bind: function () {
      document.addEventListener('click', function (event) {
        var target = event.target.closest('[data-action]');
        if (!target) return;
        var name = target.dataset.action;

        if (name === 'lang') { App.applyLang(target.dataset.lang); return; }
        if (name === 'theme') { App.applyTheme(target.dataset.theme); App.renderSettings(); return; }
        if (name === 'sleep') {
          Player.setSleep(target.dataset.value);
          $$('[data-action="sleep"]').forEach(function (chip) { chip.classList.toggle('is-on', chip === target && target.dataset.value !== '0'); });
          return;
        }
        event.preventDefault();
        App.action(name, target);
      });

      $('#view').addEventListener('input', function (event) {
        if (event.target.id !== 'search-input') return;
        var value = event.target.value;
        $('.searchbar__clear').hidden = !value;
        clearTimeout(App.searchTimer);
        App.searchTimer = setTimeout(function () {
          App.search.query = value.trim();
          App.runSearch(true);
        }, 420);
      });

      window.addEventListener('resize', function () { App.positionYouTube(); });
      window.addEventListener('hashchange', function () {
        var route = location.hash.replace('#', '');
        if (route && route !== App.route) App.go(route);
      });

      $('#nav-toggle').addEventListener('click', function () { document.body.classList.toggle('nav-open'); });

      ['#bar-progress', '#np-progress'].forEach(function (selector) {
        var bar = $(selector);
        var seek = function (event) {
          var rect = bar.getBoundingClientRect();
          var point = (event.touches ? event.touches[0].clientX : event.clientX) - rect.left;
          Player.seekFraction(point / rect.width);
        };
        bar.addEventListener('click', seek);
      });

      $('#volume').addEventListener('input', function () { Player.setVolume(this.value / 100); });

      $('#modal-settings').addEventListener('input', function (event) {
        var band = event.target.dataset.eq;
        if (!band) return;
        Store.prefs.eq[band] = band === 'loud' ? event.target.checked : Number(event.target.value);
        Store.savePrefs();
        Player.applyEq();
        App.renderSettings();
      });

      $$('[data-close]').forEach(function (button) {
        button.addEventListener('click', function () { button.closest('dialog').close(); });
      });

      $('#login-submit').addEventListener('click', function () {
        var user = $('#login-user').value.trim();
        var pass = $('#login-pass').value;
        if (hashCode(user + '::' + pass) === ADMIN_HASH) {
          App.isAdmin = true;
          localStorage.setItem('muzzz:admin', '1');
          $('#login-pass').value = '';
          $('#modal-login').close();
          App.openAdmin();
        } else {
          $('#login-error').hidden = false;
        }
      });
      $('#login-pass').addEventListener('keydown', function (event) { if (event.key === 'Enter') $('#login-submit').click(); });

      $('#admin-logout').addEventListener('click', function () {
        App.isAdmin = false;
        localStorage.removeItem('muzzz:admin');
        $('#modal-admin').close();
      });
      $('#admin-add').addEventListener('click', function () { $('#admin-files').click(); });
      $('#admin-files').addEventListener('change', function () { App.addUploads(this.files); this.value = ''; });
      $('#admin-restore').addEventListener('click', function () {
        Store.restoreLocal();
        App.loadLocal().then(function () { Wave.init(App.local); App.renderAdmin(); App.refreshCurrentView(); });
      });
      $('#admin-list').addEventListener('click', function (event) {
        var button = event.target.closest('[data-admin-del]');
        if (!button) return;
        Store.hideLocal(button.dataset.adminDel);
        App.loadLocal().then(function () { Wave.init(App.local); App.renderAdmin(); App.refreshCurrentView(); });
      });
      $('#admin-list').addEventListener('change', function (event) {
        var input = event.target.closest('input[data-field]');
        if (!input) return;
        var id = input.closest('.arow').dataset.id;
        Store.setOverride(id, input.dataset.field, input.value.trim());
        App.loadLocal().then(function () { Wave.init(App.local); App.refreshCurrentView(); });
      });

      document.addEventListener('keydown', function (event) {
        var tag = (event.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || document.querySelector('dialog[open]')) {
          if (event.key === 'Escape') event.target.blur();
          return;
        }
        if (event.key === ' ') { event.preventDefault(); Player.toggle(); }
        if (event.key === 'ArrowRight' && event.shiftKey) Player.next(false);
        if (event.key === 'ArrowLeft' && event.shiftKey) Player.prev();
        if (event.key === 'Escape' && App.npOpen) App.openNp(false);
        if (event.key === '/') { event.preventDefault(); App.go('search'); setTimeout(function () { var i = $('#search-input'); if (i) i.focus(); }, 60); }
      });
    }
  };

  window.App = App;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { App.init(); });
  else App.init();
})();
