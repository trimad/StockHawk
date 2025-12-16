const state = {
  assets: [],
  filtered: [],
  insights: null,
  selected: null
};

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('search').addEventListener('input', onSearch);
  document.getElementById('refresh-button').addEventListener('click', () => loadAll(true));
  document.getElementById('alpaca-sync-button').addEventListener('click', triggerAlpacaSync);
  loadAll();
});

async function loadAll(forceSelectFirst = false) {
  const [assets, insights] = await Promise.all([loadAssets(), loadInsights()]);
  if (forceSelectFirst && assets.length) {
    selectAsset(assets[0].symbol);
  } else if (state.selected) {
    selectAsset(state.selected);
  }
  renderInsights(insights);
}

async function loadAssets() {
  const response = await fetch('/api/assets');
  const data = await response.json();
  state.assets = data;
  state.filtered = data;
  renderAssetList();
  updateMeta(data);
  if (!state.selected && data.length) {
    selectAsset(data[0].symbol);
  }
  return data;
}

async function loadInsights() {
  const response = await fetch('/api/insights');
  const data = await response.json();
  state.insights = data;
  return data;
}

function onSearch(event) {
  const term = event.target.value.trim().toLowerCase();
  state.filtered = state.assets.filter(asset => asset.symbol.toLowerCase().includes(term) || asset.name.toLowerCase().includes(term));
  renderAssetList();
}

function renderAssetList() {
  const container = document.getElementById('asset-list');
  container.innerHTML = '';

  if (!state.filtered.length) {
    container.innerHTML = '<div class="empty">No matches</div>';
    return;
  }

  state.filtered.forEach(asset => {
    const btn = document.createElement('button');
    btn.className = `asset-row${state.selected === asset.symbol ? ' active' : ''}`;
    btn.innerHTML = `
      <div class="asset-symbol">${asset.symbol}</div>
      <div class="asset-name">${asset.name}</div>
      <div class="tag">CAGR ${formatPct(asset.cagr)}</div>
      <div class="delta ${asset.changePct >= 0 ? 'positive' : 'negative'}">${formatPct(asset.changePct)}</div>
    `;
    btn.addEventListener('click', () => selectAsset(asset.symbol));
    container.appendChild(btn);
  });
}

async function selectAsset(symbol) {
  state.selected = symbol;
  renderAssetList();
  const response = await fetch(`/api/assets/${symbol}?limit=320`);
  if (!response.ok) {
    renderDetail(null);
    return;
  }
  const asset = await response.json();
  renderDetail(asset);
}

function renderDetail(asset) {
  const title = document.getElementById('detail-title');
  const exchange = document.getElementById('detail-exchange');
  const currency = document.getElementById('detail-currency');
  const updated = document.getElementById('detail-updated');
  const change = document.getElementById('detail-change');
  const metricsGrid = document.getElementById('metrics-grid');

  if (!asset) {
    title.textContent = 'Pick a symbol';
    metricsGrid.innerHTML = '<div class="empty">No data</div>';
    return;
  }

  title.textContent = `${asset.symbol} · ${asset.name}`;
  exchange.textContent = asset.exchange;
  currency.textContent = asset.currency;
  updated.textContent = `Updated ${asset.lastUpdated}`;

  change.textContent = `${formatPct(asset.metrics.changePct)} today`;
  change.className = `delta ${asset.metrics.changePct >= 0 ? 'positive' : 'negative'}`;

  const metricDefs = [
    { label: 'Last Close', value: formatCurrency(asset.metrics.latestClose, asset.currency) },
    { label: 'CAGR', value: formatPct(asset.metrics.cagr) },
    { label: '90d Momentum', value: formatPct(asset.metrics.momentum90d) },
    { label: '365d Momentum', value: formatPct(asset.metrics.momentum365d) },
    { label: 'Max Drawdown', value: formatPct(asset.metrics.maxDrawdown) },
    { label: 'Volatility (ann.)', value: formatPct(asset.metrics.volatility) },
    { label: '52w High', value: formatCurrency(asset.metrics.yearHigh, asset.currency) },
    { label: '52w Low', value: formatCurrency(asset.metrics.yearLow, asset.currency) },
    { label: 'Observations', value: asset.metrics.sampleCount }
  ];

  metricsGrid.innerHTML = '';
  metricDefs.forEach(item => {
    const card = document.createElement('div');
    card.className = 'metric';
    card.innerHTML = `
      <div class="label">${item.label}</div>
      <div class="value">${item.value ?? '—'}</div>
    `;
    metricsGrid.appendChild(card);
  });

  drawChart(asset.series || []);
}

