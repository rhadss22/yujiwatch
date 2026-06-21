if (new URLSearchParams(location.search).has('admin')) localStorage.setItem('yuji-admin', '1');
const isAdmin = localStorage.getItem('yuji-admin') === '1';

const mintFeed = document.getElementById('mint-feed');
const statusEl = document.getElementById('status');
const gasEl = document.getElementById('gas-display');
const overviewList = document.getElementById('overview-list');
const noSelection = document.getElementById('no-selection');
const detailEl = document.getElementById('collection-detail');

const allMints = [];
const collections = new Map();
const imageCache = new Map();
const imagePending = new Set();
let activeTimeWindow = 300000;
let selectedCollection = null;
let lastGasPrice = 0;
const hiddenCollections = new Set(JSON.parse(localStorage.getItem('yuji-hidden') || '[]'));

function saveHidden() {
  localStorage.setItem('yuji-hidden', JSON.stringify([...hiddenCollections]));
}

function toggleHidden(address) {
  if (hiddenCollections.has(address)) hiddenCollections.delete(address);
  else hiddenCollections.add(address);
  saveHidden();
  updateOverview();
  refreshLiveFeedVisibility();
}

function refreshLiveFeedVisibility() {
  mintFeed.querySelectorAll('.mint-entry').forEach(el => {
    el.style.display = hiddenCollections.has(el.dataset.contract) ? 'none' : '';
  });
}

function avatarHtml(contract, name, cls) {
  const initial = name ? name.charAt(0).toUpperCase() : '?';
  const img = imageCache.get(contract);
  if (img) {
    return `<img src="${img}" alt="" class="${cls}" onerror="this.outerHTML='<div class=\\'${cls}\\'>${initial}</div>'">`;
  }
  return `<div class="${cls}">${initial}</div>`;
}

function fetchImage(contract) {
  if (imageCache.has(contract) || imagePending.has(contract)) return;
  imagePending.add(contract);
  fetch(`/api/image/${contract}`)
    .then(r => r.json())
    .then(data => {
      imagePending.delete(contract);
      if (data.image) {
        imageCache.set(contract, data.image);
        updateAvatars(contract);
      }
    })
    .catch(() => imagePending.delete(contract));
}

function updateAvatars(contract) {
  const img = imageCache.get(contract);
  if (!img) return;
  document.querySelectorAll(`[data-contract="${contract}"] .me-avatar`).forEach(el => {
    el.outerHTML = `<img src="${img}" alt="" class="me-avatar" onerror="this.outerHTML='<div class=\\'me-avatar\\'>?</div>'">`;
  });
  document.querySelectorAll(`.ov-card[data-addr="${contract}"] .ov-avatar`).forEach(el => {
    el.outerHTML = `<img src="${img}" alt="" class="ov-avatar" onerror="this.outerHTML='<div class=\\'ov-avatar\\'>?</div>'">`;
  });
  if (selectedCollection === contract) {
    const detailAvatar = document.getElementById('detail-avatar');
    detailAvatar.innerHTML = `<img src="${img}" alt="" style="width:100%;height:100%;object-fit:cover;">`;
  }
}

// Etherscan link SVG
const etherscanSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h';
}

