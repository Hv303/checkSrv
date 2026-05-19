'use strict';

const https = require('node:https');
const http = require('node:http');
const Module = require('node:module');
const { URL } = require('node:url');

// Ganti URL ini ke raw GitHub milikmu, atau isi env CHECKSRV_SOURCE di panel.
const SOURCE_URL = process.env.CHECKSRV_SOURCE || 'https://raw.githubusercontent.com/USERNAME/REPOSITORY/main/index.js';

if (SOURCE_URL.includes('USERNAME/REPOSITORY')) {
  console.error('CHECKSRV_SOURCE belum diisi. Ganti SOURCE_URL ke raw GitHub index.js milikmu.');
  process.exit(1);
}

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const request = client.get(
      parsed,
      {
        headers: {
          Accept: 'text/plain,*/*;q=0.8',
          'User-Agent': 'checkSrv-loader/1.0.0',
        },
      },
      (response) => {
        const statusCode = response.statusCode || 0;
        const location = response.headers.location;

        if ([301, 302, 303, 307, 308].includes(statusCode) && location && redirects < 5) {
          response.resume();
          resolve(download(new URL(location, parsed).toString(), redirects + 1));
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new Error(`Gagal download source. HTTP ${statusCode}`));
          return;
        }

        let code = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          code += chunk;
          if (code.length > 3 * 1024 * 1024) request.destroy(new Error('Source terlalu besar'));
        });
        response.on('end', () => resolve(code));
      },
    );

    request.setTimeout(15000, () => request.destroy(new Error('Timeout download source')));
    request.on('error', reject);
  });
}

download(SOURCE_URL)
  .then((code) => {
    const remoteModule = new Module(SOURCE_URL, module.parent || module);
    remoteModule.filename = SOURCE_URL;
    remoteModule.paths = Module._nodeModulePaths(process.cwd());
    remoteModule._compile(code, SOURCE_URL);
  })
  .catch((error) => {
    console.error(`Loader gagal: ${error.message}`);
    process.exit(1);
  });
