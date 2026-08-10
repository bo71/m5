/* ═══════════════════════════════════════════════════════════════════════
   M5 Sales Explorer — Interactive Drill-Down Visualization
   ═══════════════════════════════════════════════════════════════════════ */

// ── Colour Palette ────────────────────────────────────────────────────
const COLORS = {
  CA:        '#A8D8EA',
  TX:        '#FFAAA5',
  WI:        '#B5EAD7',
  FOODS:     '#FFD3B4',
  HOBBIES:   '#D5AAFF',
  HOUSEHOLD: '#85E3FF',
};

const STATE_EMOJI = { CA: '🌴', TX: '🤠', WI: '🧀' };
const CAT_EMOJI   = { FOODS: '🍔', HOBBIES: '🎨', HOUSEHOLD: '🏠' };

// ── State ─────────────────────────────────────────────────────────────
let dates, stateDaily, storeDaily, categoryDaily, deptDaily, itemsSummary, hierarchy;
let currentLevel = 'states';   // states | stores | categories | departments | items
let currentPath  = [];          // e.g. ['CA','CA_1','FOODS','FOODS_1']
let currentDay   = 0;
let isPlaying    = false;
let playSpeed    = 1;           // 1, 2, 4, 8
let playTimer    = null;
let tileElements = [];          // current DOM tiles for fast updates
let itemDailyCache = {};        // store|dept → { data, maxVal }
let chartInstance = null;       // Chart.js instance
let currentTopItemIds = [];     // Track top 4 item IDs for dynamic chart updates

// ── Lazy-load item daily data ─────────────────────────────────────────
async function loadItemDaily(storeId, deptId) {
  const key = `${storeId}|${deptId}`;
  if (itemDailyCache[key]) return itemDailyCache[key];

  const fname = `${storeId}--${deptId}.json`;
  const data = await fetch(`data/items/${fname}`).then(r => r.json());

  // Pre-compute max daily value across all items+days for colour scaling
  let maxVal = 1;
  for (const id in data) {
    for (let d = 0; d < data[id].length; d++) {
      if (data[id][d] > maxVal) maxVal = data[id][d];
    }
  }

  itemDailyCache[key] = { data, maxVal };
  return itemDailyCache[key];
}

// ── DOM refs ──────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const gridEl      = $('grid');
const loadingEl   = $('loading');
const sliderEl    = $('day-slider');
const sliderFill  = $('slider-fill');
const playBtn     = $('play-btn');
const playIcon    = $('play-icon');
const pauseIcon   = $('pause-icon');
const speedBtn    = $('speed-btn');
const breadcrumb  = $('breadcrumb');
const backBtn     = $('back-btn');
const hdrDate     = $('hdr-date');
const hdrTotal    = $('hdr-total');
const dayCounter  = $('day-counter');
const levelLabel  = $('level-label');
const levelDetail = $('level-detail');
const timelineDate = $('timeline-date');
const ticksEl     = $('slider-ticks');
const chartTitle    = $('chart-title');
const chartSubtitle = $('chart-subtitle');
const chartLegend   = $('chart-legend');
const chartWrapper  = $('chart-wrapper');

// ── Helpers ───────────────────────────────────────────────────────────
function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function lerp(a, b, t) { return a + (b - a) * t; }

// Darken a hex colour by mixing with black
function darken(hex, amount = 0.35) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const dr = Math.round(r * (1 - amount));
  const dg = Math.round(g * (1 - amount));
  const db = Math.round(b * (1 - amount));
  return `rgb(${dr},${dg},${db})`;
}

// Compute max value for normalization at current level
function getMaxValue(items) {
  if (currentLevel === 'items') {
    return Math.max(1, ...items.map(i => i.value));
  }
  // For daily levels, use a rolling max across recent days for stability
  return Math.max(1, ...items.map(i => i.value));
}

// ── Data Loading ──────────────────────────────────────────────────────
async function loadData() {
  const load = (f) => fetch(`data/${f}`).then(r => r.json());
  [dates, stateDaily, storeDaily, categoryDaily, deptDaily, itemsSummary, hierarchy] =
    await Promise.all([
      load('dates.json'),
      load('state_daily.json'),
      load('store_daily.json'),
      load('category_daily.json'),
      load('dept_daily.json'),
      load('items_summary.json'),
      load('hierarchy.json'),
    ]);
  sliderEl.max = dates.length - 1;
}

