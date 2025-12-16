const fs = require('fs');
const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_SERIES_LIMIT = 240;

app.use(express.json());
app.use(express.static('public'));

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

app.use((req, res) => {
  res.status(404).send({ message: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`Stock Hawk listening on http://localhost:${PORT}`);
});

function loadAssets() {
  const map = new Map();
  const files = fs.readdirSync(DATA_DIR)
    .filter(file => file.toLowerCase().endsWith('.json'))
    .filter(file => !file.toLowerCase().startsWith('symbol'));

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
