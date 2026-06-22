require('dotenv').config();
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { ethers } = require('ethers');

process.on('uncaughtException', (err) => {
  console.error('Uncaught:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message || err);
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.static('public'));

const clients = new Set();
const contractCache = new Map();
const MINTS_FILE = path.join(__dirname, 'mints_history.json');
const MAX_RECENT = 5000;
const MAX_AGE = 24 * 60 * 60 * 1000;

let recentMints = [];
try {
  if (fs.existsSync(MINTS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(MINTS_FILE, 'utf8'));
    const cutoff = Date.now() - MAX_AGE;
    recentMints = raw.filter(m => m.timestamp > cutoff);
    console.log(`Loaded ${recentMints.length} mints from history`);
  }
} catch { recentMints = []; }

let savePending = false;
function scheduleSave() {
  if (savePending) return;
  savePending = true;
  setTimeout(() => {
    savePending = false;
    try { fs.writeFileSync(MINTS_FILE, JSON.stringify(recentMints)); } catch {}
  }, 10_000);
}
const processedKeys = new Map();

let wsProvider = null;
let httpProvider = null;
let pendingCalls = 0;
const MAX_CONCURRENT = 10;
const callQueue = [];
let cleanupInterval = null;
let reconnecting = false;

async function throttled(fn) {
  if (pendingCalls >= MAX_CONCURRENT) {
    await new Promise(resolve => callQueue.push(resolve));
  }
  pendingCalls++;
  try {
    return await fn();
  } finally {
    pendingCalls--;
    if (callQueue.length > 0) callQueue.shift()();
  }
}

let currentStatus = { type: 'status', connected: false, message: 'Starting...' };
const uniqueIPs = new Set();

wss.on('connection', (ws, req) => {
  clients.add(ws);
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  uniqueIPs.add(ip);
  ws.send(JSON.stringify(currentStatus));
  ws.send(JSON.stringify({ type: 'history', mints: recentMints }));
  if (currentGas) ws.send(JSON.stringify({ type: 'gas', ...currentGas }));
  ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  }
}

// ===== GAS TRACKER =====
let currentGas = null;

async function pollGas() {
  // Try Etherscan first
  try {
    const key = process.env.ETHERSCAN_API_KEY || '';
    const keyParam = key ? `&apikey=${key}` : '';
    const resp = await fetch(`https://api.etherscan.io/api?module=gastracker&action=gasoracle${keyParam}`);
    const data = await resp.json();
    if (data.status === '1' && data.result) {
      currentGas = {
        low: parseFloat(data.result.SafeGasPrice),
        avg: parseFloat(data.result.ProposeGasPrice),
        high: parseFloat(data.result.FastGasPrice),
        base: parseFloat(data.result.suggestBaseFee),
      };
      broadcast({ type: 'gas', ...currentGas });
      return;
    }
  } catch (e) {
    console.error('Etherscan gas error:', e.message);
  }
  // Fallback: get base fee from RPC
  try {
    const p = httpProvider || wsProvider;
    if (p) {
      const block = await p.getBlock('latest');
      if (block?.baseFeePerGas) {
        const base = parseFloat(ethers.formatUnits(block.baseFeePerGas, 'gwei'));
        currentGas = { low: base, avg: base, high: base, base };
        broadcast({ type: 'gas', ...currentGas });
      }
    }
  } catch (e) {
    console.error('RPC gas fallback error:', e.message);
  }
}

setInterval(pollGas, 15_000);

// Event signatures
const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_SINGLE_SIG = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const ZERO_PADDED = '0x' + '0'.repeat(64);

const KNOWN_SELECTORS = {
  '0x1249c58b': 'mint',
  '0xa0712d68': 'mint',
  '0x40c10f19': 'mint',
  '0x6a627842': 'mint',
  '0xefef39a1': 'mint',
  '0x2db11544': 'mint',
  '0xa945bf80': 'mintPublic',
  '0xa723533e': 'mintSigned',
  '0x84bb1e42': 'mintTo',
  '0x4fda4840': 'mintBatch',
  '0x156e29f6': 'mintTo',
  '0x731133e9': 'mint',
  '0xd37c353b': 'mintPublic',
  '0xe2986429': 'mint',
  '0xac9650d8': 'multicall',
  '0x5ae401dc': 'multicall',
  '0x26092b83': 'purchase',
  '0xd96a094a': 'buy',
  '0x3610724e': 'claim',
  '0x4e71d92d': 'claim',
  '0xf088d547': 'mintSigned',
  '0x57bc3d78': 'observe',
  '0xfb92488a': 'mint',
  '0xb869e5b9': 'mint',
  '0x6871ee40': 'mint',
  '0xa14481ae': 'mint',
  '0xe6798baa': 'mint',
  '0xd85d3d27': 'mintPublic',
  '0x94bf804d': 'mint',
  '0x2e234dae': 'mint',
  '0x574fed17': 'mint',
  '0x0d0cda62': 'mint',
  '0x1b2ef1ca': 'mint',
  '0x3ccfd60b': 'withdraw',
  '0x9e34070f': 'claim',
  '0xba7a86b8': 'mint',
  '0x236aed60': 'check',
};

async function getContractInfo(address) {
  if (contractCache.has(address)) return contractCache.get(address);

  const info = {
    address,
    name: address.slice(0, 6) + '...' + address.slice(-4),
    symbol: '',
    totalSupply: null,
    isERC721: null,
  };

  try {
    const p = httpProvider || wsProvider;
    const c = new ethers.Contract(address, [
      'function name() view returns (string)',
      'function symbol() view returns (string)',
      'function totalSupply() view returns (uint256)',
    ], p);

    await Promise.allSettled([
      throttled(() => c.name().then(n => info.name = n)),
      throttled(() => c.symbol().then(s => info.symbol = s)),
      throttled(() => c.totalSupply().then(s => info.totalSupply = s.toString())),
    ]);
  } catch {}

  contractCache.set(address, info);
  setTimeout(() => contractCache.delete(address), 120_000);
  return info;
}

async function handleLog(log, standard) {
  // ERC-721: must have 4 topics (signature, from, to, tokenId) and empty data
  if (standard === 'ERC-721') {
    if (log.topics.length !== 4) return;
  }

  const key = log.transactionHash + ':' + log.address;

  if (processedKeys.has(key)) {
    const existing = processedKeys.get(key);
    existing.quantity = (existing.quantity || 1) + 1;
    // Update in recentMints
    const idx = recentMints.findIndex(m => m.txHash === log.transactionHash && m.contract === log.address);
    if (idx !== -1) recentMints[idx].quantity = existing.quantity;
    broadcast({ type: 'update', txHash: log.transactionHash, contract: log.address, quantity: existing.quantity });
    return;
  }

  try {
    const p = httpProvider || wsProvider;
    const [info, tx] = await Promise.all([
      getContractInfo(log.address),
      throttled(() => p.getTransaction(log.transactionHash)).catch(() => null),
    ]);

    const minter = tx?.from || null;
    const value = tx ? ethers.formatEther(tx.value) : '0';
    const valueWei = tx ? tx.value.toString() : '0';

    let fnName = 'mint';
    let selector = '';
    if (tx?.data && tx.data.length >= 10) {
      selector = tx.data.slice(0, 10);
      fnName = KNOWN_SELECTORS[selector] || selector;
    }

    let gasGwei = 0;
    if (tx) {
      try {
        const gp = tx.gasPrice || tx.maxFeePerGas || tx.maxPriorityFeePerGas;
        if (gp && gp > 0n) {
          const parsed = parseFloat(ethers.formatUnits(gp, 'gwei'));
          gasGwei = parsed < 1 ? parseFloat(parsed.toFixed(2)) : Math.round(parsed);
        }
      } catch {}
    }

    const mint = {
      txHash: log.transactionHash,
      contract: log.address,
      name: info.name,
      symbol: info.symbol,
      totalSupply: info.totalSupply,
      standard,
      minter,
      value,
      valueWei,
      quantity: 1,
      fnName,
      selector,
      gasPrice: gasGwei,
      blockNumber: log.blockNumber,
      timestamp: Date.now(),
    };

    processedKeys.set(key, mint);
    recentMints.unshift(mint);
    if (recentMints.length > MAX_RECENT) recentMints.pop();
    scheduleSave();

    broadcast({ type: 'mint', data: mint });
    console.log(`MINT: ${info.name} (${standard}) ${value} ETH | ${minter ? minter.slice(0, 10) : '?'}...`);
  } catch {}
}

function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  console.log('Reconnecting in 5s...');
  currentStatus = { type: 'status', connected: false, message: 'Reconnecting...' };
  broadcast(currentStatus);
  setTimeout(() => {
    reconnecting = false;
    startListener();
  }, 5_000);
}

async function destroyProvider() {
  if (wsProvider) {
    try { wsProvider.removeAllListeners(); } catch {}
    try { wsProvider.websocket.removeAllListeners(); } catch {}
    try { wsProvider.destroy(); } catch {}
    wsProvider = null;
  }
}

async function startListener() {
  const wsUrl = process.env.ETH_WS_RPC;
  const httpUrl = process.env.ETH_HTTP_RPC;

  if (!wsUrl || wsUrl.includes('YOUR_KEY')) {
    console.log('\n  ETH_WS_RPC not configured in .env');
    currentStatus = { type: 'status', connected: false, message: 'RPC not configured' };
    broadcast(currentStatus);
    return;
  }

  await destroyProvider();

  try {
    wsProvider = new ethers.WebSocketProvider(wsUrl);

    wsProvider.websocket.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });

    wsProvider.websocket.on('close', () => {
      console.log('WebSocket disconnected');
      destroyProvider();
      scheduleReconnect();
    });

    if (httpUrl && !httpUrl.includes('YOUR_KEY')) {
      httpProvider = new ethers.JsonRpcProvider(httpUrl);
    }

    const network = await wsProvider.getNetwork();
    console.log(`Connected to ${network.name} (chainId: ${network.chainId})`);

    wsProvider.on({ topics: [TRANSFER_SIG, ZERO_PADDED] }, (log) => {
      handleLog(log, 'ERC-721');
    });

    wsProvider.on({ topics: [TRANSFER_SINGLE_SIG, null, ZERO_PADDED] }, (log) => {
      handleLog(log, 'ERC-1155');
    });

    console.log('Listening for mints...\n');
    currentStatus = { type: 'status', connected: true, network: network.name };
    broadcast(currentStatus);

    if (!cleanupInterval) {
      cleanupInterval = setInterval(() => {
        const keyCutoff = Date.now() - 60_000;
        for (const [key, mint] of processedKeys) {
          if (mint.timestamp < keyCutoff) processedKeys.delete(key);
        }
        const ageCutoff = Date.now() - MAX_AGE;
        const before = recentMints.length;
        recentMints = recentMints.filter(m => m.timestamp > ageCutoff);
        if (recentMints.length < before) scheduleSave();
      }, 30_000);
    }

  } catch (err) {
    console.error('Connection failed:', err.message);
    await destroyProvider();
    scheduleReconnect();
  }
}

