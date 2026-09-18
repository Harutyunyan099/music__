/* muzzz — one player for two sources: local audio files and the YouTube embed.
   Time updates are throttled at the source so the UI never gets more work than a frame. */
(function (global) {
  'use strict';

  var audio = new Audio();
  audio.preload = 'metadata';
  audio.setAttribute('playsinline', '');
  audio.setAttribute('webkit-playsinline', '');
  audio.setAttribute('x-webkit-airplay', 'allow');
  // Android keeps a media session alive more reliably when the element is in the document
  if (document.body) document.body.appendChild(audio);
  else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(audio); });

  var listeners = [];
  var pollTimer = null;
  var lastEmittedPosition = -1;
  var yt = { api: null, player: null, ready: false };
  var sound = { ready: false, tried: false, ctx: null, bass: null, mid: null, treble: null, comp: null, gain: null };

  function prefs() {
    return (global.Store && Store.prefs) || {};
  }

  var Player = {
    track: null,
    queue: [],
    index: -1,
    context: 'list',
    playing: false,
    loading: false,
    position: 0,
    duration: 0,
    volume: 0.85,
    muted: false,
    repeat: 'off',
    shuffle: false,
    autoplay: true,
    history: [],              // for shuffle "previous"
    sleepTimer: null,
    sleepAtEnd: false,
    primed: false,            // a track is shown in the bar but not loaded yet
    onEnded: null,
    onError: null,

    on: function (fn) { listeners.push(fn); },
    emit: function (what) {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](what, Player); } catch (e) { /* keep the others alive */ }
      }
    },

    init: function () {
      var saved = prefs();
      this.volume = typeof saved.volume === 'number' ? saved.volume : 0.85;
      this.muted = !!saved.muted;
      this.repeat = saved.repeat || 'off';
      this.shuffle = !!saved.shuffle;
      this.autoplay = saved.autoplay !== false;
      audio.volume = this.volume;
      audio.muted = this.muted;
    },

    /* ------------------------------------------------------------ queue */

    setQueue: function (tracks, index, context) {
      this.queue = (tracks || []).slice();
      this.index = typeof index === 'number' ? index : -1;
      this.context = context || 'list';
      this.emit('queue');
    },

    /** Shows a track in the player without loading or playing it (used on startup). */
    prime: function (track, queue, index) {
      if (!track) return;
      this.primed = true;
      this.track = track;
      this.queue = (queue && queue.length) ? queue.slice() : [track];
      this.index = typeof index === 'number' ? index : 0;
      this.position = 0;
      this.duration = track.duration || 0;
      this.playing = false;
      this.loading = false;
      this.emit('track');
    },

    play: function (track, options) {
      options = options || {};
      this.primed = false;
      if (options.queue) this.setQueue(options.queue, options.index, options.context);
      else if (options.context) this.context = options.context;

      if (!track) return;
      if (this.track && this.track.id === track.id) { this.toggle(); return; }

      if (this.track) this.history.push(this.track.id);
      if (this.history.length > 40) this.history.shift();

      this.track = track;
      this.position = 0;
      lastEmittedPosition = -1;
      this.duration = track.duration || 0;
      this.loading = true;
      this.emit('track');

      var atIndex = this.queue.findIndex(function (t) { return t.id === track.id; });
      if (atIndex !== -1) this.index = atIndex;

      if (track.source === 'youtube') this.playYouTube(track);
      else this.playLocal(track);

      if (global.Store) Store.pushRecent(track);
      this.updateMediaSession();
    },

    toggle: function () {
      if (!this.track) {
        if (this.queue.length) this.play(this.queue[Math.max(0, this.index)]);
        return;
      }
      if (this.primed) {                       // first press after a reload: load it now
        var pending = this.track;
        this.primed = false;
        this.track = null;
        this.play(pending, { context: this.context });
        return;
      }
      if (this.track.source === 'youtube') {
        if (!yt.player || !yt.ready) return;
        if (this.playing) yt.player.pauseVideo();
        else yt.player.playVideo();
      } else {
        if (this.playing) audio.pause();
        else audio.play().catch(function (error) {
          if (error && error.name === 'NotAllowedError' && Player.onError) Player.onError('blocked');
        });
      }
    },

    pause: function () {
      if (!this.track) return;
      if (this.track.source === 'youtube') { if (yt.player && yt.ready) yt.player.pauseVideo(); }
      else audio.pause();
    },

    pickShuffleIndex: function () {
      if (this.queue.length < 2) return 0;
      var next;
      do { next = Math.floor(Math.random() * this.queue.length); }
      while (next === this.index);
      return next;
    },

    next: function (auto) {
      if (this.context === 'wave' && typeof this.onEnded === 'function') {
        this.onEnded(auto === true);
        return;
      }
      if (!this.queue.length) return;

      if (auto && this.repeat === 'one') {
        this.seekTo(0);
        this.resume();
        return;
      }

      var nextIndex;
      if (this.shuffle) {
        nextIndex = this.pickShuffleIndex();
      } else {
        nextIndex = this.index + 1;
        if (nextIndex >= this.queue.length) {
          if (auto && this.repeat !== 'all') { this.pause(); this.emit('state'); return; }
          nextIndex = 0;
        }
      }
      this.index = nextIndex;
      this.play(this.queue[nextIndex], { context: this.context });
    },

    prev: function () {
      if (this.position > 4) { this.seekTo(0); return; }
      if (!this.queue.length) return;

      var previousId = this.shuffle ? this.history.pop() : null;
      if (previousId) {
        var found = this.queue.filter(function (t) { return t.id === previousId; })[0];
        if (found) { this.play(found, { context: this.context }); return; }
      }
      var prevIndex = this.index - 1;
      if (prevIndex < 0) prevIndex = this.queue.length - 1;
      this.index = prevIndex;
      this.play(this.queue[prevIndex], { context: this.context });
    },

    resume: function () {
      if (!this.track) return;
      if (this.track.source === 'youtube') { if (yt.player && yt.ready) yt.player.playVideo(); }
      else audio.play().catch(function () { /* needs a user gesture */ });
    },

    /* ----------------------------------------------------------- sources */

    playLocal: function (track) {
      this.stopYouTube();
      audio.src = track.src;
      audio.volume = this.volume;
      audio.muted = this.muted;
      audio.load();
      audio.play().catch(function (error) {
        Player.playing = false;
        Player.emit('state');
        if (error && error.name === 'NotAllowedError' && Player.onError) Player.onError('blocked');
      });
      this.buildChain();
    },

    playYouTube: function (track) {
      audio.pause();
      audio.removeAttribute('src');
      this.ensureYouTube().then(function () {
        if (!Player.track || Player.track.videoId !== track.videoId) return;
        yt.player.loadVideoById(track.videoId);
        if (Player.muted) yt.player.mute();
        else { yt.player.unMute(); yt.player.setVolume(Math.round(Player.volume * 100)); }
      }).catch(function () {
        Player.loading = false;
        Player.emit('state');
        if (Player.onError) Player.onError('yt_api');
      });
    },

    stopYouTube: function () {
      this.stopPolling();
      if (yt.player && yt.ready) {
        try { yt.player.stopVideo(); } catch (e) { /* ignore */ }
      }
    },

    ensureYouTube: function () {
      if (yt.api) return yt.api;
      yt.api = new Promise(function (resolve, reject) {
        var failTimer = setTimeout(function () { reject(new Error('timeout')); }, 15000);

        var build = function () {
          yt.player = new global.YT.Player('yt-frame', {
            height: '100%', width: '100%',
            playerVars: {
              autoplay: 1, controls: 0, disablekb: 1, modestbranding: 1,
              rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0
            },
            events: {
              onReady: function () { yt.ready = true; clearTimeout(failTimer); resolve(); },
              onStateChange: Player.onYouTubeState,
              onError: function (event) {
                Player.loading = false;
                Player.emit('state');
                if (Player.onError) {
                  Player.onError(event.data === 101 || event.data === 150 ? 'embed_blocked' : 'video');
                }
              }
            }
          });
        };

        if (global.YT && global.YT.Player) { build(); return; }
        var prior = global.onYouTubeIframeAPIReady;
        global.onYouTubeIframeAPIReady = function () {
          if (typeof prior === 'function') prior();
          build();
        };
        var script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        script.onerror = function () { clearTimeout(failTimer); reject(new Error('script')); };
        document.head.appendChild(script);
      });
      return yt.api;
    },

    onYouTubeState: function (event) {
      var state = global.YT.PlayerState;
      if (event.data === state.PLAYING) {
        Player.playing = true;
        Player.loading = false;
        Player.duration = yt.player.getDuration() || Player.duration;
        Player.startPolling();
      } else if (event.data === state.PAUSED) {
        Player.playing = false;
        Player.stopPolling();
      } else if (event.data === state.BUFFERING) {
        Player.loading = true;
      } else if (event.data === state.ENDED) {
        Player.playing = false;
        Player.stopPolling();
        Player.handleEnded();
      }
      Player.emit('state');
    },

    startPolling: function () {
      this.stopPolling();
      pollTimer = setInterval(function () {
        if (!yt.player || !yt.ready || document.hidden) return;
        Player.position = yt.player.getCurrentTime() || 0;
        Player.duration = yt.player.getDuration() || Player.duration;
        Player.emitTime();
      }, 500);
    },

    stopPolling: function () {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    },

    /** Only tell the UI when the visible second actually changed. */
    emitTime: function () {
      var second = Math.floor(this.position);
      if (second === lastEmittedPosition) return;
      lastEmittedPosition = second;
      this.updatePositionState();
      this.emit('time');
    },

    handleEnded: function () {
      if (this.sleepAtEnd) {
        this.sleepAtEnd = false;
        this.pause();
        this.emit('sleep');
        return;
      }
      if (!this.autoplay) { this.emit('state'); return; }
      this.next(true);
    },

    /* ---------------------------------------------------------- controls */

    seekTo: function (seconds) {
      if (!this.track) return;
      if (this.track.source === 'youtube') {
        if (yt.player && yt.ready) yt.player.seekTo(seconds, true);
      } else {
        audio.currentTime = seconds;
      }
      this.position = seconds;
      lastEmittedPosition = -1;
      this.emitTime();
    },

    seekFraction: function (fraction) {
      if (this.duration) this.seekTo(Math.max(0, Math.min(1, fraction)) * this.duration);
    },

    setVolume: function (value) {
      this.volume = Math.max(0, Math.min(1, value));
      this.muted = false;
      audio.volume = this.volume;
      audio.muted = false;
      if (yt.player && yt.ready) { yt.player.unMute(); yt.player.setVolume(Math.round(this.volume * 100)); }
      if (global.Store) { Store.prefs.volume = this.volume; Store.prefs.muted = false; Store.savePrefs(); }
      this.emit('volume');
    },

    toggleMute: function () {
      this.muted = !this.muted;
      audio.muted = this.muted;
      if (yt.player && yt.ready) {
        if (this.muted) yt.player.mute();
        else { yt.player.unMute(); yt.player.setVolume(Math.round(this.volume * 100)); }
      }
      if (global.Store) { Store.prefs.muted = this.muted; Store.savePrefs(); }
      this.emit('volume');
    },

    cycleRepeat: function () {
      var order = ['off', 'all', 'one'];
      this.repeat = order[(order.indexOf(this.repeat) + 1) % order.length];
      if (global.Store) { Store.prefs.repeat = this.repeat; Store.savePrefs(); }
      this.emit('mode');
      return this.repeat;
    },

    toggleShuffle: function () {
      this.shuffle = !this.shuffle;
      if (global.Store) { Store.prefs.shuffle = this.shuffle; Store.savePrefs(); }
      this.emit('mode');
      return this.shuffle;
    },

    setAutoplay: function (value) {
      this.autoplay = !!value;
      if (global.Store) { Store.prefs.autoplay = this.autoplay; Store.savePrefs(); }
      this.emit('mode');
    },

    setSleep: function (value) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
      this.sleepAtEnd = false;
      if (value === 'end') this.sleepAtEnd = true;
      else if (Number(value) > 0) {
        this.sleepTimer = setTimeout(function () { Player.pause(); Player.emit('sleep'); }, Number(value) * 60000);
      }
      this.emit('sleep');
    },

    /* ------------------------------------------- equaliser for local files */

    eqIsActive: function () {
      var eq = (prefs().eq) || {};
      return !!(eq.bass || eq.mid || eq.treble || eq.loud);
    },

    /* The equaliser routes the element through Web Audio. Some Android builds suspend
       that graph in the background, which would silence playback — so the graph is only
       created when the equaliser is actually in use. Flat EQ = plain <audio> = safest. */
    buildChain: function (force) {
      if (!force && !this.eqIsActive()) return;
      if (sound.tried || location.protocol === 'file:') { this.applyEq(); return; }
      sound.tried = true;
      try {
        var Ctx = global.AudioContext || global.webkitAudioContext;
        if (!Ctx) return;
        var ctx = new Ctx();
        var source = ctx.createMediaElementSource(audio);
        var bass = ctx.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 190;
        var mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1100; mid.Q.value = 0.9;
        var treble = ctx.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 4800;
        var comp = ctx.createDynamicsCompressor();
        var gain = ctx.createGain();
        source.connect(bass); bass.connect(mid); mid.connect(treble);
        treble.connect(comp); comp.connect(gain); gain.connect(ctx.destination);
        sound = Object.assign(sound, {
          ready: true, ctx: ctx, bass: bass, mid: mid, treble: treble, comp: comp, gain: gain
        });
        this.applyEq();
      } catch (e) { sound.ready = false; }
    },

    applyEq: function () {
      if (!sound.ready) {
        if (this.eqIsActive() && this.track && this.track.source !== 'youtube') this.buildChain(true);
        return;
      }
      if (!global.Store) return;
      var eq = Store.prefs.eq || { bass: 0, mid: 0, treble: 0, loud: false };
      sound.bass.gain.value = eq.bass;
      sound.mid.gain.value = eq.mid;
      sound.treble.gain.value = eq.treble;
      if (eq.loud) {
        sound.comp.threshold.value = -20; sound.comp.knee.value = 18; sound.comp.ratio.value = 6;
        sound.comp.attack.value = 0.005; sound.comp.release.value = 0.25; sound.gain.gain.value = 1.45;
      } else {
        sound.comp.threshold.value = 0; sound.comp.knee.value = 0; sound.comp.ratio.value = 1;
        sound.gain.gain.value = 1;
      }
      if (sound.ctx && sound.ctx.state === 'suspended') sound.ctx.resume();
    },

    /* ----------------------------------------------------- media session */

    updateMediaSession: function () {
      if (!('mediaSession' in navigator) || !this.track) return;
      try {
        var art = this.track.artwork || 'icon-512.png';
        navigator.mediaSession.metadata = new global.MediaMetadata({
          title: this.track.title,
          artist: this.track.artist,
          album: 'muzzz',
          artwork: [
            { src: art, sizes: '512x512' },
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' }
          ]
        });
        var handlers = {
          play: function () { Player.resume(); },
          pause: function () { Player.pause(); },
          stop: function () { Player.pause(); },
          previoustrack: function () { Player.prev(); },
          nexttrack: function () { Player.next(false); },
          seekbackward: function (d) { Player.seekTo(Math.max(0, Player.position - ((d && d.seekOffset) || 10))); },
          seekforward: function (d) { Player.seekTo(Player.position + ((d && d.seekOffset) || 10)); },
          seekto: function (d) { if (d && d.seekTime != null) Player.seekTo(d.seekTime); }
        };
        Object.keys(handlers).forEach(function (name) {
          try { navigator.mediaSession.setActionHandler(name, handlers[name]); } catch (e) { /* unsupported action */ }
        });
      } catch (e) { /* ignore */ }
    },

    /** Lock screen scrubber + play/pause state, so the phone can drive playback. */
    updatePositionState: function () {
      if (!('mediaSession' in navigator)) return;
      try {
        navigator.mediaSession.playbackState = !this.track ? 'none' : (this.playing ? 'playing' : 'paused');
        var duration = this.duration;
        if (navigator.mediaSession.setPositionState && duration > 0 && isFinite(duration) && !isNaN(duration)) {
          navigator.mediaSession.setPositionState({
            duration: duration,
            position: Math.max(0, Math.min(this.position || 0, duration)),
            playbackRate: audio.playbackRate || 1
          });
        }
      } catch (e) { /* ignore */ }
    }
  };

  /* --------------------------------------------------- local audio events */

  audio.addEventListener('playing', function () {
    Player.playing = true; Player.loading = false;
    if (sound.ctx && sound.ctx.state === 'suspended') sound.ctx.resume();
    Player.updatePositionState();
    Player.emit('state');
  });
  audio.addEventListener('pause', function () {
    Player.playing = false;
    Player.updatePositionState();
    Player.emit('state');
  });
  audio.addEventListener('waiting', function () { Player.loading = true; Player.emit('state'); });
  audio.addEventListener('timeupdate', function () {
    if (Player.track && Player.track.source !== 'youtube') {
      Player.position = audio.currentTime;
      Player.emitTime();
    }
  });
  audio.addEventListener('loadedmetadata', function () {
    if (Player.track && Player.track.source !== 'youtube' && isFinite(audio.duration)) {
      Player.duration = audio.duration;
      lastEmittedPosition = -1;
      Player.emitTime();
    }
  });
  audio.addEventListener('canplay', function () {
    if (Player.track && Player.track.source !== 'youtube') { Player.loading = false; Player.emit('state'); }
  });
  audio.addEventListener('seeking', function () { Player.loading = true; Player.emit('state'); });
  audio.addEventListener('seeked', function () {
    Player.loading = false;
    Player.position = audio.currentTime;
    lastEmittedPosition = -1;
    Player.emitTime();
    Player.emit('state');
  });
  audio.addEventListener('ended', function () { Player.handleEnded(); });
  audio.addEventListener('error', function () {
    if (!audio.getAttribute('src')) return;          // cleared on purpose, not a failure
    Player.loading = false;
    Player.playing = false;
    Player.emit('state');
    if (Player.onError) Player.onError('local_file');
  });

  /* The browser may suspend the Web Audio graph when the app is backgrounded;
     resuming it keeps local playback alive with the screen off. */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (sound.ctx && sound.ctx.state === 'suspended') sound.ctx.resume();
    Player.updatePositionState();
  });

  global.Player = Player;
})(window);
