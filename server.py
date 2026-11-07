#!/usr/bin/env python3
"""
Umsteiger – small web server for the app.

Serves the app files (like `python3 -m http.server`) and answers the app's requests for timetable and
real-time data. They come from Transitous (https://transitous.org, MOTIS with open data from many
sources, see https://transitous.org/sources/), translated into the compact format of the app:

  /api/eva?q=<name>&lat=<lat>&lon=<lon>     stop id of a station (for its arrivals)
  /api/arrivals?eva=<id>[&when=<YYYY-MM-DDTHH:MM>]
                                            trains arriving in the next hour
  /api/train?journeyId=<trip>&eva=<id>[&stop=<id>&lat=&lon=]
                                            one train at one station: platform and direction of arrival
                                            (from the course of the line)
  /api/places?q=<text>[&lat=&lon=]          stations, stops, addresses and places for a search text
                                            (places near lat/lon first)
  /api/journeys?from=<id>&to=<id>[&when=<YYYY-MM-DDTHH:MM>][&arrive=1][&page=<cursor>]
                                            connections from A to B (ids from /api/places, or "lat,lon")
  /api/journey?id=<id>                      one journey of /api/journeys again, with current real-time data
  /api/nearby?lat=<lat>&lon=<lon>           stops near a point, closest first
  /api/departures?eva=<id>[&when=<YYYY-MM-DDTHH:MM>]
                                            departures of a stop (all kinds) for about an hour
  /api/trip?journeyId=<trip>                all stops of a trip with planned and real times

Times in the answers are local times (Europe/Berlin) without zone, as the app shows them.
No packages needed (Python 3.9+). Usage: python3 server.py [port] [host]
(default: port 8000, reachable from the whole network; host 127.0.0.1 = only from this machine)
"""
import gzip
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

TRANSITOUS = 'https://api.transitous.org/api'
REPOSITORY = 'https://github.com/lemmsen/umsteiger'
BERLIN = ZoneInfo('Europe/Berlin')
CACHE_SECONDS = 60
PLAN_DAILY_NOTICE = 720   # Transitous asks to get in touch above this many journey searches a day
APPROACH_M = 300          # point on the route this far before the station = direction of arrival
EVA_MAX_DIST = 1500       # m: station search result must be this close to the given position
STOP_MAX_DIST = 600       # m: a stop of the train this close to the station counts as this station
SAME_STOP_DIST = 300      # m: search results this close are the same stop (from another data source)
SHAPE_TOLERANCE = 15      # m: simplification of the course of a leg
MAX_NOTES = 5             # messages per journey, leg or stop
NEARBY_RADIUS = 1000      # m: stops this close can name a point on the map
NEARBY_MAX = 12
PLACE_BIAS = 3            # how strongly the place search prefers places near the user (Transitous default 1)
LONG_WALK = 500           # m on foot in a journey from which a quicker journey with less walking replaces it
WALK_SAVED = 300          # m: … when that one walks at least this much less
HOUR = 3600
RAIL_MODES = ['HIGHSPEED_RAIL', 'LONG_DISTANCE', 'NIGHT_RAIL', 'REGIONAL_FAST_RAIL', 'REGIONAL_RAIL',
              'RAIL', 'SUBURBAN', 'SUBWAY', 'METRO']

# Transitous mode -> product of the app (the names come from bahn.de, the app's first data source)
PRODUCT = {'HIGHSPEED_RAIL': 'ICE', 'LONG_DISTANCE': 'EC_IC', 'NIGHT_RAIL': 'EC_IC',
           'REGIONAL_FAST_RAIL': 'REGIONAL', 'REGIONAL_RAIL': 'REGIONAL', 'RAIL': 'REGIONAL',
           'SUBURBAN': 'SBAHN', 'SUBWAY': 'UBAHN', 'METRO': 'UBAHN', 'TRAM': 'TRAM', 'CABLE_CAR': 'TRAM',
           'BUS': 'BUS', 'COACH': 'BUS', 'FERRY': 'SCHIFF', 'ODM': 'ANRUFPFLICHTIG'}


