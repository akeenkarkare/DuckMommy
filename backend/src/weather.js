// "Hey duck, what's the weather?" Open-Meteo (free, no key, plain fetch): geocode the place, read the
// current conditions + 3-day forecast, and hand the numbers to Claude (memory.js answerWeather) or
// say them with a template if Claude is down. Default place: WEATHER_PLACE, else Stony Brook, NY.

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 5000;
const STONY_BROOK = { name: 'Stony Brook, New York', latitude: 40.9257, longitude: -73.1409 };

// WMO weather codes -> words the duck can say
const CODES = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'cloudy', 45: 'foggy', 48: 'foggy',
  51: 'drizzly', 53: 'drizzly', 55: 'drizzly', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rainy', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snowy', 75: 'heavy snow', 77: 'snow grains',
  80: 'rain showers', 81: 'rain showers', 82: 'heavy rain showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail',
};
export const describe = (code) => CODES[code] ?? 'mixed weather';

const geoCache = new Map();

async function getJson(url, fetchImpl) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
  return r.json();
}

/** Place name -> { name, latitude, longitude }, or null if nothing matches. '' = the default place. */
export async function findPlace(place, { defaultPlace = process.env.WEATHER_PLACE, fetchImpl = fetch } = {}) {
  const wanted = String(place || defaultPlace || '').trim();
  if (!wanted) return STONY_BROOK;
  const key = wanted.toLowerCase();
  if (geoCache.has(key)) return geoCache.get(key);
  const q = new URLSearchParams({ name: wanted, count: '1', language: 'en', format: 'json' });
  const data = await getJson(`${GEO_URL}?${q}`, fetchImpl);
  const hit = data.results?.[0];
  const found = hit ? {
    name: [hit.name, hit.admin1 && hit.admin1 !== hit.name ? hit.admin1 : null].filter(Boolean).join(', '),
    latitude: hit.latitude, longitude: hit.longitude,
  } : null;
  geoCache.set(key, found);
  return found;
}

/** { place, current: {temp, feels, desc, wind, precip}, days: [{date, high, low, rain_chance, desc}] } */
export async function getWeather({ place, units = process.env.WEATHER_UNITS || 'fahrenheit', fetchImpl = fetch, defaultPlace } = {}) {
  const where = await findPlace(place, { defaultPlace, fetchImpl });
  if (!where) return null;
  const q = new URLSearchParams({
    latitude: String(where.latitude), longitude: String(where.longitude),
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    temperature_unit: units === 'celsius' ? 'celsius' : 'fahrenheit',
    wind_speed_unit: units === 'celsius' ? 'kmh' : 'mph',
    timezone: 'auto', forecast_days: '3',
  });
  const d = await getJson(`${FORECAST_URL}?${q}`, fetchImpl);
  const c = d.current ?? {}, day = d.daily ?? {};
  const round = (x) => (Number.isFinite(x) ? Math.round(x) : null);
  return {
    place: where.name,
    units: units === 'celsius' ? 'C' : 'F',
    current: {
      temp: round(c.temperature_2m), feels: round(c.apparent_temperature), desc: describe(c.weather_code),
      wind: round(c.wind_speed_10m), wind_unit: units === 'celsius' ? 'km/h' : 'mph', precip: c.precipitation ?? 0,
    },
    days: (day.time ?? []).map((date, i) => ({
      date, desc: describe(day.weather_code?.[i]), high: round(day.temperature_2m_max?.[i]),
      low: round(day.temperature_2m_min?.[i]), rain_chance: round(day.precipitation_probability_max?.[i]),
    })),
  };
}

/** No-AI line, for when Claude is unavailable. */
export function weatherLine(w) {
  const now = w.current, today = w.days[0];
  let line = `Right now in ${w.place} it's ${now.temp} degrees and ${now.desc}`;
  if (now.feels != null && Math.abs(now.feels - now.temp) >= 3) line += `, feels like ${now.feels}`;
  line += '.';
  if (today) {
    line += ` High of ${today.high}, low of ${today.low}`;
    line += today.rain_chance >= 30 ? `, ${today.rain_chance} percent chance of rain. Maybe grab an umbrella.` : '.';
  }
  return line;
}