function shortAddr(addr) {
  if (!addr) return '???';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function formatValue(value) {
  const n = parseFloat(value);
  if (n === 0) return 'Free';
  if (n < 0.0001) return '< 0.0001 ETH';
  if (n < 0.01) return 'Ξ ' + n.toFixed(4);
  return 'Ξ ' + n.toFixed(3);
}

function formatNumber(n) {
  if (n === null || n === undefined) return '—';
  const num = parseInt(n);
  if (isNaN(num)) return n;
  return num.toLocaleString();
}

// ===== LIVE MINT CARD =====
function createMintEntry(mint) {
  const el = document.createElement('div');
  el.className = 'mint-entry new';
  el.dataset.contract = mint.contract;
  el.dataset.txhash = mint.txHash;

  const isFree = parseFloat(mint.value) === 0;
  const priceLabel = formatValue(mint.value);
  const qty = mint.quantity || 1;
  const fnLabel = mint.fnName && !mint.fnName.startsWith('0x') ? mint.fnName : 'mint';
  const time = timeAgo(mint.timestamp);
  const gas = mint.gasPrice || 0;
  const qtyBadge = qty > 1 ? `<span class="me-qty-badge">x${qty}</span>` : '';

  el.innerHTML = `
    ${avatarHtml(mint.contract, mint.name, 'me-avatar')}
    <div class="me-body">
      <div class="me-name" title="${mint.name}">${mint.name} ${qtyBadge}</div>
      <div class="me-meta">
        <span class="me-price ${isFree ? 'free' : 'paid'}">${priceLabel}</span>
        <span class="sep">|</span>
        <span class="me-fn">&#9670; ${fnLabel}</span>
        <span class="sep">|</span>
        <span class="me-gas">&#9981; ${gas}</span>
      </div>
    </div>
    <div class="me-right">
      <span class="me-time">&lt; ${time}</span>
      <div class="me-links">
        <a href="https://etherscan.io/tx/${mint.txHash}" target="_blank" rel="noopener"
           title="View tx on Etherscan" onclick="event.stopPropagation()">${etherscanSvg}</a>
      </div>
    </div>
  `;

  el.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    showCollection(mint.contract);
  });
  setTimeout(() => el.classList.remove('new'), 300);

  return el;
}

// ===== ADD MINT =====
function addMint(mint, prepend) {
  allMints.unshift(mint);
  if (allMints.length > 5000) allMints.pop();

  if (!collections.has(mint.contract)) {
    collections.set(mint.contract, {
      name: mint.name,
      symbol: mint.symbol,
      standard: mint.standard,
      totalSupply: mint.totalSupply,
      minters: new Set(),
      mints: [],
      lastPrice: mint.value,
      lastGas: mint.gasPrice,
    });
    fetchImage(mint.contract);
  }

  const col = collections.get(mint.contract);
  col.mints.unshift(mint);
  if (mint.minter) col.minters.add(mint.minter);
  if (mint.name) col.name = mint.name;
  if (mint.totalSupply) col.totalSupply = mint.totalSupply;
  col.lastPrice = mint.value;
  col.lastGas = mint.gasPrice;

  // Update gas display
  if (mint.gasPrice && mint.gasPrice > 0) {
    lastGasPrice = mint.gasPrice;
    gasEl.innerHTML = `&#9981; ${lastGasPrice} gwei`;
  }

  // Add to live feed
  const entry = createMintEntry(mint);
  if (hiddenCollections.has(mint.contract)) entry.style.display = 'none';
  if (prepend !== false) {
    mintFeed.prepend(entry);
  } else {
    mintFeed.appendChild(entry);
  }

  while (mintFeed.children.length > 200) {
    mintFeed.lastChild.remove();
  }

  // If this collection is selected, update detail
  if (selectedCollection === mint.contract) {
    showCollection(mint.contract);
  }
}

