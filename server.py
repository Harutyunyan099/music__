#!/usr/bin/env python3
"""muzzz — online/local server and YouTube Data API proxy."""

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

API_BASE = os.environ.get(
    'YOUTUBE_API_BASE',
    'https://www.googleapis.com/youtube/v3'
)

CACHE_TTL = 600
CACHE_MAX = 200
UPSTREAM_TIMEOUT = 12


# ---------------------------------------------------------------------------
# ENV
# ---------------------------------------------------------------------------

def load_env():
    """Read .env without overriding real environment variables."""

    path = os.path.join(ROOT, '.env')

    if not os.path.exists(path):
        return

    try:
        with open(path, 'r', encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()

                if not line:
                    continue

                if line.startswith('#'):
                    continue

                if '=' not in line:
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


# ---------------------------------------------------------------------------
# CACHE
# ---------------------------------------------------------------------------

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

            oldest = min(
                _cache.items(),
                key=lambda item: item[1][0]
            )[0]

            _cache.pop(oldest, None)

        _cache[key] = (time.time(), value)


# ---------------------------------------------------------------------------
# YOUTUBE
# ---------------------------------------------------------------------------

ISO_DURATION = re.compile(
    r'P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?'
)


def iso_to_seconds(value):
    match = ISO_DURATION.match(value or '')

    if not match:
        return 0

    days, hours, minutes, seconds = (
        int(part or 0)
        for part in match.groups()
    )

    return (
        days * 86400
        + hours * 3600
        + minutes * 60
        + seconds
    )


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

    url = (
        API_BASE
        + '/'
        + endpoint
        + '?'
        + urllib.parse.urlencode(query, doseq=True)
    )

    request = urllib.request.Request(
        url,
        headers={
            'Accept': 'application/json'
        }
    )

    try:

        with urllib.request.urlopen(
            request,
            timeout=UPSTREAM_TIMEOUT
        ) as response:

            return json.loads(
                response.read().decode('utf-8')
            )

    except urllib.error.HTTPError as error:

        body = ''

        try:
            body = error.read().decode(
                'utf-8',
                'replace'
            )
        except Exception:
            pass

        reason = 'upstream'

        if (
            'quotaExceeded' in body
            or 'dailyLimitExceeded' in body
        ):
            reason = 'quota'

        elif (
            error.code in (400, 403)
            and (
                'keyInvalid' in body
                or 'API key not valid' in body
            )
        ):
            reason = 'bad_key'

        elif error.code == 403:
            reason = 'forbidden'

        elif error.code == 404:
            reason = 'not_found'

        print(
            '[youtube] %s -> %s (%s)'
            % (endpoint, error.code, reason),
            file=sys.stderr
        )

        raise UpstreamError(
            502 if error.code >= 500 else 400,
            reason
        )

    except urllib.error.URLError as error:

        print(
            '[youtube] network error: %s'
            % error.reason,
            file=sys.stderr
        )

        raise UpstreamError(
            504,
            'network'
        )

    except (
        ValueError,
        TimeoutError
    ):

        raise UpstreamError(
            502,
            'bad_response'
        )


def shape_items(search_payload):

    items = search_payload.get('items') or []

    ids = []
    base = {}

    for item in items:

        video_id = (
            (item.get('id') or {}).get('videoId')
            if isinstance(item.get('id'), dict)
            else item.get('id')
        )

        if not isinstance(video_id, str):
            continue

        snippet = item.get('snippet') or {}

        thumbs = snippet.get('thumbnails') or {}

        thumb = (
            thumbs.get('high')
            or thumbs.get('medium')
            or thumbs.get('default')
            or {}
        ).get('url', '')

        entry = {
            'videoId': video_id,
            'title': snippet.get('title', ''),
            'channel': snippet.get('channelTitle', ''),
            'channelId': snippet.get('channelId', ''),
            'thumbnail': thumb,
            'publishedAt': snippet.get('publishedAt', ''),
            'duration': iso_to_seconds(
                (item.get('contentDetails') or {}).get(
                    'duration'
                )
            ),
            'views': int(
                (item.get('statistics') or {}).get(
                    'viewCount'
                )
                or 0
            ),
            'embeddable': (
                item.get('status') or {}
            ).get(
                'embeddable',
                True
            )
        }

        base[video_id] = entry
        ids.append(video_id)

    missing = [
        video_id
        for video_id in ids
        if not base[video_id]['duration']
    ]

    if missing:

        try:

            details = call_youtube(
                'videos',
                {
                    'part': (
                        'contentDetails,statistics,status'
                    ),
                    'id': ','.join(
                        missing[:50]
                    ),
                    'maxResults': 50
                }
            )

            for video in details.get('items') or []:

                entry = base.get(
                    video.get('id')
                )

                if not entry:
                    continue

                entry['duration'] = iso_to_seconds(
                    (
                        video.get(
                            'contentDetails'
                        )
                        or {}
                    ).get('duration')
                )

                entry['views'] = int(
                    (
                        video.get(
                            'statistics'
                        )
                        or {}
                    ).get(
                        'viewCount'
                    )
                    or 0
                )

                entry['embeddable'] = (
                    video.get('status')
                    or {}
                ).get(
                    'embeddable',
                    True
                )

        except UpstreamError:
            pass

    tracks = [
        base[video_id]
        for video_id in ids
        if base[video_id].get(
            'embeddable',
            True
        )
    ]

    return {
        'items': tracks,
        'nextPageToken': search_payload.get(
            'nextPageToken',
            ''
        ),
        'totalResults': (
            search_payload.get('pageInfo')
            or {}
        ).get(
            'totalResults',
            len(tracks)
        )
    }


def youtube_search(
    query,
    page_token='',
    max_results=24,
    order='relevance'
):

    cache_key = (
        'search:%s:%s:%s:%s'
        % (
            query.lower().strip(),
            page_token,
            max_results,
            order
        )
    )

    cached = cache_get(cache_key)

    if cached:
        return cached

    payload = call_youtube(
        'search',
        {
            'part': 'snippet',
            'q': query,
            'type': 'video',
            'videoCategoryId': '10',
            'videoEmbeddable': 'true',
            'videoSyndicated': 'true',
            'maxResults': max_results,
            'order': order,
            'pageToken': page_token
        }
    )

    result = shape_items(payload)

    cache_put(
        cache_key,
        result
    )

    return result


def youtube_videos(ids):

    cache_key = (
        'videos:'
        + ','.join(
            sorted(ids)
        )
    )

    cached = cache_get(cache_key)

    if cached:
        return cached

    payload = call_youtube(
        'videos',
        {
            'part': (
                'snippet,contentDetails,'
                'statistics,status'
            ),
            'id': ','.join(
                ids[:50]
            )
        }
    )

    result = shape_items(
        {
            'items':
                payload.get('items')
                or []
        }
    )

    cache_put(
        cache_key,
        result
    )

    return result


# ---------------------------------------------------------------------------
# SERVER
# ---------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):

    server_version = 'muzzz'

    def __init__(
        self,
        *args,
        **kwargs
    ):

        super().__init__(
            *args,
            directory=ROOT,
            **kwargs
        )

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,

        '.js': 'text/javascript',
        '.json': 'application/json',

        '.mp3': 'audio/mpeg',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.ogg': 'audio/ogg',
        '.opus': 'audio/ogg',
        '.wav': 'audio/wav',
        '.flac': 'audio/flac',

        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
    }

    # -----------------------------------------------------------------------
    # JSON
    # -----------------------------------------------------------------------

    def send_json(
        self,
        payload,
        status=HTTPStatus.OK
    ):

        body = json.dumps(
            payload,
            ensure_ascii=False
        ).encode('utf-8')

        self.send_response(status)

        self.send_header(
            'Content-Type',
            'application/json; charset=utf-8'
        )

        self.send_header(
            'Content-Length',
            str(len(body))
        )

        self.send_header(
            'Cache-Control',
            'no-store'
        )

        self.end_headers()

        self.wfile.write(body)

    def send_error_json(
        self,
        status,
        reason
    ):

        self.send_json(
            {
                'error': reason
            },
            status
        )

    # -----------------------------------------------------------------------
    # LOG
    # -----------------------------------------------------------------------

    def log_message(
        self,
        fmt,
        *args
    ):

        if (
            len(args) > 1
            and isinstance(args[1], str)
            and args[1] not in (
                '200',
                '206',
                '304'
            )
        ):

            sys.stderr.write(
                '  %s %s\n'
                % (
                    args[1],
                    args[0]
                )
            )

    # -----------------------------------------------------------------------
    # API
    # -----------------------------------------------------------------------

    def handle_api(
        self,
        path,
        params
    ):

        if path == '/api/status':

            self.send_json(
                {
                    'youtube': bool(
                        api_key()
                    ),
                    'version': 2
                }
            )

            return

        if path == '/api/search':

            query = (
                params.get('q') or ['']
            )[0].strip()

            if not query:

                self.send_error_json(
                    400,
                    'empty_query'
                )

                return

            query = query[:120]

            try:

                limit = max(
                    1,
                    min(
                        int(
                            (
                                params.get(
                                    'limit'
                                )
                                or ['24']
                            )[0]
                        ),
                        50
                    )
                )

            except ValueError:

                limit = 24

            order = (
                params.get('order')
                or ['relevance']
            )[0]

            if order not in (
                'relevance',
                'viewCount',
                'date',
                'rating'
            ):

                order = 'relevance'

            page_token = (
                params.get('pageToken')
                or ['']
            )[0]

            if not re.fullmatch(
                r'[\w=-]{0,64}',
                page_token
            ):

                page_token = ''

            try:

                self.send_json(
                    youtube_search(
                        query,
                        page_token,
                        limit,
                        order
                    )
                )

            except UpstreamError as error:

                self.send_error_json(
                    error.code,
                    error.reason
                )

            return

        if path == '/api/videos':

            raw = (
                params.get('ids')
                or ['']
            )[0]

            ids = [
                item.strip()
                for item in raw.split(',')
                if re.fullmatch(
                    r'[\w-]{5,20}',
                    item.strip()
                )
            ]

            if not ids:

                self.send_error_json(
                    400,
                    'empty_ids'
                )

                return

            try:

                self.send_json(
                    youtube_videos(ids)
                )

            except UpstreamError as error:

                self.send_error_json(
                    error.code,
                    error.reason
                )

            return

        self.send_error_json(
            404,
            'unknown_endpoint'
        )

    # -----------------------------------------------------------------------
    # GET
    # -----------------------------------------------------------------------

    def do_GET(self):

        parsed = urllib.parse.urlparse(
            self.path
        )

        if parsed.path.startswith('/api/'):

            self.handle_api(
                parsed.path,
                urllib.parse.parse_qs(
                    parsed.query
                )
            )

            return

        range_header = self.headers.get(
            'Range'
        )

        if (
            range_header
            and self.serve_range(
                range_header
            )
        ):

            return

        super().do_GET()

    # -----------------------------------------------------------------------
    # RANGE
    # -----------------------------------------------------------------------

    def serve_range(
        self,
        range_header
    ):

        path = self.translate_path(
            self.path
        )

        if not os.path.isfile(path):
            return False

        match = re.match(
            r'bytes=(\d*)-(\d*)',
            range_header.strip()
        )

        if not match:
            return False

        size = os.path.getsize(path)

        start_raw, end_raw = match.groups()

        if start_raw == '':

            if end_raw == '':
                return False

            length = min(
                int(end_raw),
                size
            )

            start = size - length
            end = size - 1

        else:

            start = int(start_raw)

            end = (
                int(end_raw)
                if end_raw
                else size - 1
            )

        if start >= size:

            self.send_response(
                HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE
            )

            self.send_header(
                'Content-Range',
                'bytes */%d' % size
            )

            self.end_headers()

            return True

        end = min(
            end,
            size - 1
        )

        self.send_response(
            HTTPStatus.PARTIAL_CONTENT
        )

        self.send_header(
            'Content-Type',
            self.guess_type(path)
        )

        self.send_header(
            'Content-Range',
            'bytes %d-%d/%d'
            % (
                start,
                end,
                size
            )
        )

        self.send_header(
            'Content-Length',
            str(
                end - start + 1
            )
        )

        self.end_headers()

        remaining = (
            end - start + 1
        )

        with open(
            path,
            'rb'
        ) as handle:

            handle.seek(start)

            while remaining > 0:

                chunk = handle.read(
                    min(
                        64 * 1024,
                        remaining
                    )
                )

                if not chunk:
                    break

                try:

                    self.wfile.write(
                        chunk
                    )

                except (
                    BrokenPipeError,
                    ConnectionResetError
                ):

                    return True

                remaining -= len(chunk)

        return True

    # -----------------------------------------------------------------------
    # HEADERS
    # -----------------------------------------------------------------------

    def end_headers(self):

        self.send_header(
            'Accept-Ranges',
            'bytes'
        )

        super().end_headers()


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

def main():

    load_env()

    port = int(
        os.environ.get(
            'PORT'
        )
        or (
            sys.argv[1]
            if len(sys.argv) > 1
            else 8000
        )
    )

    for _ in range(20):

        try:

            socketserver.TCPServer.allow_reuse_address = True

            with ThreadingHTTPServer(
                (
                    '0.0.0.0',
                    port
                ),
                Handler
            ) as httpd:

                print()
                print(
                    '  muzzz is running on port %d'
                    % port
                )

                print(
                    '  YouTube API key: %s'
                    % (
                        'loaded'
                        if api_key()
                        else 'NOT SET'
                    )
                )

                if not api_key():

                    print(
                        '  Search is disabled because '
                        'YOUTUBE_API_KEY is missing.'
                    )

                print(
                    '  Stop with Ctrl+C'
                )

                print()

                httpd.serve_forever()

            return

        except OSError:

            port += 1

    print(
        'No free port found.'
    )


if __name__ == '__main__':

    try:

        main()

    except KeyboardInterrupt:

        print(
            '\n  Bye.'
        )