// ── Get items for current view ────────────────────────────────────────
function getViewItems() {
  let rawItems = [];

  switch (currentLevel) {
    case 'states':
      return Object.entries(hierarchy.states).map(([id, info]) => ({
        id, name: info.name, color: COLORS[id],
        emoji: STATE_EMOJI[id],
        value: stateDaily[id][currentDay],
        sub: `${info.stores.length} stores`,
      }));

    case 'stores': {
      const stateId = currentPath[0];
      const stInfo = hierarchy.states[stateId];
      rawItems = stInfo.stores.map(sid => ({
        id: sid, name: sid.replace('_', ' #'), color: COLORS[stateId],
        emoji: '🏬',
        value: storeDaily[sid][currentDay],
        sub: '3 categories',
      }));
      break;
    }

    case 'categories': {
      const storeId = currentPath[1];
      return Object.entries(hierarchy.categories).map(([catId, info]) => ({
        id: catId, name: info.name, color: COLORS[catId],
        emoji: CAT_EMOJI[catId],
        value: categoryDaily[`${storeId}|${catId}`][currentDay],
        sub: `${info.departments.length} departments`,
      }));
    }

    case 'departments': {
      const storeId = currentPath[1];
      const catId = currentPath[2];
      const catInfo = hierarchy.categories[catId];
      rawItems = catInfo.departments.map(deptId => ({
        id: deptId, name: deptId.replace('_', ' '), color: COLORS[catId],
        emoji: '📦',
        value: deptDaily[`${storeId}|${deptId}`][currentDay],
        sub: `${(itemsSummary[`${storeId}|${deptId}`] || []).length} items`,
      }));
      break;
    }

    case 'items': {
      const storeId = currentPath[1];
      const deptId = currentPath[3];
      const key = `${storeId}|${deptId}`;
      const summaryItems = itemsSummary[key] || [];
      const cached = itemDailyCache[key];
      const catId = currentPath[2];

      rawItems = summaryItems.map(item => {
        const dayVal = cached ? (cached.data[item.id]?.[currentDay] ?? 0) : item.t;
        return {
          id: item.id, name: item.id, color: COLORS[catId],
          emoji: '',
          value: dayVal,
          sub: '',
          isItem: true,
        };
      });
      break;
    }
  }

  // Calculate translucent heatmap intensity for all levels after states
  const maxVal = Math.max(1, ...rawItems.map(i => i.value));
  return rawItems.map(it => ({
    ...it,
    intensity: maxVal > 0 ? it.value / maxVal : 0
  }));
}

// ── Render tiles ──────────────────────────────────────────────────────
function renderGrid(animate = true) {
  const items = getViewItems();
  const isItems = currentLevel === 'items';

  // Update grid sizing class
  gridEl.className = 'grid-container';
  if (currentLevel === 'states' || currentLevel === 'categories') gridEl.classList.add('grid--large');
  else if (currentLevel === 'items') gridEl.classList.add('grid--small');
  else gridEl.classList.add('grid--medium');

  // Clear
  gridEl.innerHTML = '';
  tileElements = [];

  items.forEach((item, i) => {
    const tile = document.createElement('div');
    tile.className = 'tile' + (isItems ? ' tile--item' : '');
    tile.style.setProperty('--tile-color', item.color);
    tile.dataset.id = item.id;

    if (animate) {
      tile.classList.add('entering');
      tile.style.animationDelay = `${Math.min(i * 30, 600)}ms`;
    }

    // Translucent heatmap background color for levels after initial state level
    if (currentLevel !== 'states' && item.intensity !== undefined) {
      const alpha = 0.05 + item.intensity * 0.32;
      const hexAlpha = Math.round(alpha * 255).toString(16).padStart(2, '0');
      tile.style.backgroundColor = `${item.color}${hexAlpha}`;
    }

    tile.innerHTML = `
      <div class="tile-accent"></div>
      ${(item.emoji && currentLevel !== 'states') ? `<div class="tile-icon">${item.emoji}</div>` : ''}
      <div class="tile-name ${currentLevel === 'states' ? 'tile-name--state' : ''}">${isItems ? '#' + item.name.split('_').pop() : item.name}</div>
      <div class="tile-value" data-raw="${item.value}">${fmtNum(item.value)}</div>
      ${item.sub ? `<div class="tile-label">${item.sub}</div>` : ''}
      ${!isItems ? '<div class="tile-arrow">→</div>' : ''}
    `;

    // Drill-down on click (not for items)
    if (!isItems) {
      tile.addEventListener('click', () => drillDown(item.id));
    }

    gridEl.appendChild(tile);
    tileElements.push({ el: tile, id: item.id });
  });

  // Scroll to top
  $('main').scrollTop = 0;

  // Render sales chart for current level
  renderChart();
}

