/* make-icon.js — 用 Electron 把海豹畫成 PNG 圖示
 *
 * 執行（在 desktop/ 目錄）：npm run icons
 * 產出：
 *   assets/icon.png  256×256，整隻海豹，給打包後的 exe 與視窗圖示
 *   assets/tray.png  64×64，只取頭部，給系統匣
 *
 * 做法：開一個 1024×1024 的透明離屏視窗載入 index.html（?pose=yaw:0 固定姿勢），
 * 直接擷取畫面再縮小。角色是外部 PNG 圖層，不能用序列化 SVG 的方式畫。
 * 換了圖之後重跑一次；下面的擷取範圍是 1024 座標，依新圖的範圍調整。
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const WEB_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.resolve(__dirname, '..', 'assets');

// 整隻海豹約在 x 87～937、y 157～961；頭約在 x 252～817、y 157～671
const JOBS = [
  { file: 'icon.png', size: 256, rect: { x: 62, y: 109, width: 900, height: 900 } },
  { file: 'tray.png', size: 64, rect: { x: 235, y: 114, width: 600, height: 600 } },
];

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    useContentSize: true,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  try {
    await win.loadFile(path.join(WEB_ROOT, 'index.html'), { query: { ui: '0', bg: 'transparent', pose: 'yaw:0' } });
    // 等三張圖層載入、畫面穩定
    await win.webContents.executeJavaScript(`new Promise((ok) => {
      const imgs = Array.from(document.querySelectorAll('#seal image'));
      let n = 0;
      const done = () => { if (++n >= imgs.length) ok(); };
      imgs.forEach((el) => {
        const probe = new Image();
        probe.onload = done;
        probe.onerror = done;
        probe.src = el.getAttribute('href');
      });
      if (!imgs.length) ok();
    })`);
    await sleep(800);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    // 離屏視窗的 capturePage 會忽略範圍參數，所以先擷取整頁再自己裁。
    // 視窗可能被螢幕工作區限制而變小（例如 1024×752），畫面裡的 1024 座標會等比縮放置中，這裡換算回去
    const full = await win.webContents.capturePage();
    const { width, height } = full.getSize();
    if (full.isEmpty() || width < 200 || height < 200) throw new Error(`擷取畫面大小不對：${width}×${height}`);
    const s = Math.min(width, height) / 1024;
    const ox = (width - 1024 * s) / 2;
    const oy = (height - 1024 * s) / 2;
    console.log(`擷取 ${width}×${height}，比例 ${s.toFixed(3)}`);
    for (const job of JOBS) {
      const out = path.join(OUT_DIR, job.file);
      const r = job.rect;
      const crop = {
        x: Math.round(ox + r.x * s),
        y: Math.round(oy + r.y * s),
        width: Math.round(r.width * s),
        height: Math.round(r.height * s),
      };
      const shot = full.crop(crop).resize({ width: job.size, height: job.size, quality: 'best' });
      fs.writeFileSync(out, shot.toPNG());
      console.log(`已寫入 ${out}`);
    }
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
