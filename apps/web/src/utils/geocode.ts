/**
 * Nominatim (OpenStreetMap) geocoding with localStorage cache.
 *
 * Rate-limited to 1 request per second per Nominatim usage policy.
 * Results are cached by address string so repeated lookups are instant.
 */

const CACHE_KEY = "smpl_geocode_cache";

export type GeoResult = {
  lat: number;
  lng: number;
};

function readCache(): Record<string, GeoResult> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, GeoResult>) : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, GeoResult>) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // storage full or unavailable
  }
}

/**
 * Look up a single address. Returns cached result immediately if available,
 * otherwise queries Nominatim and caches the result.
 */
export async function geocodeAddress(address: string): Promise<GeoResult | null> {
  const trimmed = address.trim();
  if (!trimmed) return null;

  // Check cache first
  const cache = readCache();
  const cached = cache[trimmed];
  if (cached) return cached;

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(trimmed)}`;
    const response = await fetch(url, {
      headers: { "Accept-Language": "en" },
    });
    if (!response.ok) return null;

    const data = (await response.json()) as Array<{ lat: string; lon: string }>;
    if (!data || data.length === 0) return null;

    const result: GeoResult = {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
    };

    if (!Number.isFinite(result.lat) || !Number.isFinite(result.lng)) return null;

    // Cache the result
    const updatedCache = readCache();
    updatedCache[trimmed] = result;
    writeCache(updatedCache);

    return result;
  } catch {
    return null;
  }
}

/**
 * Geocode multiple addresses sequentially with a 1-second delay between
 * requests to respect Nominatim's rate limit. Calls `onProgress` after
 * each address is processed.
 */
export async function geocodeBatch(
  addresses: readonly string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, GeoResult>> {
  const results = new Map<string, GeoResult>();
  const cache = readCache();

  // Separate cached vs uncached
  const uncached: string[] = [];
  for (const addr of addresses) {
    const trimmed = addr.trim();
    if (!trimmed) continue;
    const hit = cache[trimmed];
    if (hit) {
      results.set(trimmed, hit);
    } else {
      uncached.push(trimmed);
    }
  }

  const total = uncached.length;
  let done = 0;

  for (const addr of uncached) {
    const result = await geocodeAddress(addr);
    if (result) {
      results.set(addr, result);
    }
    done++;
    onProgress?.(done, total);

    // Rate limit: 1 request per second
    if (done < total) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }

  return results;
}

/**
 * Clear the geocode cache (useful if addresses were updated).
 */
export function clearGeocodeCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}
