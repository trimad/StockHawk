require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const unirest = require('unirest');

if (process.env.ALLOW_INSECURE_TLS === '1') {
  // For environments with custom corporate roots; less secure.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const ALPACA_DATA_DIR = path.join(DATA_DIR, 'alpaca');
const DEFAULT_SERIES_LIMIT = 240;
const ALPACA_TRADING_URL = 'https://paper-api.alpaca.markets/v2';
const ALPACA_DATA_URL = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets/v2';

const configPath = path.join(__dirname, 'config.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const ALPACA_KEY = process.env.APCA_API_KEY_ID || process.env.ALPACA_KEY || config?.alpaca?.paper?.apiKey || 'PK6JADDEGWV35H0YBCZP';
const ALPACA_SECRET = process.env.APCA_API_SECRET_KEY || process.env.ALPACA_SECRET || config?.alpaca?.paper?.secretKey || '';

app.use(express.json());
app.use(express.static('public'));

if (!fs.existsSync(ALPACA_DATA_DIR)) {
  fs.mkdirSync(ALPACA_DATA_DIR, { recursive: true });
}

const assets = loadAssets();

app.get('/api/health', (req, res) => {
  res.send({
    datasets: assets.size,
    lastUpdated: getLastUpdated(),
    symbols: [...assets.keys()]
  });
});

app.get('/api/assets', (req, res) => {
  res.send(buildSummaries());
});

app.get('/api/assets/:symbol', (req, res) => {
  const asset = findAsset(req.params.symbol);
  if (!asset) {
    return res.status(404).send({ message: 'Symbol not found' });
  }

  const limit = parseInt(req.query.limit || DEFAULT_SERIES_LIMIT, 10);
  const series = limit > 0 ? asset.series.slice(-limit) : asset.series;
  res.send({ ...asset, series });
});

app.get('/api/assets/:symbol/series', (req, res) => {
  const asset = findAsset(req.params.symbol);
  if (!asset) {
    return res.status(404).send({ message: 'Symbol not found' });
  }

  const limit = parseInt(req.query.limit || DEFAULT_SERIES_LIMIT, 10);
  const series = limit > 0 ? asset.series.slice(-limit) : asset.series;
  res.send(series);
});

app.get('/api/insights', (req, res) => {
  const summaries = buildSummaries();
  const leaders = {
    momentum: topN(summaries.filter(s => s.momentum90d !== null), 'momentum90d', 3, 'desc'),
    growth: topN(summaries.filter(s => Number.isFinite(s.cagr)), 'cagr', 3, 'desc'),
    stability: topN(summaries.filter(s => Number.isFinite(s.maxDrawdown)), 'maxDrawdown', 3, 'asc'),
    intraday: topN(summaries.filter(s => Number.isFinite(s.changePct)), 'changePct', 3, 'desc')
  };

  res.send({
    datasets: assets.size,
    lastUpdated: getLastUpdated(),
    leaders
  });
});

app.post('/api/alpaca/sync', async (req, res) => {
  try {
    if (!ALPACA_KEY || !ALPACA_SECRET) {
      return res.status(400).send({ message: 'Alpaca credentials missing. Set APCA_API_KEY_ID and APCA_API_SECRET_KEY.' });
    }
    const summary = await syncAlpacaData();
    res.send(summary);
  } catch (err) {
    console.warn('Alpaca sync error:', err);
    res.status(500).send({ message: err.message, stack: process.env.NODE_ENV === 'development' ? err.stack : undefined });
  }
});

app.use((req, res) => {
  res.status(404).send({ message: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`Stock Hawk listening on http://localhost:${PORT}`);
  if (process.env.ALPACA_SYNC_ON_START === '1') {
    syncAlpacaData().catch(err => console.warn('Alpaca sync failed:', err.message));
  }
});

function loadAssets() {
  const map = new Map();
  const files = fs.readdirSync(DATA_DIR)
    .filter(file => file.toLowerCase().endsWith('.json'))
    .filter(file => !file.toLowerCase().startsWith('symbol'))
    .filter(file => !file.toLowerCase().includes('.alpaca.'));

  for (const file of files) {
    const fullPath = path.join(DATA_DIR, file);
    try {
      const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const asset = normalizeAsset(raw, file);
      if (!asset) continue;

      const key = asset.symbol.toUpperCase();
      const existing = map.get(key);
      if (existing) {
        const existingTs = existing.series[existing.series.length - 1].ts;
        const currentTs = asset.series[asset.series.length - 1].ts;
        if (currentTs <= existingTs) {
          continue;
        }
      }
      map.set(key, asset);
    } catch (err) {
      console.warn(`Skipping ${file}: ${err.message}`);
    }
  }

  return map;
}

function normalizeAsset(raw, filename) {
  const result = raw?.chart?.result?.[0];
  if (!result) return null;

  const symbol = (result.meta?.symbol || path.parse(filename).name).trim().toUpperCase();
  const name = (result.meta?.longName || result.meta?.shortName || symbol).trim();
  const series = toSeries(result);
  if (series.length < 2) return null;

  const metrics = calculateMetrics(series);
  return {
    symbol,
    name,
    exchange: result.meta?.exchangeName || 'Unknown exchange',
    currency: result.meta?.currency || 'USD',
    firstTradeDate: result.meta?.firstTradeDate ? new Date(result.meta.firstTradeDate * 1000).toISOString().slice(0, 10) : null,
    lastUpdated: series[series.length - 1].date,
    metrics,
    series
  };
}

function toSeries(result) {
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const adjCloses = result.indicators?.adjclose?.[0]?.adjclose || [];

  const series = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (!Number.isFinite(close)) continue;

    const ts = timestamps[i] * 1000;
    series.push({
      ts,
      date: new Date(ts).toISOString().slice(0, 10),
      close,
      adjClose: Number.isFinite(adjCloses[i]) ? adjCloses[i] : close
    });
  }

  series.sort((a, b) => a.ts - b.ts);
  return series;
}

function calculateMetrics(series) {
  const closes = series.map(p => p.close);
  const latest = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const changePct = prev ? ((latest - prev) / prev) * 100 : 0;

  const yearHigh = Math.max(...closes);
  const yearLow = Math.min(...closes);
  const maxDrawdown = getMaxDrawdown(closes);
  const momentum90d = getRangeChange(series, 90);
  const momentum365d = getRangeChange(series, 365);

  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) {
      returns.push(Math.log(closes[i] / closes[i - 1]));
    }
  }

  const meanReturn = returns.reduce((acc, cur) => acc + cur, 0) / (returns.length || 1);
  const variance = returns.reduce((acc, cur) => acc + Math.pow(cur - meanReturn, 2), 0) / (returns.length || 1);
  const volatility = Math.sqrt(variance) * Math.sqrt(252) * 100;

  const spanYears = (series[series.length - 1].ts - series[0].ts) / (1000 * 60 * 60 * 24 * 365);
  const cagr = spanYears > 0 ? (Math.pow(closes[closes.length - 1] / closes[0], 1 / spanYears) - 1) * 100 : 0;

  return {
    latestClose: latest,
    previousClose: prev,
    changePct,
    yearHigh,
    yearLow,
    maxDrawdown,
    volatility,
    cagr,
    momentum90d,
    momentum365d,
    sampleCount: series.length
  };
}

