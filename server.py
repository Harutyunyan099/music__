#!/usr/bin/env python3
"""muzzz — static server + YouTube Data API v3 proxy.

Local:      python server.py            -> http://localhost:8000
Render:     Start command: python server.py   (binds 0.0.0.0 and uses $PORT)

The API key is read from the environment (or a local .env) and never leaves this
process: the browser only ever talks to /api/* on this server.

    YOUTUBE_API_KEY=AIza...        required for search
    PORT=8000                      set automatically by Render
    OPEN_BROWSER=1                 local convenience, off by default
    YOUTUBE_API_BASE=...           only used for tests against a mock
"""

import json
import os
import re
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
API_BASE = os.environ.get('YOUTUBE_API_BASE', 'https://www.googleapis.com/youtube/v3')

CACHE_TTL = 600            # seconds a search result stays warm
CACHE_MAX = 200
UPSTREAM_TIMEOUT = 12

# Never hand these to a browser, even though they live next to index.html.
BLOCKED_NAMES = {'.env', '.env.local', '.git', '.gitignore', 'server.py', 'requirements.txt', 'procfile'}
BLOCKED_SUFFIXES = ('.py', '.pyc', '.key', '.pem', '.log')

STATIC_CACHE = {
    '.m4a': 'public, max-age=604800', '.mp3': 'public, max-age=604800',
    '.wav': 'public, max-age=604800', '.flac': 'public, max-age=604800',
    '.jpg': 'public, max-age=604800', '.jpeg': 'public, max-age=604800',
    '.png': 'public, max-age=604800', '.webp': 'public, max-age=604800',
    '.svg': 'public, max-age=86400',
    '.css': 'public, max-age=3600', '.js': 'public, max-age=3600',
}


# --------------------------------------------------------------------------- env

def load_env():
    """Read .env (KEY=VALUE per line) without overriding real environment vars."""
    path = os.path.join(ROOT, '.env')
    if not os.path.exists(path):
        return
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        pass


def api_key():
    return (os.environ.get('YOUTUBE_API_KEY') or '').strip()


# ------------------------------------------------------------------------- cache

_cache = {}
_cache_lock = threading.Lock()


def cache_get(key):
    with _cache_lock:
        hit = _cache.get(key)
        if not hit:
            return None
        if time.time() - hit[0] > CACHE_TTL:
            _cache.pop(key, None)
            return None
        return hit[1]


def cache_put(key, value):
    with _cache_lock:
        if len(_cache) >= CACHE_MAX:
            oldest = min(_cache.items(), key=lambda item: item[1][0])[0]
            _cache.pop(oldest, None)
        _cache[key] = (time.time(), value)


# ---------------------------------------------------------------------- youtube

ISO_DURATION = re.compile(r'P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?')


def iso_to_seconds(value):
    match = ISO_DURATION.match(value or '')
    if not match:
        return 0
    days, hours, minutes, seconds = (int(part or 0) for part in match.groups())
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


class UpstreamError(Exception):
    def __init__(self, code, reason):
        super().__init__(reason)
        self.code = code
        self.reason = reason