// Extended contract details (fetched on demand, cached 10min)
const extendedCache = new Map();

async function getContractExtended(address) {
  if (extendedCache.has(address)) return extendedCache.get(address);

  const details = {
    maxSupply: null,
    verified: false,
    deployer: null,
    deployTx: null,
    deployTime: null,
    openseaUrl: `https://opensea.io/assets/ethereum/${address}`,
    image: null,
  };

  const p = httpProvider || wsProvider;
  if (!p) return details;

  const etherscanKey = process.env.ETHERSCAN_API_KEY || '';
  const keyParam = etherscanKey ? `&apikey=${etherscanKey}` : '';

  await Promise.allSettled([
    // maxSupply on-chain
    (async () => {
      const c = new ethers.Contract(address, [
        'function maxSupply() view returns (uint256)',
        'function MAX_SUPPLY() view returns (uint256)',
        'function maxMintSupply() view returns (uint256)',
      ], p);
      try { details.maxSupply = (await throttled(() => c.maxSupply())).toString(); } catch {
        try { details.maxSupply = (await throttled(() => c.MAX_SUPPLY())).toString(); } catch {
          try { details.maxSupply = (await throttled(() => c.maxMintSupply())).toString(); } catch {}
        }
      }
    })(),

    // Etherscan: verified status + deployer
    (async () => {
      try {
        const [abiResp, creationResp] = await Promise.all([
          fetch(`https://api.etherscan.io/api?module=contract&action=getabi&address=${address}${keyParam}`).then(r => r.json()),
          fetch(`https://api.etherscan.io/api?module=contract&action=getcontractcreation&contractaddresses=${address}${keyParam}`).then(r => r.json()),
        ]);
        details.verified = abiResp.status === '1';
        if (creationResp.result?.length > 0) {
          details.deployer = creationResp.result[0].contractCreator;
          details.deployTx = creationResp.result[0].txHash;
        }
      } catch {}
    })(),

    // Alchemy NFT API: image, opensea slug, deployer fallback
    (async () => {
      try {
        const httpUrl = process.env.ETH_HTTP_RPC;
        if (!httpUrl) return;
        const alchemyBase = httpUrl.replace('/v2/', '/nft/v3/');
        const resp = await fetch(`${alchemyBase}/getContractMetadata?contractAddress=${address}`);
        const data = await resp.json();
        if (data.openSeaMetadata?.collectionSlug) {
          details.openseaUrl = `https://opensea.io/collection/${data.openSeaMetadata.collectionSlug}`;
        }
        if (data.openSeaMetadata?.imageUrl) {
          details.image = data.openSeaMetadata.imageUrl;
        }
        if (data.contractDeployer && !details.deployer) {
          details.deployer = data.contractDeployer;
        }
      } catch {}
    })(),
  ]);

  // Deploy timestamp from block
  if (details.deployTx) {
    try {
      const tx = await throttled(() => p.getTransaction(details.deployTx));
      if (tx?.blockNumber) {
        const block = await throttled(() => p.getBlock(tx.blockNumber));
        if (block) details.deployTime = block.timestamp * 1000;
      }
    } catch {}
  }

  extendedCache.set(address, details);
  setTimeout(() => extendedCache.delete(address), 600_000);
  return details;
}