// ===== LEFT SIDEBAR: OVERVIEW =====
function updateOverview() {
  const cutoff = Date.now() - activeTimeWindow;

  const ranked = [];
  for (const [addr, col] of collections) {
    const recent = col.mints.filter(m => m.timestamp > cutoff);
    if (recent.length === 0) continue;
    ranked.push({ address: addr, ...col, recentCount: recent.length });
  }

  ranked.sort((a, b) => b.recentCount - a.recentCount);

  overviewList.innerHTML = '';

  if (ranked.length === 0) {
    const windowLabel = activeTimeWindow < 60000 ? '1m' :
      activeTimeWindow < 300000 ? (activeTimeWindow / 60000) + 'm' :
      activeTimeWindow < 3600000 ? (activeTimeWindow / 60000) + 'm' :
      (activeTimeWindow / 3600000) + 'h';
    overviewList.innerHTML = `<p class="empty-state">No mints in the last ${windowLabel}</p>`;
    return;
  }

  for (const col of ranked.slice(0, 50)) {
    const isHidden = hiddenCollections.has(col.address);
    const card = document.createElement('div');
    card.className = 'ov-card' + (selectedCollection === col.address ? ' active' : '') + (isHidden ? ' ov-hidden' : '');
    card.dataset.addr = col.address;

    const eyeIcon = isHidden
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

    card.innerHTML = `
      ${avatarHtml(col.address, col.name, 'ov-avatar')}
      <div class="ov-body">
        <div class="ov-name" title="${col.name}">${col.name}</div>
        <div class="ov-sub">
          <span>${col.standard}</span>
          <span>${shortAddr(col.address)}</span>
        </div>
      </div>
      <span class="ov-count">${col.recentCount}</span>
      <span class="ov-price">${formatValue(col.lastPrice)}</span>
      <button class="ov-hide-btn" data-hide="${col.address}" title="${isHidden ? 'Show' : 'Hide'}">${eyeIcon}</button>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.ov-hide-btn')) {
        e.stopPropagation();
        toggleHidden(col.address);
        return;
      }
      showCollection(col.address);
    });
    overviewList.appendChild(card);
  }
}

// ===== CENTER: COLLECTION DETAIL =====
function timeAgoLabel(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

async function showCollection(address) {
  const col = collections.get(address);
  if (!col) return;

  selectedCollection = address;
  noSelection.style.display = 'none';
  detailEl.style.display = 'block';

  // Immediate data from local state
  const initial = col.name ? col.name.charAt(0).toUpperCase() : '?';
  const detailAvatar = document.getElementById('detail-avatar');
  const cachedImg = imageCache.get(address);
  if (cachedImg) {
    detailAvatar.innerHTML = `<img src="${cachedImg}" alt="" style="width:100%;height:100%;object-fit:cover;">`;
  } else {
    detailAvatar.textContent = initial;
  }
  document.getElementById('detail-name').textContent = col.name;

  const badgeEl = document.getElementById('detail-standard');
  badgeEl.textContent = col.standard;
  badgeEl.className = 'badge ' + (col.standard === 'ERC-721' ? 'badge-721' : 'badge-1155');

  document.getElementById('badge-verified').style.display = 'none';

  const addrEl = document.getElementById('detail-address');
  addrEl.textContent = shortAddr(address);
  addrEl.href = 'https://etherscan.io/address/' + address;

  document.getElementById('detail-etherscan').href = 'https://etherscan.io/address/' + address;
  document.getElementById('detail-opensea').href = `https://opensea.io/assets/ethereum/${address}`;

  document.getElementById('detail-supply').textContent = formatNumber(col.totalSupply);
  document.getElementById('detail-supply-pct').textContent = '';
  document.getElementById('detail-max').textContent = '?';
  document.getElementById('detail-minters').textContent = col.minters.size.toLocaleString();
  document.getElementById('detail-tracked').textContent = col.mints.length;

  // Deploy info placeholders
  document.getElementById('deploy-wallet').textContent = '...';
  document.getElementById('deploy-wallet').href = '#';
  document.getElementById('deploy-time').textContent = '';
  document.getElementById('deploy-time').href = '#';

  // First/last mint from local data
  const localFirst = col.mints.length > 0 ? col.mints[col.mints.length - 1] : null;
  const localLast = col.mints.length > 0 ? col.mints[0] : null;
  document.getElementById('first-mint-time').textContent = localFirst ? timeAgoLabel(localFirst.timestamp) : '—';
  document.getElementById('last-mint-time').textContent = localLast ? timeAgoLabel(localLast.timestamp) : '—';

  document.getElementById('copy-addr').onclick = () => navigator.clipboard.writeText(address);

  // Render mints list
  renderDetailMints(col);
  updateOverview();

  // Fetch extended details from server
  try {
    const resp = await fetch(`/api/collection/${address}`);
    const data = await resp.json();

    // Collection image
    if (data.image && !imageCache.has(address)) {
      imageCache.set(address, data.image);
      updateAvatars(address);
    }

    // Verified badge
    if (data.verified) {
      document.getElementById('badge-verified').style.display = 'inline';
    }

    // Max supply
    if (data.maxSupply) {
      document.getElementById('detail-max').textContent = formatNumber(data.maxSupply);
      // Calculate percentage
      if (data.totalSupply && data.maxSupply) {
        const pct = ((parseInt(data.totalSupply) / parseInt(data.maxSupply)) * 100).toFixed(1);
        document.getElementById('detail-supply-pct').textContent = `(${pct}%)`;
      }
    }

    // OpenSea link (with proper slug if available)
    if (data.openseaUrl) {
      document.getElementById('detail-opensea').href = data.openseaUrl;
    }

    // Deployer
    if (data.deployer) {
      const walletEl = document.getElementById('deploy-wallet');
      walletEl.textContent = shortAddr(data.deployer);
      walletEl.href = `https://etherscan.io/address/${data.deployer}`;
    }

    if (data.deployTx) {
      const timeEl = document.getElementById('deploy-time');
      timeEl.textContent = data.deployTime ? timeAgoLabel(data.deployTime) : '';
      timeEl.href = `https://etherscan.io/tx/${data.deployTx}`;
    }

    // First/last from server (more accurate if more history)
    if (data.firstMintTime) {
      document.getElementById('first-mint-time').textContent = timeAgoLabel(data.firstMintTime);
    }
    if (data.lastMintTime) {
      document.getElementById('last-mint-time').textContent = timeAgoLabel(data.lastMintTime);
    }

    // Update unique minters from server
    if (data.uniqueMinters) {
      document.getElementById('detail-minters').textContent = data.uniqueMinters.toLocaleString();
    }

  } catch {}
}

function renderDetailMints(col) {
  const mintsList = document.getElementById('detail-mints');
  mintsList.innerHTML = '';

  for (const mint of col.mints.slice(0, 40)) {
    const row = document.createElement('div');
    row.className = 'detail-mint-row';
    const fnLabel = mint.fnName && !mint.fnName.startsWith('0x') ? mint.fnName : 'mint';
    row.innerHTML = `
      <span class="dmr-minter">${shortAddr(mint.minter)}</span>
      <span class="dmr-price">${formatValue(mint.value)}</span>
      <span class="dmr-fn">&#9670; ${fnLabel}</span>
      <span class="dmr-time">
        &lt; ${timeAgo(mint.timestamp)}
        <a href="https://etherscan.io/tx/${mint.txHash}" target="_blank" rel="noopener" title="View tx">${etherscanSvg}</a>
      </span>
    `;
    mintsList.appendChild(row);
  }
}

// ===== TIME FILTERS =====
document.querySelectorAll('.time-filters button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelector('.time-filters .active').classList.remove('active');
    btn.classList.add('active');
    activeTimeWindow = parseInt(btn.dataset.window);
    updateOverview();
  });
});

