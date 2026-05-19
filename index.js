'use strict';

const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { URL } = require('node:url');

const APP_NAME = 'checkSrv';
const APP_VERSION = '1.0.0';

const CONFIG = Object.freeze({
  port: parsePort(process.env.PORT || process.env.SERVER_PORT || process.env.APP_PORT || process.env.WEB_PORT, 3000),
  host: process.env.HOST || process.env.SERVER_HOST || '0.0.0.0',
  publicUrl: String(process.env.PUBLIC_URL || process.env.APP_URL || '').trim(),
  publicProtocol: String(process.env.PUBLIC_PROTOCOL || 'http').replace(/:$/, ''),
  refreshMs: clamp(parsePositiveInt(process.env.REFRESH_MS || process.env.CHECKSRV_REFRESH_MS, 2000), 1000, 15000),
  geoTimeoutMs: clamp(parsePositiveInt(process.env.GEO_TIMEOUT_MS || process.env.CHECKSRV_GEO_TIMEOUT_MS, 3000), 1000, 10000),
  diskPath: process.env.DISK_PATH || process.env.CHECKSRV_DISK_PATH || process.cwd(),
});

let publicGeo = emptyGeo();
let latestSnapshot = null;
let metricsTimer = null;
let refreshInFlight = false;
let previousCpu = null;
let previousNetwork = null;
const sseClients = new Set();