def app_version():
    """Version of the app files next to this script (deploy.sh puts a checksum into sw.js)."""
    here = os.path.dirname(os.path.abspath(__file__))
    for path in (os.path.join(here, 'sw.js'), os.path.join(here, 'app', 'sw.js')):
        try:
            with open(path, encoding='utf-8') as f:
                m = re.search(r"const VERSION = 'umsteiger-([\w-]+)'", f.read())
            if m:
                return m.group(1)
        except OSError:
            pass
    return 'dev'


# Transitous asks every client to name itself, its version and a contact
USER_AGENT = f'Umsteiger/{app_version()} (+{REPOSITORY})'

_cache = {}
_plans = {'day': None, 'count': 0}


def fetch(path, params):
    """GET a Transitous API path as JSON, cached for a minute."""
    url = TRANSITOUS + path + '?' + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    hit = _cache.get(url)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    if path.endswith('/plan'):
        count_plan()
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json',
                                               'Accept-Encoding': 'gzip'})
    with urllib.request.urlopen(req, timeout=20) as res:
        raw = res.read()
        if res.headers.get('Content-Encoding') == 'gzip':
            raw = gzip.decompress(raw)
    data = json.loads(raw.decode('utf-8'))
    if len(_cache) > 500:
        _cache.clear()
    _cache[url] = (time.time(), data)
    return data


def count_plan():
    """Journey searches per day; above Transitous' limit a note in the log, once a day."""
    day = time.strftime('%Y-%m-%d')
    if _plans['day'] != day:
        _plans.update(day=day, count=0)
    _plans['count'] += 1
    if _plans['count'] == PLAN_DAILY_NOTICE:
        print(f'Note: {PLAN_DAILY_NOTICE} journey searches today – Transitous asks to get in touch above this '
              '(Matrix #transitous:matrix.spline.de).', file=sys.stderr)


def distance(lat1, lon1, lat2, lon2):
    k = math.pi / 180
    x = (lon2 - lon1) * k * math.cos((lat1 + lat2) / 2 * k)
    y = (lat2 - lat1) * k
    return math.hypot(x, y) * 6371000


def utc_param(local):
    """'2026-10-01T13:04' (Berlin) or nothing (now) -> '2026-10-01T11:04:00Z'"""
    dt = datetime.fromisoformat(local).replace(tzinfo=BERLIN) if local else datetime.now(BERLIN)
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def local(iso, tz=None):
    """'2026-10-01T11:04:00Z' -> '2026-10-01T13:04:00' (local time of the stop, Berlin by default)"""
    if not iso:
        return None
    zone = BERLIN
    if tz:
        try:
            zone = ZoneInfo(tz)
        except (KeyError, ValueError):
            pass
    dt = datetime.fromisoformat(iso.replace('Z', '+00:00'))
    return dt.astimezone(zone).strftime('%Y-%m-%dT%H:%M:%S')


def place_param(pid):
    """Origin or destination for Transitous: a stop id or 'lat,lon'. Places stored by earlier versions of
    the app carry bahn.de ids with the position in them ('A=1@O=Name@X=13388600@Y=52548600@…')."""
    if '@' in pid:
        parts = dict(p.split('=', 1) for p in pid.split('@') if '=' in p)
        try:
            return f"{int(parts['Y']) / 1e6:.6f},{int(parts['X']) / 1e6:.6f}"
        except (KeyError, ValueError):
            raise ValueError('place')
    return pid


def decode_polyline(s, precision):
    """Encoded polyline (Google's algorithm, here usually with 6 digits) -> [(lat, lon)]"""
    points, index, lat, lon = [], 0, 0, 0
    factor = 10 ** precision
    while index < len(s):
        values = []
        for _ in range(2):
            shift = result = 0
            while True:
                b = ord(s[index]) - 63
                index += 1
                result |= (b & 0x1f) << shift
                shift += 5
                if b < 0x20:
                    break
            values.append(~(result >> 1) if result & 1 else result >> 1)
        lat += values[0]
        lon += values[1]
        points.append((lat / factor, lon / factor))
    return points


