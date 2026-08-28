import { defaultCustomerConfig } from './configSheetSchema';

const toSlug = (str) => str?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || '';

/** Filename stem without extension; strips trailing -config (e.g. SHC-config.xlsx → SHC). */
export function fileNameStem(fileName) {
  const raw = String(fileName || '').replace(/\.xlsx?$/i, '').trim();
  const stripped = raw.replace(/-config$/i, '').trim();
  return stripped || raw;
}

/**
 * Derive a URL-safe customer ID from an xlsx filename.
 * e.g. "SHC.xlsx" → "shc", "SHC-config.xlsx" → "shc"
 */
export function customerIdFromFileName(fileName) {
  return toSlug(fileNameStem(fileName)) || 'customer';
}

/**
 * Short display code shown as subtitle (from filename stem).
 * e.g. "SHC.xlsx" → "SHC", "EastCentral-config.xlsx" → "EastCentral"
 */
export function customerCodeFromFileName(fileName) {
  const stem = fileNameStem(fileName);
  if (!stem) return 'CUSTOMER';
  if (stem.length <= 8 && /^[a-zA-Z0-9_-]+$/.test(stem)) {
    return stem.replace(/_/g, '-').toUpperCase();
  }
  return stem;
}

/**
 * Derive a unique customer ID from a friendly name (for manual customers).
 */