function parsePort(value, fallback) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function parsePositiveInt(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function emptyGeo() {
  return {
    ip: '',
    city: '',
    region: '',
    country: '',
    countryCode: '',
    latitude: null,
    longitude: null,
    timezone: '',
    isp: '',
    org: '',
    asn: '',
    source: 'none',
  };
}

function normalizeGeo(geo) {
  return {
    ...emptyGeo(),
    ...geo,
    ip: pickString(geo.ip),
    city: pickString(geo.city),
    region: pickString(geo.region),
    country: pickString(geo.country),
    countryCode: pickString(geo.countryCode).toUpperCase(),
    timezone: pickString(geo.timezone),
    isp: pickString(geo.isp),
    org: pickString(geo.org),
    asn: pickString(geo.asn),
    source: pickString(geo.source) || 'unknown',
  };
}

function geoScore(geo) {
  let score = 0;
  if (geo.ip) score += 10;
  if (geo.country || geo.countryCode) score += 5;
  if (geo.city) score += 3;
  if (geo.region) score += 2;
  if (geo.isp || geo.org) score += 5;
  if (geo.asn) score += 2;
  if (Number.isFinite(geo.latitude) && Number.isFinite(geo.longitude)) score += 2;
  return score;
}

function requestText(rawUrl, timeoutMs, redirects = 0) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      reject(error);
      return;
    }

    const client = url.protocol === 'http:' ? http : https;
    let settled = false;
    let request;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimeout);
      if (error) reject(error);
      else resolve(value);
    };

    const totalTimeout = setTimeout(() => {
      if (request) request.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    request = client.get(
      url,
      {
        headers: {
          Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
          'User-Agent': `${APP_NAME}/${APP_VERSION}`,
        },
      },
      (response) => {
        const statusCode = response.statusCode || 0;
        const location = response.headers.location;

        if ([301, 302, 303, 307, 308].includes(statusCode) && location && redirects < 3) {
          response.resume();
          const nextUrl = new URL(location, url).toString();
          finish(null, requestText(nextUrl, timeoutMs, redirects + 1));
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          finish(new Error(`HTTP ${statusCode} from ${url.hostname}`));
          return;
        }

        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1024 * 1024) {
            request.destroy(new Error('Response too large'));
          }
        });
        response.on('end', () => finish(null, body));
        response.on('error', finish);
      },
    );

    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Request timeout after ${timeoutMs}ms`)));
    request.on('error', finish);
  });
}

async function requestJson(url, timeoutMs) {
  const text = await requestText(url, timeoutMs);
  return JSON.parse(text);
}

async function getPublicGeo() {
  const providers = [
    {
      name: 'ipwho.is',
      url: 'https://ipwho.is/',
      normalize(data) {
        if (data && data.success === false) return null;
        const connection = data && data.connection ? data.connection : {};
        const timezone = data && data.timezone ? data.timezone : {};
        return normalizeGeo({
          ip: data.ip,
          city: data.city,
          region: data.region,
          country: data.country,
          countryCode: data.country_code,
          latitude: Number(data.latitude),
          longitude: Number(data.longitude),
          timezone: timezone.id,
          isp: connection.isp,
          org: connection.org,
          asn: connection.asn ? `AS${connection.asn}` : '',
          source: 'ipwho.is',
        });
      },
    },
    {
      name: 'ipapi.co',
      url: 'https://ipapi.co/json/',
      normalize(data) {
        if (data && data.error) return null;
        return normalizeGeo({
          ip: data.ip,
          city: data.city,
          region: data.region,
          country: data.country_name,
          countryCode: data.country_code,
          latitude: Number(data.latitude),
          longitude: Number(data.longitude),
          timezone: data.timezone,
          isp: data.org,
          org: data.org,
          asn: data.asn,
          source: 'ipapi.co',
        });
      },
    },
    {
      name: 'ipinfo.io',
      url: 'https://ipinfo.io/json',
      normalize(data) {
        let latitude = null;
        let longitude = null;
        if (typeof data.loc === 'string' && data.loc.includes(',')) {
          const parts = data.loc.split(',');
          latitude = Number(parts[0]);
          longitude = Number(parts[1]);
        }
        return normalizeGeo({
          ip: data.ip,
          city: data.city,
          region: data.region,
          countryCode: data.country,
          latitude,
          longitude,
          timezone: data.timezone,
          isp: data.org,
          org: data.org,
          asn: data.org && data.org.startsWith('AS') ? data.org.split(' ')[0] : '',
          source: 'ipinfo.io',
        });
      },
    },
    {
      name: 'api.myip.com',
      url: 'https://api.myip.com',
      normalize(data) {
        return normalizeGeo({
          ip: data.ip,
          country: data.country,
          countryCode: data.cc,
          source: 'api.myip.com',
        });
      },
    },
    {
      name: 'ipify',
      url: 'https://api.ipify.org?format=json',
      normalize(data) {
        return normalizeGeo({ ip: data.ip, source: 'ipify' });
      },
    },
  ];

  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        const data = await requestJson(provider.url, CONFIG.geoTimeoutMs);
        const geo = provider.normalize(data);
        return geo && geo.ip ? geo : null;
      } catch (_) {
        return null;
      }
    }),
  );

  const best = results.filter(Boolean).sort((a, b) => geoScore(b) - geoScore(a))[0];
  return best || emptyGeo();
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 3000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function getDiskUsage() {
  try {
    if (process.platform === 'win32') throw new Error('Disk usage uses df and is optimized for Linux servers');
    const { stdout } = await execFileAsync('df', ['-Pk', CONFIG.diskPath]);
    const lines = stdout.trim().split('\n').filter(Boolean);
    const line = lines[lines.length - 1] || '';
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) throw new Error('Unable to parse df output');

    const total = Number(parts[1]) * 1024;
    const used = Number(parts[2]) * 1024;
    const free = Number(parts[3]) * 1024;
    const percent = total > 0 ? (used / total) * 100 : 0;

    return {
      supported: true,
      path: CONFIG.diskPath,
      filesystem: parts[0],
      mounted: parts.slice(5).join(' '),
      total,
      used,
      free,
      percent: round(percent),
    };
  } catch (error) {
    return {
      supported: false,
      path: CONFIG.diskPath,
      filesystem: '',
      mounted: '',
      total: 0,
      used: 0,
      free: 0,
      percent: 0,
      error: error.message,
    };
  }
}

function readCpuTimes() {
  const cpus = os.cpus();
  const perCore = cpus.map((cpu) => {
    const times = cpu.times;
    const total = Object.values(times).reduce((sum, value) => sum + value, 0);
    return { idle: times.idle, total };
  });

  return perCore.reduce(
    (summary, core) => {
      summary.idle += core.idle;
      summary.total += core.total;
      return summary;
    },
    { idle: 0, total: 0, perCore },
  );
}

function getCpuSnapshot() {
  const current = readCpuTimes();
  let percent = 0;
  let perCore = [];

  if (previousCpu) {
    const idleDelta = current.idle - previousCpu.idle;
    const totalDelta = current.total - previousCpu.total;
    percent = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;
    perCore = current.perCore.map((core, index) => {
      const previous = previousCpu.perCore[index];
      if (!previous) return 0;
      const coreIdleDelta = core.idle - previous.idle;
      const coreTotalDelta = core.total - previous.total;
      return round(coreTotalDelta > 0 ? (1 - coreIdleDelta / coreTotalDelta) * 100 : 0);
    });
  } else {
    perCore = current.perCore.map(() => 0);
  }

  previousCpu = current;
  const loadAverage = os.loadavg();
  const cores = Math.max(os.cpus().length, 1);

  return {
    percent: round(clamp(percent, 0, 100)),
    perCore,
    loadAverage: loadAverage.map((value) => round(value)),
    loadPercent: round(clamp((loadAverage[0] / cores) * 100, 0, 100)),
  };
}

function getMemorySnapshot() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    total,
    used,
    free,
    percent: round(total > 0 ? (used / total) * 100 : 0),
  };
}

async function getNetworkTotals() {
  if (process.platform !== 'linux') {
    return { supported: false, rxBytes: 0, txBytes: 0, interfaces: [] };
  }

  try {
    const text = await fsp.readFile('/proc/net/dev', 'utf8');
    const interfaces = [];
    let rxBytes = 0;
    let txBytes = 0;

    for (const line of text.split('\n').slice(2)) {
      if (!line.includes(':')) continue;
      const [namePart, dataPart] = line.split(':');
      const name = namePart.trim();
      if (!name || name === 'lo') continue;
      const numbers = dataPart.trim().split(/\s+/).map((value) => Number(value));
      const rx = numbers[0] || 0;
      const tx = numbers[8] || 0;
      rxBytes += rx;
      txBytes += tx;
      interfaces.push({ name, rxBytes: rx, txBytes: tx });
    }

    return { supported: true, rxBytes, txBytes, interfaces };
  } catch (_) {
    return { supported: false, rxBytes: 0, txBytes: 0, interfaces: [] };
  }
}

async function getNetworkSnapshot(now) {
  const current = await getNetworkTotals();
  if (!current.supported) {
    return { ...current, rxRate: 0, txRate: 0 };
  }

  let rxRate = 0;
  let txRate = 0;
  if (previousNetwork) {
    const seconds = Math.max((now - previousNetwork.time) / 1000, 0.001);
    rxRate = Math.max((current.rxBytes - previousNetwork.rxBytes) / seconds, 0);
    txRate = Math.max((current.txBytes - previousNetwork.txBytes) / seconds, 0);
  }

  previousNetwork = { ...current, time: now };
  return { ...current, rxRate: round(rxRate), txRate: round(txRate) };
}

function getProcessSnapshot() {
  const memory = process.memoryUsage();
  return {
    pid: process.pid,
    nodeVersion: process.version,
    uptime: round(process.uptime()),
    memory: {
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers || 0,
    },
  };
}

async function createSnapshot() {
  const now = Date.now();
  const [disk, network] = await Promise.all([getDiskUsage(), getNetworkSnapshot(now)]);
  return {
    timestamp: new Date(now).toISOString(),
    refreshMs: CONFIG.refreshMs,
    uptime: {
      system: round(os.uptime()),
      process: round(process.uptime()),
    },
    cpu: getCpuSnapshot(),
    memory: getMemorySnapshot(),
    disk,
    network,
    process: getProcessSnapshot(),
  };
}

function getLocalInterfaces() {
  const interfaces = os.networkInterfaces();
  const result = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.internal) continue;
      result.push({
        name,
        family: address.family,
        address: address.address,
        cidr: address.cidr || '',
      });
    }
  }

  return result;
}

function getCpuInfo() {
  const cpus = os.cpus();
  const speeds = cpus.map((cpu) => cpu.speed).filter((speed) => Number.isFinite(speed) && speed > 0);
  const speedMHz = speeds.length ? Math.round(speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length) : 0;

  return {
    model: cpus[0] ? cpus[0].model : 'unknown',
    cores: cpus.length,
    speedMHz,
  };
}

function isContainer() {
  return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
}

function isPterodactylLike() {
  return Boolean(process.env.P_SERVER_UUID || process.env.P_SERVER_LOCATION || process.env.SERVER_PORT);
}

function getPublicUrl() {
  if (CONFIG.publicUrl) return CONFIG.publicUrl;
  const host = publicGeo.ip || getLocalInterfaces().find((item) => item.family === 'IPv4')?.address || '127.0.0.1';
  const safeHost = host.includes(':') ? `[${host}]` : host;
  return `${CONFIG.publicProtocol}://${safeHost}:${CONFIG.port}`;
}

