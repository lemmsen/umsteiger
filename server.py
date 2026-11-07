#!/usr/bin/env python3
"""
Umsteiger – small web server for the app.

Serves the app files (like `python3 -m http.server`) and answers a few requests the app cannot
send to bahn.de itself, because bahn.de does not allow requests from other web pages (no CORS):

  /api/eva?q=<name>&lat=<lat>&lon=<lon>     DB station number (EVA) of a station
  /api/arrivals?eva=<eva>[&when=<YYYY-MM-DDTHH:MM>]
                                            arrivals in the next hour
  /api/train?journeyId=<id>&eva=<eva>       one train at one station: platform, direction of
                                            arrival (from the route geometry) and coach sequence
  /api/places?q=<text>                      stations, stops, addresses and places for a search text
  /api/journeys?from=<id>&to=<id>[&when=<YYYY-MM-DDTHH:MM>][&arrive=1][&page=<ref>]
                                            connections from A to B (ids from /api/places)
  /api/journey?id=<id>&from=<id>&to=<id>    one journey of /api/journeys again, with current real-time data
  /api/shape?journeyId=<id>&from=<eva>&to=<eva>[&flat=&flon=&tlat=&tlon=]
                                            course of one leg (line and stops between boarding and leaving)
  /api/nearby?lat=<lat>&lon=<lon>           stops near a point, closest first
  /api/departures?eva=<eva>[&when=<YYYY-MM-DDTHH:MM>]
                                            departures of a stop (all kinds) for about an hour
  /api/trip?journeyId=<id>                  all stops of a trip with planned and real times

The bahn.de interface is not official and may change; the app works without it.
No packages needed (Python 3.9+ and the curl command). Usage: python3 server.py [port] [host]
(default: port 8000, reachable from the whole network; host 127.0.0.1 = only from this machine)
"""
import gzip
import json
import math
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

BAHN = 'https://www.bahn.de/web/api'
USER_AGENT = 'Mozilla/5.0 (Umsteiger; private use)'
BERLIN = ZoneInfo('Europe/Berlin')
CACHE_SECONDS = 60
APPROACH_M = 300          # point on the route this far before the station = direction of arrival
EVA_MAX_DIST = 1500       # m: station search result must be this close to the given position
PRODUCTS = ['ICE', 'EC_IC', 'IR', 'REGIONAL', 'SBAHN', 'UBAHN']
RAIL_PRODUCTS = set(PRODUCTS)
STOP_MAX_DIST = 600       # m: a stop of the train this close to the station counts as this station

_cache = {}


def fetch(path, params, body=None):
    """GET (or with body: POST) a bahn.de API path as JSON, cached for a minute."""
    url = BAHN + path + '?' + urllib.parse.urlencode(params, doseq=True)
    key = url + (json.dumps(body, sort_keys=True) if body is not None else '')
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    # curl instead of urllib: bahn.de rejects Python's own HTTPS client (403), curl is accepted.
    # --curves: curl with OpenSSL 3.5 (Raspberry Pi OS 13) is rejected too unless it offers
    # only these classic key exchange groups.
    cmd = ['curl', '-s', '--max-time', '15', '--curves', 'X25519:P-256:P-384',
           '-w', '\n%{http_code}', '-A', USER_AGENT, '-H', 'Accept: application/json']
    if body is not None:
        cmd += ['-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', '@-']
    res = subprocess.run(cmd + [url], capture_output=True,
                         input=json.dumps(body).encode('utf-8') if body is not None else None)
    raw, _, status = res.stdout.rpartition(b'\n')
    status = status.decode('ascii', 'replace')
    # 201 for the journey search; curl --compressed is rejected (403), but bahn.de sends gzip anyway
    if res.returncode != 0 or status not in ('200', '201'):
        raise urllib.error.HTTPError(url, int(status) if status.isdigit() else 502, 'bahn.de', None, None)
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    data = json.loads(raw.decode('utf-8'))
    if len(_cache) > 500:
        _cache.clear()
    _cache[key] = (time.time(), data)
    return data


def distance(lat1, lon1, lat2, lon2):
    k = math.pi / 180
    x = (lon2 - lon1) * k * math.cos((lat1 + lat2) / 2 * k)
    y = (lat2 - lat1) * k
    return math.hypot(x, y) * 6371000