def simplify(points, tolerance):
    """Douglas-Peucker on [(lat, lon)]: drops points closer than tolerance (m) to the line through their neighbours."""
    if len(points) < 3:
        return points
    k = math.pi / 180
    lat0 = points[0][0]
    xy = [((lon - points[0][1]) * k * math.cos(lat0 * k) * 6371000, (lat - lat0) * k * 6371000) for lat, lon in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = xy[a], xy[b]
        length = math.hypot(bx - ax, by - ay) or 1e-9
        best, far = 0.0, None
        for i in range(a + 1, b):
            px, py = xy[i]
            d = abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length
            if d > best:
                best, far = d, i
        if far is not None and best > tolerance:
            keep[far] = True
            stack += [(a, far), (far, b)]
    return [p for p, on in zip(points, keep) if on]


def approach_point(route, lat, lon):
    """Point on the route APPROACH_M before the station (None if the train starts here)."""
    if len(route) < 2:
        return None
    k = min(range(len(route)), key=lambda i: distance(lat, lon, route[i][0], route[i][1]))
    walked = 0.0
    for i in range(k, 0, -1):
        walked += distance(route[i][0], route[i][1], route[i - 1][0], route[i - 1][1])
        if walked >= APPROACH_M:
            return {'lat': route[i - 1][0], 'lon': route[i - 1][1]}
    return {'lat': route[0][0], 'lon': route[0][1]} if k > 0 else None


# ---------- Translation into the app's format ----------

def product_of(mode, name, place=None):
    p = PRODUCT.get(mode, 'BUS')
    # Trains added in real time (e.g. a replacement ICE) come without kind and name: a stop with a track is a train
    if mode == 'OTHER' and place and re.match(r'^\d', str(place.get('track') or place.get('scheduledTrack') or '')):
        return 'REGIONAL'
    # S-Bahn and U-Bahn lines that a data source files under regional or other rail
    if p in ('REGIONAL', 'EC_IC') and re.match(r'^S ?\d', name or ''):
        return 'SBAHN'
    if p == 'REGIONAL' and re.match(r'^U ?\d', name or ''):
        return 'UBAHN'
    return p


def line_name(x):
    """Line as shown: 'S1', 'U8', 'Bus 862', 'Tram M10', 'RE3', 'ICE 936'."""
    name = (x.get('displayName') or x.get('routeShortName') or x.get('tripShortName') or '').strip()
    if name == '?':
        name = ''   # trains added in real time have no name
    name = re.sub(r'^([SU]) (\d+)$', r'\1\2', name)   # 'S 2' = 'S2'
    product = PRODUCT.get(x.get('mode'))
    if product == 'BUS' and name and not name.lower().startswith('bus'):
        return 'Bus ' + name
    if product == 'TRAM' and name and not name.lower().startswith(('tram', 'str')):
        return 'Tram ' + name
    return name


def products_of(modes):
    return sorted({PRODUCT.get(m, 'BUS') for m in modes or []})


def notes_of(*sources):
    """Alerts of Transitous (GTFS-RT service alerts) as [{'text', 'high'}], each text once."""
    out, seen = [], set()
    for src in sources:
        for a in src or []:
            text = ' – '.join(t for t in ((a.get('headerText') or '').strip(), (a.get('descriptionText') or '').strip()) if t)
            if not text or text in seen:
                continue
            seen.add(text)
            out.append({'text': text, 'high': a.get('severityLevel') == 'SEVERE'})
    out.sort(key=lambda n: not n['high'])
    return out[:MAX_NOTES]


def track_pair(p):
    """Planned track and (if changed) the actual one."""
    planned, actual = p.get('scheduledTrack'), p.get('track')
    return planned or actual, actual if actual and planned and actual != planned else None


def stop_of(p, which, rt):
    """One stop in the compact format; which = 'arrival' or 'departure', rt = real-time data known."""
    planned = 'scheduled' + which[0].upper() + which[1:]
    track, rt_track = track_pair(p)
    tz = p.get('tz')
    name = p.get('name')
    return {'name': None if name in ('START', 'END') else name, 'eva': p.get('stopId'),
            'lat': p.get('lat'), 'lon': p.get('lon'),
            'time': local(p.get(planned) or p.get(which), tz), 'rtTime': local(p.get(which), tz) if rt else None,
            'track': track, 'rtTrack': rt_track, 'cancelled': bool(p.get('cancelled')),
            'notes': notes_of(p.get('alerts'))}


def leg_stops(l):
    return [l['from']] + (l.get('intermediateStops') or []) + [l['to']]


def shape_of(l):
    """Course of a leg: the line (simplified) and its stops with times."""
    rt = bool(l.get('realTime'))
    stops = []
    for n, p in enumerate(leg_stops(l)):
        s = stop_of(p, 'departure' if n == 0 or p.get('departure') else 'arrival', rt)
        stops.append({k: s[k] for k in ('name', 'lat', 'lon', 'time', 'rtTime', 'cancelled')})
    g = l.get('legGeometry') or {}
    points = simplify(decode_polyline(g['points'], g.get('precision', 6)), SHAPE_TOLERANCE) if g.get('points') else []
    if len(points) < 2:
        points = [(s['lat'], s['lon']) for s in stops]   # no line: straight from stop to stop
    return {'points': [[round(la, 5), round(lo, 5)] for la, lo in points], 'stops': stops}


def leg_of(l):
    if l.get('mode') in ('WALK', 'BIKE', 'CAR', 'RENTAL', 'FLEX') or not l.get('tripId'):
        # Walk (to the first stop, between stops, to the destination): start, end and distance
        return {'mode': 'walk', 'distance': l.get('distance'), 'duration': l.get('duration'),
                'from': stop_of(l['from'], 'departure', False), 'to': stop_of(l['to'], 'arrival', False)}
    rt = bool(l.get('realTime'))
    stops = leg_stops(l)
    prev, nxt = stops[-2], stops[1]
    name = line_name(l)
    return {'mode': 'transit', 'line': name, 'product': product_of(l.get('mode'), name, l['from']),
            'direction': l.get('headsign'), 'journeyId': l.get('tripId'), 'duration': l.get('duration'),
            'from': stop_of(l['from'], 'departure', rt), 'to': stop_of(l['to'], 'arrival', rt),
            'stops': len(stops) - 2,
            'prev': {'name': prev.get('name'), 'lat': prev.get('lat'), 'lon': prev.get('lon')},
            'next': {'name': nxt.get('name'), 'lat': nxt.get('lat'), 'lon': nxt.get('lon')},
            'cancelled': bool(l.get('cancelled')), 'notes': notes_of(l.get('alerts')),
            'shape': shape_of(l)}


def journey_of(it):
    return {'id': it.get('id'), 'duration': it.get('duration'), 'changes': it.get('transfers'),
            'legs': [leg_of(l) for l in it.get('legs', [])], 'notes': []}


# ---------- API ----------

def api_places(q):
    params = {'text': q['q']}
    if q.get('lat') and q.get('lon'):
        # Places near the user first ("Kochstraße" in Berlin, not in Ahlbeck); far places still come first
        # when the text names them ("München Hbf")
        params.update(place=f"{float(q['lat']):.4f},{float(q['lon']):.4f}", placeBias=PLACE_BIAS)
    res = fetch('/v1/geocode', params)
    out = []
    for p in res:
        kind = {'STOP': 'station', 'ADDRESS': 'address', 'PLACE': 'place'}.get(p.get('type'))
        if not kind or p.get('lat') is None:
            continue
        # The same station from another data source (e.g. a foreign railway) close by: once is enough
        if kind == 'station' and any(o['kind'] == 'station' and distance(o['lat'], o['lon'], p['lat'], p['lon']) < SAME_STOP_DIST
                                     for o in out):
            continue
        name = p.get('name') or ''
        if kind == 'address' and p.get('houseNumber') and p['houseNumber'] not in name:
            name = f"{p.get('street') or name} {p['houseNumber']}"
        city = next((a['name'] for a in p.get('areas') or [] if a.get('default')), None)
        if kind != 'station' and city and city not in name:
            name += ', ' + city
        pid = p['id'] if kind == 'station' else f"{p['lat']:.6f},{p['lon']:.6f}"
        out.append({'id': pid, 'name': name, 'kind': kind, 'lat': p['lat'], 'lon': p['lon'],
                    'eva': pid if kind == 'station' else None, 'products': products_of(p.get('modes'))})
    return {'places': out[:10]}


def api_nearby(q):
    """Stops near a point: the closest one (names a point tapped on the map) and a list, closest first."""
    lat, lon = float(q['lat']), float(q['lon'])
    dlat = NEARBY_RADIUS / 111320
    dlon = dlat / max(0.1, math.cos(lat * math.pi / 180))
    res = fetch('/v6/map/stops', {'min': f'{lat - dlat:.5f},{lon - dlon:.5f}', 'max': f'{lat + dlat:.5f},{lon + dlon:.5f}'})
    # Stops of one name (platforms, bus stands on both sides of the street) are one stop: the station's id
    # if there is one (its departures include all of them), else the closest one's
    groups = {}
    for p in res:
        if p.get('lat') is None or not p.get('stopId'):
            continue
        d = distance(lat, lon, p['lat'], p['lon'])
        if d > NEARBY_RADIUS:
            continue
        g = groups.setdefault(p.get('name'), {'name': p.get('name'), 'eva': None, 'near': None, 'lat': p['lat'],
                                              'lon': p['lon'], 'products': set(), 'distance': d})
        g['products'] |= set(products_of(p.get('modes')))
        if p.get('parentId') and (not g['eva'] or p['parentId'].startswith('de-')):
            g['eva'] = p['parentId']
        if d <= g['distance'] or not g['near']:
            g.update(lat=p['lat'], lon=p['lon'], distance=d, near=p['stopId'])
    stops = sorted(groups.values(), key=lambda s: s['distance'])
    for s in stops:
        s['eva'] = s['id'] = s['eva'] or s.pop('near')
        s.pop('near', None)
    # German data first: the same station from a foreign source (e.g. "Berlin Gesundbrunnen" of a Swedish feed)
    german = [s for s in stops if s['eva'].startswith('de-')]
    out = [dict(s, products=sorted(s['products']), distance=round(s['distance'])) for s in stops
           if s['eva'].startswith('de-') or not any(distance(s['lat'], s['lon'], g['lat'], g['lon']) < SAME_STOP_DIST for g in german)]
    out = out[:NEARBY_MAX]
    return {'stop': out[0] if out else None, 'stops': out}


def walked(it):
    return sum(l.get('distance') or 0 for l in it.get('legs', []) if l.get('mode') == 'WALK')


def without_long_walks(its):
    """Transitous keeps journeys with fewer changes even when they need up to 15 minutes on foot (S-Bahn and then
    900 m instead of one stop on the U-Bahn). Such a journey is left out when another one of the answer leaves
    no earlier, arrives no later and needs much less walking – the planners people know do not show it either."""
    def better(b, a):
        return (b is not a and b.get('startTime', '') >= a.get('startTime', '') and b.get('endTime', '') <= a.get('endTime', '')
                and walked(b) <= walked(a) - WALK_SAVED)
    return [a for a in its if walked(a) < LONG_WALK or not any(better(b, a) for b in its)]


def api_journeys(q):
    params = {'fromPlace': place_param(q['from']), 'toPlace': place_param(q['to']),
              'time': utc_param(q.get('when')), 'arriveBy': 'true' if q.get('arrive') == '1' else 'false',
              'pageCursor': q.get('page')}
    res = fetch('/v6/plan', params)
    return {'journeys': [journey_of(it) for it in without_long_walks(res.get('itineraries', []))],
            'earlier': res.get('previousPageCursor'), 'later': res.get('nextPageCursor')}


def api_journey(q):
    """One journey again with current real-time data (id = 'id' of a journey from /api/journeys)."""
    try:
        it = fetch('/v6/refresh-itinerary', {'itineraryId': q['id']})
    except urllib.error.HTTPError as e:
        if 400 <= e.code < 500:
            return {'journey': None}   # cannot be put together any more (e.g. a train was cancelled)
        raise
    return {'journey': journey_of(it) if it and it.get('legs') else None}


def api_departures(q):
    """Departures of a stop (all kinds, also bus and tram) for about an hour from 'when'."""
    res = fetch('/v6/stoptimes', {'stopId': q['eva'], 'time': utc_param(q.get('when')), 'window': HOUR,
                                  'n': 20, 'fetchStops': 'true'})
    out = []
    for e in res.get('stopTimes', []):
        p = e.get('place') or {}
        rt = bool(e.get('realTime'))
        s = stop_of(p, 'departure', rt)
        name = line_name(e)
        out.append({'journeyId': e.get('tripId'), 'line': name, 'product': product_of(e.get('mode'), name, p),
                    'direction': e.get('headsign'), 'via': [x.get('name') for x in (e.get('nextStops') or [])[:3]],
                    'stop': p.get('stopId'), 'time': s['time'], 'rtTime': s['rtTime'],
                    'track': s['track'], 'rtTrack': s['rtTrack'],
                    'cancelled': bool(e.get('cancelled') or e.get('tripCancelled')), 'notes': s['notes']})
    out.sort(key=lambda d: d['time'] or '')
    return {'departures': out}


def trip_leg(trip_id):
    res = fetch('/v6/trip', {'tripId': trip_id})
    legs = res.get('legs') or []
    if not legs:
        raise ValueError('trip')
    return legs[0]


def api_trip(q):
    """Course of a trip: all stops with planned and real times, tracks and messages."""
    l = trip_leg(q['journeyId'])
    rt = bool(l.get('realTime'))
    stops = leg_stops(l)
    out = []
    for n, p in enumerate(stops):
        arr = stop_of(p, 'arrival', rt) if n > 0 else None
        dep = stop_of(p, 'departure', rt) if n < len(stops) - 1 else None
        s = dep or arr
        out.append({'name': p.get('name'), 'eva': p.get('stopId'), 'lat': p.get('lat'), 'lon': p.get('lon'),
                    'arr': {'time': arr['time'], 'rtTime': arr['rtTime']} if arr else None,
                    'dep': {'time': dep['time'], 'rtTime': dep['rtTime']} if dep else None,
                    'track': s['track'], 'rtTrack': s['rtTrack'], 'cancelled': s['cancelled'], 'notes': s['notes']})
    return {'name': line_name(l), 'cancelled': bool(l.get('cancelled')), 'stops': out, 'notes': notes_of(l.get('alerts'))}


def api_eva(q):
    """The station for the arrivals of the station view: a stop with trains close to the given position."""
    lat, lon = float(q['lat']), float(q['lon'])
    res = fetch('/v1/geocode', {'text': q['q'], 'type': 'STOP', 'place': f'{lat},{lon}'})
    best = None
    for p in res:
        if p.get('lat') is None or not set(p.get('modes') or []) & set(RAIL_MODES):
            continue
        d = distance(lat, lon, p['lat'], p['lon'])
        # German data first (the same station also comes from foreign railways), then the most kinds of trains
        rank = (not p['id'].startswith('de-'), -len(p.get('modes') or []), d)
        if d <= EVA_MAX_DIST and (best is None or rank < best[0]):
            best = (rank, p)
    if not best:
        return {'eva': None}
    return {'eva': best[1]['id'], 'name': best[1]['name'], 'distance': round(best[0][2])}


def api_arrivals(q):
    res = fetch('/v6/stoptimes', {'stopId': q['eva'], 'time': utc_param(q.get('when')), 'arriveBy': 'true',
                                  'direction': 'LATER', 'window': HOUR, 'n': 20, 'mode': ','.join(RAIL_MODES)})
    out = []
    for e in res.get('stopTimes', []):
        p = e.get('place') or {}
        s = stop_of(p, 'arrival', bool(e.get('realTime')))
        if not s['time']:
            continue   # the train starts here
        name = line_name(e)
        out.append({'journeyId': e.get('tripId'), 'name': name, 'product': product_of(e.get('mode'), name, p),
                    'time': s['time'], 'rtTime': s['rtTime'], 'stop': p.get('stopId'),
                    'platform': s['track'], 'rtPlatform': s['rtTrack'], 'from': (e.get('tripFrom') or {}).get('name')})
    return {'arrivals': out}


def api_train(q):
    """One train at one station: platform, the stop before and the direction it arrives from."""
    l = trip_leg(q['journeyId'])
    stops = leg_stops(l)
    ids = {q.get('stop'), q['eva']}
    i = next((n for n, p in enumerate(stops) if p.get('stopId') in ids or p.get('parentId') in ids), None)
    if i is None and q.get('lat') and q.get('lon'):
        lat, lon = float(q['lat']), float(q['lon'])
        near = [(distance(lat, lon, p['lat'], p['lon']), n) for n, p in enumerate(stops) if p.get('lat') is not None]
        if near and min(near)[0] <= STOP_MAX_DIST:
            i = min(near)[1]
    if i is None:
        return {'error': 'The train does not stop at this station.'}
    here = stops[i]
    prev = stops[i - 1] if i > 0 else None
    g = l.get('legGeometry') or {}
    route = decode_polyline(g['points'], g.get('precision', 6)) if g.get('points') else []
    track, rt_track = track_pair(here)
    return {'name': line_name(l), 'platform': rt_track or track,
            'prev': {'name': prev.get('name'), 'lat': prev['lat'], 'lon': prev['lon']} if prev else None,
            'approach': approach_point(route, here['lat'], here['lon']) if route else None,
            'sequence': None}   # coach sequences came from bahn.de, which no longer answers


ROUTES = {'/api/eva': (api_eva, ['q', 'lat', 'lon']),
          '/api/arrivals': (api_arrivals, ['eva']),
          '/api/train': (api_train, ['journeyId', 'eva']),
          '/api/places': (api_places, ['q']),
          '/api/nearby': (api_nearby, ['lat', 'lon']),
          '/api/journeys': (api_journeys, ['from', 'to']),
          '/api/journey': (api_journey, ['id']),
          '/api/departures': (api_departures, ['eva']),
          '/api/trip': (api_trip, ['journeyId'])}


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if not url.path.startswith('/api/'):
            return super().do_GET()
        route = ROUTES.get(url.path)
        if not route:
            return self.send_json(404, {'error': 'Unknown request.'})
        q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        if any(not q.get(k) for k in route[1]):
            return self.send_json(400, {'error': 'Missing parameters: ' + ', '.join(route[1])})
        try:
            self.send_json(200, route[0](q))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            self.send_json(502, {'error': 'Transitous does not answer (' + str(getattr(e, 'code', e)) + ').'})
        except (ValueError, KeyError) as e:
            self.send_json(400, {'error': 'Invalid input (' + str(e) + ').'})

    def end_headers(self):
        # App files say ?v=dev locally (deploy.sh puts a checksum there): the browser must ask every time
        if not self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    host = sys.argv[2] if len(sys.argv) > 2 else ''   # '' = reachable from the whole network
    print(f'Umsteiger running at http://localhost:{port}/  (stop with Ctrl+C)')
    ThreadingHTTPServer((host, port), Handler).serve_forever()