function getSummary() {
  return {
    app: {
      name: APP_NAME,
      version: APP_VERSION,
      startedAt: startedAt.toISOString(),
    },
    access: {
      host: CONFIG.host,
      port: CONFIG.port,
      publicUrl: getPublicUrl(),
      refreshMs: CONFIG.refreshMs,
    },
    geo: publicGeo,
    server: {
      hostname: os.hostname(),
      platform: os.platform(),
      type: os.type(),
      release: os.release(),
      arch: os.arch(),
      uptime: round(os.uptime()),
      cpu: getCpuInfo(),
      memory: getMemorySnapshot(),
      localInterfaces: getLocalInterfaces(),
      runtime: {
        nodeVersion: process.version,
        pid: process.pid,
        cwd: process.cwd(),
        container: isContainer(),
        pterodactyl: isPterodactylLike(),
        pterodactylLocation: process.env.P_SERVER_LOCATION || '',
      },
    },
    realtime: latestSnapshot,
  };
}

const startedAt = new Date();

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatLocation(geo) {
  return [geo.city, geo.region, geo.country || geo.countryCode].filter(Boolean).join(', ') || 'unknown';
}

function printBootLog() {
  const summary = getSummary();
  const disk = latestSnapshot && latestSnapshot.disk ? latestSnapshot.disk : { used: 0, total: 0, percent: 0 };
  const memory = summary.server.memory;
  const cpu = summary.server.cpu;

  console.log('='.repeat(58));
  console.log(`${APP_NAME} ready`);
  console.log(`URL      : ${summary.access.publicUrl}`);
  console.log(`IP       : ${summary.geo.ip || 'unknown'}`);
  console.log(`Location : ${formatLocation(summary.geo)}`);
  console.log(`Provider : ${summary.geo.isp || summary.geo.org || 'unknown'}`);
  console.log(`CPU      : ${cpu.model} (${cpu.cores} cores)`);
  console.log(`Memory   : ${formatBytes(memory.used)} / ${formatBytes(memory.total)} (${memory.percent}%)`);
  console.log(`Disk     : ${disk.supported === false ? 'unknown' : `${formatBytes(disk.used)} / ${formatBytes(disk.total)} (${disk.percent}%)`}`);
  console.log('='.repeat(58));
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body, null, 2));
}

function sendHtml(response, html) {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(html);
}

function sendSse(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function handleEvents(request, response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.write(': connected\n\n');
  sseClients.add(response);

  if (latestSnapshot) sendSse(response, 'snapshot', latestSnapshot);

  const heartbeat = setInterval(() => {
    response.write(': ping\n\n');
  }, 25000);

  request.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(response);
  });
}