function drawChart(series) {
  const canvas = document.getElementById('price-chart');
  const ctx = canvas.getContext('2d');

  const width = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const height = canvas.clientHeight || 240;
  const ratio = window.devicePixelRatio || 1;

  canvas.width = width * ratio;
  canvas.height = height * ratio;
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, width, height);

  if (!series.length) {
    ctx.fillStyle = '#7d8ba6';
    ctx.fillText('No chart data', 10, 20);
    return;
  }

  const points = series.slice(-160);
  const closes = points.map(p => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const pad = (max - min) * 0.1 || 1;

  const xStep = points.length > 1 ? width / (points.length - 1) : width;

  ctx.beginPath();
  points.forEach((point, idx) => {
    const x = idx * xStep;
    const y = height - ((point.close - (min - pad)) / ((max + pad) - (min - pad))) * height;
    if (idx === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.strokeStyle = '#6cf0c2';
  ctx.lineWidth = 2;
  ctx.stroke();

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, 'rgba(108, 240, 194, 0.25)');
  gradient.addColorStop(1, 'rgba(108, 240, 194, 0)');

  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
}

function renderInsights(insights) {
  const container = document.getElementById('insights-grid');
  const caption = document.getElementById('insights-caption');

  if (!insights) {
    container.innerHTML = '<div class="empty">No insight data</div>';
    return;
  }

  caption.textContent = `Using ${insights.datasets} cached files · Last updated ${insights.lastUpdated || 'n/a'}`;
  container.innerHTML = '';

  const sections = [
    { key: 'momentum', title: 'Momentum (90d)', formatter: formatPct },
    { key: 'growth', title: 'Growth (CAGR)', formatter: formatPct },
    { key: 'stability', title: 'Lowest Drawdown', formatter: formatPct },
    { key: 'intraday', title: 'Today\'s Move', formatter: formatPct }
  ];

  sections.forEach(section => {
    const card = document.createElement('div');
    card.className = 'insight-card';
    card.innerHTML = `<h4>${section.title}</h4>`;
    const leaders = insights.leaders?.[section.key] || [];
    if (!leaders.length) {
      card.innerHTML += '<div class="empty">n/a</div>';
    } else {
      leaders.forEach(leader => {
        const row = document.createElement('div');
        row.className = 'leader';
        row.innerHTML = `
          <span>${leader.symbol}</span>
          <span class="delta ${leader.value >= 0 ? 'positive' : 'negative'}">${section.formatter(leader.value)}</span>
        `;
        row.addEventListener('click', () => selectAsset(leader.symbol));
        card.appendChild(row);
      });
    }
    container.appendChild(card);
  });
}

function updateMeta(data) {
  const datasetCount = document.getElementById('dataset-count');
  const lastUpdated = document.getElementById('last-updated');

  datasetCount.textContent = `${data.length} datasets loaded`;
  const sorted = [...data].sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));
  lastUpdated.textContent = sorted.length ? `Freshest: ${sorted[0].lastUpdated}` : '';
}

function formatPct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const fixed = value.toFixed(2);
  return `${fixed}%`;
}

function formatCurrency(value, currency = 'USD') {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${currency} ${value.toFixed(2)}`;
}

async function triggerAlpacaSync() {
  const statusEl = document.getElementById('sync-status');
  statusEl.textContent = 'Syncing Alpaca bars… this can take a while for all symbols.';
  try {
    const res = await fetch('/api/alpaca/sync', { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    const summary = await res.json();
    statusEl.textContent = `Alpaca sync complete: fetched ${summary.fetched} / ${summary.total}, failed ${summary.failed}, delay ${summary.delayMs}ms.`;
  } catch (err) {
    statusEl.textContent = `Alpaca sync failed: ${err.message}`;
    console.error(err);
  }
}
