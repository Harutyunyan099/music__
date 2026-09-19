/* muzzz — service worker.
   Job 1: the app opens even without internet (and installs as a real app, which is
   what lets local songs keep playing when the screen goes off).
   Job 2: the site updates itself — a new VERSION replaces the old cache on the next visit. */

var VERSION = 'muzzz-v4.2.0';
var SHELL_CACHE = VERSION + '-shell';
var MEDIA_CACHE = VERSION + '-media';

var SHELL = [
  './', 'index.html', 'style.css',
  'app.js', 'store.js', 'api.js', 'player.js', 'wave.js', 'i18n.js',
  'songs.json', 'manifest.json', 'icon-192.png', 'icon-512.png'
];

var MEDIA = /\.(m4a|mp3|wav|flac|ogg|opus|jpg|jpeg|png|webp|svg)$/i;

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // cached one by one: a single missing file must not break the whole install
      return Promise.all(SHELL.map(function (url) {
        return cache.add(url).catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key.indexOf(VERSION) !== 0) return caches.delete(key);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

function networkFirst(request) {
  return fetch(request).then(function (response) {
    if (response && response.status === 200) {
      var copy = response.clone();
      caches.open(SHELL_CACHE).then(function (cache) { cache.put(request, copy); });
    }
    return response;
  }).catch(function () {
    return caches.match(request).then(function (cached) {
      return cached || caches.match('index.html');
    });
  });
}

function cacheFirst(request) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      if (response && response.status === 200 && response.type === 'basic') {
        var copy = response.clone();
        caches.open(MEDIA_CACHE).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;        // YouTube and friends: untouched
  if (url.pathname.indexOf('/api/') === 0) return;        // search always goes to the network

  // Range requests (audio seeking) must never be answered from a cached partial body
  if (request.headers.get('range')) return;

  if (MEDIA.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(networkFirst(request));
});
