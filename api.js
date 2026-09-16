/* muzzz — talks to our own backend only; the YouTube key lives on the server */
(function (global) {
  'use strict';

  var memory = new Map();
  var MEM_TTL = 5 * 60 * 1000;

  function cacheKey(path, params) {
    return path + '?' + new URLSearchParams(params).toString();
  }

  function fromCache(key) {
    var hit = memory.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > MEM_TTL) { memory.delete(key); return null; }
    return hit.value;
  }

  function toCache(key, value) {
    if (memory.size > 120) memory.delete(memory.keys().next().value);
    memory.set(key, { at: Date.now(), value: value });
  }

  function request(path, params, signal) {
    var key = cacheKey(path, params);
    var cached = fromCache(key);
    if (cached) return Promise.resolve(cached);

    return fetch(key, { signal: signal })
      .then(function (response) {
        return response.json().catch(function () { return { error: 'bad_response' }; })
          .then(function (payload) {
            if (!response.ok || payload.error) {
              var error = new Error(payload.error || 'request_failed');
              error.reason = payload.error || 'request_failed';
              throw error;
            }
            return payload;
          });
      })
      .then(function (payload) { toCache(key, payload); return payload; })
      .catch(function (error) {
        if (error.name === 'AbortError') throw error;
        if (!error.reason) error.reason = 'network';
        throw error;
      });
  }

  var Api = {
    available: null,

    status: function () {
      return fetch('/api/status')
        .then(function (r) { return r.json(); })
        .then(function (data) { Api.available = !!data.youtube; return data; })
        .catch(function () { Api.available = false; return { youtube: false }; });
    },

    search: function (query, options) {
      options = options || {};
      var params = { q: query, limit: options.limit || 24 };
      if (options.pageToken) params.pageToken = options.pageToken;
      if (options.order) params.order = options.order;
      return request('/api/search', params, options.signal);
    },

    videos: function (ids) {
      return request('/api/videos', { ids: ids.join(',') });
    },

    /** search.list item -> the track shape the whole app uses */
    toTrack: function (item) {
      var parts = Api.splitTitle(item.title, item.channel);
      return {
        id: 'yt:' + item.videoId,
        source: 'youtube',
        videoId: item.videoId,
        title: parts.title,
        artist: parts.artist,
        channel: item.channel,
        channelId: item.channelId,
        artwork: item.thumbnail,
        duration: item.duration || 0,
        url: 'https://www.youtube.com/watch?v=' + item.videoId,
        views: item.views || 0
      };
    },

    /** "Artist - Song (Official Video)" -> {artist, title} */
    splitTitle: function (rawTitle, channel) {
      var title = String(rawTitle || '')
        .replace(/\s*[([][^)\]]*(official|lyric|audio|video|clip|premiere|mv|hd|4k)[^)\]]*[)\]]/gi, '')
        .replace(/\s*[|/]\s*(official|premiere).*$/gi, '')
        .trim();
      var artist = (channel || '').replace(/\s*-\s*Topic$/i, '').trim();
      var dash = title.split(/\s+[-–—]\s+/);
      if (dash.length > 1) {
        artist = dash[0].trim();
        title = dash.slice(1).join(' - ').trim();
      }
      return { artist: artist || 'Unknown', title: title || rawTitle || '' };
    }
  };

  global.Api = Api;
})(window);
