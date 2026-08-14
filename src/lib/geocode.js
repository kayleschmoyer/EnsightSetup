import { customerWeatherAddress, customerLocationFields } from './customerUtils';

const RETRY_BASE_DELAY_MS = 250;

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

const US_STATE_NAME_TO_CODE = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
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

const fetchWithRetry = async (url, opts = {}, config = {}) => {
  const { retries = 2, timeoutMs = 10000 } = config;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(tid);
      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * 2 ** attempt));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(tid);
      lastError = err;
      if (err?.name === 'AbortError') throw err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * 2 ** attempt));
    }
  }
  throw lastError ?? new Error('Network request failed');
};

/** Geocode a US address string via Open-Meteo (no API key required). */
export async function geocodeAddress(query, signal) {
  if (!query) return null;

  const variants = [];
  const seen = new Set();
  const push = (v) => {
    const t = (v || '').trim().replace(/,\s*$/, '').trim();
    if (!t) return;
    if (US_STATES.has(t.toUpperCase())) return;
    if (seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    variants.push(t);
  };

  const cleaned = query.replace(/\b\d{5}(?:-\d{4})?\b/g, '').trim().replace(/,\s*$/, '');
  const parts = cleaned.split(',').map((s) => s.trim()).filter(Boolean);
  const lastIsState = parts.length >= 2 && US_STATES.has(parts[parts.length - 1].toUpperCase());

  if (lastIsState && parts.length >= 2) {
    const city = parts[parts.length - 2];
    const state = parts[parts.length - 1].toUpperCase();
    push(`${city}, ${state}`);
    push(city);
  }
  push(cleaned);
  push(query);
  if (parts.length >= 2) {
    push(parts.slice(1).join(', '));
    push(parts[parts.length - 2]);
  }
  push(parts[0]);

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
    }
  }
  return null;
}

const GEOCODE_DELAY_MS = 120;
const MARKER_COLORS = [
  '#22d3ee', '#818cf8', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#38bdf8', '#fb7185',
];

function markerColor(index) {
  return MARKER_COLORS[index % MARKER_COLORS.length];
}

function hasPlottableAddress(customer) {
  const { address, city, state } = customerLocationFields(customer);
  return Boolean(city || state || address);
}

const geoSessionCache = new Map();

/** Geocode all customers with addresses for map plotting. */
export async function geocodeCustomersForMap(customers, signal) {
  const plottable = customers.filter(hasPlottableAddress);
  const noAddress = customers.filter((c) => !hasPlottableAddress(c));
  const plotted = [];
  const skipped = noAddress.map((c) => ({ customer: c, reason: 'No address' }));

  for (let i = 0; i < plottable.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const customer = plottable[i];
    const addr = customerWeatherAddress(customer);
    const cacheKey = addr.toLowerCase();

    try {
      let geo = geoSessionCache.get(cacheKey);
      if (!geo) {
        const result = await geocodeAddress(addr, signal);
        if (!result) {
          skipped.push({ customer, reason: 'Location not found' });
        } else {
          geo = result;
          geoSessionCache.set(cacheKey, geo);
          plotted.push({
            customer,
            address: addr,
            coordinates: [result.longitude, result.latitude],
            locationName: result.locationName,
            color: markerColor(i),
          });
        }
      } else {
        plotted.push({
          customer,
          address: addr,
          coordinates: [geo.longitude, geo.latitude],
          locationName: geo.locationName,
          color: markerColor(i),
        });
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      skipped.push({ customer, reason: 'Geocoding failed' });
    }

    if (i < plottable.length - 1) {
      await new Promise((r) => setTimeout(r, GEOCODE_DELAY_MS));
    }
  }

  return { plotted, skipped };
}
