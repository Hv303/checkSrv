<div align="center">

# checkSrv

Realtime server monitor dashboard untuk VPS, dedicated server, container, dan Pterodactyl.

[![Node.js](https://img.shields.io/badge/Node.js-16%2B-3c873a?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Pterodactyl](https://img.shields.io/badge/Pterodactyl-Ready-1f2937?style=for-the-badge)](https://pterodactyl.io/)
[![Tailwind](https://img.shields.io/badge/Tailwind-CDN-38bdf8?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Realtime](https://img.shields.io/badge/Realtime-SSE-10b981?style=for-the-badge)](#endpoint)

**GitHub:** https://github.com/Hv303/checkSrv

</div>

## Tentang Project

`checkSrv` adalah script Node.js ringan untuk menampilkan informasi server lewat website yang rapi, responsive, dan realtime.

Cukup jalankan `node index.js`, lalu buka `IP_PUBLIC:PORT` di browser. Dashboard akan menampilkan IP publik, lokasi IP, provider/ISP, spesifikasi server, CPU/RAM/disk usage, network traffic, uptime, runtime Node.js, dan tombol copy cepat.

## Fitur Utama

| Fitur | Keterangan |
| --- | --- |
| Public IP | Menampilkan IP publik server |
| Geo IP | Menampilkan lokasi, timezone, ISP/provider, ASN |
| Server Spec | CPU model, core, RAM, disk, OS, kernel, hostname |
| Realtime Usage | CPU, RAM, disk, network upload/download realtime |
| Copy Button | Copy URL, IP, port, dan endpoint dengan sekali klik |
| Responsive UI | Tampilan nyaman di HP, tablet, dan desktop |
| No Database | Tidak butuh database dan tidak butuh setup ribet |
| Pterodactyl Ready | Bisa jalan dari panel Pterodactyl |

## Quick Start VPS

Clone repo:

```bash
git clone https://github.com/Hv303/checkSrv.git
cd checkSrv
node index.js
```

Default port adalah `3000`.

Kalau mau ganti port:

```bash
PORT=8080 node index.js
```

Lalu buka di browser:

```txt
http://IP_PUBLIC_SERVER:PORT
```

Contoh:

```txt
http://123.123.123.123:8080
```

## Quick Start Pterodactyl

Di Pterodactyl kamu bisa pakai cara paling simpel: cukup buat file `index.js`, lalu paste kode loader di bawah.

```js
const https = require("node:https");
const Module = require("node:module");

const SOURCE_URL = "https://raw.githubusercontent.com/Hv303/checkSrv/main/index.js";

https
  .get(SOURCE_URL, { headers: { "User-Agent": "checkSrv-loader" } }, (res) => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      console.error("Gagal download source. HTTP " + res.statusCode);
      process.exit(1);
    }

    let code = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => (code += chunk));
    res.on("end", () => {
      const remoteModule = new Module(SOURCE_URL, module);
      remoteModule.filename = SOURCE_URL;
      remoteModule.paths = Module._nodeModulePaths(process.cwd());
      remoteModule._compile(code, SOURCE_URL);
    });
  })
  .on("error", (err) => {
    console.error("Loader gagal:", err.message);
    process.exit(1);
  });
```

Startup command di Pterodactyl:

```bash
node index.js
```

Script otomatis membaca port dari `SERVER_PORT`, jadi biasanya tidak perlu edit port manual di Pterodactyl.

## Cara Upload Full Source Ke Pterodactyl

Kalau kamu tidak mau pakai loader, upload semua file repo ini ke Pterodactyl.

Jalankan:

```bash
node index.js
```

Cara ini cocok kalau kamu ingin semua source tersimpan langsung di server panel.

## Config Environment

Kamu bisa mengatur script lewat environment variable.

| Variable | Fungsi | Default |
| --- | --- | --- |
| `PORT` | Port website | `3000` |
| `SERVER_PORT` | Port dari Pterodactyl | otomatis terbaca |
| `HOST` | Host bind server | `0.0.0.0` |
| `PUBLIC_URL` | URL publik manual jika pakai domain/proxy | otomatis dari IP publik |
| `PUBLIC_PROTOCOL` | Protocol URL otomatis | `http` |
| `REFRESH_MS` | Interval update realtime | `2000` |
| `GEO_TIMEOUT_MS` | Timeout API lokasi IP | `3000` |
| `DISK_PATH` | Path disk yang dicek | folder script berjalan |

Contoh VPS:

```bash
PORT=8080 REFRESH_MS=1500 node index.js
```

Contoh jika pakai domain:

```bash
PUBLIC_URL=https://status.domainkamu.com node index.js
```

## Endpoint

| Endpoint | Fungsi |
| --- | --- |
| `/` | Dashboard website |
| `/api/summary` | Data lengkap server dalam JSON |
| `/api/realtime` | Data realtime usage dalam JSON |
| `/events` | Stream realtime SSE |
| `/healthz` | Health check |

## Log Terminal

Log dibuat singkat supaya terminal tetap bersih.

```txt
==========================================================
checkSrv ready
URL      : http://123.123.123.123:3000
IP       : 123.123.123.123
Location : Jakarta, Indonesia
Provider : Example ISP
CPU      : AMD EPYC Processor (4 cores)
Memory   : 1.2 GB / 4.0 GB (30%)
Disk     : 12.4 GB / 50.0 GB (24.8%)
==========================================================
```

## Catatan

- Lokasi IP berasal dari database IP geo, jadi bukan lokasi GPS fisik server.
- Jika API IP geo sedang limit/down, dashboard tetap jalan, tetapi lokasi/provider bisa tampil `unknown`.
- Disk usage memakai command `df`, paling cocok untuk Linux VPS dan Pterodactyl.
- Jika memakai domain atau reverse proxy, isi `PUBLIC_URL` supaya URL di dashboard sesuai alamat domain.
- Loader Pterodactyl menjalankan kode dari raw GitHub. Pastikan URL raw mengarah ke repo yang kamu percaya.

## Development

Cek sintaks:

```bash
npm run check
```

Jalankan project:

```bash
npm start
```

## License

MIT
