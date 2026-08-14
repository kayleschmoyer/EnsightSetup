import React, { useEffect, useRef, useState } from "react";
import { Cloud, Droplets, Wind, MapPin, Loader2 } from "lucide-react";

const DEBOUNCE_DELAY_MS = 450;
const RETRY_BASE_DELAY_MS = 250;
const MAX_CACHE_SIZE = 100;
const CACHE_TTL_MS = 15 * 60 * 1000;

/** Shared across all Weather instances so header + site cards reuse one fetch. */
const sharedGeoCache = new Map();
const sharedWeatherCache = new Map();
const pendingWeatherFetches = new Map();
const ERROR_CACHE_TTL_MS = 5 * 60 * 1000;

function trimCache(map) {
  if (map.size <= MAX_CACHE_SIZE) return;
  const oldest = map.keys().next().value;
  map.delete(oldest);
}

const getWeatherIcon = (code) => {
  const c = Number(code);
  if (c === 0) return "☀️";
  if (c <= 3) return "⛅";
  if (c <= 48) return "🌫️";
  if (c <= 67) return "🌧️";
  if (c <= 77) return "🌨️";
  if (c <= 82) return "🌦️";
  if (c <= 86) return "🌨️";
  return "⛈️";
};

const isCacheValid = (entry) => entry && Date.now() - entry.timestamp < CACHE_TTL_MS;

const fetchWithRetry = async (url, opts = {}, config = {}) => {
  const { retries = 2, timeoutMs = 10000 } = config;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const tid = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(tid);
      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        await new Promise(r => setTimeout(r, RETRY_BASE_DELAY_MS * 2 ** attempt));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(tid);
      // Our own timeout abort is a retryable failure, not a caller cancel —
      // surface it as a regular error so the UI never sticks on "Loading".
      if (err?.name === 'AbortError' && timedOut && !opts.signal?.aborted) {
        lastError = new Error('Request timed out');
      } else if (err?.name === 'AbortError') {
        throw err;
      } else {
        lastError = err;
      }
      if (attempt < retries) await new Promise(r => setTimeout(r, RETRY_BASE_DELAY_MS * 2 ** attempt));
    }
  }
  throw lastError ?? new Error("Network request failed");
};

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
]);

const US_STATE_NAME_TO_CODE = {
  alabama:'AL', alaska:'AK', arizona:'AZ', arkansas:'AR', california:'CA', colorado:'CO',
  connecticut:'CT', delaware:'DE', florida:'FL', georgia:'GA', hawaii:'HI', idaho:'ID',
  illinois:'IL', indiana:'IN', iowa:'IA', kansas:'KS', kentucky:'KY', louisiana:'LA',
  maine:'ME', maryland:'MD', massachusetts:'MA', michigan:'MI', minnesota:'MN',
  mississippi:'MS', missouri:'MO', montana:'MT', nebraska:'NE', nevada:'NV',
  'new hampshire':'NH', 'new jersey':'NJ', 'new mexico':'NM', 'new york':'NY',
  'north carolina':'NC', 'north dakota':'ND', ohio:'OH', oklahoma:'OK', oregon:'OR',
  pennsylvania:'PA', 'rhode island':'RI', 'south carolina':'SC', 'south dakota':'SD',
  tennessee:'TN', texas:'TX', utah:'UT', vermont:'VT', virginia:'VA', washington:'WA',
  'west virginia':'WV', wisconsin:'WI', wyoming:'WY', 'district of columbia':'DC'
};

const formatLocationName = (top, fallback) => {
  if (!top) return fallback;
  const country = top.country || '';
  const isUS = country === 'United States' || top.country_code === 'US';
  let region = top.admin1 || '';
  if (isUS && region) {
    const code = US_STATE_NAME_TO_CODE[region.toLowerCase()];
    if (code) region = code;
  }
  const parts = [top.name, region].filter(Boolean);
  if (!isUS && country) parts.push(country);
  return parts.join(', ') || fallback;
};