def call_youtube(endpoint, params):
    key = api_key()
    if not key:
        raise UpstreamError(503, 'no_key')

    query = dict(params)
    query['key'] = key
    url = API_BASE + '/' + endpoint + '?' + urllib.parse.urlencode(query, doseq=True)
    request = urllib.request.Request(url, headers={'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as error:
        body = ''
        try:
            body = error.read().decode('utf-8', 'replace')
        except Exception:
            pass
        reason = 'upstream'
        if 'quotaExceeded' in body or 'dailyLimitExceeded' in body:
            reason = 'quota'
        elif error.code in (400, 403) and ('keyInvalid' in body or 'API key not valid' in body):
            reason = 'bad_key'
        elif error.code == 403:
            reason = 'forbidden'
        elif error.code == 404:
            reason = 'not_found'
        # the upstream body is never forwarded: it can echo the key back
        print('[youtube] %s -> %s (%s)' % (endpoint, error.code, reason), file=sys.stderr)
        raise UpstreamError(502 if error.code >= 500 else 400, reason)
    except urllib.error.URLError as error:
        print('[youtube] network error: %s' % error.reason, file=sys.stderr)
        raise UpstreamError(504, 'network')
    except (ValueError, TimeoutError):
        raise UpstreamError(502, 'bad_response')


def shape_items(payload):
    """search.list (+ videos.list) -> flat track objects the frontend understands."""
    items = payload.get('items') or []
    order = []
    base = {}

    for item in items:
        raw_id = item.get('id')
        video_id = raw_id.get('videoId') if isinstance(raw_id, dict) else raw_id
        if not isinstance(video_id, str):
            continue
        snippet = item.get('snippet') or {}
        thumbs = snippet.get('thumbnails') or {}
        thumb = (thumbs.get('medium') or thumbs.get('high') or thumbs.get('default') or {}).get('url', '')
        base[video_id] = {
            'videoId': video_id,
            'title': snippet.get('title', ''),
            'channel': snippet.get('channelTitle', ''),
            'channelId': snippet.get('channelId', ''),
            'thumbnail': thumb,
            'publishedAt': snippet.get('publishedAt', ''),
            'duration': iso_to_seconds((item.get('contentDetails') or {}).get('duration')),
            'views': int((item.get('statistics') or {}).get('viewCount') or 0),
            'embeddable': (item.get('status') or {}).get('embeddable', True)
        }
        order.append(video_id)

    missing = [i for i in order if not base[i]['duration']]
    if missing:
        try:
            details = call_youtube('videos', {
                'part': 'contentDetails,statistics,status',
                'id': ','.join(missing[:50]),
                'maxResults': 50
            })
            for video in details.get('items') or []:
                entry = base.get(video.get('id'))
                if not entry:
                    continue
                entry['duration'] = iso_to_seconds((video.get('contentDetails') or {}).get('duration'))
                entry['views'] = int((video.get('statistics') or {}).get('viewCount') or 0)
                entry['embeddable'] = (video.get('status') or {}).get('embeddable', True)
        except UpstreamError:
            pass          # duration is nice to have, not critical

    tracks = [base[i] for i in order if base[i].get('embeddable', True)]
    return {
        'items': tracks,
        'nextPageToken': payload.get('nextPageToken', ''),
        'totalResults': (payload.get('pageInfo') or {}).get('totalResults', len(tracks))
    }


def youtube_search(query, page_token='', max_results=24, order='relevance'):
    cache_key = 'search:%s:%s:%s:%s' % (query.lower().strip(), page_token, max_results, order)
    cached = cache_get(cache_key)
    if cached:
        return cached

    payload = call_youtube('search', {
        'part': 'snippet',
        'q': query,
        'type': 'video',
        'videoCategoryId': '10',          # Music
        'videoEmbeddable': 'true',
        'videoSyndicated': 'true',
        'maxResults': max_results,
        'order': order,
        'pageToken': page_token
    })
    result = shape_items(payload)
    cache_put(cache_key, result)
    return result


def youtube_videos(ids):
    cache_key = 'videos:' + ','.join(sorted(ids))
    cached = cache_get(cache_key)
    if cached:
        return cached

    payload = call_youtube('videos', {
        'part': 'snippet,contentDetails,statistics,status',
        'id': ','.join(ids[:50])
    })
    result = shape_items({'items': payload.get('items') or []})
    cache_put(cache_key, result)
    return result


# ------------------------------------------------------------------------ server

class Handler(SimpleHTTPRequestHandler):
    server_version = 'muzzz'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.json': 'application/json',
        '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
        '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
        '.svg': 'image/svg+xml', '.webp': 'image/webp',
    }

    # ---- helpers ----------------------------------------------------------

    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def send_error_json(self, status, reason):
        self.send_json({'error': reason}, status)

    def log_message(self, fmt, *args):
        if len(args) > 1 and isinstance(args[1], str) and args[1] not in ('200', '206', '304'):
            sys.stderr.write('  %s %s\n' % (args[1], args[0]))

    def is_blocked(self, path):
        """Secrets and server source are never served, whatever the URL looks like."""
        name = os.path.basename(urllib.parse.unquote(path).split('?')[0]).lower()
        if name in BLOCKED_NAMES or name.endswith(BLOCKED_SUFFIXES):
            return True
        parts = [p.lower() for p in urllib.parse.unquote(path).split('/') if p]
        return any(part.startswith('.') for part in parts)

    # ---- api --------------------------------------------------------------

    def handle_api(self, path, params):
        if path == '/api/status':
            self.send_json({'youtube': bool(api_key()), 'version': 3})
            return

        if path == '/api/search':
            query = (params.get('q') or [''])[0].strip()[:120]
            if not query:
                self.send_error_json(400, 'empty_query')
                return
            try:
                limit = max(1, min(int((params.get('limit') or ['24'])[0]), 50))
            except ValueError:
                limit = 24
            order = (params.get('order') or ['relevance'])[0]
            if order not in ('relevance', 'viewCount', 'date', 'rating'):
                order = 'relevance'
            page_token = (params.get('pageToken') or [''])[0]
            if not re.fullmatch(r'[\w=-]{0,64}', page_token):
                page_token = ''
            try:
                self.send_json(youtube_search(query, page_token, limit, order))
            except UpstreamError as error:
                self.send_error_json(error.code, error.reason)
            return

        if path == '/api/videos':
            raw = (params.get('ids') or [''])[0]
            ids = [i.strip() for i in raw.split(',') if re.fullmatch(r'[\w-]{5,20}', i.strip())]
            if not ids:
                self.send_error_json(400, 'empty_ids')
                return
            try:
                self.send_json(youtube_videos(ids))
            except UpstreamError as error:
                self.send_error_json(error.code, error.reason)
            return

        self.send_error_json(404, 'unknown_endpoint')

    # ---- static -----------------------------------------------------------

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path.startswith('/api/'):
            self.handle_api(parsed.path, urllib.parse.parse_qs(parsed.query))
            return

        if self.is_blocked(parsed.path):
            self.send_error_json(404, 'not_found')
            return

        range_header = self.headers.get('Range')
        if range_header and self.serve_range(range_header):
            return
        super().do_GET()

    def serve_range(self, range_header):
        """Partial content so seeking inside local audio works in every browser."""
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return False
        match = re.match(r'bytes=(\d*)-(\d*)', range_header.strip())
        if not match:
            return False

        size = os.path.getsize(path)
        start_raw, end_raw = match.groups()
        if start_raw == '':
            if end_raw == '':
                return False
            length = min(int(end_raw), size)
            start, end = size - length, size - 1
        else:
            start = int(start_raw)
            end = int(end_raw) if end_raw else size - 1
        if start >= size:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header('Content-Range', 'bytes */%d' % size)
            self.end_headers()
            return True
        end = min(end, size - 1)

        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        if self.command == 'HEAD':
            return True

        remaining = end - start + 1
        with open(path, 'rb') as handle:
            handle.seek(start)
            while remaining > 0:
                chunk = handle.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return True
                remaining -= len(chunk)
        return True

    def end_headers(self):
        path = urllib.parse.urlparse(self.path).path
        name = os.path.basename(path).lower()
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')

        if name == 'sw.js':
            # the service worker itself must never be cached, or updates never arrive
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Service-Worker-Allowed', '/')
        elif name in ('', 'index.html', 'manifest.json'):
            self.send_header('Cache-Control', 'no-cache')
        else:
            suffix = os.path.splitext(path)[1].lower()
            if suffix in STATIC_CACHE and not path.startswith('/api/'):
                self.send_header('Cache-Control', STATIC_CACHE[suffix])
        super().end_headers()


def main():
    load_env()
    port = int(os.environ.get('PORT') or (sys.argv[1] if len(sys.argv) > 1 else 8000))
    host = os.environ.get('HOST', '0.0.0.0')        # Render needs 0.0.0.0
    attempts = 1 if os.environ.get('PORT') else 20  # never wander off $PORT in production

    for _ in range(attempts):
        try:
            socketserver.TCPServer.allow_reuse_address = True
            with ThreadingHTTPServer((host, port), Handler) as httpd:
                print('\n  muzzz is running on http://localhost:%d/' % port)
                print('  YouTube API key:   %s' % ('loaded' if api_key() else 'NOT SET (search disabled)'))
                if not api_key():
                    print('  -> put YOUTUBE_API_KEY=your_key in a .env file next to server.py')
                print('  Stop with Ctrl+C\n')

                if os.environ.get('OPEN_BROWSER') == '1':
                    try:
                        import webbrowser
                        webbrowser.open('http://localhost:%d/' % port)
                    except Exception:
                        pass

                httpd.serve_forever()
            return
        except OSError:
            port += 1
    print('Could not bind a port.')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\n  Bye.')
