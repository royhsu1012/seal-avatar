/* make-icon.js — 用 Electron 把 index.html 裡的海豹 SVG 畫成 PNG 圖示
 *
 * 執行（在 desktop/ 目錄）：npm run icons
 * 產出：
 *   assets/icon.png  256×256，整隻海豹，給打包後的 exe 與視窗圖示
 *   assets/tray.png  64×64，只取頭部，給系統匣
 *
 * 換了正式繪圖之後重跑一次即可；程式只靠 <svg id="seal"> 這個 id。
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const WEB_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.resolve(__dirname, '..', 'assets');

// viewBox 區域與輸出大小。tray 只框頭部（頭的橢圓中心 (300,300)、半徑約 190×172，耳朵到 x=103～497）
const JOBS = [
  { file: 'icon.png', size: 256, viewBox: null },
  { file: 'tray.png', size: 64, viewBox: '88 102 424 424' },
];

async function render(win, job) {
  // 把頁面裡的 SVG 序列化成獨立的 svg 圖檔，用 <img> 載入後畫到透明 canvas 上
  return win.webContents.executeJavaScript(`(async () => {
    const src = document.getElementById('seal');
    if (!src) throw new Error('找不到 #seal');
    const svg = src.cloneNode(true);
    ${job.viewBox ? `svg.setAttribute('viewBox', '${job.viewBox}');` : ''}
    svg.setAttribute('width', '${job.size}');
    svg.setAttribute('height', '${job.size}');
    const xml = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
    const img = new Image();
    await new Promise((ok, fail) => { img.onload = ok; img.onerror = () => fail(new Error('SVG 載入失敗')); img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ${job.size};
    canvas.getContext('2d').drawImage(img, 0, 0, ${job.size}, ${job.size});
    URL.revokeObjectURL(url);
    return canvas.toDataURL('image/png');
  })()`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { offscreen: true } });
  try {
    await win.loadFile(path.join(WEB_ROOT, 'index.html'), { query: { ui: '0', bg: 'transparent' } });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const job of JOBS) {
      const dataUrl = await render(win, job);
      const out = path.join(OUT_DIR, job.file);
      fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
      console.log(`已寫入 ${out}`);
    }
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
