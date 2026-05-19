# checkSrv

checkSrv adalah script Node.js untuk menampilkan informasi server lewat website yang rapi dan realtime.

Cocok untuk VPS, dedicated server, container, dan Pterodactyl. Backend-nya tidak butuh database dan tidak butuh dependency npm tambahan. Cukup jalankan `node index.js`.

## Fitur

- Menampilkan IP publik server.
- Menampilkan lokasi IP publik.
- Menampilkan provider/ISP dan ASN jika API geo berhasil membaca datanya.
- Menampilkan port yang sedang dipakai.
- Menampilkan CPU model, jumlah core, OS, kernel, hostname, Node.js version, dan PID.
- Menampilkan RAM, disk, CPU usage, network upload/download secara realtime.
- Website responsive untuk desktop dan HP.
- Tombol copy untuk URL, IP, port, dan endpoint API.
- Realtime memakai SSE, jadi browser menerima update tanpa reload.
- Log terminal dibuat singkat supaya tidak terlalu ramai.

## Tampilan

UI dibuat dengan tema dark seperti dashboard modern: clean, card-based, mirip gaya ChatGPT/shadcn, dan full Tailwind lewat CDN.

Icons memakai Lucide CDN. Kalau server/browser tidak punya akses internet ke CDN, data tetap jalan, hanya icons/font eksternal yang mungkin tidak muncul.

## Cara Jalan Di VPS

Pastikan Node.js sudah ada. Disarankan Node.js 18 atau lebih baru, tapi script ini dibuat tetap ringan untuk Node.js 16+.

```bash
node index.js
```

Default port adalah `3000`.

Kalau mau ganti port:

```bash
PORT=8080 node index.js
```

Setelah jalan, buka:

```txt
http://IP_PUBLIC_SERVER:PORT
```

Contoh:

```txt
http://123.123.123.123:8080
```

## Cara Jalan Di Pterodactyl

Ada dua cara. Pilih yang paling enak buat kamu.

## Cara 1: Upload Source Lengkap

Upload semua file repo ini ke server Pterodactyl, lalu startup command:

```bash
node index.js
```

Biasanya Pterodactyl sudah memberi port lewat variable `SERVER_PORT`. Script ini otomatis membaca `SERVER_PORT`, jadi kamu tidak harus edit kode.

## Cara 2: Di Pterodactyl Cukup Buat index.js Loader

Cara ini cocok kalau source code full ada di GitHub, lalu di Pterodactyl kamu hanya ingin membuat satu file `index.js` kecil.

1. Upload project ini ke GitHub.
2. Buka file `index.js` di GitHub.
3. Klik tombol `Raw`.
4. Copy URL raw-nya.
5. Di Pterodactyl, buat file `index.js` dengan isi seperti ini:

```js
'use strict';

const https = require('node:https');
const http = require('node:http');
const Module = require('node:module');
const { URL } = require('node:url');

const SOURCE_URL = process.env.CHECKSRV_SOURCE || 'https://raw.githubusercontent.com/USERNAME/REPOSITORY/main/index.js';

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(parsed, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        resolve(download(new URL(res.headers.location, parsed).toString(), redirects + 1));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      let code = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { code += chunk; });
      res.on('end', () => resolve(code));
    });
    req.setTimeout(15000, () => req.destroy(new Error('Timeout download source')));
    req.on('error', reject);
  });
}

download(SOURCE_URL)
  .then((code) => {
    const remoteModule = new Module(SOURCE_URL, module.parent || module);
    remoteModule.filename = SOURCE_URL;
    remoteModule.paths = Module._nodeModulePaths(process.cwd());
    remoteModule._compile(code, SOURCE_URL);
  })
  .catch((err) => {
    console.error('Loader gagal:', err.message);
    process.exit(1);
  });
```

Ganti bagian ini:

```txt
https://raw.githubusercontent.com/USERNAME/REPOSITORY/main/index.js
```

menjadi URL raw GitHub kamu.

Contoh bentuk URL-nya:

```txt
https://raw.githubusercontent.com/nama-kamu/checksrv/main/index.js
```

Lalu startup command tetap:

```bash
node index.js
```

## Cara Lebih Rapi Untuk Loader

Kalau tidak mau edit kode loader, kamu bisa isi variable environment di Pterodactyl:

```txt
CHECKSRV_SOURCE=https://raw.githubusercontent.com/nama-kamu/checksrv/main/index.js
```

Lalu file `index.js` di Pterodactyl bisa memakai isi dari `pterodactyl-loader.js`.

## Variable Config

Kamu bisa mengatur script lewat environment variable.

| Variable | Fungsi | Default |
| --- | --- | --- |
| `PORT` | Port website | `3000` |
| `SERVER_PORT` | Port dari Pterodactyl, otomatis terbaca | kosong |
| `HOST` | Host bind server | `0.0.0.0` |
| `PUBLIC_URL` | URL publik manual kalau pakai domain/proxy | otomatis dari IP publik |
| `PUBLIC_PROTOCOL` | Protocol URL otomatis | `http` |
| `REFRESH_MS` | Interval realtime dashboard | `2000` |
| `GEO_TIMEOUT_MS` | Timeout API IP geo | `3000` |
| `DISK_PATH` | Path disk yang dicek | folder tempat script jalan |
| `CHECKSRV_SOURCE` | URL raw GitHub untuk loader | kosong |

Contoh:

```bash
PORT=8080 REFRESH_MS=1500 node index.js
```

Kalau kamu pakai domain atau reverse proxy:

```bash
PUBLIC_URL=https://status.domainkamu.com node index.js
```

## Endpoint API

Website utama:

```txt
/
```

Data lengkap server:

```txt
/api/summary
```

Data realtime saja:

```txt
/api/realtime
```

Stream realtime SSE:

```txt
/events
```

Health check:

```txt
/healthz
```

## Catatan Penting

- Lokasi IP publik bukan lokasi GPS fisik. Itu hasil pembacaan dari database IP geo.
- Kalau provider IP geo sedang limit/down, script tetap jalan, hanya lokasi/provider bisa tampil `unknown`.
- Disk usage memakai command `df`, jadi paling akurat di Linux. Ini sesuai target VPS dan Pterodactyl.
- Kalau Pterodactyl memakai reverse proxy atau domain khusus, lebih bagus isi `PUBLIC_URL` supaya URL yang tampil di dashboard sesuai alamat yang kamu pakai.
- Loader GitHub akan mengeksekusi kode dari URL yang kamu isi. Pakai raw URL dari repo milikmu sendiri.

## Log Terminal

Saat server berhasil jalan, log dibuat singkat seperti ini:

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

## Development Check

Untuk cek sintaks:

```bash
npm run check
```

Untuk menjalankan:

```bash
npm start
```
