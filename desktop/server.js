/* server.js — Electron 主程序裡的小型靜態伺服器
 *
 * 行為與 tools/serve.ps1 相同：
 *   - 提供專案根目錄的靜態檔案（index.html、js/、css/）
 *   - /params：追蹤頁 POST 最新參數、顯示頁 GET 取回（OBS 裡的 ?mode=viewer 就是靠這個）
 *   - /diag：把診斷數值印到終端機
 *
 * 只監聽本機（127.0.0.1 與 ::1），預設埠 8788。
 * 網頁用 fetch('/params') 這種相對於 origin 的路徑，所以不能用 file:// 開，一定要有 http 伺服器。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.woff2': 'font/woff2',
};

const MAX_PARAMS_BYTES = 64 * 1024;

function timestamp() {
  return new Date().toTimeString().slice(0, 8);
}

function createHandler(root, log) {
  const rootNorm = path.resolve(root);
  const rootKey = process.platform === 'win32' ? rootNorm.toLowerCase() : rootNorm;
  let latestParams = ''; // 追蹤頁最近一次 POST 上來的 JSON 字串

  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      res.writeHead(400).end();
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch (e) {
      res.writeHead(400).end();
      return;
    }
    if (rel === '') rel = 'index.html';

    if (rel === 'params') {
      // 追蹤頁與顯示頁之間的參數中繼，只在本機；不寫 log 以免洗版
      if (req.method === 'POST') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > MAX_PARAMS_BYTES) req.destroy();
        });
        req.on('end', () => {
          latestParams = body;
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(latestParams || '{}');
      return;
    }

    if (rel === 'diag') {
      // 診斷模式（網頁加 ?diag=1）：把追蹤數值印出來
      log(`${timestamp()} DIAG ${decodeURIComponent(url.search.replace(/^\?/, '')).replace(/&/g, '  ')}`);
      res.writeHead(204).end();
      return;
    }

    const full = path.resolve(rootNorm, rel);
    const fullKey = process.platform === 'win32' ? full.toLowerCase() : full;
    const inside = fullKey === rootKey || fullKey.startsWith(rootKey + path.sep);
    fs.stat(full, (err, stat) => {
      if (!inside || err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`404 Not Found: /${rel}`);
        log(`${timestamp()} 404 ${url.pathname}${url.search}`);
        return;
      }
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(full).pipe(res);
      log(`${timestamp()} 200 ${url.pathname}${url.search}`);
    });
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

/**
 * 啟動伺服器。成功回傳 { port, url, close }；埠被佔用時拒絕，err.code 為 'EADDRINUSE'，
 * 或在 Windows 上被 http.sys（例如 tools/serve.ps1 的 HttpListener）佔用時為 'EACCES'。
 */
async function start({ root, port, log = console.log }) {
  const handler = createHandler(root, log);
  const v4 = http.createServer(handler);
  await listen(v4, port, '127.0.0.1');

  // Chrome 與 OBS 開 http://localhost 時可能先連 ::1，有 IPv6 就一起聽；沒有就算了
  let v6 = null;
  try {
    v6 = http.createServer(handler);
    await listen(v6, port, '::1');
  } catch (e) {
    v6 = null;
  }

  return {
    port,
    url: `http://localhost:${port}`,
    close() {
      v4.close();
      if (v6) v6.close();
    },
  };
}

/**
 * 探測這個埠上是不是已經有一台相容的伺服器（例如 start-server.bat 跑著的 tools/serve.ps1）。
 * 判斷標準：GET /params 回 200 且內容是 JSON 物件。
 * 一定要用 localhost 這個主機名稱，serve.ps1 的 HttpListener 只接受 Host: localhost。
 */
function probe(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: 'localhost', port, path: '/params', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > MAX_PARAMS_BYTES) req.destroy();
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(false);
        try {
          const d = JSON.parse(body);
          resolve(d !== null && typeof d === 'object');
        } catch (e) {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

module.exports = { start, probe, MIME };
