/* muzzz — one player for two sources: local audio files and the YouTube embed */
(function (global) {
  'use strict';

  var audio = new Audio();
  audio.preload = 'metadata';

  var listeners = [];
  var pollTimer = null;
  var yt = { api: null, player: null, ready: false, pending: null };
  var sound = { ready: false, tried: false, ctx: null, bass: null, mid: null, treble: null, comp: null, gain: null };

  var Player = {
    track: null,
    queue: [],
    index: -1,
    context: 'list',        // list | wave | collection ...
    playing: false,
    loading: false,
    position: 0,
    duration: 0,
    volume: 0.85,
    muted: false,
    sleepTimer: null,
    sleepAtEnd: false,
    onEnded: null,          // set by the app (wave continues the stream)
    onError: null,

    on: function (fn) { listeners.push(fn); },
    emit: function (what) { listeners.forEach(function (fn) { fn(what, Player); }); },

    /* ------------------------------------------------------------ queue */

    setQueue: function (tracks, index, context) {
      this.queue = (tracks || []).slice();
      this.index = typeof index === 'number' ? index : -1;
      this.context = context || 'list';
      this.emit('queue');
    },

    play: function (track, options) {
      options = options || {};
      if (options.queue) this.setQueue(options.queue, options.index, options.context);
      else if (options.context) this.context = options.context;

      if (!track) return;
      if (this.track && this.track.id === track.id) { this.toggle(); return; }

      this.track = track;
      this.position = 0;
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
      if (this.track.source === 'youtube') {
        if (!yt.player || !yt.ready) return;
        if (this.playing) yt.player.pauseVideo();
        else yt.player.playVideo();
      } else {
        if (this.playing) audio.pause();
        else audio.play().catch(function () {});
      }
    },

    pause: function () {
      if (!this.track) return;
      if (this.track.source === 'youtube') { if (yt.player && yt.ready) yt.player.pauseVideo(); }
      else audio.pause();
    },

    next: function (auto) {
      if (this.context === 'wave' && typeof this.onEnded === 'function') {
        this.onEnded(auto === true);
        return;
      }
      if (!this.queue.length) return;
      var nextIndex = this.index + 1;
      if (nextIndex >= this.queue.length) {
        if (auto) { this.pause(); return; }
        nextIndex = 0;
      }
      this.index = nextIndex;
      this.play(this.queue[nextIndex], { context: this.context });
    },

    prev: function () {
      if (this.position > 4) { this.seekTo(0); return; }
      if (!this.queue.length) return;
      var prevIndex = this.index - 1;
      if (prevIndex < 0) prevIndex = this.queue.length - 1;
      this.index = prevIndex;
      this.play(this.queue[prevIndex], { context: this.context });
    },

    /* ----------------------------------------------------------- sources */

    playLocal: function (track) {
      this.stopYouTube();
      audio.src = track.src;
      audio.volume = this.muted ? 0 : this.volume;
      audio.load();
      audio.play().catch(function () { Player.playing = false; Player.emit('state'); });
      this.buildChain();
    },

    playYouTube: function (track) {
      audio.pause();
      audio.removeAttribute('src');
      this.ensureYouTube().then(function () {
        if (!Player.track || Player.track.videoId !== track.videoId) return;
        yt.player.loadVideoById(track.videoId);
        yt.player.setVolume(Player.muted ? 0 : Math.round(Player.volume * 100));
      }).catch(function () {
        Player.loading = false;
        Player.emit('state');
        if (Player.onError) Player.onError('yt_api');
      });
    },

    stopYouTube: function () {
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
                if (Player.onError) Player.onError(event.data === 101 || event.data === 150 ? 'embed_blocked' : 'video');
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
        script.onerror = function () { reject(new Error('script')); };
        document.head.appendChild(script);
      });
      return yt.api;
    },

    onYouTubeState: function (event) {
      var YTState = global.YT.PlayerState;
      if (event.data === YTState.PLAYING) {
        Player.playing = true;
        Player.loading = false;
        Player.duration = yt.player.getDuration() || Player.duration;
        Player.startPolling();
      } else if (event.data === YTState.PAUSED) {
        Player.playing = false;
        Player.stopPolling();
      } else if (event.data === YTState.BUFFERING) {
        Player.loading = true;
      } else if (event.data === YTState.ENDED) {
        Player.playing = false;
        Player.stopPolling();
        Player.handleEnded();
      }
      Player.emit('state');
    },

    startPolling: function () {
      this.stopPolling();
      pollTimer = setInterval(function () {
        if (!yt.player || !yt.ready) return;
        Player.position = yt.player.getCurrentTime() || 0;
        Player.duration = yt.player.getDuration() || Player.duration;
        Player.emit('time');
      }, 300);
    },

    stopPolling: function () {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    },

    handleEnded: function () {
      if (this.sleepAtEnd) {
        this.sleepAtEnd = false;
        this.emit('sleep');
        return;
      }
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
      this.emit('time');
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

    buildChain: function () {
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
        sound = Object.assign(sound, { ready: true, ctx: ctx, bass: bass, mid: mid, treble: treble, comp: comp, gain: gain });
        this.applyEq();
      } catch (e) { sound.ready = false; }
    },

    applyEq: function () {
      if (!sound.ready || !global.Store) return;
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
        navigator.mediaSession.metadata = new global.MediaMetadata({
          title: this.track.title,
          artist: this.track.artist,
          album: 'muzzz',
          artwork: [{ src: this.track.artwork || 'placeholder.svg', sizes: '480x360' }]
        });
        navigator.mediaSession.setActionHandler('play', function () { Player.toggle(); });
        navigator.mediaSession.setActionHandler('pause', function () { Player.toggle(); });
        navigator.mediaSession.setActionHandler('previoustrack', function () { Player.prev(); });
        navigator.mediaSession.setActionHandler('nexttrack', function () { Player.next(false); });
      } catch (e) { /* ignore */ }
    }
  };

  /* --------------------------------------------------- local audio events */

  audio.addEventListener('playing', function () {
    Player.playing = true; Player.loading = false; Player.emit('state');
  });
  audio.addEventListener('pause', function () { Player.playing = false; Player.emit('state'); });
  audio.addEventListener('waiting', function () { Player.loading = true; Player.emit('state'); });
  audio.addEventListener('timeupdate', function () {
    if (Player.track && Player.track.source !== 'youtube') {
      Player.position = audio.currentTime;
      Player.emit('time');
    }
  });
  audio.addEventListener('loadedmetadata', function () {
    if (Player.track && Player.track.source !== 'youtube' && isFinite(audio.duration)) {
      Player.duration = audio.duration;
      Player.emit('time');
    }
  });
  audio.addEventListener('ended', function () { Player.handleEnded(); });
  audio.addEventListener('error', function () {
    Player.loading = false;
    Player.playing = false;
    Player.emit('state');
    if (Player.onError) Player.onError('local_file');
  });

  global.Player = Player;
})(window);