async function refreshSnapshot() {
  if (refreshInFlight) return;
  refreshInFlight = true;

  try {
    latestSnapshot = await createSnapshot();
    const payload = `event: snapshot\ndata: ${JSON.stringify(latestSnapshot)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch (_) {
        sseClients.delete(client);
      }
    }
  } finally {
    refreshInFlight = false;
  }
}

function startMetricsLoop() {
  metricsTimer = setInterval(() => {
    refreshSnapshot().catch((error) => {
      console.error(`[metrics] ${error.message}`);
    });
  }, CONFIG.refreshMs);
}

async function routeRequest(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  if (url.pathname === '/') {
    sendHtml(response, renderHtml());
    return;
  }

  if (url.pathname === '/api/summary') {
    if (!latestSnapshot) latestSnapshot = await createSnapshot();
    sendJson(response, 200, getSummary());
    return;
  }

  if (url.pathname === '/api/realtime') {
    if (!latestSnapshot) latestSnapshot = await createSnapshot();
    sendJson(response, 200, latestSnapshot);
    return;
  }

  if (url.pathname === '/events') {
    handleEvents(request, response);
    return;
  }

  if (url.pathname === '/healthz') {
    sendJson(response, 200, { ok: true, name: APP_NAME, version: APP_VERSION, time: new Date().toISOString() });
    return;
  }

  if (url.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

function renderHtml() {
  return `<!doctype html>
<html lang="id" class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#080808" />
  <title>checkSrv - Server Intel Console</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
          boxShadow: {
            soft: '0 18px 80px rgba(0,0,0,.35)',
            glow: '0 0 80px rgba(16,185,129,.18)'
          }
        }
      }
    };
  </script>
  <script defer src="https://unpkg.com/lucide@latest"></script>
  <style>
    :root { color-scheme: dark; }
    * { scrollbar-width: thin; scrollbar-color: rgba(113,113,122,.7) transparent; }
    body { background: #070707; }
    .mesh { background-image: radial-gradient(circle at 15% 10%, rgba(16,185,129,.2), transparent 30%), radial-gradient(circle at 85% 0%, rgba(59,130,246,.16), transparent 32%), radial-gradient(circle at 50% 100%, rgba(168,85,247,.12), transparent 30%); }
    .card { border: 1px solid rgba(255,255,255,.09); background: linear-gradient(180deg, rgba(24,24,27,.78), rgba(9,9,11,.88)); box-shadow: 0 18px 80px rgba(0,0,0,.25); }
    .hairline { background: linear-gradient(90deg, transparent, rgba(255,255,255,.18), transparent); }
    .scanline { background: linear-gradient(90deg, transparent, rgba(16,185,129,.55), transparent); animation: scan 2.5s linear infinite; }
    @keyframes scan { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
  </style>
</head>
<body class="min-h-screen overflow-x-hidden bg-[#070707] text-zinc-100 antialiased selection:bg-emerald-400/30 selection:text-emerald-50">
  <div class="mesh pointer-events-none fixed inset-0 opacity-90"></div>
  <div class="pointer-events-none fixed inset-0 bg-[linear-gradient(rgba(255,255,255,.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.025)_1px,transparent_1px)] bg-[size:72px_72px]"></div>

  <main class="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-5 sm:px-6 lg:px-8">
    <nav class="mb-5 flex flex-col gap-3 rounded-3xl border border-white/10 bg-zinc-950/60 p-3 shadow-soft backdrop-blur md:flex-row md:items-center md:justify-between">
      <div class="flex items-center gap-3">
        <div class="grid h-11 w-11 place-items-center rounded-2xl border border-emerald-400/25 bg-emerald-400/10 text-emerald-300 shadow-glow">
          <i data-lucide="activity" class="h-5 w-5"></i>
        </div>
        <div>
          <p class="text-sm font-semibold tracking-tight text-zinc-50">checkSrv</p>
          <p class="text-xs text-zinc-400">Server Intel Console</p>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 font-medium text-emerald-200"><span class="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_16px_rgba(110,231,183,.9)]"></span>Live SSE</span>
        <span class="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-zinc-300">Tailwind UI</span>
        <span id="connection-status" class="rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-1.5 text-amber-200">Connecting</span>
      </div>
    </nav>

    <section class="grid gap-4 lg:grid-cols-[1.35fr_.65fr]">
      <div class="card relative overflow-hidden rounded-[2rem] p-6 sm:p-8">
        <div class="absolute inset-x-0 top-0 h-px hairline"></div>
        <div class="absolute left-0 top-0 h-px w-full overflow-hidden"><div class="scanline h-px w-1/2"></div></div>
        <div class="relative flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div class="max-w-2xl">
            <div class="mb-5 flex flex-wrap gap-2">
              <span class="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-300">Public Server Monitor</span>
              <span class="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-200">No backend dependency</span>
            </div>
            <h1 class="text-4xl font-bold tracking-[-0.04em] text-zinc-50 sm:text-5xl lg:text-6xl">Server status yang rapi, realtime, dan siap dibuka dari browser.</h1>
            <p class="mt-5 max-w-2xl text-sm leading-6 text-zinc-400 sm:text-base">Dashboard ini membaca IP publik, lokasi, provider, CPU, RAM, disk, network, runtime Node.js, dan usage realtime langsung dari server tempat script berjalan.</p>
          </div>
          <div class="grid min-w-48 gap-2 rounded-3xl border border-white/10 bg-black/20 p-4">
            <p class="text-xs uppercase tracking-[.28em] text-zinc-500">Updated</p>
            <p id="last-updated" class="text-2xl font-semibold tracking-tight text-zinc-100">--:--:--</p>
            <p class="text-xs text-zinc-500">Refresh setiap <span id="refresh-ms">${CONFIG.refreshMs}</span> ms</p>
          </div>
        </div>
      </div>

      <aside class="card rounded-[2rem] p-5">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div>
            <p class="text-sm font-semibold text-zinc-50">Access Point</p>
            <p class="text-xs text-zinc-500">Buka URL ini dari Chrome</p>
          </div>
          <i data-lucide="globe-2" class="h-5 w-5 text-emerald-300"></i>
        </div>
        <div class="rounded-2xl border border-white/10 bg-black/25 p-4">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-xs text-zinc-500">Public URL</p>
              <p id="public-url" class="mt-1 break-all text-sm font-medium text-zinc-100">Loading...</p>
            </div>
            <button class="copy-btn rounded-xl border border-white/10 bg-white/5 p-2 text-zinc-300 transition hover:bg-white/10 hover:text-white" data-copy-target="public-url" title="Copy URL"><i data-lucide="copy" class="h-4 w-4"></i></button>
          </div>
        </div>
        <div class="mt-3 grid grid-cols-2 gap-3">
          <div class="rounded-2xl border border-white/10 bg-white/[.03] p-4">
            <div class="mb-2 flex items-center justify-between"><p class="text-xs text-zinc-500">IP Public</p><button class="copy-btn text-zinc-500 hover:text-zinc-100" data-copy-target="public-ip"><i data-lucide="copy" class="h-4 w-4"></i></button></div>
            <p id="public-ip" class="break-all text-sm font-semibold text-zinc-100">unknown</p>
          </div>
          <div class="rounded-2xl border border-white/10 bg-white/[.03] p-4">
            <div class="mb-2 flex items-center justify-between"><p class="text-xs text-zinc-500">Port</p><button class="copy-btn text-zinc-500 hover:text-zinc-100" data-copy-target="server-port"><i data-lucide="copy" class="h-4 w-4"></i></button></div>
            <p id="server-port" class="text-sm font-semibold text-zinc-100">----</p>
          </div>
        </div>
      </aside>
    </section>

    <section class="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <article class="card rounded-3xl p-5">
        <div class="flex items-center justify-between"><p class="text-sm font-medium text-zinc-400">CPU Usage</p><i data-lucide="cpu" class="h-5 w-5 text-emerald-300"></i></div>
        <div class="mt-5 flex items-end justify-between gap-4">
          <div><p id="cpu-percent" class="text-4xl font-bold tracking-[-0.04em] text-zinc-50">0%</p><p id="cpu-load" class="mt-1 text-xs text-zinc-500">Load: 0, 0, 0</p></div>
          <div id="cpu-ring" class="grid h-20 w-20 place-items-center rounded-full bg-zinc-800"><div class="grid h-14 w-14 place-items-center rounded-full bg-zinc-950 text-xs text-zinc-400">CPU</div></div>
        </div>
        <div class="mt-5 h-2 overflow-hidden rounded-full bg-white/10"><div id="cpu-bar" class="h-full w-0 rounded-full bg-emerald-300 transition-all duration-500"></div></div>
      </article>

      <article class="card rounded-3xl p-5">
        <div class="flex items-center justify-between"><p class="text-sm font-medium text-zinc-400">Memory</p><i data-lucide="memory-stick" class="h-5 w-5 text-sky-300"></i></div>
        <div class="mt-5"><p id="memory-percent" class="text-4xl font-bold tracking-[-0.04em] text-zinc-50">0%</p><p id="memory-detail" class="mt-1 text-xs text-zinc-500">0 B / 0 B</p></div>
        <div class="mt-5 h-2 overflow-hidden rounded-full bg-white/10"><div id="memory-bar" class="h-full w-0 rounded-full bg-sky-300 transition-all duration-500"></div></div>
      </article>

      <article class="card rounded-3xl p-5">
        <div class="flex items-center justify-between"><p class="text-sm font-medium text-zinc-400">Disk</p><i data-lucide="hard-drive" class="h-5 w-5 text-violet-300"></i></div>
        <div class="mt-5"><p id="disk-percent" class="text-4xl font-bold tracking-[-0.04em] text-zinc-50">0%</p><p id="disk-detail" class="mt-1 text-xs text-zinc-500">0 B / 0 B</p></div>
        <div class="mt-5 h-2 overflow-hidden rounded-full bg-white/10"><div id="disk-bar" class="h-full w-0 rounded-full bg-violet-300 transition-all duration-500"></div></div>
      </article>

      <article class="card rounded-3xl p-5">
        <div class="flex items-center justify-between"><p class="text-sm font-medium text-zinc-400">Network</p><i data-lucide="radio-tower" class="h-5 w-5 text-amber-300"></i></div>
        <div class="mt-5 grid gap-2">
          <div class="flex items-center justify-between gap-3 rounded-2xl bg-white/[.03] px-3 py-2"><span class="text-xs text-zinc-500">Down</span><span id="network-rx" class="text-sm font-semibold text-zinc-100">0 B/s</span></div>
          <div class="flex items-center justify-between gap-3 rounded-2xl bg-white/[.03] px-3 py-2"><span class="text-xs text-zinc-500">Up</span><span id="network-tx" class="text-sm font-semibold text-zinc-100">0 B/s</span></div>
        </div>
        <p id="network-total" class="mt-4 text-xs text-zinc-500">Total: 0 B / 0 B</p>
      </article>
    </section>

    <section class="mt-4 grid gap-4 lg:grid-cols-[.9fr_1.1fr]">
      <article class="card rounded-[2rem] p-5 sm:p-6">
        <div class="mb-5 flex items-center justify-between gap-3">
          <div><p class="text-sm font-semibold text-zinc-50">Origin & Provider</p><p class="text-xs text-zinc-500">Lokasi ini berdasarkan public IP, bukan GPS fisik.</p></div>
          <i data-lucide="map-pinned" class="h-5 w-5 text-emerald-300"></i>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="rounded-2xl border border-white/10 bg-black/20 p-4"><p class="text-xs text-zinc-500">Location</p><p id="geo-location" class="mt-1 text-sm font-semibold text-zinc-100">unknown</p></div>
          <div class="rounded-2xl border border-white/10 bg-black/20 p-4"><p class="text-xs text-zinc-500">Provider / ISP</p><p id="geo-provider" class="mt-1 text-sm font-semibold text-zinc-100">unknown</p></div>
          <div class="rounded-2xl border border-white/10 bg-black/20 p-4"><p class="text-xs text-zinc-500">ASN</p><p id="geo-asn" class="mt-1 text-sm font-semibold text-zinc-100">unknown</p></div>
          <div class="rounded-2xl border border-white/10 bg-black/20 p-4"><p class="text-xs text-zinc-500">Timezone</p><p id="geo-timezone" class="mt-1 text-sm font-semibold text-zinc-100">unknown</p></div>
        </div>
      </article>

      <article class="card rounded-[2rem] p-5 sm:p-6">
        <div class="mb-5 flex items-center justify-between gap-3">
          <div><p class="text-sm font-semibold text-zinc-50">System DNA</p><p class="text-xs text-zinc-500">Identitas mesin dan runtime script.</p></div>
          <i data-lucide="server" class="h-5 w-5 text-sky-300"></i>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="rounded-2xl border border-white/10 bg-black/20 p-4 sm:col-span-2"><p class="text-xs text-zinc-500">CPU Model</p><p id="cpu-model" class="mt-1 text-sm font-semibold text-zinc-100">unknown</p></div>
          <div class="rounded-2xl border border-white/10 bg-black/20 p-4"><p class="text-xs text-zinc-500">Hostname</p><p id="hostname" class="mt-1 break-all text-sm font-semibold text-zinc-100">unknown</p></div>
          <div class="rounded-2xl border border-white/10 bg-black/20 p-4"><p class="text-xs text-zinc-500">OS / Kernel</p><p id="os-release" class="mt-1 text-sm font-semibold text-zinc-100">unknown</p></div>
          <div class="rounded-2xl border border-white/10 bg-black/20 p-4"><p class="text-xs text-zinc-500">Cores / Arch</p><p id="cpu-cores" class="mt-1 text-sm font-semibold text-zinc-100">unknown</p></div>
          <div class="rounded-2xl border border-white/10 bg-black/20 p-4"><p class="text-xs text-zinc-500">Node / PID</p><p id="node-runtime" class="mt-1 text-sm font-semibold text-zinc-100">unknown</p></div>
        </div>
      </article>
    </section>

    <section class="mt-4 grid gap-4 lg:grid-cols-3">
      <article class="card rounded-[2rem] p-5 sm:p-6 lg:col-span-2">
        <div class="mb-5 flex items-center justify-between gap-3">
          <div><p class="text-sm font-semibold text-zinc-50">Network Interfaces</p><p class="text-xs text-zinc-500">IP lokal yang terdeteksi dari server.</p></div>
          <i data-lucide="network" class="h-5 w-5 text-violet-300"></i>
        </div>
        <div id="iface-list" class="grid gap-3 md:grid-cols-2"></div>
      </article>

      <article class="card rounded-[2rem] p-5 sm:p-6">
        <div class="mb-5 flex items-center justify-between gap-3">
          <div><p class="text-sm font-semibold text-zinc-50">Runtime</p><p class="text-xs text-zinc-500">Info uptime dan environment.</p></div>
          <i data-lucide="square-terminal" class="h-5 w-5 text-amber-300"></i>
        </div>
        <div class="space-y-3 text-sm">
          <div class="flex items-center justify-between gap-3 rounded-2xl bg-white/[.03] px-4 py-3"><span class="text-zinc-500">System uptime</span><span id="system-uptime" class="font-medium text-zinc-100">unknown</span></div>
          <div class="flex items-center justify-between gap-3 rounded-2xl bg-white/[.03] px-4 py-3"><span class="text-zinc-500">Process uptime</span><span id="process-uptime" class="font-medium text-zinc-100">unknown</span></div>
          <div class="flex items-center justify-between gap-3 rounded-2xl bg-white/[.03] px-4 py-3"><span class="text-zinc-500">Container</span><span id="container-mode" class="font-medium text-zinc-100">unknown</span></div>
          <div class="flex items-center justify-between gap-3 rounded-2xl bg-white/[.03] px-4 py-3"><span class="text-zinc-500">Pterodactyl</span><span id="pterodactyl-mode" class="font-medium text-zinc-100">unknown</span></div>
        </div>
      </article>
    </section>

    <section class="mt-4 grid gap-4 lg:grid-cols-3">
      <article class="card rounded-[2rem] p-5 sm:p-6 lg:col-span-2">
        <div class="mb-5 flex items-center justify-between gap-3">
          <div><p class="text-sm font-semibold text-zinc-50">API Shortcuts</p><p class="text-xs text-zinc-500">Endpoint bawaan untuk integrasi atau pengecekan cepat.</p></div>
          <i data-lucide="braces" class="h-5 w-5 text-emerald-300"></i>
        </div>
        <div class="grid gap-3 sm:grid-cols-3">
          <button class="copy-btn rounded-2xl border border-white/10 bg-black/20 p-4 text-left transition hover:bg-white/[.06]" data-copy-value="/api/summary"><p class="text-xs text-zinc-500">Summary JSON</p><p class="mt-1 text-sm font-semibold text-zinc-100">/api/summary</p></button>
          <button class="copy-btn rounded-2xl border border-white/10 bg-black/20 p-4 text-left transition hover:bg-white/[.06]" data-copy-value="/api/realtime"><p class="text-xs text-zinc-500">Realtime JSON</p><p class="mt-1 text-sm font-semibold text-zinc-100">/api/realtime</p></button>
          <button class="copy-btn rounded-2xl border border-white/10 bg-black/20 p-4 text-left transition hover:bg-white/[.06]" data-copy-value="/events"><p class="text-xs text-zinc-500">SSE Stream</p><p class="mt-1 text-sm font-semibold text-zinc-100">/events</p></button>
        </div>
      </article>
      <article class="card rounded-[2rem] p-5 sm:p-6">
        <p class="text-sm font-semibold text-zinc-50">Process Memory</p>
        <p id="process-memory" class="mt-4 text-3xl font-bold tracking-[-0.04em] text-zinc-50">0 B</p>
        <p class="mt-1 text-xs text-zinc-500">RSS memory milik proses Node.js ini.</p>
      </article>
    </section>

    <footer class="py-8 text-center text-xs text-zinc-600">Built with Node.js, Tailwind CSS, Lucide icons, and SSE realtime updates.</footer>
  </main>

  <div id="toast" class="pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2 translate-y-8 rounded-full border border-white/10 bg-zinc-950/90 px-4 py-2 text-sm text-zinc-100 opacity-0 shadow-soft backdrop-blur transition duration-300">Copied</div>

  <script>
    var refreshMs = ${CONFIG.refreshMs};
    var eventSource = null;

    function el(id) { return document.getElementById(id); }
    function setText(id, value) {
      var node = el(id);
      if (!node) return;
      node.textContent = value === undefined || value === null || value === '' ? 'unknown' : String(value);
    }
    function clampNumber(value, min, max) { return Math.min(Math.max(Number(value) || 0, min), max); }
    function fmtPercent(value) {
      if (!Number.isFinite(Number(value))) return 'unknown';
      var number = clampNumber(value, 0, 100);
      return number.toFixed(number >= 10 ? 1 : 2) + '%';
    }
    function fmtBytes(bytes) {
      var number = Number(bytes);
      if (!Number.isFinite(number)) return 'unknown';
      if (number === 0) return '0 B';
      var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
      var index = Math.min(Math.floor(Math.log(Math.abs(number)) / Math.log(1024)), units.length - 1);
      return (number / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
    }
    function fmtDuration(seconds) {
      var value = Math.max(Number(seconds) || 0, 0);
      var days = Math.floor(value / 86400);
      var hours = Math.floor((value % 86400) / 3600);
      var minutes = Math.floor((value % 3600) / 60);
      if (days > 0) return days + 'd ' + hours + 'h';
      if (hours > 0) return hours + 'h ' + minutes + 'm';
      return minutes + 'm ' + Math.floor(value % 60) + 's';
    }
    function setBar(id, percent) {
      var node = el(id);
      if (node) node.style.width = clampNumber(percent, 0, 100) + '%';
    }
    function setRing(id, percent, color) {
      var node = el(id);
      if (!node) return;
      var degrees = clampNumber(percent, 0, 100) * 3.6;
      node.style.background = 'conic-gradient(' + color + ' 0deg, ' + color + ' ' + degrees + 'deg, rgba(255,255,255,.09) ' + degrees + 'deg, rgba(255,255,255,.09) 360deg)';
    }
    function escapeHtml(value) {
      return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function(char) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
      });
    }
    function locationText(geo) {
      var parts = [geo.city, geo.region, geo.country || geo.countryCode].filter(Boolean);
      return parts.join(', ') || 'unknown';
    }
    function refreshIcons() {
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    }
    function showToast(message) {
      var toast = el('toast');
      if (!toast) return;
      toast.textContent = message || 'Copied';
      toast.classList.remove('translate-y-8', 'opacity-0');
      clearTimeout(showToast.timer);
      showToast.timer = setTimeout(function() {
        toast.classList.add('translate-y-8', 'opacity-0');
      }, 1400);
    }
    function copyText(value) {
      if (!value) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(function() { showToast('Copied: ' + value); }).catch(function() { fallbackCopy(value); });
      } else {
        fallbackCopy(value);
      }
    }
    function fallbackCopy(value) {
      var input = document.createElement('textarea');
      input.value = value;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      try { document.execCommand('copy'); showToast('Copied: ' + value); } catch (_) { showToast('Copy gagal'); }
      document.body.removeChild(input);
    }
    function setConnection(status) {
      var node = el('connection-status');
      if (!node) return;
      node.className = 'rounded-full border px-3 py-1.5 text-xs';
      if (status === 'live') {
        node.className += ' border-emerald-400/20 bg-emerald-400/10 text-emerald-200';
        node.textContent = 'Live';
      } else if (status === 'reconnecting') {
        node.className += ' border-amber-400/20 bg-amber-400/10 text-amber-200';
        node.textContent = 'Reconnecting';
      } else {
        node.className += ' border-red-400/20 bg-red-400/10 text-red-200';
        node.textContent = 'Offline';
      }
    }
    function renderStatic(data) {
      var access = data.access || {};
      var geo = data.geo || {};
      var server = data.server || {};
      var runtime = server.runtime || {};
      var cpu = server.cpu || {};
      var interfaces = server.localInterfaces || [];

      setText('public-url', access.publicUrl);
      setText('public-ip', geo.ip);
      setText('server-port', access.port);
      setText('geo-location', locationText(geo));
      setText('geo-provider', geo.isp || geo.org);
      setText('geo-asn', geo.asn);
      setText('geo-timezone', geo.timezone);
      setText('cpu-model', cpu.model);
      setText('hostname', server.hostname);
      setText('os-release', (server.type || server.platform || 'unknown') + ' ' + (server.release || ''));
      setText('cpu-cores', (cpu.cores || 0) + ' cores / ' + (server.arch || 'unknown') + (cpu.speedMHz ? ' / ' + cpu.speedMHz + ' MHz' : ''));
      setText('node-runtime', (runtime.nodeVersion || 'unknown') + ' / PID ' + (runtime.pid || 'unknown'));
      setText('container-mode', runtime.container ? 'Yes' : 'No');
      setText('pterodactyl-mode', runtime.pterodactyl ? 'Yes' : 'No');

      var list = el('iface-list');
      if (list) {
        if (!interfaces.length) {
          list.innerHTML = '<div class="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-zinc-400">Tidak ada interface publik/lokal non-internal yang terbaca.</div>';
        } else {
          list.innerHTML = interfaces.map(function(item) {
            return '<div class="rounded-2xl border border-white/10 bg-black/20 p-4">' +
              '<div class="mb-2 flex items-center justify-between gap-3"><p class="text-xs text-zinc-500">' + escapeHtml(item.name) + '</p><span class="rounded-full bg-white/5 px-2 py-1 text-[11px] text-zinc-400">' + escapeHtml(item.family) + '</span></div>' +
              '<p class="break-all text-sm font-semibold text-zinc-100">' + escapeHtml(item.address) + '</p>' +
              '<p class="mt-1 break-all text-xs text-zinc-500">' + escapeHtml(item.cidr || '') + '</p>' +
            '</div>';
          }).join('');
        }
      }
      refreshIcons();
    }
    function renderSnapshot(snapshot) {
      if (!snapshot) return;
      var cpu = snapshot.cpu || {};
      var memory = snapshot.memory || {};
      var disk = snapshot.disk || {};
      var network = snapshot.network || {};
      var processInfo = snapshot.process || {};

      setText('last-updated', new Date(snapshot.timestamp).toLocaleTimeString());
      setText('cpu-percent', fmtPercent(cpu.percent));
      setText('cpu-load', 'Load: ' + (cpu.loadAverage || [0, 0, 0]).join(', '));
      setBar('cpu-bar', cpu.percent);
      setRing('cpu-ring', cpu.percent, '#6ee7b7');

      setText('memory-percent', fmtPercent(memory.percent));
      setText('memory-detail', fmtBytes(memory.used) + ' / ' + fmtBytes(memory.total));
      setBar('memory-bar', memory.percent);

      setText('disk-percent', disk.supported === false ? 'unknown' : fmtPercent(disk.percent));
      setText('disk-detail', disk.supported === false ? 'Disk tidak terbaca' : fmtBytes(disk.used) + ' / ' + fmtBytes(disk.total));
      setBar('disk-bar', disk.percent);

      setText('network-rx', fmtBytes(network.rxRate) + '/s');
      setText('network-tx', fmtBytes(network.txRate) + '/s');
      setText('network-total', 'Total: ' + fmtBytes(network.rxBytes) + ' down / ' + fmtBytes(network.txBytes) + ' up');

      setText('system-uptime', fmtDuration(snapshot.uptime && snapshot.uptime.system));
      setText('process-uptime', fmtDuration(snapshot.uptime && snapshot.uptime.process));
      setText('process-memory', fmtBytes(processInfo.memory && processInfo.memory.rss));
      setConnection('live');
    }
    async function loadSummary() {
      var response = await fetch('/api/summary', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var data = await response.json();
      renderStatic(data);
      renderSnapshot(data.realtime);
    }
    function connectEvents() {
      if (!window.EventSource) {
        setInterval(function() { loadSummary().catch(function() { setConnection('offline'); }); }, refreshMs);
        return;
      }
      eventSource = new EventSource('/events');
      eventSource.addEventListener('open', function() { setConnection('live'); });
      eventSource.addEventListener('snapshot', function(event) {
        try { renderSnapshot(JSON.parse(event.data)); } catch (_) {}
      });
      eventSource.onerror = function() { setConnection('reconnecting'); };
    }

    document.addEventListener('click', function(event) {
      var button = event.target.closest('[data-copy-target], [data-copy-value]');
      if (!button) return;
      var value = button.getAttribute('data-copy-value');
      var target = button.getAttribute('data-copy-target');
      if (!value && target && el(target)) value = el(target).textContent.trim();
      copyText(value);
    });
    window.addEventListener('load', refreshIcons);

    loadSummary().then(connectEvents).catch(function(error) {
      setConnection('offline');
      showToast('Gagal load data: ' + error.message);
      setInterval(function() { loadSummary().catch(function() {}); }, refreshMs);
    });
  </script>
</body>
</html>`;
}

const server = http.createServer((request, response) => {
  routeRequest(request, response).catch((error) => {
    console.error(`[request] ${error.stack || error.message}`);
    if (!response.headersSent) sendJson(response, 500, { error: 'Internal server error' });
    else response.end();
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${CONFIG.port} sudah dipakai. Ganti PORT atau matikan proses lain.`);
  } else if (error.code === 'EACCES') {
    console.error(`Tidak punya izin membuka port ${CONFIG.port}. Pakai port lain atau jalankan dengan izin yang sesuai.`);
  } else {
    console.error(error.stack || error.message);
  }
  process.exit(1);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  if (metricsTimer) clearInterval(metricsTimer);
  for (const client of sseClients) client.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

(async () => {
  publicGeo = await getPublicGeo();
  await refreshSnapshot();
  startMetricsLoop();
  server.listen(CONFIG.port, CONFIG.host, printBootLog);
})();