// API routes
app.get('/api/collection/:address', async (req, res) => {
  try {
    const addr = req.params.address;
    const [info, extended] = await Promise.all([
      getContractInfo(addr),
      getContractExtended(addr),
    ]);

    const mints = recentMints.filter(m => m.contract.toLowerCase() === addr.toLowerCase());
    const uniqueMinters = new Set(mints.map(m => m.minter).filter(Boolean)).size;
    const firstMint = mints.length > 0 ? mints[mints.length - 1] : null;
    const lastMint = mints.length > 0 ? mints[0] : null;

    let deployerBalance = null;
    let deployerAge = null;
    const p = httpProvider || wsProvider;
    if (extended.deployer && p) {
      await Promise.allSettled([
        (async () => {
          const bal = await throttled(() => p.getBalance(extended.deployer));
          deployerBalance = parseFloat(ethers.formatEther(bal));
        })(),
        (async () => {
          const etherscanKey = process.env.ETHERSCAN_API_KEY || '';
          const keyParam = etherscanKey ? `&apikey=${etherscanKey}` : '';
          const resp = await fetch(`https://api.etherscan.io/api?module=account&action=txlist&address=${extended.deployer}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc${keyParam}`);
          const data = await resp.json();
          if (data.result?.length > 0 && data.result[0].timeStamp) {
            deployerAge = parseInt(data.result[0].timeStamp) * 1000;
          }
        })(),
      ]);
    }

    res.json({
      ...info,
      ...extended,
      recentMintCount: mints.length,
      uniqueMinters,
      firstMintTime: firstMint?.timestamp || null,
      lastMintTime: lastMint?.timestamp || null,
      deployerBalance,
      deployerAge,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const imageCache = new Map();

app.get('/api/image/:address', async (req, res) => {
  const addr = req.params.address;
  if (imageCache.has(addr)) return res.json({ image: imageCache.get(addr) });
  try {
    const httpUrl = process.env.ETH_HTTP_RPC;
    if (!httpUrl) return res.json({ image: null });
    const alchemyBase = httpUrl.replace('/v2/', '/nft/v3/');
    const resp = await fetch(`${alchemyBase}/getContractMetadata?contractAddress=${addr}`);
    const data = await resp.json();
    const img = data.openSeaMetadata?.imageUrl || null;
    if (img) {
      imageCache.set(addr, img);
      setTimeout(() => imageCache.delete(addr), 600_000);
    }
    res.json({ image: img });
  } catch {
    res.json({ image: null });
  }
});

const holdersCache = new Map();

app.get('/api/holders/:address', async (req, res) => {
  const addr = req.params.address;
  if (holdersCache.has(addr)) return res.json(holdersCache.get(addr));

  try {
    const httpUrl = process.env.ETH_HTTP_RPC;
    if (!httpUrl) return res.json({ holders: [] });
    const alchemyBase = httpUrl.replace('/v2/', '/nft/v3/');
    const key = httpUrl.split('/v2/')[1];

    const ownersResp = await fetch(`${alchemyBase}/getOwnersForContract?contractAddress=${addr}&withTokenBalances=true`);
    const ownersData = await ownersResp.json();

    if (!ownersData.owners || ownersData.owners.length === 0) return res.json({ holders: [] });

    const sorted = ownersData.owners
      .map(o => ({ address: o.ownerAddress, tokenCount: o.tokenBalances ? o.tokenBalances.reduce((s, t) => s + parseInt(t.balance || '1'), 0) : 1 }))
      .sort((a, b) => b.tokenCount - a.tokenCount)
      .slice(0, 15);

    const p = httpProvider || wsProvider;
    if (p) {
      await Promise.all(sorted.map(async (h) => {
        try {
          const bal = await throttled(() => p.getBalance(h.address));
          h.ethBalance = parseFloat(ethers.formatEther(bal));
        } catch { h.ethBalance = null; }
      }));
    }

    const result = { holders: sorted, timestamp: Date.now() };
    holdersCache.set(addr, result);
    setTimeout(() => holdersCache.delete(addr), 600_000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, holders: [] });
  }
});

app.get('/api/viewers', (req, res) => {
  res.json({ online: clients.size, total: uniqueIPs.size });
});

app.get('/api/stats', (req, res) => {
  const oneMinAgo = Date.now() - 60_000;
  const mintsLastMin = recentMints.filter(m => m.timestamp > oneMinAgo).length;
  res.json({
    totalTracked: recentMints.length,
    mintsPerMinute: mintsLastMin,
    uniqueContracts: new Set(recentMints.map(m => m.contract)).size,
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  YujiWatch running on http://localhost:${PORT}\n`);
  startListener();
  pollGas();
});