function getMaxDrawdown(closes) {
  let peak = closes[0];
  let maxDd = 0;
  for (const price of closes) {
    if (price > peak) {
      peak = price;
    }
    const dd = ((price - peak) / peak) * 100;
    if (dd < maxDd) {
      maxDd = dd;
    }
  }
  return maxDd;
}

function getRangeChange(series, days) {
  const lastTs = series[series.length - 1].ts;
  const cutoff = lastTs - days * 24 * 60 * 60 * 1000;
  const window = series.filter(point => point.ts >= cutoff);
  if (window.length < 2) return null;
  const start = window[0].close;
  const end = window[window.length - 1].close;
  if (!Number.isFinite(start) || start === 0) return null;
  return ((end - start) / start) * 100;
}

function buildSummaries() {
  const summaries = [];
  assets.forEach(asset => {
    summaries.push({
      symbol: asset.symbol,
      name: asset.name,
      exchange: asset.exchange,
      currency: asset.currency,
      lastUpdated: asset.lastUpdated,
      ...asset.metrics
    });
  });

  return summaries.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function topN(list, key, n, direction = 'desc') {
  const sorted = [...list].sort((a, b) => direction === 'asc' ? a[key] - b[key] : b[key] - a[key]);
  return sorted.slice(0, n).map(item => ({
    symbol: item.symbol,
    name: item.name,
    value: item[key]
  }));
}

function findAsset(symbol) {
  const key = symbol.toUpperCase();
  if (assets.has(key)) return assets.get(key);

  for (const [sym, asset] of assets.entries()) {
    if (sym.toUpperCase() === key) return asset;
  }
  return null;
}

function getLastUpdated() {
  let latestTs = 0;
  assets.forEach(asset => {
    const ts = asset.series[asset.series.length - 1].ts;
    if (ts > latestTs) {
      latestTs = ts;
    }
  });
  return latestTs ? new Date(latestTs).toISOString() : null;
}

async function syncAlpacaData() {
  console.log('Starting Alpaca sync...');

  const throttleMs = parseInt(process.env.ALPACA_SYNC_DELAY_MS || '200', 10);
  const limitSymbols = process.env.ALPACA_SYNC_LIMIT ? parseInt(process.env.ALPACA_SYNC_LIMIT, 10) : null;

  const assetsList = await fetchAlpacaAssets();
  const equities = assetsList.filter(a => a.asset_class === 'us_equity' && a.tradable);
  const symbols = limitSymbols ? equities.slice(0, limitSymbols) : equities;

  let success = 0;
  let failures = 0;

  for (const asset of symbols) {
    try {
      const bar = await fetchLatestBar(asset.symbol);
      if (bar) {
        const payload = {
          meta: asset,
          bar
        };
        const target = path.join(ALPACA_DATA_DIR, `${asset.symbol}.alpaca.json`);
        fs.writeFileSync(target, JSON.stringify(payload, null, 2));
        success += 1;
      } else {
        failures += 1;
      }
    } catch (err) {
      failures += 1;
      console.warn(`Alpaca fetch failed for ${asset.symbol}: ${err.message}`);
    }
    if (throttleMs > 0) {
      await delay(throttleMs);
    }
  }

  console.log(`Alpaca sync complete. Saved ${success}, failed ${failures}.`);
  return { fetched: success, failed: failures, total: symbols.length, delayMs: throttleMs };
}

function fetchAlpacaAssets() {
  return new Promise((resolve, reject) => {
    const req = unirest('GET', `${ALPACA_TRADING_URL}/assets`);
    req.headers({
      'APCA-API-KEY-ID': ALPACA_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET
    });
    req.end(res => {
      if (res.error) return reject(res.error);
      if (res.statusCode && res.statusCode >= 300) {
        return reject(new Error(`Assets request failed (${res.statusCode})${res.body ? ': ' + JSON.stringify(res.body).slice(0, 400) : ''}`));
      }
      if (!Array.isArray(res.body)) return reject(new Error('Unexpected asset response'));
      resolve(res.body);
    });
  });
}

function fetchLatestBar(symbol) {
  return new Promise((resolve, reject) => {
    const req = unirest('GET', `${ALPACA_DATA_URL}/stocks/${encodeURIComponent(symbol)}/bars`);
    req.query({
      timeframe: '1Day',
      limit: 1,
      adjustment: 'raw'
    });
    req.headers({
      'APCA-API-KEY-ID': ALPACA_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET
    });
    req.end(res => {
      if (res.error) return reject(res.error);
      if (res.statusCode && res.statusCode >= 300) {
        return reject(new Error(`Bar request failed (${res.statusCode})${res.body ? ': ' + JSON.stringify(res.body).slice(0, 400) : ''}`));
      }
      const bar = res.body?.bars?.[0];
      resolve(bar || null);
    });
  });
}

function delay(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}
