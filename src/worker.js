const UPSTREAM = 'https://api.adsb.lol';
const USER_AGENT = 'AirRadar-MVP/0.2 (Cloudflare Worker; ODbL data via adsb.lol)';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function aircraftItems(payload) {
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['ac', 'aircraft']) {
    if (Array.isArray(payload[key])) {
      return payload[key].filter((item) => item && typeof item === 'object');
    }
  }
  return [];
}

function dedupeAircraft(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    let key = String(item.hex || '').trim().toLowerCase();
    if (!key) {
      key = ['flight', 'r', 'lat', 'lon']
        .map((field) => String(item[field] ?? '').trim().toLowerCase())
        .join('|');
    }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

async function upstreamGet(path) {
  const url = `${UPSTREAM}${path}`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      // A very short edge cache prevents duplicate refreshes from hammering
      // the public upstream while keeping the map effectively live.
      cf: {
        cacheEverything: true,
        cacheTtl: 2,
      },
    });

    const body = await response.arrayBuffer();
    const headers = new Headers();
    headers.set('content-type', response.headers.get('content-type') || 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store');
    headers.set('x-content-type-options', 'nosniff');
    headers.set('x-airradar-upstream', 'adsb.lol');

    return new Response(body, { status: response.status, headers });
  } catch (error) {
    return json(
      {
        error: 'upstream_unavailable',
        detail: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }
}

async function upstreamJson(path) {
  const response = await upstreamGet(path);
  if (!response.ok) return { response, data: null };
  try {
    const data = await response.clone().json();
    return { response, data };
  } catch {
    return { response: json({ error: 'bad_upstream_json' }, 502), data: null };
  }
}

async function handleApi(request) {
  if (request.method !== 'GET') {
    return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/health') {
    return json({ ok: true, service: 'AirRadar MVP', upstream: UPSTREAM });
  }

  if (path === '/api/aircraft') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const requestedRadius = Number(url.searchParams.get('radius') || '100');

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(requestedRadius)) {
      return json({ error: 'bad_coordinates' }, 400);
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return json({ error: 'bad_coordinates' }, 400);
    }

    const radius = Math.max(1, Math.min(requestedRadius, 250));
    const upstreamPath = `/v2/point/${lat.toFixed(5)}/${lon.toFixed(5)}/${radius.toFixed(1)}`;
    return upstreamGet(upstreamPath);
  }

  if (path.startsWith('/api/icao/')) {
    const raw = path.slice('/api/icao/'.length).trim().toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(raw)) return json({ error: 'bad_icao' }, 400);
    return upstreamGet(`/v2/icao/${encodeURIComponent(raw)}`);
  }

  if (path === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim().toUpperCase();
    if (!q || q.length > 32 || !/^[A-Z0-9+._-]+$/.test(q)) {
      return json({ error: 'bad_query' }, 400);
    }

    const encoded = encodeURIComponent(q);
    const paths = /^[0-9A-F]{6}$/.test(q)
      ? [`/v2/icao/${encoded}`, `/v2/callsign/${encoded}`, `/v2/reg/${encoded}`]
      : [`/v2/callsign/${encoded}`, `/v2/reg/${encoded}`];

    const results = await Promise.all(paths.map((upstreamPath) => upstreamJson(upstreamPath)));
    const merged = [];
    const errors = [];

    for (const result of results) {
      if (!result.response.ok || !result.data) {
        errors.push(result.response.status);
        continue;
      }
      merged.push(...aircraftItems(result.data));
    }

    const ac = dedupeAircraft(merged);
    return json({ ac, total: ac.length, query: q, errors });
  }

  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request);
    }

    return env.ASSETS.fetch(request);
  },
};
