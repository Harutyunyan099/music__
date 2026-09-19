/* muzzz — application shell: routing, views, search, player UI, playlists, admin.

   Rendering rule of this file: a full view is built only when the route changes or
   when the list the route displays actually changed. Everything else (favourite
   toggles, play state, progress) patches the exact nodes that changed. */
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

  function escapeId(id) {
    return (window.CSS && CSS.escape) ? CSS.escape(id) : String(id).replace(/["\\]/g, '\\$&');
  }

  var ADMIN_HASH = 'jrv83x';            // Narek :: harutyunyan2009

  /* Artwork fallback as a data URI: it can never 404, so no broken image ever shows. */
  var PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#2a2140"/><stop offset="1" stop-color="#3a1f36"/>' +
    '</linearGradient></defs><rect width="64" height="64" fill="url(#g)"/>' +
    '<path d="M25 44V22l16-3.4v18.6" fill="none" stroke="#a9a6c4" stroke-width="2.6" stroke-linecap="round"/>' +
    '<ellipse cx="22" cy="44.5" rx="4.6" ry="3.8" fill="#a9a6c4"/>' +
    '<ellipse cx="38" cy="41" rx="4.6" ry="3.8" fill="#a9a6c4"/></svg>');

  var App = {
    route: 'home',
    routeParam: '',
    local: [],
    localUrls: [],                      // object URLs to revoke when the library reloads
    registry: new Map(),
    search: { query: '', order: 'relevance', items: [], token: '', loading: false, error: null },
    searchTimer: null,
    searchAbort: null,
    searchSeq: 0,
    npOpen: false,
    isAdmin: false,
    pendingPlaylistTrack: null,
    frame: { progress: false, render: false },

    /* ------------------------------------------------------------- setup */

    init: function () {
      try { this.isAdmin = !!localStorage.getItem('muzzz:admin'); } catch (e) { this.isAdmin = false; }

      this.applyTheme(Store.prefs.theme, true);
      this.applyLang(Store.prefs.lang, true);

      Player.init();
      Player.onEnded = function () { App.waveNext(); };
      Player.onError = function (reason) { App.playerError(reason); };
      Player.on(function (what) { App.onPlayerEvent(what); });
      Store.onChange(function (what, id) { App.onStoreEvent(what, id); });

      this.bind();
      this.fixBrokenImages();
      this.registerServiceWorker();
      this.syncModes();
      this.syncPlayState();

      this.loadLocal().then(function () {
        Wave.init(App.local);
        App.go(location.hash.replace('#', '') || 'home', { silent: true });
        App.restoreLastTrack();
      });

      Api.status().then(function () {
        if (App.route === 'search') App.renderResults();
      });
    },

    /* --------------------------------------------------- local library */

    loadLocal: function () {
      this.localUrls.forEach(function (url) { URL.revokeObjectURL(url); });
      this.localUrls = [];

      return fetch('songs.json', { cache: 'no-store' })
        .then(function (response) { return response.ok ? response.json() : { songs: [] }; })
        .catch(function () { return { songs: [] }; })
        .then(function (data) {
          var list = (Array.isArray(data.songs) ? data.songs : []).map(function (song) {
            return {
              id: 'local:' + song.id,
              source: 'local',
              title: song.title,
              artist: song.artist,
              artwork: song.cover || PLACEHOLDER,
              duration: song.duration || 0,
              src: song.src,
              genre: song.genre || ''
            };
          });

          return Store.db.all().catch(function () { return []; }).then(function (uploads) {
            (uploads || []).forEach(function (item) {
              var url = URL.createObjectURL(item.blob);
              App.localUrls.push(url);
              list.push({
                id: 'upload:' + item.id,
                source: 'local',
                title: item.title,
                artist: item.artist,
                artwork: PLACEHOLDER,
                duration: item.duration || 0,
                src: url,
                upload: true
              });
            });

            App.local = list
              .filter(function (track) { return !Store.hiddenLocal.has(track.id); })
              .map(function (track) {
                var over = Store.overrides[track.id];
                if (over) {
                  if (over.title) track.title = over.title;
                  if (over.artist) track.artist = over.artist;
                }
                App.registry.set(track.id, track);
                return track;
              });
          });
        })
        .catch(function () { App.local = []; });
    },

    /** Images that failed before the listener existed still get the fallback. */
    fixBrokenImages: function () {
      $$('img').forEach(function (img) {
        if (img.complete && img.naturalWidth === 0 && img.dataset.fallback !== '1') {
          img.dataset.fallback = '1';
          img.src = PLACEHOLDER;
        }
      });
    },

    /** The bar keeps the last played song after a reload — one tap resumes it. */
    restoreLastTrack: function () {
      if (Player.track || !Store.recent.length) return;
      var queue = this.reg(Store.recent.slice(0, 30)).map(function (item) {
        return App.registry.get(item.id) || item;      // fresh src for uploaded files
      });
      Player.prime(queue[0], queue, 0);
      this.syncTrackInfo();
      this.syncPlayState();
      this.markCurrent();
    },

    reg: function (tracks) {
      for (var i = 0; i < tracks.length; i++) this.registry.set(tracks[i].id, tracks[i]);
      return tracks;
    },

    trackById: function (id) { return this.registry.get(id); },

    /* ---------------------------------------------------- source resolver --

       A YouTube result can only play through the YouTube embed, and that embed is
       stopped by the platform in the background. But if the user already owns the
       same song as a file (songs.json or an upload), we can play THAT instead:
       same track in the UI, real <audio> underneath, real background playback.
       Nothing is faked — the substitution only happens on a confident match.      */

    normalizeName: function (value) {
      return String(value || '')
        .toLowerCase()
        .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')                     // (official video)
        .replace(/\b(official|lyrics?|audio|video|clip|hd|4k|mv|premiere)\b/g, ' ')
        .replace(/\s+feat\.?\s.*$/, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
    },

    artistTokens: function (value) {
      return this.normalizeName(value).split(' ').filter(function (token) { return token.length > 2; });
    },

    matchLocal: function (track) {
      if (!track || track.source !== 'youtube' || !this.local.length) return null;
      var title = this.normalizeName(track.title);
      if (title.length < 3) return null;
      var wanted = this.artistTokens(track.artist);
      var self = this;

      return this.local.filter(function (local) {
        var localTitle = self.normalizeName(local.title);
        if (!localTitle) return false;
        var sameTitle = localTitle === title ||
          (localTitle.length > 4 && title.indexOf(localTitle) !== -1) ||
          (title.length > 4 && localTitle.indexOf(title) !== -1);
        if (!sameTitle) return false;
        if (!wanted.length) return true;
        var mine = self.artistTokens(local.artist);
        return mine.some(function (token) { return wanted.indexOf(token) !== -1; });
      })[0] || null;
    },

    /** Every play goes through here, so the rule is applied everywhere. */
    resolve: function (track) {
      var local = this.matchLocal(track);
      if (!local) return track;
      if (!this.substituteNotice) {
        this.substituteNotice = true;
        this.toast(t('t_local_source'));
      }
      return local;
    },

    /* ----------------------------------------------------------- routing */

    go: function (route, options) {
      options = options || {};
      var parts = String(route || 'home').split('/');
      this.route = parts[0] || 'home';
      this.routeParam = parts[1] || '';

      if (!options.silent) location.hash = route;
      $$('.nav__item[data-route]').forEach(function (item) {
        var on = item.dataset.route === App.route;
        item.classList.toggle('is-active', on);
        item.setAttribute('aria-current', on ? 'page' : 'false');
      });
      document.body.classList.remove('nav-open');
      this.renderView();
      $('#view').scrollTop = 0;
    },

    /** Coalesces several data events in one frame into a single render. */
    rerender: function () {
      if (this.frame.render) return;
      this.frame.render = true;
      requestAnimationFrame(function () {
        App.frame.render = false;
        var view = $('#view');
        var top = view.scrollTop;
        App.renderView();
        view.scrollTop = top;              // a data change must not throw the user to the top
      });
    },

    renderView: function () {
      var view = $('#view');
      var builder = this.views[this.route] || this.views.home;
      try {
        view.innerHTML = builder.call(this);
      } catch (e) {
        view.innerHTML = this.errorBox('generic');
      }
      if (this.route === 'search') {
        var input = $('#search-input');
        if (input) input.value = this.search.query;
        this.renderResults();
      }
      this.markCurrent();
    },

    /* ------------------------------------------------------- components */

    card: function (track, options) {
      options = options || {};
      this.registry.set(track.id, track);
      var inCollection = Store.inCollection(track.id);
      var fav = Store.isFavorite(track.id);
      var current = Player.track && Player.track.id === track.id;

      return '<article class="card' + (current ? ' is-current' : '') + '" data-id="' + h(track.id) + '">' +
        '<div class="card__art">' +
          '<img src="' + h(track.artwork || PLACEHOLDER) + '" alt="" loading="lazy" decoding="async" ' +
            '>' +
          '<button class="card__play" data-action="play" data-id="' + h(track.id) + '" ' +
            'aria-label="' + h(t('play')) + ' — ' + h(track.title) + '">' + this.icon('play') + '</button>' +
          (track.duration ? '<span class="card__time">' + fmtTime(track.duration) + '</span>' : '') +
        '</div>' +
        '<div class="card__body">' +
          '<h3 class="card__title" title="' + h(track.title) + '">' + h(track.title) + '</h3>' +
          '<p class="card__artist">' + h(track.artist) + '</p>' +
        '</div>' +
        '<div class="card__actions">' +
          this.favButton(track, fav) +
          (options.removable
            ? this.plainButton('remove', track.id, 'trash', t('remove'))
            : this.addButton(track, inCollection)) +
          this.plainButton('menu', track.id, 'dots', t('more')) +
        '</div>' +
      '</article>';
    },

    row: function (track, options) {
      options = options || {};
      this.registry.set(track.id, track);
      var fav = Store.isFavorite(track.id);
      var inCollection = Store.inCollection(track.id);
      var current = Player.track && Player.track.id === track.id;

      return '<li class="row' + (current ? ' is-current' : '') + '" data-id="' + h(track.id) + '" ' +
          'data-action="play" tabindex="0" role="button" aria-label="' + h(track.title + ' — ' + track.artist) + '">' +
        '<span class="row__art"><img src="' + h(track.artwork || PLACEHOLDER) + '" alt="" loading="lazy" ' +
          'decoding="async">' +
          '<span class="row__play">' + this.icon('play') + '</span></span>' +
        '<span class="row__text"><span class="row__title">' + h(track.title) + '</span>' +
        '<span class="row__artist">' + h(track.artist) + '</span></span>' +
        '<span class="row__time">' + (track.duration ? fmtTime(track.duration) : '') + '</span>' +
        '<span class="row__actions">' +
          this.favButton(track, fav) +
          (options.removable
            ? this.plainButton(options.removeAction || 'remove', track.id, 'trash', t('remove'))
            : this.addButton(track, inCollection)) +
          this.plainButton('menu', track.id, 'dots', t('more')) +
        '</span>' +
      '</li>';
    },

    favButton: function (track, fav) {
      return '<button class="chip-btn' + (fav ? ' is-on' : '') + '" data-action="fav" data-id="' + h(track.id) + '" ' +
        'aria-pressed="' + (fav ? 'true' : 'false') + '" aria-label="' + h(fav ? t('fav_on') : t('fav_off')) + '">' +
        this.icon(fav ? 'heart-on' : 'heart') + '</button>';
    },

    addButton: function (track, inCollection) {
      return '<button class="chip-btn' + (inCollection ? ' is-on' : '') + '" data-action="add" data-id="' + h(track.id) + '" ' +
        'aria-pressed="' + (inCollection ? 'true' : 'false') + '" aria-label="' + h(inCollection ? t('added') : t('add')) + '">' +
        this.icon(inCollection ? 'check' : 'plus') + '</button>';
    },

    plainButton: function (action, id, icon, label) {
      return '<button class="chip-btn" data-action="' + action + '" data-id="' + h(id) + '" ' +
        'aria-label="' + h(label) + '">' + this.icon(icon) + '</button>';
    },

    section: function (title, body, options) {
      options = options || {};
      if (!body) return '';
      return '<section class="section">' +
        '<header class="section__head"><h2>' + h(title) + '</h2>' +
        (options.route ? '<button class="link-btn" data-action="goto" data-route="' + h(options.route) + '">' + h(t('see_all')) + '</button>' : '') +
        (options.extra || '') +
        '</header>' + body + '</section>';
    },

    grid: function (tracks, options) {
      if (!tracks.length) return '';
      var out = new Array(tracks.length);
      for (var i = 0; i < tracks.length; i++) out[i] = this.card(tracks[i], options);
      return '<div class="grid">' + out.join('') + '</div>';
    },

    list: function (tracks, options) {
      if (!tracks.length) return '';
      var out = new Array(tracks.length);
      for (var i = 0; i < tracks.length; i++) out[i] = this.row(tracks[i], options);
      return '<ol class="rows">' + out.join('') + '</ol>';
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
      for (var i = 0; i < count; i++) {
        out += '<div class="card card--skeleton" aria-hidden="true"><div class="sk sk--art"></div>' +
          '<div class="sk sk--line"></div><div class="sk sk--line sk--short"></div></div>';
      }
      return '<div class="grid">' + out + '</div>';
    },

    icon: function (name) {
      return '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
    },

    errorBox: function (reason) {
      var key = { no_key: 'err_no_key', quota: 'err_quota', network: 'err_network', bad_key: 'err_bad_key' }[reason] || 'err_generic';
      return '<div class="notice">' + this.icon('alert') + '<p>' + h(t(key)) + '</p>' +
        (reason === 'no_key' ? '' : '<button class="btn" data-action="retry">' + h(t('retry')) + '</button>') + '</div>';
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
        if (this.local.length) out += this.section(t('sec_local'), this.grid(this.local.slice(0, 12)), { route: 'collection' });

        if (!Store.hasTaste() && !this.local.length) {
          out += this.empty(t('empty_wave_title'), t('empty_wave_text'), { route: 'search', label: t('discover') });
        }
        return out;
      },

      search: function () {
        var state = this.search;
        return '<header class="view-head"><h1>' + h(t('nav_search')) + '</h1></header>' +
          '<div class="searchbar">' +
            '<span class="searchbar__icon">' + this.icon('search') + '</span>' +
            '<input id="search-input" type="search" autocomplete="off" spellcheck="false" enterkeyhint="search" ' +
              'placeholder="' + h(t('search_ph')) + '" value="' + h(state.query) + '" aria-label="' + h(t('nav_search')) + '">' +
            '<button class="searchbar__clear" data-action="search-clear" aria-label="' + h(t('cancel')) + '"' +
              (state.query ? '' : ' hidden') + '>' + this.icon('close') + '</button>' +
          '</div>' +
          '<div class="filters" role="group" aria-label="' + h(t('nav_search')) + '">' +
            ['relevance', 'viewCount', 'date'].map(function (order) {
              var label = order === 'relevance' ? t('order_relevance') : (order === 'viewCount' ? t('order_views') : t('order_date'));
              return '<button class="chip' + (state.order === order ? ' is-on' : '') + '" data-action="order" ' +
                'data-order="' + order + '" aria-pressed="' + (state.order === order) + '">' + h(label) + '</button>';
            }).join('') +
          '</div>' +
          '<div id="results" aria-live="polite"></div>';
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

        var bars = '';
        for (var i = 0; i < 18; i++) bars += '<i style="--i:' + i + '"></i>';

        var out = '<section class="wave' + (Player.playing && track ? ' is-live' : '') + '" id="wave-hero">' +
          '<div class="wave__bars" aria-hidden="true">' + bars + '</div>' +
          '<div class="wave__inner">' +
            '<p class="wave__eyebrow">' + h(t('sec_wave')) + '</p>' +
            '<h1>' + h(t('wave_title')) + '</h1>' +
            '<p class="wave__sub">' + h(t('wave_sub')) + '</p>';

        if (track) {
          out += '<div class="wave__now">' +
            '<img class="wave__art" src="' + h(track.artwork || PLACEHOLDER) + '" alt="" decoding="async" ' +
              '>' +
            '<div class="wave__meta">' +
              (reasonText ? '<p class="wave__reason">' + h(reasonText) + '</p>' : '') +
              '<h2>' + h(track.title) + '</h2>' +
              '<p class="wave__artist">' + h(track.artist) + '</p>' +
              '<div class="wave__controls">' +
                '<button class="btn btn--primary" data-action="player-toggle">' +
                  '<span class="only-play">' + this.icon('play') + ' ' + h(t('play')) + '</span>' +
                  '<span class="only-pause">' + this.icon('pause') + ' ' + h(t('pause')) + '</span>' +
                '</button>' +
                '<button class="btn" data-action="wave-next">' + this.icon('next') + ' ' + h(t('wave_skip')) + '</button>' +
                this.favButton(track, Store.isFavorite(track.id)) +
                this.addButton(track, Store.inCollection(track.id)) +
                '<button class="chip-btn" data-action="wave-block" aria-label="' + h(t('wave_block')) + '" ' +
                  'title="' + h(t('wave_block')) + '">' + this.icon('block') + '</button>' +
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
        var out = '<header class="view-head"><h1>' + h(t('nav_collection')) + '</h1>' +
          '<button class="btn btn--small" data-action="playlist-new">' + this.icon('plus') + ' ' + h(t('playlist_new')) + '</button>' +
          '</header>';

        if (Store.playlists.length) {
          out += this.section(t('playlists'), '<div class="plgrid">' + Store.playlists.map(function (playlist) {
            return '<button class="plcard" data-action="goto" data-route="playlist/' + h(playlist.id) + '">' +
              '<span class="plcard__icon">' + App.icon('queue') + '</span>' +
              '<span class="plcard__text"><b>' + h(playlist.name) + '</b>' +
              '<i>' + h(t('track_count', { n: playlist.tracks.length })) + '</i></span></button>';
          }).join('') + '</div>');
        }

        if (!Store.collection.length && !this.local.length && !Store.playlists.length) {
          return out + this.empty(t('empty_collection_title'), t('empty_collection_text'), { route: 'search', label: t('discover') });
        }
        if (Store.collection.length) out += this.section(t('sec_collection'), this.list(this.reg(Store.collection), { removable: true }));
        if (this.local.length) out += this.section(t('sec_local'), this.list(this.local));
        return out;
      },

      playlist: function () {
        var playlist = Store.playlist(this.routeParam);
        if (!playlist) return this.empty(t('empty_collection_title'), t('empty_collection_text'), { route: 'collection', label: t('nav_collection') });

        var out = '<header class="view-head view-head--playlist">' +
          '<div><p class="eyebrow">' + h(t('playlists')) + '</p><h1>' + h(playlist.name) + '</h1>' +
          '<p class="muted">' + h(t('track_count', { n: playlist.tracks.length })) + '</p></div>' +
          '<div class="head-actions">' +
            (playlist.tracks.length ? '<button class="btn btn--primary" data-action="playlist-play">' + this.icon('play') + ' ' + h(t('play')) + '</button>' : '') +
            '<button class="btn btn--small" data-action="playlist-rename">' + h(t('rename')) + '</button>' +
            '<button class="btn btn--small btn--ghost" data-action="playlist-delete">' + h(t('delete')) + '</button>' +
          '</div></header>';

        if (!playlist.tracks.length) {
          return out + this.empty(t('empty_playlist_title'), t('empty_playlist_text'), { route: 'search', label: t('discover') });
        }
        return out + this.list(this.reg(playlist.tracks), { removable: true, removeAction: 'playlist-remove' });
      },

      favorites: function () {
        var out = '<header class="view-head"><h1>' + h(t('nav_favorites')) + '</h1>' +
          (Store.favorites.length ? '<button class="link-btn" data-action="clear-favorites">' + h(t('clear_favorites')) + '</button>' : '') +
          '</header>';
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

    /* -------------------------------------------------------------- search */

    renderResults: function () {
      var box = $('#results');
      if (!box) return;
      var state = this.search;

      if (Api.available === false) { box.innerHTML = this.errorBox('no_key'); return; }
      if (state.error) { box.innerHTML = this.errorBox(state.error); return; }
      if (state.loading && !state.items.length) { box.innerHTML = this.skeletons(8); return; }

      if (!state.query) {
        box.innerHTML = '<div class="hint">' + h(t('search_hint')) + '</div>' +
          (this.local.length ? this.section(t('sec_local'), this.grid(this.local.slice(0, 12))) : '');
        this.markCurrent();
        return;
      }
      if (!state.items.length) {
        box.innerHTML = this.empty(t('empty_search_title'), t('empty_search_text'));
        return;
      }

      box.innerHTML = '<p class="results-note">' + h(t('search_results', { q: state.query })) + '</p>' +
        this.grid(this.reg(state.items)) +
        (state.loading ? this.skeletons(4)
          : (state.token ? '<div class="more"><button class="btn" data-action="more">' + h(t('load_more')) + '</button></div>' : ''));
      this.markCurrent();
    },

    runSearch: function (reset) {
      var state = this.search;
      if (!state.query) {
        state.items = []; state.token = ''; state.error = null; state.loading = false;
        this.renderResults();
        return;
      }
      if (this.searchAbort) this.searchAbort.abort();
      this.searchAbort = new AbortController();
      var seq = ++this.searchSeq;

      if (reset) { state.items = []; state.token = ''; }
      state.loading = true;
      state.error = null;
      this.renderResults();

      Api.search(state.query, { pageToken: state.token, order: state.order, signal: this.searchAbort.signal })
        .then(function (payload) {
          if (seq !== App.searchSeq) return;           // a newer query already won
          var tracks = (payload.items || []).map(Api.toTrack);
          var known = {};
          state.items.forEach(function (item) { known[item.id] = true; });
          state.items = state.items.concat(tracks.filter(function (track) {
            if (known[track.id]) return false;
            known[track.id] = true;
            return true;
          }));
          state.token = payload.nextPageToken || '';
          state.loading = false;
          App.renderResults();
        })
        .catch(function (error) {
          if (error.name === 'AbortError' || seq !== App.searchSeq) return;
          state.loading = false;
          state.error = error.reason || 'generic';
          App.renderResults();
        });
    },

    /* ---------------------------------------------------------------- wave */

    waveStart: function () {
      Player.context = 'wave';
      Wave.start().then(function (track) {
        if (!track) { App.toast(t('err_generic')); return; }
        Player.play(App.resolve(track), { queue: [track], index: 0, context: 'wave' });
        if (App.route === 'wave') App.rerender();
      });
    },

    waveNext: function () {
      Wave.next().then(function (track) {
        if (!track) { App.toast(t('err_generic')); return; }
        Player.play(App.resolve(track), { queue: [track], index: 0, context: 'wave' });
        if (App.route === 'wave') App.rerender();
      });
    },

    waveBlock: function () {
      var track = Player.track;
      if (!track) return;
      this.toast(t('t_skipped'));
      Wave.skip(track).then(function (next) {
        if (next) Player.play(App.resolve(next), { queue: [next], index: 0, context: 'wave' });
        if (App.route === 'wave') App.rerender();
      });
    },

    /* ------------------------------------------------------------ actions */

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
          if (Store.inCollection(track.id)) { Store.removeFromCollection(track.id); this.toast(t('t_removed')); }
          else { Store.addToCollection(track); this.toast(t('t_added')); }
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

        case 'playlist':
          if (!track) return;
          this.openPlaylistPicker(track);
          return;

        case 'menu':
          if (!track) return;
          this.openMenu(track);
          return;

        case 'menu-play':
          $('#modal-menu').close();
          if (this.menuTrack) this.playFromContext(this.menuTrack);
          return;

        case 'menu-queue': {
          if (!this.menuTrack) return;
          $('#modal-menu').close();
          this.addToQueue(this.menuTrack);
          return;
        }

        case 'menu-radio': {
          if (!this.menuTrack) return;
          $('#modal-menu').close();
          this.startRadio(this.menuTrack);
          return;
        }

        case 'menu-share': {
          if (!this.menuTrack) return;
          $('#modal-menu').close();
          this.shareTrack(this.menuTrack);
          return;
        }

        case 'menu-playlist':
          if (!this.menuTrack) return;
          $('#modal-menu').close();
          this.openPlaylistPicker(this.menuTrack);
          return;

        case 'playlist-new': {
          var name = prompt(t('playlist_name'), t('playlist_default'));
          if (name === null) return;
          var created = Store.createPlaylist(name);
          this.go('playlist/' + created.id);
          return;
        }

        case 'playlist-rename': {
          var playlist = Store.playlist(this.routeParam);
          if (!playlist) return;
          var newName = prompt(t('playlist_name'), playlist.name);
          if (newName === null) return;
          Store.renamePlaylist(playlist.id, newName);
          return;
        }

        case 'playlist-delete':
          if (!confirm(t('confirm_delete_playlist'))) return;
          Store.deletePlaylist(this.routeParam);
          this.go('collection');
          return;

        case 'playlist-remove':
          Store.removeFromPlaylist(this.routeParam, id);
          this.toast(t('t_removed'));
          return;

        case 'playlist-play': {
          var open = Store.playlist(this.routeParam);
          if (!open || !open.tracks.length) return;
          this.reg(open.tracks);
          Player.play(this.resolve(open.tracks[0]), { queue: open.tracks, index: 0, context: 'playlist' });
          return;
        }

        case 'playlist-pick': {
          var target = element.dataset.playlist;
          var pending = this.pendingPlaylistTrack;
          if (!target || !pending) return;
          if (Store.inPlaylist(target, pending.id)) {
            Store.removeFromPlaylist(target, pending.id);
            this.toast(t('t_removed'));
          } else {
            Store.addToPlaylist(target, pending);
            this.toast(t('t_added_playlist'));
          }
          this.renderPlaylistPicker();
          return;
        }

        case 'playlist-create-pick': {
          var freshName = prompt(t('playlist_name'), t('playlist_default'));
          if (freshName === null) return;
          var fresh = Store.createPlaylist(freshName);
          if (this.pendingPlaylistTrack) Store.addToPlaylist(fresh.id, this.pendingPlaylistTrack);
          this.renderPlaylistPicker();
          return;
        }

        case 'goto': this.go(element.dataset.route); return;
        case 'order':
          this.search.order = element.dataset.order;
          $$('[data-action="order"]').forEach(function (chip) {
            var on = chip === element;
            chip.classList.toggle('is-on', on);
            chip.setAttribute('aria-pressed', String(on));
          });
          this.runSearch(true);
          return;
        case 'more': this.runSearch(false); return;
        case 'retry': this.runSearch(true); return;
        case 'search-clear': {
          this.search.query = '';
          this.search.items = [];
          this.search.error = null;
          var input = $('#search-input');
          if (input) { input.value = ''; input.focus(); }
          var clear = $('.searchbar__clear');
          if (clear) clear.hidden = true;
          this.renderResults();
          return;
        }

        case 'clear-recent':
          if (!confirm(t('confirm_clear'))) return;
          Store.clearRecent();
          this.toast(t('t_cleared'));
          return;

        case 'clear-favorites':
          if (!confirm(t('confirm_clear'))) return;
          Store.clearFavorites();
          this.toast(t('t_cleared'));
          return;

        case 'reset-all':
          if (!confirm(t('confirm_reset'))) return;
          Store.resetAll();
          this.toast(t('t_cleared'));
          return;

        case 'wave-start': this.waveStart(); return;
        case 'wave-next': this.waveNext(); return;
        case 'wave-block': this.waveBlock(); return;

        case 'player-toggle': Player.toggle(); return;
        case 'player-next': Player.next(false); return;
        case 'player-prev': Player.prev(); return;
        case 'player-mute': Player.toggleMute(); return;
        case 'player-shuffle':
          Player.toggleShuffle();
          this.toast(Player.shuffle ? t('shuffle_on') : t('shuffle_off'));
          return;
        case 'player-repeat': {
          var mode = Player.cycleRepeat();
          this.toast(t('repeat_' + mode));
          return;
        }

        case 'np-open': this.openNp(true); return;
        case 'np-close': this.openNp(false); return;
        case 'add-my-files': $('#admin-files').click(); return;
        case 'settings': this.openModal('settings'); return;
        case 'admin': this.openAdmin(); return;
        default: return;
      }
    },

    /** Playing from a view also builds the queue from what is visible there. */
    playFromContext: function (track) {
      var pool;
      if (this.route === 'search') pool = this.search.items;
      else if (this.route === 'collection') pool = Store.collection.concat(this.local);
      else if (this.route === 'playlist') pool = (Store.playlist(this.routeParam) || { tracks: [] }).tracks;
      else if (this.route === 'favorites') pool = Store.favorites;
      else if (this.route === 'recent') pool = Store.recent;
      else if (this.route === 'wave') pool = [track].concat(Wave.upNext);
      else pool = Store.recent.concat(Store.favorites, Store.collection, this.local);

      var unique = [];
      var seen = {};
      pool.concat([track]).forEach(function (item) {
        if (item && !seen[item.id]) { seen[item.id] = true; unique.push(item); }
      });
      var index = unique.findIndex(function (item) { return item.id === track.id; });
      Player.play(this.resolve(track), { queue: unique, index: index, context: this.route === 'wave' ? 'wave' : 'list' });
    },

    /* ----------------------------------------------------------- player UI */

    onPlayerEvent: function (what) {
      if (document.hidden && (what === 'time' || what === 'state')) return;
      if (what === 'time') { this.scheduleProgress(); return; }

      if (what === 'track') {
        this.extendRadio();
        if (Player.track && Player.track.source === 'youtube' &&
            window.matchMedia('(max-width: 720px)').matches && !this.npOpen) {
          this.openNp(true);            // the video belongs in the main player, not in a list
        }
        if (Player.track && Player.track.source === 'youtube' && !this.ytNoticeShown) {
          this.ytNoticeShown = true;
          this.toast(t('yt_bg_note'));
        }
        this.syncTrackInfo();
        this.syncPlayState();
        this.markCurrent();
        this.positionYouTube();
        if (this.npOpen) this.renderQueue();
        if (this.route === 'wave') this.rerender();
        return;
      }
      if (what === 'mode') { this.syncModes(); return; }
      if (what === 'volume') { this.syncVolume(); return; }
      if (what === 'sleep') { return; }
      if (what === 'queue') { if (this.npOpen) this.renderQueue(); return; }

      // 'state' — play / pause / buffering: only classes change
      this.syncPlayState();
      var wave = $('#wave-hero');
      if (wave) wave.classList.toggle('is-live', Player.playing);
    },

    onStoreEvent: function (what, id) {
      if (what === 'favorites' || what === 'collection') {
        this.patchTrack(id);
        this.syncPlayerButtons();
        var affected = (what === 'favorites' && this.route === 'favorites') ||
                       (what === 'collection' && this.route === 'collection') ||
                       this.route === 'home';
        if (affected) this.rerender();
        return;
      }
      if (what === 'recent') {
        if (this.route === 'recent' || this.route === 'home') this.rerender();
        return;
      }
      if (what === 'playlists') {
        if (this.route === 'collection' || this.route === 'playlist') this.rerender();
        return;
      }
      if (what === 'reset') { this.rerender(); this.syncPlayerButtons(); }
    },

    /** Updates only the buttons of one track, wherever it is on screen. */
    patchTrack: function (id) {
      if (!id) return;
      var track = this.trackById(id);
      if (!track) return;
      var selector = '[data-id="' + escapeId(id) + '"]';
      var fav = Store.isFavorite(id);
      var inCollection = Store.inCollection(id);

      $$('[data-action="fav"]' + selector).forEach(function (button) {
        button.classList.toggle('is-on', fav);
        button.setAttribute('aria-pressed', String(fav));
        button.setAttribute('aria-label', fav ? t('fav_on') : t('fav_off'));
        button.innerHTML = App.icon(fav ? 'heart-on' : 'heart');
      });
      $$('[data-action="add"]' + selector).forEach(function (button) {
        button.classList.toggle('is-on', inCollection);
        button.setAttribute('aria-pressed', String(inCollection));
        button.setAttribute('aria-label', inCollection ? t('added') : t('add'));
        button.innerHTML = App.icon(inCollection ? 'check' : 'plus');
      });
    },

    markCurrent: function () {
      var id = Player.track ? Player.track.id : null;
      $$('.card.is-current, .row.is-current').forEach(function (node) {
        if (node.dataset.id !== id) node.classList.remove('is-current');
      });
      if (!id) return;
      $$('.card[data-id="' + escapeId(id) + '"], .row[data-id="' + escapeId(id) + '"]').forEach(function (node) {
        node.classList.add('is-current');
      });
    },

    syncTrackInfo: function () {
      var track = Player.track;
      if (!track) return;
      $('#bar-title').textContent = track.title;
      $('#bar-artist').textContent = track.artist;
      var barImg = $('#bar-img');
      var artwork = track.artwork || PLACEHOLDER;
      if (barImg.getAttribute('src') !== artwork) barImg.src = artwork;
      $('#np-title').textContent = track.title;
      $('#np-artist').textContent = track.artist;
      var npImg = $('#np-img');
      if (npImg.getAttribute('src') !== artwork) npImg.src = artwork;
      document.title = track.title + ' — muzzz';
      this.syncPlayerButtons();
      this.scheduleProgress(true);
    },

    syncPlayerButtons: function () {
      var track = Player.track;
      if (!track) return;
      var fav = Store.isFavorite(track.id);
      var inCollection = Store.inCollection(track.id);
      $$('[data-player="1"][data-action="fav"]').forEach(function (button) {
        button.dataset.id = track.id;
        button.classList.toggle('is-on', fav);
        button.setAttribute('aria-pressed', String(fav));
        button.innerHTML = App.icon(fav ? 'heart-on' : 'heart');
      });
      $$('[data-player="1"][data-action="add"]').forEach(function (button) {
        button.dataset.id = track.id;
        button.classList.toggle('is-on', inCollection);
        button.setAttribute('aria-pressed', String(inCollection));
        button.innerHTML = App.icon(inCollection ? 'check' : 'plus');
      });
    },

    syncPlayState: function () {
      var body = document.body;
      body.classList.toggle('has-track', !!Player.track);
      body.classList.toggle('is-playing', Player.playing);
      body.classList.toggle('is-loading', Player.loading);
      body.classList.toggle('is-youtube', !!Player.track && Player.track.source === 'youtube');
      $$('[data-action="player-toggle"]').forEach(function (button) {
        button.setAttribute('aria-label', Player.playing ? t('pause') : t('play'));
      });
    },

    syncModes: function () {
      var shuffle = $('#btn-shuffle');
      if (shuffle) {
        shuffle.classList.toggle('is-on', Player.shuffle);
        shuffle.setAttribute('aria-pressed', String(Player.shuffle));
      }
      var repeat = $('#btn-repeat');
      if (repeat) {
        repeat.classList.toggle('is-on', Player.repeat !== 'off');
        repeat.dataset.mode = Player.repeat;
        repeat.setAttribute('aria-label', t('repeat_' + Player.repeat));
        var badge = $('#repeat-badge');
        if (badge) badge.hidden = Player.repeat !== 'one';
      }
    },

    syncVolume: function () {
      document.body.classList.toggle('is-muted', Player.muted);
      var slider = $('#volume');
      var value = Math.round((Player.muted ? 0 : Player.volume) * 100);
      if (Number(slider.value) !== value) slider.value = value;
    },

    /** Progress is written once per animation frame and only when it changed. */
    scheduleProgress: function (force) {
      if (document.hidden) return;          // background: the lock screen drives the UI, not the DOM
      if (this.frame.progress && !force) return;
      this.frame.progress = true;
      requestAnimationFrame(function () {
        App.frame.progress = false;
        App.writeProgress();
      });
    },

    writeProgress: function () {
      var duration = Player.duration || 0;
      var percent = duration ? (Player.position / duration) * 100 : 0;
      var now = fmtTime(Player.position);
      var total = fmtTime(duration);

      if (this._percent !== percent) {
        this._percent = percent;
        $('#bar-progress').style.setProperty('--p', percent.toFixed(2));
        if (this.npOpen) $('#np-progress').style.setProperty('--p', percent.toFixed(2));
      }
      if (this._now !== now) {
        this._now = now;
        $('#bar-now').textContent = now;
        if (this.npOpen) $('#np-now').textContent = now;
      }
      if (this._total !== total) {
        this._total = total;
        $('#bar-total').textContent = total;
        $('#np-total').textContent = total;
      }
    },

    renderQueue: function () {
      var box = $('#queue-list');
      if (!box) return;
      var items = Player.context === 'wave' ? Wave.upNext : Player.queue.slice(Player.index + 1);
      if (!items.length) {
        box.innerHTML = '<li class="qrow qrow--empty">' + h(t('queue_empty')) + '</li>';
        return;
      }
      this.reg(items);
      box.innerHTML = items.slice(0, 20).map(function (track) {
        return '<li class="qrow" data-action="play" data-id="' + h(track.id) + '">' +
          '<img src="' + h(track.artwork || PLACEHOLDER) + '" alt="" loading="lazy" decoding="async" ' +
            '>' +
          '<span><b>' + h(track.title) + '</b><i>' + h(track.artist) + '</i></span></li>';
      }).join('');
    },

    playerError: function (reason) {
      if (reason === 'blocked') { this.toast(t('err_blocked')); return; }
      if (reason === 'embed_blocked') this.toast(t('err_embed'));
      else if (reason === 'local_file') this.toast(t('err_local'));
      else if (reason === 'yt_api') { this.toast(t('err_network')); return; }
      else this.toast(t('err_video'));

      if (reason === 'video' || reason === 'embed_blocked') {
        setTimeout(function () { Player.next(true); }, 1500);
      }
    },

    openNp: function (open) {
      if (open && !Player.track) return;
      this.npOpen = open;
      document.body.classList.toggle('np-open', open);
      $('#np').setAttribute('aria-hidden', String(!open));
      if (open) { this.renderQueue(); this.writeProgress(); }
      this.positionYouTube();
    },

    /** The iframe never moves in the DOM (that would reload it) — only its transform. */
    positionYouTube: function () {
      var host = $('#yt-host');
      var track = Player.track;
      if (!track || track.source !== 'youtube') { host.classList.remove('is-live'); return; }
      host.classList.add('is-live');

      var target = this.npOpen ? $('#np-art') : $('#bar-art');
      if (!target) return;
      var rect = target.getBoundingClientRect();
      var scale = rect.width / 320;
      host.style.transform = 'translate3d(' + rect.left + 'px,' + rect.top + 'px,0) scale(' + scale + ')';
      host.style.borderRadius = (this.npOpen ? 22 : 12) / scale + 'px';
    },

    /* -------------------------------------------------- song menu (⋮) ----- */

    openMenu: function (track) {
      this.menuTrack = track;
      var fav = Store.isFavorite(track.id);
      var inCollection = Store.inCollection(track.id);

      $('#menu-head').innerHTML =
        '<img src="' + h(track.artwork || PLACEHOLDER) + '" alt="">' +
        '<span><b>' + h(track.title) + '</b><i>' + h(track.artist) + '</i></span>';

      var item = function (action, icon, label, on, accent) {
        return '<button class="sheet__item' + (on ? ' is-on' : '') + (accent ? ' sheet__item--accent' : '') +
          '" data-action="' + action + '">' + App.icon(icon) + '<span>' + h(label) + '</span></button>';
      };

      $('#menu-body').innerHTML =
        item('menu-play', 'play', t('play')) +
        item('fav', fav ? 'heart-on' : 'heart', fav ? t('fav_on') : t('fav_off'), fav).replace('data-action="fav"', 'data-action="fav" data-id="' + h(track.id) + '"') +
        item('add', inCollection ? 'check' : 'plus', inCollection ? t('added') : t('add'), inCollection).replace('data-action="add"', 'data-action="add" data-id="' + h(track.id) + '"') +
        item('menu-queue', 'queue', t('add_to_queue')) +
        item('menu-playlist', 'library', t('add_to_playlist')) +
        item('menu-radio', 'radio', t('start_radio'), false, true) +
        item('menu-share', 'share', t('share'));

      var dialog = $('#modal-menu');
      if (!dialog.open) dialog.showModal();
    },

    addToQueue: function (track) {
      if (!Player.queue.length) {
        Player.setQueue([track], 0, 'list');
      } else {
        var already = Player.queue.some(function (t) { return t.id === track.id; });
        if (already) { this.toast(t('t_in_queue')); return; }
        Player.queue.splice(Player.index + 1, 0, track);
        Player.emit('queue');
      }
      this.registry.set(track.id, track);
      this.toast(t('t_queued'));
      if (this.npOpen) this.renderQueue();
    },

    /** "A wave like this song": one seed track -> a self-extending queue. */
    startRadio: function (track) {
      var self = this;
      this.toast(t('radio_loading'));
      Radio.start(track).then(function (tracks) {
        if (!tracks.length) {
          self.toast(Api.available === false ? t('err_no_key') : t('radio_empty'));
          return;
        }
        var seen = {};
        var queue = [track].concat(tracks).filter(function (item) {
          if (!item || seen[item.id]) return false;
          seen[item.id] = true;
          return true;
        });
        self.reg(queue);
        Player.play(self.resolve(track), { queue: queue, index: 0, context: 'radio' });
        self.toast(t('radio_started', { a: track.artist }));
        if (self.route === 'wave' || self.route === 'home') self.rerender();
      });
    },

    /** Keeps the radio endless: top the queue up before it runs out. */
    extendRadio: function () {
      if (Player.context !== 'radio' || !Radio.active) return;
      var left = Player.queue.length - Player.index - 1;
      if (left > 3 || Radio.loading) return;
      var recent = Player.queue.slice(Math.max(0, Player.index - 2), Player.index + 1);
      Radio.more(recent).then(function (tracks) {
        if (!tracks.length) return;
        var known = {};
        Player.queue.forEach(function (item) { known[item.id] = true; });
        var extra = tracks.filter(function (item) { return !known[item.id]; });
        if (!extra.length) return;
        App.reg(extra);
        Player.queue = Player.queue.concat(extra);
        Player.emit('queue');
        if (App.npOpen) App.renderQueue();
      });
    },

    shareTrack: function (track) {
      var url = track.url || location.href;
      var data = { title: track.title, text: track.title + ' — ' + track.artist, url: url };
      if (navigator.share) {
        navigator.share(data).catch(function () { /* user cancelled */ });
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { App.toast(t('t_copied')); })
          .catch(function () { App.toast(url); });
        return;
      }
      this.toast(url);
    },

    /* ------------------------------------------------------ modals, admin */

    openModal: function (name) {
      if (name === 'settings') this.renderSettings();
      var dialog = $('#modal-' + name);
      if (dialog && !dialog.open) dialog.showModal();
    },

    openPlaylistPicker: function (track) {
      this.pendingPlaylistTrack = track;
      this.renderPlaylistPicker();
      var dialog = $('#modal-playlist');
      if (!dialog.open) dialog.showModal();
    },

    renderPlaylistPicker: function () {
      var track = this.pendingPlaylistTrack;
      var body = $('#playlist-body');
      if (!track) { body.innerHTML = ''; return; }
      body.innerHTML = '<p class="muted">' + h(track.title) + ' — ' + h(track.artist) + '</p>' +
        (Store.playlists.length
          ? '<div class="pllist">' + Store.playlists.map(function (playlist) {
              var inside = Store.inPlaylist(playlist.id, track.id);
              return '<button class="plrow' + (inside ? ' is-on' : '') + '" data-action="playlist-pick" ' +
                'data-playlist="' + h(playlist.id) + '"><span>' + h(playlist.name) + '</span>' +
                '<i>' + h(t('track_count', { n: playlist.tracks.length })) + '</i>' +
                (inside ? App.icon('check') : App.icon('plus')) + '</button>';
            }).join('') + '</div>'
          : '<p class="muted">' + h(t('no_playlists')) + '</p>') +
        '<button class="btn btn--primary" data-action="playlist-create-pick">' + this.icon('plus') + ' ' + h(t('playlist_new')) + '</button>';
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

        '<label class="setting"><span>' + h(t('autoplay')) + '</span>' +
          '<input type="checkbox" class="switch" data-action="autoplay"' + (Player.autoplay ? ' checked' : '') + '></label>' +
        '<p class="muted">' + h(t('bg_note')) + '</p>' +

        '<div class="setting setting--col"><span>' + h(t('eq_title')) + '</span>' +
          ['bass', 'mid', 'treble'].map(function (band) {
            var label = band === 'bass' ? t('eq_low') : (band === 'mid' ? t('eq_mid') : t('eq_high'));
            return '<label class="slider"><i>' + h(label) + '</i>' +
              '<input type="range" min="-10" max="10" step="1" value="' + eq[band] + '" data-eq="' + band + '" ' +
              'aria-label="' + h(label) + '"><b>' + (eq[band] > 0 ? '+' : '') + eq[band] + '</b></label>';
          }).join('') +
          '<label class="check"><input type="checkbox" data-eq="loud"' + (eq.loud ? ' checked' : '') + '>' +
          '<span>' + h(t('eq_loud')) + '</span></label>' +
        '</div>' +

        '<div class="setting setting--col"><span>' + h(t('sleep')) + '</span>' +
          '<div class="chips">' + [['0', t('sleep_off')], ['15', t('sleep_min', { n: 15 })], ['30', t('sleep_min', { n: 30 })], ['60', t('sleep_min', { n: 60 })], ['end', t('sleep_end')]]
            .map(function (pair) {
              return '<button class="chip" data-action="sleep" data-value="' + pair[0] + '">' + h(pair[1]) + '</button>';
            }).join('') +
          '</div></div>' +

        '<div class="setting setting--col"><span>' + h(t('data')) + '</span>' +
          '<div class="chips">' +
            '<button class="chip" data-action="clear-recent">' + h(t('clear_recent')) + '</button>' +
            '<button class="chip" data-action="clear-favorites">' + h(t('clear_favorites')) + '</button>' +
            '<button class="chip" data-action="reset-all">' + h(t('reset_all')) + '</button>' +
          '</div></div>' +

        '<div class="setting setting--col"><span>' + h(t('my_files')) + '</span>' +
          '<p class="muted">' + h(t('my_files_hint')) + '</p>' +
          '<button class="btn btn--primary" data-action="add-my-files">' + this.icon('plus') + ' ' + h(t('admin_add')) + '</button>' +
        '</div>' +
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
          '<img src="' + h(track.artwork || PLACEHOLDER) + '" alt="" loading="lazy" ' +
            '>' +
          '<span class="arow__fields">' +
            '<input value="' + h(track.title) + '" data-field="title" aria-label="' + h(t('admin_title_field')) + '">' +
            '<input value="' + h(track.artist) + '" data-field="artist" aria-label="' + h(t('lbl_artist')) + '">' +
          '</span>' +
          '<button class="chip-btn" data-admin-del="' + h(track.id) + '" aria-label="' + h(t('remove')) + '">' +
            App.icon('trash') + '</button>' +
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
      if (!list.length) { this.toast(t('err_no_audio')); return; }

      var jobs = list.map(function (file) {
        var id = file.name + ':' + file.size;
        var url = URL.createObjectURL(file);
        return new Promise(function (resolve) {
          var probe = new Audio();
          probe.preload = 'metadata';
          var settled = false;
          var done = function (duration) {
            if (settled) return;
            settled = true;
            URL.revokeObjectURL(url);
            resolve(duration);
          };
          probe.onloadedmetadata = function () { done(isFinite(probe.duration) ? probe.duration : 0); };
          probe.onerror = function () { done(0); };
          setTimeout(function () { done(0); }, 4000);
          probe.src = url;
        }).then(function (duration) {
          var base = file.name.replace(/\.[a-z0-9]+$/i, '').replace(/_+/g, ' ');
          var parts = base.split(/\s+-\s+/);
          return Store.db.put({
            id: id, name: file.name, blob: file,
            title: parts.length > 1 ? parts.slice(1).join(' - ') : base,
            artist: parts.length > 1 ? parts[0] : t('unknown_artist'),
            duration: duration, addedAt: Date.now()
          }).catch(function () { /* file:// has no IndexedDB */ });
        });
      });

      Promise.all(jobs).then(function () {
        App.loadLocal().then(function () {
          Wave.init(App.local);
          App.renderAdmin();
          App.rerender();
          App.toast(t('t_added'));
        });
      });
    },

    /* ------------------------------------------- offline app + self update */

    registerServiceWorker: function () {
      if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;

      navigator.serviceWorker.register('sw.js').then(function (registration) {
        registration.addEventListener('updatefound', function () {
          var installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', function () {
            if (installing.state !== 'installed' || !navigator.serviceWorker.controller) return;
            App.updateReady = true;
            // never cut the music off: reload now only if nothing is playing
            if (!Player.playing) location.reload();
            else App.toast(t('update_ready'));
          });
        });
        // check for a new deploy when the app is opened again
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) registration.update();
        });
      }).catch(function () { /* served without HTTPS: no offline mode, app still works */ });

      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (App.reloading) return;
        App.reloading = true;
        if (!Player.playing) location.reload();
      });
    },

    /* --------------------------------------------------------- theme, lang */

    applyTheme: function (theme, silent) {
      Store.prefs.theme = theme;
      Store.savePrefs();
      document.documentElement.dataset.theme = theme;
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = theme === 'day' ? '#f3f4f7' : '#07070b';
      if (!silent) this.renderSettings();
    },

    applyLang: function (lang, silent) {
      Store.prefs.lang = lang;
      Store.savePrefs();
      document.documentElement.lang = lang;
      $$('[data-i18n]').forEach(function (node) { node.textContent = t(node.dataset.i18n); });
      $$('[data-i18n-aria]').forEach(function (node) { node.setAttribute('aria-label', t(node.dataset.i18nAria)); });
      if (!silent) { this.renderView(); this.renderSettings(); this.syncModes(); }
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
      // any artwork that fails to load quietly falls back to the inline placeholder
      document.addEventListener('error', function (event) {
        var node = event.target;
        if (!node || node.tagName !== 'IMG' || node.dataset.fallback === '1') return;
        node.dataset.fallback = '1';
        node.src = PLACEHOLDER;
      }, true);

      document.addEventListener('click', function (event) {
        var target = event.target.closest('[data-action]');
        if (!target) return;
        var name = target.dataset.action;

        if (name === 'lang') { App.applyLang(target.dataset.lang); return; }
        if (name === 'theme') { App.applyTheme(target.dataset.theme); return; }
        if (name === 'sleep') {
          Player.setSleep(target.dataset.value);
          $$('[data-action="sleep"]').forEach(function (chip) {
            chip.classList.toggle('is-on', chip === target && target.dataset.value !== '0');
          });
          return;
        }
        if (name === 'autoplay') return;                 // handled by the change listener
        event.preventDefault();
        App.action(name, target);
      });

      document.addEventListener('keydown', function (event) {
        var row = event.target.closest && event.target.closest('.row');
        if (row && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          App.action('play', row);
        }
      });

      // search input: the field is never re-rendered while typing, so focus is kept
      $('#view').addEventListener('input', function (event) {
        if (event.target.id !== 'search-input') return;
        var value = event.target.value;
        var clear = $('.searchbar__clear');
        if (clear) clear.hidden = !value;
        clearTimeout(App.searchTimer);
        App.searchTimer = setTimeout(function () {
          var trimmed = value.trim();
          if (trimmed === App.search.query) return;
          App.search.query = trimmed;
          App.runSearch(true);
        }, 350);
      });

      $('#view').addEventListener('keydown', function (event) {
        if (event.target.id === 'search-input' && event.key === 'Enter') {
          clearTimeout(App.searchTimer);
          App.search.query = event.target.value.trim();
          App.runSearch(true);
          event.target.blur();
        }
      });

      document.addEventListener('visibilitychange', function () {
        if (document.hidden) return;
        App.syncPlayState();
        App.syncTrackInfo();
        App.writeProgress();
      });

      var resizeTimer = null;
      window.addEventListener('resize', function () {
        if (resizeTimer) return;
        resizeTimer = setTimeout(function () { resizeTimer = null; App.positionYouTube(); }, 150);
      }, { passive: true });

      window.addEventListener('hashchange', function () {
        var route = location.hash.replace('#', '');
        if (route && route !== (App.route + (App.routeParam ? '/' + App.routeParam : ''))) App.go(route, { silent: true });
      });

      $('#nav-toggle').addEventListener('click', function () { document.body.classList.toggle('nav-open'); });

      ['#bar-progress', '#np-progress'].forEach(function (selector) {
        var bar = $(selector);
        var seek = function (event) {
          var rect = bar.getBoundingClientRect();
          var point = (event.clientX !== undefined ? event.clientX : event.touches[0].clientX) - rect.left;
          Player.seekFraction(point / rect.width);
        };
        bar.addEventListener('click', seek);
        bar.addEventListener('keydown', function (event) {
          if (event.key === 'ArrowRight') Player.seekTo(Player.position + 5);
          if (event.key === 'ArrowLeft') Player.seekTo(Math.max(0, Player.position - 5));
        });
      });

      $('#volume').addEventListener('input', function () { Player.setVolume(this.value / 100); });

      $('#modal-settings').addEventListener('input', function (event) {
        var band = event.target.dataset.eq;
        if (band) {
          Store.prefs.eq[band] = band === 'loud' ? event.target.checked : Number(event.target.value);
          Store.savePrefs();
          Player.applyEq();
          var label = event.target.parentNode.querySelector('b');
          if (label) label.textContent = (Store.prefs.eq[band] > 0 ? '+' : '') + Store.prefs.eq[band];
          return;
        }
        if (event.target.dataset.action === 'autoplay') Player.setAutoplay(event.target.checked);
      });

      $$('[data-close]').forEach(function (button) {
        button.addEventListener('click', function () { button.closest('dialog').close(); });
      });

      $('#login-submit').addEventListener('click', function () {
        var user = $('#login-user').value.trim();
        var pass = $('#login-pass').value;
        if (hashCode(user + '::' + pass) === ADMIN_HASH) {
          App.isAdmin = true;
          try { localStorage.setItem('muzzz:admin', '1'); } catch (e) {}
          $('#login-pass').value = '';
          $('#modal-login').close();
          App.openAdmin();
        } else {
          $('#login-error').hidden = false;
        }
      });
      $('#login-pass').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') $('#login-submit').click();
      });

      $('#admin-logout').addEventListener('click', function () {
        App.isAdmin = false;
        try { localStorage.removeItem('muzzz:admin'); } catch (e) {}
        $('#modal-admin').close();
      });
      $('#admin-add').addEventListener('click', function () { $('#admin-files').click(); });
      $('#admin-files').addEventListener('change', function () { App.addUploads(this.files); this.value = ''; });
      $('#admin-restore').addEventListener('click', function () {
        Store.restoreLocal();
        App.loadLocal().then(function () { Wave.init(App.local); App.renderAdmin(); App.rerender(); });
      });
      $('#admin-list').addEventListener('click', function (event) {
        var button = event.target.closest('[data-admin-del]');
        if (!button) return;
        Store.hideLocal(button.dataset.adminDel);
        App.loadLocal().then(function () { Wave.init(App.local); App.renderAdmin(); App.rerender(); });
      });
      $('#admin-list').addEventListener('change', function (event) {
        var input = event.target.closest('input[data-field]');
        if (!input) return;
        var id = input.closest('.arow').dataset.id;
        Store.setOverride(id, input.dataset.field, input.value.trim());
        App.loadLocal().then(function () { Wave.init(App.local); App.rerender(); });
      });

      document.addEventListener('keydown', function (event) {
        var tag = (event.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || document.querySelector('dialog[open]')) {
          if (event.key === 'Escape' && tag === 'input') event.target.blur();
          return;
        }
        if (event.key === ' ') { event.preventDefault(); Player.toggle(); }
        if (event.key === 'ArrowRight' && event.shiftKey) Player.next(false);
        if (event.key === 'ArrowLeft' && event.shiftKey) Player.prev();
        if (event.key === 'Escape' && App.npOpen) App.openNp(false);
        if (event.key === '/') {
          event.preventDefault();
          App.go('search');
          setTimeout(function () { var input = $('#search-input'); if (input) input.focus(); }, 60);
        }
      });
    }
  };

  window.App = App;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { App.init(); });
  else App.init();
})();