// ===== SEARCH =====
document.getElementById('search-input').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  if (!q) {
    updateOverview();
    return;
  }

  const results = [];
  for (const [addr, col] of collections) {
    if (col.name.toLowerCase().includes(q) || addr.toLowerCase().includes(q)) {
      results.push({ address: addr, ...col, recentCount: col.mints.length });
    }
  }

  results.sort((a, b) => b.recentCount - a.recentCount);
  overviewList.innerHTML = '';

  if (results.length === 0) {
    overviewList.innerHTML = '<p class="empty-state">No results</p>';
    return;
  }

  for (const col of results.slice(0, 30)) {
    const card = document.createElement('div');
    card.className = 'ov-card';
    card.dataset.addr = col.address;
    card.innerHTML = `
      ${avatarHtml(col.address, col.name, 'ov-avatar')}
      <div class="ov-body">
        <div class="ov-name">${col.name}</div>
        <div class="ov-sub"><span>${col.standard}</span></div>
      </div>
      <span class="ov-count">${col.recentCount}</span>
      <span class="ov-price">${formatValue(col.lastPrice)}</span>
    `;
    card.addEventListener('click', () => showCollection(col.address));
    overviewList.appendChild(card);
  }
});

// ===== WEBSOCKET =====
function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    statusEl.innerHTML = '&#9679; Connected';
    statusEl.className = 'status online';
  };

  ws.onclose = () => {
    statusEl.innerHTML = '&#9679; Reconnecting...';
    statusEl.className = 'status offline';
    setTimeout(connect, 3000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'mint') {
      addMint(msg.data);
      checkAlerts(msg.data);
      updateOverview();
    } else if (msg.type === 'history') {
      for (const m of msg.mints.reverse()) {
        addMint(m, false);
      }
      updateOverview();
    } else if (msg.type === 'status') {
      if (msg.connected) {
        statusEl.innerHTML = `&#9679; ${msg.network}`;
        statusEl.className = 'status online';
      } else {
        statusEl.innerHTML = `&#9679; ${msg.message || 'Disconnected'}`;
        statusEl.className = 'status offline';
      }
    } else if (msg.type === 'update') {
      const mint = allMints.find(m => m.txHash === msg.txHash && m.contract === msg.contract);
      if (mint) {
        mint.quantity = msg.quantity;
        const el = mintFeed.querySelector(`[data-txhash="${msg.txHash}"]`);
        if (el) {
          const nameEl = el.querySelector('.me-name');
          if (nameEl) {
            const existing = nameEl.querySelector('.me-qty-badge');
            if (msg.quantity > 1) {
              if (existing) {
                existing.textContent = `x${msg.quantity}`;
              } else {
                const badge = document.createElement('span');
                badge.className = 'me-qty-badge';
                badge.textContent = `x${msg.quantity}`;
                nameEl.appendChild(badge);
              }
            }
          }
        }
      }
    } else if (msg.type === 'viewers' && isAdmin) {
      const vd = document.getElementById('viewers-display');
      vd.style.display = '';
      vd.innerHTML = `&#128065; ${msg.online} online | ${msg.total} total`;
    }
  };
}

