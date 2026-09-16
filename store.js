/* muzzz — persistence layer (localStorage + IndexedDB for user uploaded files) */
(function (global) {
  'use strict';

  var PREFIX = 'muzzz:';
  var LIMITS = { recent: 60, waveHistory: 120, skipped: 80 };

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function write(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); }
    catch (e) { /* private mode or quota */ }
  }

  var listeners = [];

  var Store = {
    collection: read('collection', []),
    favorites: read('favorites', []),
    recent: read('recent', []),
    waveHistory: read('waveHistory', []),
    skipped: read('skipped', []),
    prefs: Object.assign({
      volume: 0.85, muted: false, lang: 'hy', theme: 'night',
      eq: { bass: 0, mid: 0, treble: 0, loud: false }
    }, read('prefs', {})),

    onChange: function (fn) { listeners.push(fn); },
    emit: function (what) { listeners.forEach(function (fn) { fn(what); }); },

    savePrefs: function () { write('prefs', this.prefs); },

    /* ---------------------------------------------------------- collection */

    inCollection: function (id) {
      return this.collection.some(function (t) { return t.id === id; });
    },

    addToCollection: function (track) {
      if (!track || this.inCollection(track.id)) return false;
      var item = Object.assign({}, track, { addedAt: Date.now() });
      this.collection.unshift(item);
      write('collection', this.collection);
      this.emit('collection');
      return true;
    },

    removeFromCollection: function (id) {
      var before = this.collection.length;
      this.collection = this.collection.filter(function (t) { return t.id !== id; });
      if (this.collection.length !== before) {
        write('collection', this.collection);
        this.emit('collection');
      }
    },

    /* ----------------------------------------------------------- favorites */

    isFavorite: function (id) {
      return this.favorites.some(function (t) { return t.id === id; });
    },

    toggleFavorite: function (track) {
      if (!track) return false;
      if (this.isFavorite(track.id)) {
        this.favorites = this.favorites.filter(function (t) { return t.id !== track.id; });
        write('favorites', this.favorites);
        this.emit('favorites');
        return false;
      }
      this.favorites.unshift(Object.assign({}, track, { addedAt: Date.now() }));
      write('favorites', this.favorites);
      this.emit('favorites');
      return true;
    },

    /* -------------------------------------------------------------- recent */

    pushRecent: function (track) {
      if (!track) return;
      var item = Object.assign({}, track, { playedAt: Date.now() });
      this.recent = [item].concat(this.recent.filter(function (t) { return t.id !== track.id; }))
        .slice(0, LIMITS.recent);
      write('recent', this.recent);
      this.emit('recent');
    },

    clearRecent: function () {
      this.recent = [];
      write('recent', []);
      this.emit('recent');
    },

    /* ---------------------------------------------------------------- wave */

    rememberWave: function (track) {
      if (!track) return;
      this.waveHistory = [track.id].concat(this.waveHistory.filter(function (id) { return id !== track.id; }))
        .slice(0, LIMITS.waveHistory);
      write('waveHistory', this.waveHistory);
    },

    skipWave: function (track) {
      if (!track) return;
      this.skipped = [track.id].concat(this.skipped.filter(function (id) { return id !== track.id; }))
        .slice(0, LIMITS.skipped);
      write('skipped', this.skipped);
    },

    wasHeardRecently: function (id) {
      return this.waveHistory.indexOf(id) !== -1 || this.skipped.indexOf(id) !== -1;
    },

    /* --------------------------------------------------- taste / user data */

    hasTaste: function () {
      return this.favorites.length > 0 || this.collection.length > 0 || this.recent.length > 0;
    },

    /** Weighted artist list built from what the user actually listens to. */
    artistWeights: function (localTracks) {
      var weights = {};
      var bump = function (artist, amount) {
        if (!artist) return;
        artist.split(/\s*[,&×xX]\s+|\s+feat\.?\s+/).slice(0, 2).forEach(function (name) {
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

    /* --------------------------- uploaded files (IndexedDB, admin section) */

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
    hiddenLocal: new Set(read('hiddenLocal', [])),
    overrides: read('overrides', {}),

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
