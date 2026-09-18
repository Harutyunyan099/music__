/* muzzz — persistence layer (localStorage + IndexedDB for user uploaded files)
   Every change emits a precise event so the UI can patch instead of re-rendering. */
(function (global) {
  'use strict';

  var PREFIX = 'muzzz:';
  var LIMITS = { recent: 60, waveHistory: 120, skipped: 80, playlistTracks: 500 };
  var WRITE_DELAY = 250;

  /* --------------------------------------------------------------- storage */

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(PREFIX + key);
      if (raw === null) return fallback;
      var value = JSON.parse(raw);
      return value === null || value === undefined ? fallback : value;
    } catch (e) {
      return fallback;                    // corrupted entry must never break boot
    }
  }

  var pending = {};
  var writeTimer = null;

  function flush() {
    writeTimer = null;
    Object.keys(pending).forEach(function (key) {
      try { localStorage.setItem(PREFIX + key, JSON.stringify(pending[key])); }
      catch (e) { /* private mode or quota */ }
    });
    pending = {};
  }

  /** Writes are batched: a burst of changes costs one stringify per key. */
  function write(key, value) {
    pending[key] = value;
    if (writeTimer) return;
    writeTimer = setTimeout(flush, WRITE_DELAY);
  }

  global.addEventListener('pagehide', flush);
  global.addEventListener('beforeunload', flush);

  /* ------------------------------------------------------------ validation */

  function validTrack(track) {
    return !!track && typeof track === 'object' && typeof track.id === 'string' && !!track.title;
  }

  function trackList(value) {
    return Array.isArray(value) ? value.filter(validTrack) : [];
  }

  function idList(value) {
    return Array.isArray(value) ? value.filter(function (id) { return typeof id === 'string'; }) : [];
  }

  function playlistList(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(function (item) {
      return item && typeof item.id === 'string' && typeof item.name === 'string';
    }).map(function (item) {
      item.tracks = trackList(item.tracks);
      return item;
    });
  }

  function uid() {
    return 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------------------------------------------------------------- store */

  var listeners = [];

  var Store = {
    collection: trackList(read('collection', [])),
    favorites: trackList(read('favorites', [])),
    recent: trackList(read('recent', [])),
    playlists: playlistList(read('playlists', [])),
    waveHistory: idList(read('waveHistory', [])),
    skipped: idList(read('skipped', [])),

    prefs: Object.assign({
      volume: 0.85,
      muted: false,
      lang: 'hy',
      theme: 'night',
      autoplay: true,
      repeat: 'off',          // off | all | one
      shuffle: false,
      eq: { bass: 0, mid: 0, treble: 0, loud: false }
    }, (function () {
      var saved = read('prefs', {});
      return (saved && typeof saved === 'object') ? saved : {};
    })()),

    onChange: function (fn) { listeners.push(fn); },
    emit: function (what, payload) {
      listeners.forEach(function (fn) {
        try { fn(what, payload); } catch (e) { /* one listener must not kill the rest */ }
      });
    },

    savePrefs: function () { write('prefs', this.prefs); },

    /* ------------------------------------------------------- collection */

    inCollection: function (id) {
      return this.collection.some(function (t) { return t.id === id; });
    },

    addToCollection: function (track) {
      if (!validTrack(track) || this.inCollection(track.id)) return false;
      this.collection = [Object.assign({}, track, { addedAt: Date.now() })].concat(this.collection);
      write('collection', this.collection);
      this.emit('collection', track.id);
      return true;
    },

    removeFromCollection: function (id) {
      var before = this.collection.length;
      this.collection = this.collection.filter(function (t) { return t.id !== id; });
      if (this.collection.length === before) return;
      write('collection', this.collection);
      this.emit('collection', id);
    },

    /* -------------------------------------------------------- favorites */

    isFavorite: function (id) {
      return this.favorites.some(function (t) { return t.id === id; });
    },

    toggleFavorite: function (track) {
      if (!validTrack(track)) return false;
      var on;
      if (this.isFavorite(track.id)) {
        this.favorites = this.favorites.filter(function (t) { return t.id !== track.id; });
        on = false;
      } else {
        this.favorites = [Object.assign({}, track, { addedAt: Date.now() })].concat(this.favorites);
        on = true;
      }
      write('favorites', this.favorites);
      this.emit('favorites', track.id);
      return on;
    },

    clearFavorites: function () {
      this.favorites = [];
      write('favorites', []);
      this.emit('favorites', null);
    },

    /* ----------------------------------------------------------- recent */

    pushRecent: function (track) {
      if (!validTrack(track)) return;
      var head = this.recent[0];
      if (head && head.id === track.id) return;      // no duplicate records in a row
      this.recent = [Object.assign({}, track, { playedAt: Date.now() })]
        .concat(this.recent.filter(function (t) { return t.id !== track.id; }))
        .slice(0, LIMITS.recent);
      write('recent', this.recent);
      this.emit('recent', track.id);
    },

    clearRecent: function () {
      this.recent = [];
      write('recent', []);
      this.emit('recent', null);
    },

    /* -------------------------------------------------------- playlists */

    createPlaylist: function (name) {
      var playlist = { id: uid(), name: String(name || '').trim().slice(0, 60) || 'Playlist', tracks: [], createdAt: Date.now() };
      this.playlists = [playlist].concat(this.playlists);
      write('playlists', this.playlists);
      this.emit('playlists', playlist.id);
      return playlist;
    },

    playlist: function (id) {
      return this.playlists.filter(function (p) { return p.id === id; })[0] || null;
    },

    renamePlaylist: function (id, name) {
      var playlist = this.playlist(id);
      if (!playlist) return;
      playlist.name = String(name || '').trim().slice(0, 60) || playlist.name;
      write('playlists', this.playlists);
      this.emit('playlists', id);
    },

    deletePlaylist: function (id) {
      this.playlists = this.playlists.filter(function (p) { return p.id !== id; });
      write('playlists', this.playlists);
      this.emit('playlists', id);
    },

    inPlaylist: function (id, trackId) {
      var playlist = this.playlist(id);
      return !!playlist && playlist.tracks.some(function (t) { return t.id === trackId; });
    },

    addToPlaylist: function (id, track) {
      var playlist = this.playlist(id);
      if (!playlist || !validTrack(track) || this.inPlaylist(id, track.id)) return false;
      playlist.tracks = [Object.assign({}, track, { addedAt: Date.now() })]
        .concat(playlist.tracks).slice(0, LIMITS.playlistTracks);
      write('playlists', this.playlists);
      this.emit('playlists', id);
      return true;
    },

    removeFromPlaylist: function (id, trackId) {
      var playlist = this.playlist(id);
      if (!playlist) return;
      playlist.tracks = playlist.tracks.filter(function (t) { return t.id !== trackId; });
      write('playlists', this.playlists);
      this.emit('playlists', id);
    },

    /* ------------------------------------------------------------- wave */

    rememberWave: function (track) {
      if (!validTrack(track)) return;
      this.waveHistory = [track.id]
        .concat(this.waveHistory.filter(function (id) { return id !== track.id; }))
        .slice(0, LIMITS.waveHistory);
      write('waveHistory', this.waveHistory);
    },

    skipWave: function (track) {
      if (!validTrack(track)) return;
      this.skipped = [track.id]
        .concat(this.skipped.filter(function (id) { return id !== track.id; }))
        .slice(0, LIMITS.skipped);
      write('skipped', this.skipped);
    },

    wasHeardRecently: function (id) {
      return this.waveHistory.indexOf(id) !== -1 || this.skipped.indexOf(id) !== -1;
    },

    /* ------------------------------------------------------------ taste */

    hasTaste: function () {
      return this.favorites.length > 0 || this.collection.length > 0 || this.recent.length > 0;
    },

    /** Weighted artist list built from what the user actually listens to. */
    artistWeights: function (localTracks) {
      var weights = {};
      var bump = function (artist, amount) {
        if (!artist) return;
        String(artist).split(/\s*[,&×]\s+|\s+feat\.?\s+/i).slice(0, 2).forEach(function (name) {
          var key = name.trim();
          if (key.length < 2) return;
          weights[key] = (weights[key] || 0) + amount;
        });
      };
      this.favorites.forEach(function (t) { bump(t.artist, 5); });
      this.recent.slice(0, 25).forEach(function (t, i) { bump(t.artist, 4 - i * 0.1); });
      this.collection.forEach(function (t) { bump(t.artist, 2); });
      (localTracks || []).forEach(function (t) { bump(t.artist, 1); });

      return Object.keys(weights)
        .map(function (name) { return { name: name, weight: weights[name] }; })
        .sort(function (a, b) { return b.weight - a.weight; });
    },

    /* ------------------------------------------------------------ reset */

    resetAll: function () {
      this.collection = []; this.favorites = []; this.recent = [];
      this.playlists = []; this.waveHistory = []; this.skipped = [];
      ['collection', 'favorites', 'recent', 'playlists', 'waveHistory', 'skipped'].forEach(function (key) {
        write(key, []);
      });
      this.emit('reset', null);
    },

    /* --------------------------- uploaded files (IndexedDB, admin panel) */

    db: {
      handle: null,
      open: function () {
        if (this.handle) return this.handle;
        this.handle = new Promise(function (resolve, reject) {
          try {
            var request = indexedDB.open('muzzz', 1);
            request.onupgradeneeded = function () {
              if (!request.result.objectStoreNames.contains('uploads')) {
                request.result.createObjectStore('uploads', { keyPath: 'id' });
              }
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error); };
          } catch (e) { reject(e); }
        });
        return this.handle;
      },
      run: function (mode, fn) {
        return this.open().then(function (db) {
          return new Promise(function (resolve, reject) {
            var tx = db.transaction('uploads', mode);
            var req = fn(tx.objectStore('uploads'));
            tx.oncomplete = function () { resolve(req && req.result); };
            tx.onerror = function () { reject(tx.error); };
          });
        });
      },
      all: function () { return this.run('readonly', function (s) { return s.getAll(); }); },
      put: function (item) { return this.run('readwrite', function (s) { return s.put(item); }); },
      del: function (id) { return this.run('readwrite', function (s) { return s.delete(id); }); }
    },

    /* local library tweaks made in the admin panel */
    hiddenLocal: new Set(idList(read('hiddenLocal', []))),
    overrides: (function () {
      var value = read('overrides', {});
      return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    })(),

    hideLocal: function (id) {
      this.hiddenLocal.add(id);
      write('hiddenLocal', Array.from(this.hiddenLocal));
    },
    restoreLocal: function () {
      this.hiddenLocal.clear();
      write('hiddenLocal', []);
    },
    setOverride: function (id, field, value) {
      this.overrides[id] = this.overrides[id] || {};
      this.overrides[id][field] = value;
      write('overrides', this.overrides);
    }
  };

  global.Store = Store;
})(window);