// ── Update tile values (fast, no re-render) ───────────────────────────
function updateValues() {
  const items = getViewItems();
  const lookup = {};
  items.forEach(it => { lookup[it.id] = it; });

  let grandTotal = 0;
  tileElements.forEach(({ el, id }) => {
    const item = lookup[id];
    if (!item) return;
    const valEl = el.querySelector('.tile-value');
    const oldVal = parseInt(valEl.dataset.raw) || 0;
    const newVal = item.value;
    grandTotal += newVal;

    if (oldVal !== newVal) {
      valEl.dataset.raw = newVal;
      valEl.textContent = fmtNum(newVal);
      valEl.classList.remove('value-pop');
      void valEl.offsetWidth; // Force reflow for re-triggering animation
      valEl.classList.add('value-pop');
    }

    // Update translucent heatmap background color for levels after states
    if (currentLevel !== 'states' && item.intensity !== undefined) {
      const alpha = 0.05 + item.intensity * 0.32;
      const hexAlpha = Math.round(alpha * 255).toString(16).padStart(2, '0');
      el.style.backgroundColor = `${item.color}${hexAlpha}`;
    }
  });

  hdrTotal.textContent = fmtNum(grandTotal);
}

// ── Navigation ────────────────────────────────────────────────────────
async function drillDown(id) {
  currentPath.push(id);

  const levels = ['states', 'stores', 'categories', 'departments', 'items'];
  const idx = levels.indexOf(currentLevel);
  if (idx < levels.length - 1) {
    currentLevel = levels[idx + 1];
  }

  updateBreadcrumb();
  updateLevelInfo();
  renderGrid(true);
  backBtn.style.display = '';

  // Lazy-load per-item daily data when entering items level
  if (currentLevel === 'items') {
    const storeId = currentPath[1];
    const deptId = currentPath[3];
    await loadItemDaily(storeId, deptId);
    updateValues(); // Refresh tiles with actual daily values
    renderChart();  // Update chart with item daily lines
  }
}

function drillUp() {
  if (currentPath.length === 0) return;
  currentPath.pop();

  const levels = ['states', 'stores', 'categories', 'departments', 'items'];
  const idx = levels.indexOf(currentLevel);
  if (idx > 0) {
    currentLevel = levels[idx - 1];
  }

  if (currentPath.length === 0) backBtn.style.display = 'none';
  updateBreadcrumb();
  updateLevelInfo();
  renderGrid(true);
}

function navigateTo(level) {
  const levels = ['states', 'stores', 'categories', 'departments', 'items'];
  const targetIdx = levels.indexOf(level);
  const currentIdx = levels.indexOf(currentLevel);

  if (targetIdx < currentIdx) {
    currentPath = currentPath.slice(0, targetIdx);
    currentLevel = level;
    if (currentPath.length === 0) backBtn.style.display = 'none';
    updateBreadcrumb();
    updateLevelInfo();
    renderGrid(true);
  }
}

// ── Breadcrumb ────────────────────────────────────────────────────────
function updateBreadcrumb() {
  const levels = ['states', 'stores', 'categories', 'departments', 'items'];
  const names = ['States'];

  for (let i = 0; i < currentPath.length; i++) {
    const id = currentPath[i];
    switch (i) {
      case 0: names.push(hierarchy.states[id]?.name || id); break;
      case 1: names.push(id.replace('_', ' #')); break;
      case 2: names.push(hierarchy.categories[id]?.name || id); break;
      case 3: names.push(id.replace('_', ' ')); break;
    }
  }

  breadcrumb.innerHTML = names.map((name, i) => {
    const level = levels[i];
    const isActive = i === names.length - 1;
    return `<span class="breadcrumb-item${isActive ? ' active' : ''}" 
                 data-level="${level}" 
                 ${!isActive ? `onclick="navigateTo('${level}')"` : ''}>
              ${name}
            </span>`;
  }).join('');
}