connect();

// ===== MINT ALERTS =====
const settingsToggle = document.getElementById('settings-toggle');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');
const alertRulesEl = document.getElementById('alert-rules');
const alertAddBtn = document.getElementById('alert-add');

const ALERT_SOUNDS = [
  { file: 'audley_fergine-warning-alarm-loop-1-279206.mp3', label: 'Warning Alarm' },
  { file: 'dragon-studio-car-engine-372477.mp3', label: 'Car Engine' },
  { file: 'dragon-studio-car-engine-roaring-376881.mp3', label: 'Engine Roaring' },
  { file: 'freesound_community-beep-warning-6387.mp3', label: 'Beep Warning' },
  { file: 'freesound_community-warning-sound-6686.mp3', label: 'Warning Sound' },
  { file: 'pwlpl-tornado-warning-siren-sound-effect-359252.mp3', label: 'Tornado Siren' },
  { file: 'universfield-new-notification-09-352705.mp3', label: 'Notification' },
];

let alertRules = JSON.parse(localStorage.getItem('yuji-alerts') || '[]');
if (alertRules.length === 0) {
  alertRules.push({ count: 10, window: 300000, sound: ALERT_SOUNDS[0].file, enabled: true, soundOn: true });
}

const notifiedMap = new Map();

function saveAlertRules() {
  localStorage.setItem('yuji-alerts', JSON.stringify(alertRules));
}

