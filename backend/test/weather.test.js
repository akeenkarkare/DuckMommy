// Run: cd backend && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPlace, getWeather, weatherLine } from '../src/weather.js';

const FORECAST = {
  current: { temperature_2m: 51.6, apparent_temperature: 46.2, weather_code: 3, wind_speed_10m: 9.4, precipitation: 0 },
  daily: { time: ['2026-10-25', '2026-10-26', '2026-10-27'], weather_code: [3, 61, 0],
    temperature_2m_max: [57.9, 55.1, 60], temperature_2m_min: [44.2, 47, 41], precipitation_probability_max: [10, 70, 0] },
};

function fakeFetch(geo) {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).includes('geocoding')) return new Response(JSON.stringify(geo));
    return new Response(JSON.stringify(FORECAST));
  };
  return { fetchImpl, seen };
}

test('getWeather: default place is Stony Brook, no geocoding call, Fahrenheit', async () => {
  const { fetchImpl, seen } = fakeFetch({});
  const w = await getWeather({ place: '', defaultPlace: '', fetchImpl });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /latitude=40\.9257/);
  assert.match(seen[0], /temperature_unit=fahrenheit/);
  assert.equal(w.place, 'Stony Brook, New York');
  assert.deepEqual(w.current, { temp: 52, feels: 46, desc: 'cloudy', wind: 9, wind_unit: 'mph', precip: 0 });
  assert.deepEqual(w.days[1], { date: '2026-10-26', desc: 'light rain', high: 55, low: 47, rain_chance: 70 });
});

test('getWeather: a named place is geocoded; unknown places return null', async () => {
  let f = fakeFetch({ results: [{ name: 'Boston', admin1: 'Massachusetts', latitude: 42.36, longitude: -71.06 }] });
  const w = await getWeather({ place: 'Boston', fetchImpl: f.fetchImpl });
  assert.equal(w.place, 'Boston, Massachusetts');
  assert.match(f.seen[1], /latitude=42\.36/);
  f = fakeFetch({});
  assert.equal(await findPlace('Nowheresville Zzz', { fetchImpl: f.fetchImpl }), null);
});

test('weatherLine: speakable without Claude', () => {
  const w = { place: 'Stony Brook, New York', current: { temp: 52, feels: 46, desc: 'cloudy' }, days: [{ high: 58, low: 44, rain_chance: 40 }] };
  assert.equal(weatherLine(w), "Right now in Stony Brook, New York it's 52 degrees and cloudy, feels like 46. High of 58, low of 44, 40 percent chance of rain. Maybe grab an umbrella.");
});