function updateLevelInfo() {
  const descs = {
    states: 'Choose a state to explore',
    stores: `Stores in ${hierarchy.states[currentPath[0]]?.name || currentPath[0]}`,
    categories: `Categories at ${currentPath[1]?.replace('_', ' #')}`,
    departments: `${hierarchy.categories[currentPath[2]]?.name} departments`,
    items: `Items in ${currentPath[3]?.replace('_', ' ')} at ${currentPath[1]?.replace('_', ' #')}`,
  };

  const details = {
    states: '3 states · 10 stores · 30,490 products',
    stores: `${hierarchy.states[currentPath[0]]?.stores.length || 0} stores`,
    categories: '3 categories',
    departments: `${hierarchy.categories[currentPath[2]]?.departments.length || 0} departments`,
    items: `${(itemsSummary[`${currentPath[1]}|${currentPath[3]}`] || []).length} items · sorted by total sales`,
  };

  levelLabel.textContent = descs[currentLevel] || '';
  levelDetail.textContent = details[currentLevel] || '';
}

// ── Day / Slider ──────────────────────────────────────────────────────
function updateDayDisplay() {
  const iso = dates[currentDay];
  const pretty = fmtDate(iso);
  hdrDate.textContent = pretty;
  timelineDate.textContent = pretty;
  dayCounter.textContent = currentDay + 1;

  // Slider fill
  const pct = (currentDay / (dates.length - 1)) * 100;
  sliderFill.style.width = pct + '%';

  // Update line chart position marker
  updateChartMarker();
}

function onSliderInput() {
  currentDay = parseInt(sliderEl.value);
  updateDayDisplay();
  updateValues();
}

// ── Playback ──────────────────────────────────────────────────────────
function togglePlay() {
  isPlaying = !isPlaying;
  playIcon.style.display = isPlaying ? 'none' : '';
  pauseIcon.style.display = isPlaying ? '' : 'none';
  playBtn.classList.toggle('playing', isPlaying);

  if (isPlaying) startPlayback();
  else stopPlayback();
}

function startPlayback() {
  stopPlayback();
  const ms = Math.max(16, Math.round(80 / playSpeed));
  playTimer = setInterval(() => {
    currentDay += 1;
    if (currentDay >= dates.length) {
      currentDay = 0; // Loop
    }
    sliderEl.value = currentDay;
    updateDayDisplay();
    updateValues();
  }, ms);
}

function stopPlayback() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
}

function cycleSpeed() {
  const speeds = [1, 2, 4, 8];
  const idx = speeds.indexOf(playSpeed);
  playSpeed = speeds[(idx + 1) % speeds.length];
  speedBtn.textContent = playSpeed + '×';
  if (isPlaying) startPlayback(); // Restart with new speed
}

// ── Slider ticks ──────────────────────────────────────────────────────
function buildSliderTicks() {
  if (!dates || dates.length === 0) return;
  // Show year labels
  const years = new Set();
  const ticks = [];
  dates.forEach((iso, i) => {
    const y = iso.slice(0, 4);
    if (!years.has(y)) {
      years.add(y);
      const pct = (i / (dates.length - 1)) * 100;
      ticks.push(`<span class="tick" style="left:${pct}%">${y}</span>`);
    }
  });
  ticksEl.innerHTML = ticks.join('');
}

