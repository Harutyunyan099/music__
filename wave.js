/* muzzz — My Wave: a continuous stream built from what the user actually plays.
   Signals, strongest first: favourites -> recently played -> collection -> local library.
   Nothing here is faked: every candidate comes from a real YouTube search or from
   the user's own local files. */
(function (global) {
  'use strict';

  var POOL_TTL = 30 * 60 * 1000;

  var Wave = {
    local: [],
    pools: {},              // artist -> { at, tracks[] }
    upNext: [],
    lastArtists: [],
    reasons: {},            // trackId -> why it was picked
    loading: false,
    listeners: [],

    on: function (fn) { this.listeners.push(fn); },
    emit: function () { var self = this; this.listeners.forEach(function (fn) { fn(self); }); },

    init: function (localTracks) { this.local = localTracks || []; },

    hasSignals: function () {
      return Store.hasTaste() || this.local.length > 0;
    },

    seeds: function () {
      var weights = Store.artistWeights(this.local);
      return weights.slice(0, 14);
    },

    pickSeed: function () {
      var seeds = this.seeds().filter(function (seed) {
        return Wave.lastArtists.slice(0, 2).indexOf(seed.name) === -1;
      });
      if (!seeds.length) return null;
      var total = seeds.reduce(function (sum, s) { return sum + s.weight; }, 0);
      var point = Math.random() * total;
      for (var i = 0; i < seeds.length; i++) {
        point -= seeds[i].weight;
        if (point <= 0) return seeds[i];
      }
      return seeds[0];
    },

    usable: function (track) {
      if (!track) return false;
      if (Store.wasHeardRecently(track.id)) return false;
      if (this.upNext.some(function (t) { return t.id === track.id; })) return false;
      if (Player.track && Player.track.id === track.id) return false;
      if (track.duration && (track.duration < 45 || track.duration > 900)) return false;
      return true;
    },

    /** Local files that fit the wave — they keep working even without the API. */
    localCandidates: function () {
      var self = this;
      return this.local.filter(function (track) { return self.usable(track); });
    },

    fetchArtist: function (artist) {
      var cached = this.pools[artist];
      if (cached && Date.now() - cached.at < POOL_TTL) return Promise.resolve(cached.tracks);
      if (!Api.available) return Promise.resolve([]);

      return Api.search(artist, { limit: 20 })
        .then(function (payload) {
          var tracks = (payload.items || []).map(Api.toTrack);
          Wave.pools[artist] = { at: Date.now(), tracks: tracks };
          return tracks;
        })
        .catch(function () { return []; });
    },

    /** No listening history at all: start from broadly popular music, honestly labelled. */
    discover: function () {
      if (!Api.available) return Promise.resolve([]);
      var queries = ['new music 2026', 'popular music hits', 'trending songs'];
      var query = queries[Math.floor(Math.random() * queries.length)];
      return Api.search(query, { limit: 25, order: 'viewCount' })
        .then(function (payload) { return (payload.items || []).map(Api.toTrack); })
        .catch(function () { return []; });
    },

    /** Fill upNext until it holds `target` tracks, mixing artists as it goes. */
    refill: function (target, depth) {
      target = target || 4;
      depth = depth || 0;
      if (this.upNext.length >= target || depth > 3) {
        this.loading = false;
        this.emit();
        return Promise.resolve();
      }
      this.loading = true;
      this.emit();

      var self = this;
      var seed = this.pickSeed();
      var source = seed ? this.fetchArtist(seed.name) : this.discover();

      return source.then(function (tracks) {
        var picked = tracks.filter(function (track) { return self.usable(track); });
        picked.sort(function () { return Math.random() - 0.5; });

        // at most two songs per artist per round, so the wave keeps mixing
        picked.slice(0, 2).forEach(function (track) {
          self.reasons[track.id] = seed ? { type: 'artist', artist: seed.name } : { type: 'discover' };
          self.upNext.push(track);
          self.lastArtists = [track.artist].concat(self.lastArtists).slice(0, 4);
        });

        // the user's own files stay part of the stream
        var locals = self.localCandidates();
        if (locals.length && (Math.random() < 0.25 || !picked.length)) {
          var local = locals[Math.floor(Math.random() * locals.length)];
          if (local && !self.upNext.some(function (track) { return track.id === local.id; })) {
            self.reasons[local.id] = { type: 'library' };
            self.upNext.push(local);
          }
        }

        return self.refill(target, depth + 1);
      });
    },

    /** Next track for the wave; resolves with the track (or null if nothing found). */
    next: function () {
      var self = this;
      return this.refill(4).then(function () {
        var track = self.upNext.shift();
        if (!track) return null;
        self.lastArtists = [track.artist].concat(self.lastArtists).slice(0, 4);
        Store.rememberWave(track);
        self.refill(4);                     // keep the buffer warm in the background
        return track;
      });
    },

    start: function () {
      this.upNext = [];
      return this.next();
    },

    /** User skipped: do not offer this track again for a while. */
    skip: function (track) {
      if (track) Store.skipWave(track);
      return this.next();
    },

    reasonFor: function (track) {
      return track ? this.reasons[track.id] : null;
    }
  };

  global.Wave = Wave;
})(window);