function renderAlertRules() {
  alertRulesEl.innerHTML = '';
  alertRules.forEach((rule, i) => {
    const div = document.createElement('div');
    div.className = 'alert-rule' + (rule.enabled ? ' enabled' : '');

    const windowLabels = [
      { v: 60000, l: '1 min' }, { v: 180000, l: '3 min' }, { v: 300000, l: '5 min' },
      { v: 600000, l: '10 min' }, { v: 1800000, l: '30 min' }, { v: 3600000, l: '1 hr' },
    ];
    const windowOpts = windowLabels.map(w =>
      `<option value="${w.v}" ${rule.window === w.v ? 'selected' : ''}>${w.l}</option>`
    ).join('');

    const soundOpts = ALERT_SOUNDS.map(s =>
      `<option value="${s.file}" ${rule.sound === s.file ? 'selected' : ''}>${s.label}</option>`
    ).join('');

    div.innerHTML = `
      <div class="alert-rule-top">
        <span>Alert at</span>
        <input type="number" value="${rule.count}" min="1" class="alert-input" data-field="count">
        <span>mints in</span>
        <select class="alert-select" data-field="window">${windowOpts}</select>
      </div>
      <div class="alert-sound-row">
        <select class="alert-select-sound" data-field="sound">${soundOpts}</select>
        <button class="alert-rule-btn" data-action="play">&#9654;</button>
      </div>
      <div class="alert-rule-bottom">
        <label><input type="checkbox" ${rule.enabled ? 'checked' : ''} data-field="enabled"> ON</label>
        <label><input type="checkbox" ${rule.soundOn ? 'checked' : ''} data-field="soundOn"> &#128266;</label>
        <button class="alert-rule-btn" data-action="test">Test</button>
        <button class="alert-rule-btn delete" data-action="delete">&#10005;</button>
      </div>
    `;

    div.addEventListener('change', (e) => {
      const f = e.target.dataset.field;
      if (!f) return;
      if (f === 'count') rule.count = parseInt(e.target.value) || 1;
      else if (f === 'window') rule.window = parseInt(e.target.value);
      else if (f === 'sound') rule.sound = e.target.value;
      else if (f === 'enabled') { rule.enabled = e.target.checked; div.classList.toggle('enabled', rule.enabled); }
      else if (f === 'soundOn') rule.soundOn = e.target.checked;
      saveAlertRules();
      if (f === 'enabled' && rule.enabled && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    });

    div.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      if (action === 'play') {
        const audio = new Audio(rule.sound);
        audio.play();
        setTimeout(() => { audio.pause(); audio.currentTime = 0; }, 3000);
      } else if (action === 'test') {
        const audio = new Audio(rule.sound);
        if (rule.soundOn) { audio.play(); setTimeout(() => { audio.pause(); audio.currentTime = 0; }, 3000); }
        if (Notification.permission === 'default') {
          Notification.requestPermission();
        } else if (Notification.permission === 'granted') {
          new Notification('🔥 Test Collection', { body: 'Test alert working!', icon: 'yuji.jpeg', silent: true });
        }
      } else if (action === 'delete') {
        alertRules.splice(i, 1);
        saveAlertRules();
        renderAlertRules();
      }
    });

    alertRulesEl.appendChild(div);
  });
}

settingsToggle.addEventListener('click', () => {
  settingsOverlay.style.display = 'flex';
  renderLayoutPanels();
});

settingsClose.addEventListener('click', () => {
  settingsOverlay.style.display = 'none';
});

settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.style.display = 'none';
});

alertAddBtn.addEventListener('click', () => {
  alertRules.push({ count: 10, window: 300000, sound: ALERT_SOUNDS[0].file, enabled: true, soundOn: true });
  saveAlertRules();
  renderAlertRules();
});

