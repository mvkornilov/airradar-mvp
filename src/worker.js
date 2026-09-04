const SOURCES = [
  {
    name: 'adsb.fi',
    base: 'https://opendata.adsb.fi/api',
    nearby: (lat, lon, radius) => `/v3/lat/${lat}/lon/${lon}/dist/${radius}`,
    icao: (q) => `/v2/icao/${q}`,
    callsign: (q) => `/v2/callsign/${q}`,
    registration: (q) => `/v2/registration/${q}`,
  },
  {
    name: 'adsb.lol',
    base: 'https://api.adsb.lol',
    nearby: (lat, lon, radius) => `/v2/point/${lat}/${lon}/${radius}`,
    icao: (q) => `/v2/icao/${q}`,
    callsign: (q) => `/v2/callsign/${q}`,
    registration: (q) => `/v2/reg/${q}`,
  },
];

const USER_AGENT = 'AirRadar-MVP/0.3 (Cloudflare Worker; personal non-commercial prototype)';
const CACHE_TTL_SECONDS = 12;
const FALLBACK_RETRY_AFTER = 30;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeNearby(lat, lon, radius) {
  // Bucketing nearby map positions dramatically improves cache reuse while
  // being visually irrelevant at the 10–250 NM scale used by this MVP.
  return {
    lat: Math.round(lat * 100) / 100,
    lon: Math.round(lon * 100) / 100,
    radius: Math.max(10, Math.min(250, Math.round(radius / 5) * 5)),
  };
}

async function fetchSource(source, path) {
  const url = `${source.base}${path}`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
    });

    const body = await response.arrayBuffer();
    const headers = new Headers();
    headers.set('content-type', response.headers.get('content-type') || 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store');
    headers.set('x-content-type-options', 'nosniff');
    headers.set('x-airradar-source', source.name);

    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) headers.set('retry-after', retryAfter);

    return new Response(body, { status: response.status, headers });
  } catch (error) {
    return json(
      {
        error: 'upstream_unavailable',
        source: source.name,
        detail: error instanceof Error ? error.message : String(error),
      },
      502,
      { 'x-airradar-source': source.name },
    );
  }
}

async function fetchWithFallback(pathBuilder) {
  const attempts = [];

  for (const source of SOURCES) {
    const response = await fetchSource(source, pathBuilder(source));
    if (response.ok) return response;

    attempts.push({ source: source.name, status: response.status });

    // 400/404 usually means the lookup itself is valid but empty/unknown.
    // For nearby data we still fall through; for search the caller handles it.
  }

  const rateLimited = attempts.some((x) => x.status === 429);
  return json(
    {
      error: rateLimited ? 'rate_limited' : 'all_sources_failed',
      attempts,
    },
    rateLimited ? 429 : 502,
    rateLimited ? { 'retry-after': String(FALLBACK_RETRY_AFTER) } : {},
  );
}

async function cachedNearby(request, ctx, lat, lon, radius) {
  const normalized = normalizeNearby(lat, lon, radius);
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = '/__airradar_cache/nearby';
  cacheUrl.search = new URLSearchParams({
    lat: normalized.lat.toFixed(2),
    lon: normalized.lon.toFixed(2),
    radius: String(normalized.radius),
  }).toString();
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });

  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set('x-airradar-cache', 'HIT');
    return hit;
  }

  const upstream = await fetchWithFallback((source) =>
    source.nearby(normalized.lat.toFixed(2), normalized.lon.toFixed(2), normalized.radius)
  );

  if (!upstream.ok) return upstream;

  const forCache = new Response(upstream.body, upstream);
  forCache.headers.set('cache-control', `public, max-age=${CACHE_TTL_SECONDS}`);
  forCache.headers.set('x-airradar-cache', 'MISS');

  ctx.waitUntil(cache.put(cacheKey, forCache.clone()));
  return forCache;
}

function searchOrder(q) {
  if (/^[0-9A-F]{6}$/.test(q)) return ['icao'];

  // Common registration patterns: RA-..., N123AB, D-..., G-..., F-...
  const looksLikeRegistration =
    q.includes('-') || /^N\d/i.test(q) || /^RA\d/i.test(q) || /^RA-/i.test(q);

  return looksLikeRegistration
    ? ['registration', 'callsign']
    : ['callsign', 'registration'];
}

async function searchOneSource(source, q) {
  const order = searchOrder(q);
  const errors = [];

  for (let i = 0; i < order.length; i += 1) {
    const kind = order[i];
    const path = source[kind](encodeURIComponent(q));
    const response = await fetchSource(source, path);

    if (response.ok) {
      try {
        const data = await response.clone().json();
        const items = aircraftItems(data);
        if (items.length) return { items, errors };
      } catch {
        errors.push({ source: source.name, kind, status: 502 });
      }
    } else {
      errors.push({ source: source.name, kind, status: response.status });
      if (response.status === 429) return { items: [], errors, rateLimited: true };
    }

    // adsb.fi documents 1 request/sec for public endpoints. Only make a
    // second lookup if the first one did not find anything.
    if (i < order.length - 1) await sleep(1100);
  }

  return { items: [], errors };
}

async function handleSearch(q) {
  const allErrors = [];

  for (const source of SOURCES) {
    const result = await searchOneSource(source, q);
    allErrors.push(...result.errors);
    if (result.items.length) {
      const ac = dedupeAircraft(result.items);
      return json({ ac, total: ac.length, query: q, source: source.name, errors: allErrors });
    }

    // If a source rate-limits us, immediately try the fallback source rather
    // than sending multiple requests to the limited source.
  }

  const rateLimited = allErrors.some((x) => x.status === 429);
  if (rateLimited && allErrors.every((x) => x.status === 429 || x.status >= 500)) {
    return json(
      { error: 'rate_limited', query: q, errors: allErrors },
      429,
      { 'retry-after': String(FALLBACK_RETRY_AFTER) },
    );
  }

  return json({ ac: [], total: 0, query: q, errors: allErrors });
}

async function handleApi(request, ctx) {
  if (request.method !== 'GET') {
    return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/health') {
    return json({
      ok: true,
      service: 'AirRadar MVP',
      version: '0.3',
      sources: SOURCES.map((s) => s.name),
      cacheTtlSeconds: CACHE_TTL_SECONDS,
    });
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

    return cachedNearby(request, ctx, lat, lon, requestedRadius);
  }

  if (path.startsWith('/api/icao/')) {
    const raw = path.slice('/api/icao/'.length).trim().toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(raw)) return json({ error: 'bad_icao' }, 400);
    return fetchWithFallback((source) => source.icao(encodeURIComponent(raw)));
  }

  if (path === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim().toUpperCase();
    if (!q || q.length > 32 || !/^[A-Z0-9+._-]+$/.test(q)) {
      return json({ error: 'bad_query' }, 400);
    }
    return handleSearch(q);
  }

  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};