const geocode = async (query, signal) => {
  if (!query) return null;
  // Open-Meteo geocoding works best with just a place name, not "City, ST".
  // Try progressively simpler variants of the query.
  const variants = [];
  const seen = new Set();
  const push = (v) => {
    const t = (v || '').trim().replace(/,\s*$/, '').trim();
    if (!t) return;
    // Reject single-token US state abbreviations alone (e.g. "NY" matches Ny, Belgium).
    if (US_STATES.has(t.toUpperCase())) return;
    if (seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    variants.push(t);
  };

  const cleaned = query.replace(/\b\d{5}(?:-\d{4})?\b/g, '').trim().replace(/,\s*$/, '');
  const parts = cleaned.split(',').map(s => s.trim()).filter(Boolean);

  // Detect a US state code in the last segment so we can build "City, ST" preferentially.
  const lastIsState = parts.length >= 2 && US_STATES.has(parts[parts.length - 1].toUpperCase());

  if (lastIsState && parts.length >= 2) {
    const city = parts[parts.length - 2];
    const state = parts[parts.length - 1].toUpperCase();
    push(`${city}, ${state}`);     // "New York, NY"
    push(city);                    // "New York"
  }
  push(cleaned);                   // full address sans ZIP
  push(query);                     // raw original
  if (parts.length >= 2) {
    push(parts.slice(1).join(', '));   // drop first segment
    push(parts[parts.length - 2]);     // probable city alone
  }
  push(parts[0]);                  // first segment alone (last resort)

  for (const variant of variants) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(variant)}&count=1&language=en&format=json`;
    try {
      const res = await fetchWithRetry(url, { signal }, { retries: 1, timeoutMs: 8000 });
      if (!res.ok) continue;
      const data = await res.json();
      const top = data?.results?.[0];
      if (top?.latitude && top?.longitude) {
        return {
          latitude: top.latitude,
          longitude: top.longitude,
          locationName: formatLocationName(top, variant),
        };
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      // try next variant
    }
  }
  return null;
};

/**
 * Fetch geocode + forecast for an address with cross-instance deduplication:
 * concurrent callers for the same address share one in-flight promise, and
 * failures are negatively cached so a bad address is not retried per card.
 */
async function fetchWeatherForAddress(addr) {
  const key = addr.toLowerCase();

  const cached = sharedWeatherCache.get(key);
  if (cached) {
    if (cached.data && isCacheValid(cached)) return cached.data;
    if (cached.error && Date.now() - cached.timestamp < ERROR_CACHE_TTL_MS) {
      throw new Error(cached.error);
    }
  }

  const pending = pendingWeatherFetches.get(key);
  if (pending) return pending;

  const promise = (async () => {
    let geo = sharedGeoCache.get(key);
    if (!geo || !isCacheValid(geo)) {
      geo = await geocode(addr, undefined);
      if (!geo) throw new Error("Location not found");
      sharedGeoCache.set(key, { ...geo, timestamp: Date.now() });
      trimCache(sharedGeoCache);
    }

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    const res = await fetchWithRetry(weatherUrl, {}, { retries: 1 });
    if (!res.ok) throw new Error(`Weather fetch failed`);
    const info = await res.json();
    const c = info?.current;
    if (!c || typeof c.temperature_2m !== 'number') throw new Error("Weather data unavailable");

    const payload = {
      temperature: Math.round(c.temperature_2m),
      humidity: c.relative_humidity_2m ?? 0,
      windSpeed: Math.round(c.wind_speed_10m ?? 0),
      weatherCode: c.weather_code ?? 0,
      location: geo.locationName || addr,
    };

    sharedWeatherCache.set(key, { data: payload, timestamp: Date.now() });
    trimCache(sharedWeatherCache);
    return payload;
  })();

  pendingWeatherFetches.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    sharedWeatherCache.set(key, {
      error: err?.message || 'Weather unavailable',
      timestamp: Date.now(),
    });
    trimCache(sharedWeatherCache);
    throw err;
  } finally {
    pendingWeatherFetches.delete(key);
  }
}

const Weather = React.memo(({ address }) => {
  const [state, setState] = useState({ data: null, loading: false, error: null });
  const debounceRef = useRef(null);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const addr = (typeof address === 'string' ? address : '').trim();
    if (!addr) { setState({ data: null, loading: false, error: null }); return; }

    const seq = ++seqRef.current;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      const isCurrent = () => mountedRef.current && seqRef.current === seq;
      if (isCurrent()) setState({ data: null, loading: true, error: null });

      try {
        const data = await fetchWeatherForAddress(addr);
        if (isCurrent()) setState({ data, loading: false, error: null });
      } catch (err) {
        if (err?.name === 'AbortError') return;
        if (isCurrent()) setState({ data: null, loading: false, error: err.message });
      }
    }, DEBOUNCE_DELAY_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [address]);

  if (state.loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading weather...
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="flex items-center gap-2 text-xs text-destructive/70" title={state.error}>
        <Cloud className="w-3 h-3" />
        <span>Weather unavailable</span>
      </div>
    );
  }

  if (!state.data) return null;

  const { data } = state;

  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
      <span className="text-base leading-none" title="Weather">{getWeatherIcon(data.weatherCode)}</span>
      <span className="font-semibold text-foreground text-sm whitespace-nowrap">{data.temperature}°F</span>
      <div className="flex items-center gap-1 whitespace-nowrap">
        <Droplets className="w-3 h-3" />
        <span>{data.humidity}%</span>
      </div>
      <div className="flex items-center gap-1 whitespace-nowrap">
        <Wind className="w-3 h-3" />
        <span>{data.windSpeed} mph</span>
      </div>
      <div className="flex items-center gap-1 text-muted-foreground/70 min-w-0">
        <MapPin className="w-3 h-3 shrink-0" />
        <span className="truncate max-w-[120px]">{data.location}</span>
      </div>
    </div>
  );
});

Weather.displayName = 'Weather';
export default Weather;