function fireAlert(rule, name, contract, count) {
  const img = imageCache.get(contract) || 'yuji.jpeg';
  if (Notification.permission === 'granted') {
    const n = new Notification(`🔥 ${name}`, {
      body: `${count} mints detected!`,
      icon: img,
      tag: contract + '-' + rule.count,
      silent: true,
    });
    n.onclick = () => { window.focus(); showCollection(contract); n.close(); };
  }
  if (rule.soundOn && rule.sound) {
    const audio = new Audio(rule.sound);
    audio.play().catch(() => {});
    setTimeout(() => { audio.pause(); audio.currentTime = 0; }, 3000);
  }
}

function checkAlerts(mint) {
  if (Notification.permission !== 'granted') return;

  const col = collections.get(mint.contract);
  if (!col) return;

  for (const rule of alertRules) {
    if (!rule.enabled) continue;
    const cutoff = Date.now() - rule.window;
    const recentCount = col.mints.filter(m => m.timestamp > cutoff).length;
    if (recentCount < rule.count) continue;

    const key = mint.contract + ':' + rule.count + ':' + rule.window;
    const lastNotified = notifiedMap.get(key) || 0;
    if (Date.now() - lastNotified < 60000) continue;

    notifiedMap.set(key, Date.now());
    fireAlert(rule, col.name, mint.contract, recentCount);
  }
}

renderAlertRules();

// ===== LAYOUT DRAG =====
const PANELS = [
  { id: 'panel-overview', label: 'Mints Overview', col: '260px' },
  { id: 'panel-detail', label: 'Contract Detail', col: '1fr' },
  { id: 'panel-livemints', label: 'Live Mints', col: '360px' },
];
const DEFAULT_ORDER = PANELS.map(p => p.id);
let panelOrder = JSON.parse(localStorage.getItem('yuji-layout') || 'null') || [...DEFAULT_ORDER];

function applyLayout() {
  const main = document.querySelector('main');
  const cols = panelOrder.map(id => PANELS.find(p => p.id === id).col);
  main.style.gridTemplateColumns = cols.join(' ');
  panelOrder.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.style.order = i;
  });
}

function renderLayoutPanels() {
  const container = document.getElementById('layout-panels');
  if (!container) return;
  container.innerHTML = '';
  let dragSrc = null;

  panelOrder.forEach((id, i) => {
    const panel = PANELS.find(p => p.id === id);
    const item = document.createElement('div');
    item.className = 'layout-item';
    item.draggable = true;
    item.dataset.idx = i;
    item.innerHTML = `<span class="drag-handle">&#8942;&#8942;</span> ${panel.label}`;

    item.addEventListener('dragstart', (e) => {
      dragSrc = i;
      e.dataTransfer.effectAllowed = 'move';
      item.style.opacity = '0.4';
    });

    item.addEventListener('dragend', () => {
      item.style.opacity = '1';
      container.querySelectorAll('.layout-item').forEach(el => el.classList.remove('drag-over'));
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drag-over');
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const target = i;
      if (dragSrc === null || dragSrc === target) return;
      const moved = panelOrder.splice(dragSrc, 1)[0];
      panelOrder.splice(target, 0, moved);
      localStorage.setItem('yuji-layout', JSON.stringify(panelOrder));
      applyLayout();
      renderLayoutPanels();
    });

    container.appendChild(item);
  });
}

document.getElementById('layout-reset').addEventListener('click', () => {
  panelOrder = [...DEFAULT_ORDER];
  localStorage.setItem('yuji-layout', JSON.stringify(panelOrder));
  applyLayout();
  renderLayoutPanels();
});

applyLayout();

// ===== PERIODIC UPDATES =====
setInterval(() => {
  const oneMinAgo = Date.now() - 60_000;
  const rate = allMints.filter(m => m.timestamp > oneMinAgo).length;
  document.getElementById('stat-total').textContent = allMints.length.toLocaleString();
  document.getElementById('stat-collections').textContent = collections.size.toLocaleString();
  document.getElementById('stat-rate').textContent = rate;
}, 3000);

setInterval(updateOverview, 8000);