// ── Live Sales Chart (Chart.js) ───────────────────────────────────────
const dayMarkerPlugin = {
  id: 'dayMarker',
  afterDraw: (chart) => {
    if (currentDay === undefined || currentDay === null) return;
    const xAxis = chart.scales.x;
    const yAxis = chart.scales.y;
    if (!xAxis || !yAxis) return;

    const xPos = xAxis.getPixelForValue(currentDay);
    if (isNaN(xPos)) return;

    const ctx = chart.ctx;
    ctx.save();

    // Dotted vertical line
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#9C88FF';
    ctx.lineWidth = 2;
    ctx.moveTo(xPos, yAxis.top);
    ctx.lineTo(xPos, yAxis.bottom);
    ctx.stroke();

    // Indicator dot
    ctx.setLineDash([]);
    ctx.fillStyle = '#9C88FF';
    ctx.beginPath();
    ctx.arc(xPos, yAxis.top + 2, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
};

if (window.Chart) {
  Chart.register(dayMarkerPlugin);
}

function renderChart() {
  if (!window.Chart || !dates) return;

  if (currentLevel === 'items') {
    if (chartWrapper) chartWrapper.style.display = 'none';
    return;
  } else {
    if (chartWrapper) chartWrapper.style.display = '';
  }

  let title = '';
  let subtitle = '';
  let datasets = [];
  let legendItems = [];

  const storePalette = ['#A8D8EA', '#FFAAA5', '#B5EAD7', '#FFD3B4'];

  // Slice datasets up to currentDay so the plot grows live as the slider moves
  const currentCount = currentDay + 1;

  switch (currentLevel) {
    case 'states':
      title = 'State Sales Trends Over Time';
      subtitle = 'Daily unit sales across California, Texas, and Wisconsin';
      datasets = Object.keys(hierarchy.states).map(st => ({
        label: hierarchy.states[st].name,
        _fullData: stateDaily[st],
        data: stateDaily[st].slice(0, currentCount),
        borderColor: COLORS[st],
        backgroundColor: COLORS[st] + '22',
        borderWidth: 3,
        borderJoinStyle: 'round',
        borderCapStyle: 'round',
        fill: true,
        pointRadius: 0,
        tension: 0.45
      }));
      legendItems = datasets.map(d => ({ label: d.label, color: d.borderColor }));
      break;

    case 'stores': {
      const stateId = currentPath[0];
      const stName = hierarchy.states[stateId]?.name || stateId;
      title = `${stName} Store Sales Trends`;
      subtitle = `Comparing daily sales performance across stores in ${stName}`;
      const stores = hierarchy.states[stateId]?.stores || [];
      datasets = stores.map((sid, i) => ({
        label: sid.replace('_', ' #'),
        _fullData: storeDaily[sid],
        data: storeDaily[sid].slice(0, currentCount),
        borderColor: storePalette[i % storePalette.length],
        backgroundColor: storePalette[i % storePalette.length] + '22',
        borderWidth: 3,
        borderJoinStyle: 'round',
        borderCapStyle: 'round',
        fill: false,
        pointRadius: 0,
        tension: 0.45
      }));
      legendItems = datasets.map(d => ({ label: d.label, color: d.borderColor }));
      break;
    }

    case 'categories': {
      const storeId = currentPath[1];
      title = `Category Sales Trends at ${storeId.replace('_', ' #')}`;
      subtitle = 'Daily unit sales for Foods, Hobbies, and Household';
      datasets = Object.keys(hierarchy.categories).map(catId => ({
        label: hierarchy.categories[catId].name,
        _fullData: categoryDaily[`${storeId}|${catId}`],
        data: categoryDaily[`${storeId}|${catId}`].slice(0, currentCount),
        borderColor: COLORS[catId],
        backgroundColor: COLORS[catId] + '22',
        borderWidth: 3,
        borderJoinStyle: 'round',
        borderCapStyle: 'round',
        fill: true,
        pointRadius: 0,
        tension: 0.45
      }));
      legendItems = datasets.map(d => ({ label: d.label, color: d.borderColor }));
      break;
    }

    case 'departments': {
      const storeId = currentPath[1];
      const catId = currentPath[2];
      const catName = hierarchy.categories[catId]?.name;
      title = `${catName} Department Trends at ${storeId.replace('_', ' #')}`;
      subtitle = 'Comparing department sales over time';
      const depts = hierarchy.categories[catId]?.departments || [];
      datasets = depts.map((deptId, i) => ({
        label: deptId.replace('_', ' '),
        _fullData: deptDaily[`${storeId}|${deptId}`],
        data: deptDaily[`${storeId}|${deptId}`].slice(0, currentCount),
        borderColor: storePalette[i % storePalette.length],
        backgroundColor: storePalette[i % storePalette.length] + '22',
        borderWidth: 3,
        borderJoinStyle: 'round',
        borderCapStyle: 'round',
        fill: false,
        pointRadius: 0,
        tension: 0.45
      }));
      legendItems = datasets.map(d => ({ label: d.label, color: d.borderColor }));
      break;
    }
  }

  chartTitle.textContent = title;
  chartSubtitle.textContent = subtitle;
  chartLegend.innerHTML = legendItems.map(item => `
    <div class="chart-legend-item">
      <span class="chart-legend-dot" style="background:${item.color}"></span>
      <span>${item.label}</span>
    </div>
  `).join('');

  // Keep full 1,941 xLabels fixed so scale domain stays steady while line grows live
  const xLabels = dates.map(d => fmtDate(d));

  if (chartInstance) {
    chartInstance.data.labels = xLabels;
    chartInstance.data.datasets = datasets;
    chartInstance.update();
  } else {
    const ctx = $('salesChart').getContext('2d');
    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: xLabels,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: 'rgba(255, 255, 255, 0.95)',
            titleColor: '#2D2D2D',
            bodyColor: '#555555',
            borderColor: 'rgba(0,0,0,0.08)',
            borderWidth: 1,
            padding: 10,
            boxPadding: 4,
            usePointStyle: true,
            titleFont: { family: "'Patrick Hand', cursive, sans-serif", size: 14 },
            bodyFont: { family: "'Patrick Hand', cursive, sans-serif", size: 13 },
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${fmtNum(ctx.raw)} units`
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              maxTicksLimit: 8,
              font: { family: "'Patrick Hand', cursive, sans-serif", size: 13 },
              color: '#8A857D'
            }
          },
          y: {
            grid: { color: 'rgba(0,0,0,0.04)' },
            ticks: {
              font: { family: "'Patrick Hand', cursive, sans-serif", size: 13 },
              color: '#8A857D',
              callback: (val) => fmtNum(val)
            }
          }
        }
      }
    });
  }
}

function updateChartMarker() {
  if (!chartInstance || currentLevel === 'items') return;

  const currentCount = currentDay + 1;
  let activeMin = Infinity;
  let activeMax = -Infinity;

  chartInstance.data.datasets.forEach(ds => {
    if (ds._fullData) {
      ds.data = ds._fullData.slice(0, currentCount);
      for (let i = 0; i < ds.data.length; i++) {
        const v = ds.data[i];
        if (v !== undefined && v !== null && !isNaN(v)) {
          if (v < activeMin) activeMin = v;
          if (v > activeMax) activeMax = v;
        }
      }
    }
  });

  if (activeMin === Infinity) activeMin = 0;
  if (activeMax === -Infinity) activeMax = 100;

  // Dynamic auto-zoom: scale Y-axis bounds to fit visible sales window nicely
  const yMin = Math.max(0, Math.floor(activeMin * 0.92));
  const yMax = Math.ceil(activeMax * 1.08);

  chartInstance.options.scales.y.min = yMin;
  chartInstance.options.scales.y.max = yMax;

  chartInstance.update('none');
}

// ── Init ──────────────────────────────────────────────────────────────
async function init() {
  try {
    await loadData();
    loadingEl.style.display = 'none';
    gridEl.style.display = '';

    buildSliderTicks();
    updateDayDisplay();
    updateBreadcrumb();
    updateLevelInfo();
    renderGrid(true);

    // Update header total for initial day
    const total = Object.values(stateDaily).reduce((s, arr) => s + arr[currentDay], 0);
    hdrTotal.textContent = fmtNum(total);

    // Event listeners
    sliderEl.addEventListener('input', onSliderInput);
    playBtn.addEventListener('click', togglePlay);
    speedBtn.addEventListener('click', cycleSpeed);
    backBtn.addEventListener('click', drillUp);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') {
        currentDay = Math.min(dates.length - 1, currentDay + 1);
        sliderEl.value = currentDay;
        updateDayDisplay();
        updateValues();
      } else if (e.key === 'ArrowLeft') {
        currentDay = Math.max(0, currentDay - 1);
        sliderEl.value = currentDay;
        updateDayDisplay();
        updateValues();
      } else if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'Escape' || e.key === 'Backspace') {
        drillUp();
      }
    });

  } catch (err) {
    loadingEl.innerHTML = `<p style="color:#E74C3C">Failed to load data. Make sure you've run the preprocessor first.<br><code>${err.message}</code></p>`;
    console.error(err);
  }
}

// Go!
init();