export function customerIdFromFriendlyName(friendlyName, existingIds = []) {
  const base = toSlug(friendlyName) || 'customer';
  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function customerCodeFromId(customerId) {
  if (!customerId) return 'CUSTOMER';
  if (customerId.length <= 8 && !customerId.includes('-')) {
    return customerId.toUpperCase();
  }
  return customerId;
}

/**
 * Allow only safe http(s) URLs for user-controlled link targets.
 * Bare domains (e.g. "maps.google.com") are treated as https — never as
 * same-origin paths.
 * Pass `allowHttp: true` for links to internal tools that only serve plain
 * http (the URL must explicitly start with "http://").
 */
export function safeExternalUrl(url, { allowHttp = false } = {}) {
  if (!url || typeof url !== 'string') return null;
  let trimmed = url.trim();
  if (!trimmed) return null;
  // Reject relative paths / protocol-relative URLs that would resolve against the app origin.
  if (trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  const hadProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  if (!hadProtocol) {
    trimmed = `https://${trimmed}`;
  }
  try {
    const parsed = new URL(trimmed);
    // Input without a protocol must look like a real domain — single words
    // like "exam" are almost certainly typos, not URLs. Explicitly typed
    // schemes (e.g. http://internal-server) are trusted as intentional.
    if (!hadProtocol && !parsed.hostname.includes('.')) return null;
    if (parsed.protocol === 'https:') return parsed.href;
    if (parsed.protocol === 'http:' && (allowHttp || import.meta.env.DEV)) return parsed.href;
  } catch { /* invalid URL */ }
  return null;
}

/** Google Maps open URL from optional maps link or address query string. */
export const MAINTENANCE_PROVIDERS = {
  ensight: 'Ensight',
  aps: 'APS',
  other: 'Other',
};

export const DEFAULT_CUSTOMER_SUPPORT = {
  maintenanceProvider: '',
  maintenanceOther: '',
  enterpriseSite: false,
  support24Hour: false,
};

/** Normalize optional customer.support from storage or imports. */
export function normalizeCustomerSupport(support) {
  if (!support || typeof support !== 'object') return { ...DEFAULT_CUSTOMER_SUPPORT };
  const maintenanceProvider = ['ensight', 'aps', 'other'].includes(support.maintenanceProvider)
    ? support.maintenanceProvider
    : '';
  return {
    maintenanceProvider,
    maintenanceOther: typeof support.maintenanceOther === 'string' ? support.maintenanceOther : '',
    enterpriseSite: Boolean(support.enterpriseSite),
    support24Hour: Boolean(support.support24Hour),
  };
}

export function maintenanceProviderLabel(support) {
  const normalized = normalizeCustomerSupport(support);
  if (!normalized.maintenanceProvider) return null;
  if (normalized.maintenanceProvider === 'other') {
    return normalized.maintenanceOther.trim() || MAINTENANCE_PROVIDERS.other;
  }
  return MAINTENANCE_PROVIDERS[normalized.maintenanceProvider];
}

/**
 * Normalize top-level customer card config from `customer.config` or legacy flat fields.
 */
export function normalizeCustomerConfig(customer) {
  const defaults = defaultCustomerConfig();
  if (!customer || typeof customer !== 'object') return { ...defaults };

  const fromConfig = customer.config && typeof customer.config === 'object' ? customer.config : {};
  const support = normalizeCustomerSupport(fromConfig.support ?? customer.support);

  return {
    address: fromConfig.address ?? customer.address ?? defaults.address,
    city: fromConfig.city ?? customer.city ?? defaults.city,
    state: fromConfig.state ?? customer.state ?? defaults.state,
    zip: fromConfig.zip ?? customer.zip ?? defaults.zip,
    mapsUrl: fromConfig.mapsUrl ?? customer.mapsUrl ?? defaults.mapsUrl,
    support,
  };
}

/** Location fields from normalized customer config. */
export function customerLocationFields(customer) {
  const config = normalizeCustomerConfig(customer);
  return {
    address: config.address,
    city: config.city,
    state: config.state,
    zip: config.zip,
    mapsUrl: config.mapsUrl,
  };
}

/** Comma-separated address string for weather and geocoding. */
export function customerWeatherAddress(customer) {
  const { address, city, state, zip } = customerLocationFields(customer);
  return [address, city, state, zip].filter(Boolean).join(', ');
}

/** Whether a customer has enough location data to show weather or maps. */
export function hasCustomerLocation(customer) {
  const { address, city, state, zip, mapsUrl } = customerLocationFields(customer);
  return Boolean(address || city || state || zip || mapsUrl);
}

/** Build a customer update payload with merged config fields. */
export function customerConfigPatch(customer, updates = {}) {
  const current = normalizeCustomerConfig(customer);
  const { support: supportUpdates, ...locationUpdates } = updates;
  return {
    config: {
      ...current,
      ...locationUpdates,
      support: supportUpdates
        ? normalizeCustomerSupport({ ...current.support, ...supportUpdates })
        : current.support,
    },
  };
}

export function mapsOpenUrl(mapsUrl, addressQuery) {
  const safe = safeExternalUrl(mapsUrl);
  if (safe) return safe;
  if (addressQuery) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressQuery)}`;
  }
  return null;
}

function siteMergeKey(name) {
  const key = String(name || '').trim().toLowerCase();
  return key || null;
}

function nextSiteId() {
  return crypto.randomUUID();
}

function mergeSiteRecord(existing, imported) {
  return {
    ...imported,
    id: existing.id,
    contacts: existing.contacts?.length ? existing.contacts : (imported.contacts || []),
    servers: existing.servers?.length ? existing.servers : (imported.servers || []),
    displayGroups: existing.displayGroups?.length ? existing.displayGroups : (imported.displayGroups || []),
    sensorGroups: existing.sensorGroups?.length ? existing.sensorGroups : (imported.sensorGroups || []),
    quickLinks: existing.quickLinks?.length ? existing.quickLinks : (imported.quickLinks || []),
  };
}

/**
 * Merge imported sites into existing customer sites by site name.
 * Sites without a name are always added as new entries (never merged).
 */
export function mergeSites(existingSites, importedSites) {
  const result = [...existingSites];
  const byName = new Map();
  result.forEach((s) => {
    const key = siteMergeKey(s.name);
    if (key) byName.set(key, s);
  });

  importedSites.forEach((imported) => {
    const key = siteMergeKey(imported.name);
    if (!key) {
      result.push({ ...imported, id: nextSiteId(result) });
      return;
    }
    const match = byName.get(key);
    if (match) {
      const idx = result.findIndex((s) => s.id === match.id);
      result[idx] = mergeSiteRecord(match, imported);
    } else {
      const added = { ...imported, id: nextSiteId(result) };
      result.push(added);
      byName.set(key, added);
    }
  });

  return result;
}
