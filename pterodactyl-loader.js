'use strict';

const https = require('node:https');
const Module = require('node:module');

// Ganti angka ini kalau panel kamu tidak menyediakan SERVER_PORT.
const WEBSITE_PORT = 3000;
const SOURCE_URL = 'https://raw.githubusercontent.com/Hv303/checkSrv/main/index.js';

process.env.PORT = String(process.env.SERVER_PORT || process.env.PORT || WEBSITE_PORT);

https
  .get(SOURCE_URL, { headers: { 'User-Agent': 'checkSrv-loader' } }, (response) => {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      console.error(`Gagal download source. HTTP ${response.statusCode}`);
      process.exit(1);
    }

    let code = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      code += chunk;
    });
    response.on('end', () => {
      const remoteModule = new Module(SOURCE_URL, module.parent || module);
      remoteModule.filename = SOURCE_URL;
      remoteModule.paths = Module._nodeModulePaths(process.cwd());
      remoteModule._compile(code, SOURCE_URL);
    });
  })
  .on('error', (error) => {
    console.error('Loader gagal:', error.message);
    process.exit(1);
  });
