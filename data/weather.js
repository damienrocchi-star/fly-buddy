// Weather from Open-Meteo: free, no API key.
const URL_BASE = 'https://api.open-meteo.com/v1/forecast';

const CODES = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorms', 96: 'Thunderstorms', 99: 'Thunderstorms',
};
export const codeText = (c) => CODES[c] || '—';

export async function getWeather(lat, lon) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4),
    current: 'temperature_2m,cloud_cover,precipitation,wind_speed_10m,wind_gusts_10m,weather_code,pressure_msl',
    hourly: 'pressure_msl',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,sunrise,sunset',
    past_days: '3', forecast_days: '4',
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch', timezone: 'auto',
  });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  let j;
  try {
    const r = await fetch(`${URL_BASE}?${q}`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`Weather HTTP ${r.status}`);
    j = await r.json();
  } finally { clearTimeout(t); }

  const cur = j.current;
  // Pressure trend: now vs 3 hours ago.
  const hi = j.hourly.time.findIndex((x) => x >= cur.time.slice(0, 13));
  let pressureTrend = 'steady';
  if (hi >= 3) {
    const d = j.hourly.pressure_msl[hi] - j.hourly.pressure_msl[hi - 3];
    if (d <= -1) pressureTrend = 'falling';
    else if (d >= 1) pressureTrend = 'rising';
  }
  const today = cur.time.slice(0, 10);
  const ti = j.daily.time.indexOf(today);
  const past = [];
  for (let i = Math.max(0, ti - 3); i < ti; i++) past.push((j.daily.temperature_2m_max[i] + j.daily.temperature_2m_min[i]) / 2);
  const days = j.daily.time.map((d, i) => ({
    date: d, max: Math.round(j.daily.temperature_2m_max[i]), min: Math.round(j.daily.temperature_2m_min[i]),
    precip: j.daily.precipitation_sum[i], code: j.daily.weather_code[i],
    sunrise: j.daily.sunrise[i], sunset: j.daily.sunset[i],
  }));
  return {
    fetchedAt: Date.now(),
    airF: Math.round(cur.temperature_2m), cloud: cur.cloud_cover, precip: cur.precipitation,
    windMph: Math.round(cur.wind_speed_10m), gustMph: Math.round(cur.wind_gusts_10m), code: cur.weather_code,
    pressure: Math.round(cur.pressure_msl), pressureTrend,
    past3AvgAirF: past.length ? Math.round(past.reduce((a, b) => a + b, 0) / past.length) : null,
    days: days.slice(Math.max(0, ti)),
  };
}

// Sunrise/sunset for a given date from cached daily data ("2026-09-27T07:12" local time).
export function sunFor(wx, date = new Date()) {
  if (!wx || !wx.days) return {};
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const d = wx.days.find((x) => x.date === key) || wx.days[0];
  return { sunrise: d ? new Date(d.sunrise) : null, sunset: d ? new Date(d.sunset) : null };
}

// Moon phase name, computed locally (no network).
export function moonPhase(date = new Date()) {
  const synodic = 29.530588853;
  const ref = Date.UTC(2000, 0, 6, 18, 14); // a known new moon
  const age = (((date.getTime() - ref) / 864e5) % synodic + synodic) % synodic;
  const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  return names[Math.floor((age / synodic) * 8 + 0.5) % 8];
}