def coords_of(stop_id):
    """bahn.de location ids contain the position: 'A=1@O=Name@X=9741017@Y=52376764@…'."""
    parts = dict(p.split('=', 1) for p in stop_id.split('@') if '=' in p)
    try:
        return int(parts['Y']) / 1e6, int(parts['X']) / 1e6
    except (KeyError, ValueError):
        return None


def to_utc(local):
    """'2026-10-01T13:04:00' (Berlin) -> '2026-10-01T11:04:00.000Z'"""
    dt = datetime.fromisoformat(local).replace(tzinfo=BERLIN).astimezone(timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')


# ---------- API ----------

def api_eva(q):
    name, lat, lon = q['q'], float(q['lat']), float(q['lon'])
    res = fetch('/reiseloesung/orte', {'suchbegriff': name, 'typ': 'ALL', 'limit': 10})
    best = None
    for p in res:
        # Only stations with trains (a bus stop "… Bahnhof" next door has its own number)
        if p.get('type') != 'ST' or not p.get('extId') or not RAIL_PRODUCTS & set(p.get('products') or []):
            continue
        if p.get('name', '').isupper():
            continue  # whole-city entries such as "HAMBURG"
        d = distance(lat, lon, p['lat'], p['lon'])
        # Railway station numbers (EVA, 80…) first, then the entry with the most kinds of trains
        # (Hamburg Hbf, not its entrance "Kirchenallee" without S-Bahn), then the closest
        rank = (not p['extId'].startswith('80'), -len(p.get('products') or []), d)
        if d <= EVA_MAX_DIST and (best is None or rank < best[0]):
            best = (rank, p)
    if not best:
        return {'eva': None}
    return {'eva': best[1]['extId'], 'name': best[1]['name'], 'distance': round(best[0][2])}


def api_arrivals(q):
    when = datetime.fromisoformat(q['when']) if q.get('when') else datetime.now(BERLIN)
    res = fetch('/reiseloesung/ankuenfte', {
        'ortExtId': q['eva'], 'datum': when.strftime('%Y-%m-%d'), 'zeit': when.strftime('%H:%M:00'),
        'mitVias': 'false', 'verkehrsmittel[]': PRODUCTS})
    out = []
    for e in res.get('entries', []):
        v = e.get('verkehrmittel', {})
        out.append({
            'journeyId': e.get('journeyId'), 'name': v.get('langText') or v.get('name'),
            'product': v.get('produktGattung'), 'time': e.get('zeit'), 'rtTime': e.get('ezZeit'), 'stop': e.get('bahnhofsId'),
            'platform': e.get('gleis'), 'rtPlatform': e.get('ezGleis'), 'from': e.get('terminus')})
    return {'arrivals': out}


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


def api_train(q):
    d = fetch('/reiseloesung/fahrt', {'journeyId': q['journeyId'], 'poly': 'true'})
    halte = d.get('halte', [])
    # The stop at this station: by number (station or the stop number from the arrivals list, e.g. the
    # S-Bahn in Berlin has its own), otherwise the stop closest to the station
    ids = {q['eva'], q.get('stop')}
    i = next((n for n, h in enumerate(halte) if h.get('extId') in ids), None)
    if i is None and q.get('lat') and q.get('lon'):
        lat, lon = float(q['lat']), float(q['lon'])
        near = [(distance(lat, lon, *c), n) for n, h in enumerate(halte) if (c := coords_of(h.get('id', '')))]
        if near and min(near)[0] <= STOP_MAX_DIST:
            i = min(near)[1]
    if i is None:
        return {'error': 'The train does not stop at this station.'}
    h = halte[i]
    eva = h.get('extId') or q['eva']
    here = coords_of(h.get('id', ''))
    prev = halte[i - 1] if i > 0 else None
    prev_pos = coords_of(prev['id']) if prev else None

    route = []
    for desc in (d.get('polylineGroup') or {}).get('polylineDescriptions', []):
        route += [(c['lat'], c['lng']) for c in desc.get('coordinates', [])]
    approach = approach_point(route, *here) if here and route else None

    arrival = (h.get('ankunft') or {})
    departure = (h.get('abfahrt') or {})
    sequence = None
    planned = departure.get('sollzeit') or arrival.get('sollzeit')
    if planned and h.get('kategorie') and h.get('nummer'):
        try:
            s = fetch('/reisebegleitung/wagenreihung/vehicle-sequence', {
                'category': h['kategorie'], 'date': planned[:10], 'evaNumber': eva,
                'number': h['nummer'], 'time': to_utc(planned)})
            sequence = compact_sequence(s)
        except (urllib.error.HTTPError, urllib.error.URLError, ValueError, KeyError):
            sequence = None   # no coach sequence for this train (e.g. most regional trains)

    return {
        'name': d.get('zugName'), 'platform': h.get('gleis'),
        'arrival': arrival, 'departure': departure,
        'prev': {'name': prev.get('name'), 'lat': prev_pos[0], 'lon': prev_pos[1]} if prev and prev_pos else None,
        'approach': approach, 'sequence': sequence}


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


def stop_index(halte, eva, lat, lon, start=0):
    """Index of a stop of the trip: by number, else the closest one (within STOP_MAX_DIST)."""
    for n in range(start, len(halte)):
        if eva and halte[n].get('extId') == eva:
            return n
    if lat is None or lon is None:
        return None
    near = [(distance(lat, lon, *c), n) for n in range(start, len(halte)) if (c := coords_of(halte[n].get('id', '')))]
    return min(near)[1] if near and min(near)[0] <= STOP_MAX_DIST else None


def api_shape(q):
    """Course of one leg: the line between boarding and leaving (simplified) and the stops on the way."""
    num = lambda k: float(q[k]) if q.get(k) else None
    d = fetch('/reiseloesung/fahrt', {'journeyId': q['journeyId'], 'poly': 'true'})
    halte = d.get('halte', [])
    i = stop_index(halte, q.get('from'), num('flat'), num('flon'))
    j = stop_index(halte, q.get('to'), num('tlat'), num('tlon'), (i or 0) + 1) if i is not None else None
    if i is None or j is None:
        return {'points': [], 'stops': []}
    stops = []
    for h in halte[i:j + 1]:
        pos = coords_of(h.get('id', ''))
        if not pos:
            continue
        t = h.get('abfahrt') or h.get('ankunft') or {}
        stops.append({'name': h.get('name'), 'lat': pos[0], 'lon': pos[1],
                      'time': t.get('sollzeit'), 'rtTime': t.get('echtzeit') or t.get('ezZeit')})
    route = []
    for desc in (d.get('polylineGroup') or {}).get('polylineDescriptions', []):
        route += [(c['lat'], c['lng']) for c in desc.get('coordinates', [])]
    points = []
    if route and stops:
        # From the point closest to the first stop to the one closest to the last stop after it
        first, last = stops[0], stops[-1]
        a = min(range(len(route)), key=lambda n: distance(first['lat'], first['lon'], *route[n]))
        b = min(range(a, len(route)), key=lambda n: distance(last['lat'], last['lon'], *route[n]))
        points = simplify(route[a:b + 1], SHAPE_TOLERANCE)
    if len(points) < 2:
        points = [(s['lat'], s['lon']) for s in stops]   # no line from bahn.de: straight from stop to stop
    return {'points': [[round(la, 5), round(lo, 5)] for la, lo in points], 'stops': stops}


def compact_sequence(s):
    pl = s.get('platform') or {}
    vehicles = []
    for g in s.get('groups', []):
        for v in g.get('vehicles', []):
            pos = v.get('platformPosition') or {}
            t = v.get('type') or {}
            vehicles.append({'start': pos.get('start'), 'end': pos.get('end'), 'sector': pos.get('sector'),
                             'number': v.get('wagonIdentificationNumber'), 'firstClass': bool(t.get('hasFirstClass')),
                             'kind': t.get('category')})
    vehicles = [v for v in vehicles if v['start'] is not None and v['end'] is not None]
    if not vehicles:
        return None
    return {'platform': pl.get('name'), 'start': pl.get('start'), 'end': pl.get('end'),
            'sectors': [{'name': x.get('name'), 'start': x.get('start'), 'end': x.get('end')} for x in pl.get('sectors', [])],
            'vehicles': vehicles, 'status': s.get('sequenceStatus')}


PLACE_TYPES = {'ST': 'station', 'ADR': 'address', 'POI': 'place'}
SHAPE_TOLERANCE = 15      # m: simplification of the course of a leg
MAX_NOTES = 5             # messages per journey, leg or stop
NEARBY_RADIUS = 1000      # m: stops this close can name a point on the map
NEARBY_MAX = 12
ALL_PRODUCTS = ['ICE', 'EC_IC', 'IR', 'REGIONAL', 'SBAHN', 'BUS', 'SCHIFF', 'UBAHN', 'TRAM', 'ANRUFPFLICHTIG']


def api_places(q):
    res = fetch('/reiseloesung/orte', {'suchbegriff': q['q'], 'typ': 'ALL', 'limit': 10})
    out = []
    for p in res:
        kind = PLACE_TYPES.get(p.get('type'))
        if not kind or not p.get('id') or p.get('name', '').isupper():
            continue  # unknown kind, or whole-city entries such as "HAMBURG"
        out.append({'id': p['id'], 'name': p.get('name'), 'kind': kind, 'lat': p.get('lat'), 'lon': p.get('lon'),
                    'eva': p.get('extId') if kind == 'station' else None, 'products': p.get('products') or []})
    return {'places': out}


def line_name(v):
    """Line as shown: 'S1', 'U8', 'Bus M29', 'RE3', 'ICE 1507' (bahn.de 'name' is only the number for regional trains)."""
    name = (v.get('mittelText') or v.get('name') or v.get('linienNummer') or '').strip()
    return re.sub(r'^([SU]) (\d+)$', r'\1\2', name)   # 'S 2' (some trips) = 'S2'


def api_departures(q):
    """Departures of a stop (all kinds, also bus and tram) for about an hour from 'when'."""
    when = datetime.fromisoformat(q['when']) if q.get('when') else datetime.now(BERLIN)
    res = fetch('/reiseloesung/abfahrten', {
        'ortExtId': q['eva'], 'datum': when.strftime('%Y-%m-%d'), 'zeit': when.strftime('%H:%M:00'),
        'mitVias': 'true', 'verkehrsmittel[]': ALL_PRODUCTS})
    out = []
    for e in res.get('entries', []):
        v = e.get('verkehrmittel') or {}
        notes = notes_of(e.get('meldungen'))
        out.append({'journeyId': e.get('journeyId'), 'line': line_name(v), 'product': v.get('produktGattung'),
                    'direction': e.get('terminus'), 'via': (e.get('ueber') or [])[1:4], 'stop': e.get('bahnhofsId'),
                    'time': e.get('zeit'), 'rtTime': e.get('ezZeit'), 'track': e.get('gleis'), 'rtTrack': e.get('ezGleis'),
                    'cancelled': bool(e.get('cancelled') or e.get('canceled')), 'notes': notes})
    out.sort(key=lambda d: d['time'] or '')
    return {'departures': out}


def api_trip(q):
    """Course of a trip: all stops with planned and real times, tracks and messages."""
    d = fetch('/reiseloesung/fahrt', {'journeyId': q['journeyId']})
    stops = []
    for h in d.get('halte', []):
        pos = coords_of(h.get('id', '')) or (None, None)
        arr, dep = h.get('ankunft') or {}, h.get('abfahrt') or {}
        stops.append({'name': h.get('name'), 'eva': h.get('extId'), 'lat': pos[0], 'lon': pos[1],
                      'arr': {'time': arr.get('sollzeit'), 'rtTime': arr.get('echtzeit')} if arr else None,
                      'dep': {'time': dep.get('sollzeit'), 'rtTime': dep.get('echtzeit')} if dep else None,
                      'track': h.get('gleis'), 'rtTrack': h.get('ezGleis'), 'cancelled': stop_cancelled(h),
                      'notes': notes_of(h.get('priorisierteMeldungen'), h.get('risNotizen'))})
    return {'name': d.get('zugName'), 'cancelled': bool(d.get('cancelled')), 'stops': stops,
            'notes': notes_of(d.get('priorisierteMeldungen'), d.get('risNotizen'))}


def api_nearby(q):
    """Stops near a point: the closest one (names a point tapped on the map) and a list, closest first."""
    lat, lon = float(q['lat']), float(q['lon'])
    res = fetch('/reiseloesung/orte/nearby', {'lat': lat, 'long': lon, 'radius': NEARBY_RADIUS, 'maxNo': NEARBY_MAX})
    stops, names = [], set()
    for p in res:
        if p.get('type') != 'ST' or p.get('lat') is None or not p.get('extId'):
            continue
        d = distance(lat, lon, p['lat'], p['lon'])
        stops.append({'name': p.get('name'), 'eva': p['extId'], 'id': p.get('id'), 'lat': p['lat'], 'lon': p['lon'],
                      'products': p.get('products') or [], 'distance': round(d)})
    stops.sort(key=lambda s: s['distance'])
    # bahn.de lists some stops twice under different numbers (e.g. "Gesundbrunnen Bahnhof (S+U)"): keep the closer one
    stops = [s for s in stops if not (s['name'] in names or names.add(s['name']))]
    return {'stop': stops[0] if stops else None, 'stops': stops}


def notes_of(*sources):
    """Messages of bahn.de (prioritised ones, HIM messages, RIS notes) as [{'text', 'high'}], each text once."""
    out, seen = [], set()
    for src in sources:
        for m in src or []:
            text = (m.get('text') or m.get('value') or '').strip()
            if not text or text in seen:
                continue
            seen.add(text)
            out.append({'text': text, 'high': m.get('prioritaet') == 'HOCH'})
    out.sort(key=lambda n: not n['high'])
    return out[:MAX_NOTES]


def stop_cancelled(h):
    return bool(h.get('cancelled')) or any('cancel' in (n.get('key') or '').lower() for n in h.get('risNotizen') or [])


def stop_of(h, which):
    """One stop of a leg in the compact format; which = 'ankunft' or 'abfahrt'."""
    pos = coords_of(h.get('id', '')) or (None, None)
    t = h.get(which) or {}
    return {'name': h.get('name'), 'eva': h.get('extId'), 'lat': pos[0], 'lon': pos[1],
            # real time: 'echtzeit' in the journey search ('ezZeit' in the arrivals board)
            'time': t.get('sollzeit'), 'rtTime': t.get('echtzeit') or t.get('ezZeit'),
            'track': h.get('gleis'), 'rtTrack': h.get('ezGleis'), 'cancelled': stop_cancelled(h),
            'notes': notes_of(h.get('priorisierteMeldungen'), h.get('risNotizen'))}


def place_of(h, which):
    """Start or end of a walk: bahn.de gives no position there (filled in by fill_walks())."""
    h = h or {}
    t = h.get(which) or {}
    return {'name': h.get('name'), 'eva': None, 'lat': None, 'lon': None,
            'time': t.get('sollzeit'), 'rtTime': t.get('echtzeit'),
            'track': None, 'rtTrack': None, 'cancelled': False, 'notes': []}


def leg_of(a):
    v = a.get('verkehrsmittel') or {}
    halte = a.get('halte') or []
    if v.get('typ') != 'PUBLICTRANSPORT' or len(halte) < 2:
        # Walk (to the first stop, between stops, to the destination): only start, end and distance
        return {'mode': 'walk', 'distance': a.get('distanz'), 'duration': a.get('abschnittsDauer'),
                'from': place_of(a.get('startHalt'), 'abfahrt'), 'to': place_of(a.get('zielHalt'), 'ankunft')}
    prev, nxt = halte[-2], halte[1]
    prev_pos, next_pos = coords_of(prev.get('id', '')), coords_of(nxt.get('id', ''))
    return {'mode': 'transit', 'line': line_name(v), 'product': v.get('produktGattung'),
            'category': v.get('kategorie'), 'direction': v.get('richtung'), 'journeyId': a.get('journeyId'),
            'duration': a.get('abschnittsDauer'),
            'from': stop_of(halte[0], 'abfahrt'), 'to': stop_of(halte[-1], 'ankunft'),
            'stops': len(halte) - 2,
            'prev': {'name': prev.get('name'), 'lat': prev_pos[0], 'lon': prev_pos[1]} if prev_pos else None,
            'next': {'name': nxt.get('name'), 'lat': next_pos[0], 'lon': next_pos[1]} if next_pos else None,
            'cancelled': bool(a.get('originCancelled') or a.get('destinationCancelled')),
            'notes': notes_of(a.get('priorisierteMeldungen'), a.get('himMeldungen'), a.get('risNotizen'))}


def fill_walks(legs, origin, destination):
    """Positions of walks: from the neighbouring legs, at the ends from the ids of origin and destination."""
    for i, leg in enumerate(legs):
        if leg['mode'] != 'walk':
            continue
        before = legs[i - 1]['to'] if i > 0 else None
        after = legs[i + 1]['from'] if i + 1 < len(legs) else None
        for end, near, pid in (('from', before, origin), ('to', after, destination)):
            pos = (near['lat'], near['lon']) if near else coords_of(pid)
            if pos:
                leg[end]['lat'], leg[end]['lon'] = pos
    return legs


TRAVELLER = [{'typ': 'ERWACHSENER', 'ermaessigungen': [{'art': 'KEINE_ERMAESSIGUNG', 'klasse': 'KLASSENLOS'}],
              'alter': [], 'anzahl': 1}]


def journey_of(v, origin, destination):
    legs = fill_walks([leg_of(a) for a in v.get('verbindungsAbschnitte', [])], origin, destination)
    return {'id': v.get('ctxRecon'), 'duration': v.get('verbindungsDauerInSeconds'),
            'rtDuration': v.get('ezVerbindungsDauerInSeconds'), 'changes': v.get('umstiegsAnzahl'), 'legs': legs,
            'notes': notes_of(v.get('priorisierteMeldungen'), v.get('risNotizen'))}


def api_journeys(q):
    when = datetime.fromisoformat(q['when']) if q.get('when') else datetime.now(BERLIN)
    body = {
        'abfahrtsHalt': q['from'], 'ankunftsHalt': q['to'],
        'anfrageZeitpunkt': when.strftime('%Y-%m-%dT%H:%M:00'),
        'ankunftSuche': 'ANKUNFT' if q.get('arrive') == '1' else 'ABFAHRT',
        'klasse': 'KLASSE_2', 'produktgattungen': ALL_PRODUCTS, 'reisende': TRAVELLER,
        'schnelleVerbindungen': True, 'sitzplatzOnly': False, 'bikeCarriage': False,
        'reservierungsKontingenteVorhanden': False, 'nurDeutschlandTicketVerbindungen': False,
        'deutschlandTicketVorhanden': False}
    if q.get('page'):
        body['pagingReference'] = q['page']
    res = fetch('/angebote/fahrplan', {}, body)
    ref = res.get('verbindungReference') or {}
    return {'journeys': [journey_of(v, q['from'], q['to']) for v in res.get('verbindungen', [])],
            'earlier': ref.get('earlier'), 'later': ref.get('later')}


def api_journey(q):
    """One journey again with current real-time data (id = 'id' of a journey from /api/journeys)."""
    res = fetch('/angebote/recon', {}, {'ctxRecon': q['id'], 'klasse': 'KLASSE_2', 'reisende': TRAVELLER,
                                       'reservierungsKontingenteVorhanden': False, 'deutschlandTicketVorhanden': False})
    found = res.get('verbindungen') or []
    return {'journey': journey_of(found[0], q['from'], q['to']) if found else None}


ROUTES = {'/api/eva': (api_eva, ['q', 'lat', 'lon']),
          '/api/arrivals': (api_arrivals, ['eva']),
          '/api/train': (api_train, ['journeyId', 'eva']),
          '/api/places': (api_places, ['q']),
          '/api/nearby': (api_nearby, ['lat', 'lon']),
          '/api/journeys': (api_journeys, ['from', 'to']),
          '/api/journey': (api_journey, ['id', 'from', 'to']),
          '/api/shape': (api_shape, ['journeyId']),
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
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            self.send_json(502, {'error': 'bahn.de does not answer (' + str(getattr(e, 'code', e)) + ').'})
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
