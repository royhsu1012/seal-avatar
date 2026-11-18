/* main.js — 海豹 VTuber 桌面浮動視窗（Electron 主程序）
 *
 * 做的事：
 *   1. 在本機開一台小型靜態伺服器（server.js，行為同 tools/serve.ps1），預設埠 8788。
 *      埠已經被 start-server.bat 佔用的話就直接沿用那台伺服器。
 *   2. 開一個透明、無邊框、永遠置頂的視窗載入 index.html?mode=tracker&bg=transparent&ui=0。
 *      這一頁自己開攝影機、畫海豹，並把參數 POST 到 /params，所以 OBS 裡的顯示頁（?mode=viewer）會同時動。
 *   3. 系統匣圖示與右鍵選單：置頂、滑鼠穿透、控制面板、重新校正、重設、結束。
 *   4. 視窗位置大小與開關狀態存在 userData/window-state.json，下次啟動還原。
 *
 * 網頁端只靠 preload.js 加上 <html class="desktop"> 與縮放握把，index.html / js/ 完全不知道自己在 Electron 裡。
 */
'use strict';

const { app, BrowserWindow, Menu, Tray, ipcMain, screen, nativeImage, dialog, clipboard, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const server = require('./server');

// Windows 的 PowerShell 5.1 / cmd 主控台預設不是 UTF-8，中文 log 會變亂碼；把這個主控台切成 UTF-8（只影響目前這個終端機）
if (process.platform === 'win32' && process.stdout.isTTY) {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore' });
  } catch (e) {
    // 沒有 chcp 就算了
  }
}

// 視窗被其他視窗完全蓋住時，Chromium 預設會把它當成隱藏而停止繪製；追蹤要一直跑，所以關掉這個判斷
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.setAppUserModelId('io.github.royhsu1012.seal-avatar');

const APP_NAME = '海豹 VTuber';
const DEFAULT_PORT = 8788;
const DEFAULT_SIZE = 360;
const MIN_SIZE = 120;
const MAX_SIZE = 2400;
const ASPECT = 1; // 海豹 SVG 是正方形，視窗也維持正方形，才不會有看不見卻擋滑鼠的透明邊

// 打包後網頁放在 resources/web，開發時直接用上一層的專案根目錄
const WEB_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.resolve(__dirname, '..');
const ASSETS = path.join(__dirname, 'assets');
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

const argv = process.argv.slice(app.isPackaged ? 1 : 2);
const argPort = (argv.find((a) => a.startsWith('--port=')) || '').slice('--port='.length);
const PORT = parseInt(argPort || process.env.SEAL_PORT || '', 10) || DEFAULT_PORT;
const OPEN_DEVTOOLS = argv.includes('--devtools');

let win = null;
let tray = null;
let baseUrl = '';
let ownServer = null;
let quitting = false;

// ---------- 狀態存檔 ----------
const state = {
  bounds: null, // { x, y, width, height }
  alwaysOnTop: true,
  clickThrough: false,
  showPanel: false,
};

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^﻿/, '')); // 手動編輯過的檔案可能帶 BOM
    if (saved && typeof saved === 'object') {
      if (saved.bounds && Number.isFinite(saved.bounds.x) && Number.isFinite(saved.bounds.width)) state.bounds = saved.bounds;
      if (typeof saved.alwaysOnTop === 'boolean') state.alwaysOnTop = saved.alwaysOnTop;
      if (typeof saved.clickThrough === 'boolean') state.clickThrough = saved.clickThrough;
      if (typeof saved.showPanel === 'boolean') state.showPanel = saved.showPanel;
    }
  } catch (e) {
    // 第一次啟動或檔案壞掉，用預設值
  }
}

let saveTimer = null;
function saveState(immediate) {
  if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) state.bounds = win.getBounds();
  const write = () => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      console.warn('無法儲存視窗狀態', e.message);
    }
  };
  if (immediate) {
    clearTimeout(saveTimer);
    write();
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(write, 400);
}

function defaultBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const size = Math.min(DEFAULT_SIZE, area.width, area.height);
  return {
    x: area.x + area.width - size - 24,
    y: area.y + area.height - size - 24,
    width: size,
    height: Math.round(size / ASPECT),
  };
}

/** 確認存下來的位置還在某個螢幕的可見範圍內（拔掉外接螢幕後不會跑到看不見的地方） */
function sanitizeBounds(b) {
  if (!b) return defaultBounds();
  const size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(b.width)));
  const bounds = { x: Math.round(b.x), y: Math.round(b.y), width: size, height: Math.round(size / ASPECT) };
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    return cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height;
  });
  return visible ? bounds : defaultBounds();
}

// ---------- 伺服器 ----------
async function ensureServer() {
  try {
    ownServer = await server.start({ root: WEB_ROOT, port: PORT, log: console.log });
    console.log(`伺服器已啟動 ${ownServer.url}  （提供 ${WEB_ROOT}）`);
    return ownServer.url;
  } catch (e) {
    // Windows 上若是 http.sys（serve.ps1 的 HttpListener）佔著這個埠，bind 會回 EACCES 而不是 EADDRINUSE
    if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
  }
  // 埠被佔用：如果是 start-server.bat 跑著的 serve.ps1，直接沿用；不是的話就提示
  if (await server.probe(PORT)) {
    console.log(`連接埠 ${PORT} 已有本專案的伺服器在跑（例如 start-server.bat），直接沿用。`);
    return `http://localhost:${PORT}`;
  }
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: APP_NAME,
    message: `連接埠 ${PORT} 已被其他程式佔用`,
    detail:
      `海豹需要在本機開一台小伺服器給攝影機頁與 OBS 顯示頁用，但 ${PORT} 已經被別的程式用走了。\n\n` +
      `請先關閉佔用的程式再重新啟動，或指定別的連接埠：\n` +
      `  npm start -- --port=8790\n` +
      `（換埠之後 OBS 顯示頁的網址也要改成同一個埠）`,
    buttons: ['結束'],
    noLink: true,
  });
  void choice;
  app.exit(1);
  return null;
}

// ---------- 視窗 ----------
function pageUrl() {
  return `${baseUrl}/index.html?mode=tracker&bg=transparent&ui=0`;
}

function createWindow() {
  const bounds = sanitizeBounds(state.bounds);
  const iconPath = path.join(ASSETS, 'icon.png');
  win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE,
    minHeight: Math.round(MIN_SIZE / ASPECT),
    title: APP_NAME,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    transparent: true,
    frame: false,
    alwaysOnTop: state.alwaysOnTop,
    resizable: true,
    maximizable: false, // 不然在海豹上點兩下會被當成標題列而放到最大
    fullscreenable: false,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 失去焦點或被蓋住時追蹤要繼續跑
    },
  });

  win.setAspectRatio(ASPECT);
  if (state.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  if (state.clickThrough) win.setIgnoreMouseEvents(true);
  win.setMenu(null);

  win.loadURL(pageUrl());

  win.once('ready-to-show', () => {
    win.show();
    if (OPEN_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.webContents.on('did-finish-load', () => {
    if (state.showPanel) setPanelVisible(true);
  });

  // 右鍵：在非拖曳區（控制面板、握把）
  win.webContents.on('context-menu', (event, params) => {
    if (params.isEditable) return;
    event.preventDefault();
    popupMenu();
  });
  // 右鍵：在 -webkit-app-region: drag 的區域（海豹本體）。Windows 把拖曳區當成標題列，滑鼠事件完全不會進到網頁，
  // 連 Electron 的 system-context-menu 事件也不會發（無邊框視窗沒有系統選單），所以直接接視窗訊息。
  win.on('system-context-menu', (event) => {
    event.preventDefault();
    popupMenu();
  });
  if (process.platform === 'win32') {
    const WM_NCRBUTTONUP = 0x00a5;
    const WM_MOUSEWHEEL = 0x020a;
    const HTCAPTION = 2;
    const MK_CONTROL = 0x0008;
    win.hookWindowMessage(WM_NCRBUTTONUP, (wParam) => {
      if (readWord(wParam, 0) === HTCAPTION) popupMenu();
    });
    // 拖曳區上的滾輪同樣進不了網頁：Ctrl + 滾輪縮放在這裡處理（整個視窗都適用）
    win.hookWindowMessage(WM_MOUSEWHEEL, (wParam) => {
      const keys = readWord(wParam, 0);
      const delta = readWord(wParam, 2);
      if (!(keys & MK_CONTROL) || !delta) return;
      scaleWindow((delta > 0x7fff ? delta - 0x10000 : delta) > 0 ? 1.1 : 1 / 1.1);
    });
  }

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control && !input.alt && !input.meta;
    const key = input.key.toLowerCase();
    let handled = true;
    if (ctrl && key === 't') toggleAlwaysOnTop();
    else if (ctrl && key === 'p') toggleClickThrough();
    else if (ctrl && key === 'q') quit();
    else if (ctrl && (key === '=' || key === '+')) scaleWindow(1.1);
    else if (ctrl && key === '-') scaleWindow(1 / 1.1);
    else if (ctrl && key === '0') resetBounds();
    else if (ctrl && key === 'r') win.webContents.reload();
    else if (key === 'f12') win.webContents.toggleDevTools();
    else handled = false;
    if (handled) event.preventDefault();
  });

  win.on('move', () => saveState());
  win.on('resize', () => saveState());
  win.on('close', () => {
    // 沒有關閉按鈕，會走到這裡的是 Alt+F4 或工作列的關閉：視為結束
    quitting = true;
    saveState(true);
  });
  win.on('closed', () => {
    win = null;
    app.quit();
  });

  // 網頁載入失敗（通常是伺服器沒起來）時至少讓人看得到原因
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    console.error('網頁載入失敗', code, desc, url);
    notify('海豹網頁載入失敗', `${desc} (${code})\n${url}`);
  });
}

function sendToPage(js) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  return win.webContents.executeJavaScript(js, true).catch((e) => console.warn('executeJavaScript 失敗', e.message));
}

function setPanelVisible(show) {
  state.showPanel = !!show;
  sendToPage(`document.body.classList.toggle('ui-hidden', ${!show}); 0`);
  refreshMenu();
  saveState();
}

function toggleAlwaysOnTop() {
  state.alwaysOnTop = !state.alwaysOnTop;
  win.setAlwaysOnTop(state.alwaysOnTop, 'screen-saver');
  refreshMenu();
  saveState();
}

function toggleClickThrough() {
  state.clickThrough = !state.clickThrough;
  win.setIgnoreMouseEvents(state.clickThrough);
  refreshMenu();
  saveState();
  if (state.clickThrough) {
    notify('滑鼠穿透已開啟', '點擊會穿過海豹落到下面的視窗。要關掉請用系統匣的海豹圖示右鍵選單，或在視窗有焦點時按 Ctrl+P。');
  }
}

function calibrate() {
  sendToPage('window.sealVTuber && window.sealVTuber.calibrate(); 0');
}

function setSquareBounds(x, y, size) {
  const s = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(size)));
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: s, height: Math.round(s / ASPECT) });
}

/** 以視窗中心為基準放大縮小 */
function scaleWindow(factor) {
  const b = win.getBounds();
  const size = b.width * factor;
  setSquareBounds(b.x + (b.width - size) / 2, b.y + (b.height - size / ASPECT) / 2, size);
}

function resetBounds() {
  const b = defaultBounds();
  win.setBounds(b);
  saveState();
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else {
    win.show();
    if (state.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  }
  refreshMenu();
}

function quit() {
  quitting = true;
  saveState(true);
  app.quit();
}

function notify(title, body) {
  console.log(`${title}：${body.replace(/\n/g, ' ')}`);
  try {
    // 系統匣氣球會掛在海豹圖示上；一般 Notification 在沒安裝捷徑的可攜版裡會顯示成「Electron」
    if (tray && !tray.isDestroyed()) {
      const icon = path.join(ASSETS, 'icon.png');
      tray.displayBalloon({
        title,
        content: body,
        iconType: fs.existsSync(icon) ? 'custom' : 'info',
        icon: fs.existsSync(icon) ? nativeImage.createFromPath(icon) : undefined,
        noSound: true,
      });
    } else if (Notification.isSupported()) {
      new Notification({ title, body, silent: true }).show();
    }
  } catch (e) {
    console.warn('無法顯示通知', e.message);
  }
}

// ---------- 選單與系統匣 ----------
function viewerUrl() {
  return `${baseUrl}/?mode=viewer&bg=transparent&ui=0`;
}

function buildMenu() {
  const visible = win && win.isVisible();
  return Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { type: 'separator' },
    { label: '永遠在最上層', type: 'checkbox', checked: state.alwaysOnTop, accelerator: 'Ctrl+T', click: toggleAlwaysOnTop },
    {
      label: '滑鼠穿透（點擊落到下面的視窗）',
      type: 'checkbox',
      checked: state.clickThrough,
      accelerator: 'Ctrl+P',
      click: toggleClickThrough,
    },
    { label: '顯示控制面板', type: 'checkbox', checked: state.showPanel, accelerator: 'H', click: () => setPanelVisible(!state.showPanel) },
    { type: 'separator' },
    { label: '重新校正正面', accelerator: 'C', click: calibrate },
    { label: '放大', accelerator: 'Ctrl+=', click: () => scaleWindow(1.1) },
    { label: '縮小', accelerator: 'Ctrl+-', click: () => scaleWindow(1 / 1.1) },
    { label: '重設大小與位置', accelerator: 'Ctrl+0', click: resetBounds },
    { type: 'separator' },
    {
      label: '複製 OBS 顯示頁網址',
      toolTip: viewerUrl(),
      click: () => {
        clipboard.writeText(viewerUrl());
        notify('已複製顯示頁網址', `${viewerUrl()}\n貼到 OBS 瀏覽器來源的網址欄即可。`);
      },
    },
    { type: 'separator' },
    { label: visible ? '隱藏海豹' : '顯示海豹', click: toggleVisible },
    { label: '結束', accelerator: 'Ctrl+Q', click: quit },
  ]);
}

function refreshMenu() {
  if (tray) tray.setContextMenu(buildMenu());
}

let lastPopupAt = 0;
function popupMenu() {
  if (!win || win.isDestroyed()) return;
  // 同一次右鍵可能同時觸發視窗訊息與 Electron 事件，短時間內只開一次
  const now = Date.now();
  if (now - lastPopupAt < 300) return;
  lastPopupAt = now;
  buildMenu().popup({ window: win });
}

/** hookWindowMessage 給的 wParam / lParam 是 Buffer（64 位元下 8 bytes），取其中的 16 位元欄位 */
function readWord(buf, offset) {
  return Buffer.isBuffer(buf) && buf.length >= offset + 2 ? buf.readUInt16LE(offset) : 0;
}

function trayIcon() {
  const file = path.join(ASSETS, 'tray.png');
  if (!fs.existsSync(file)) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(file);
  const px = Math.round(16 * screen.getPrimaryDisplay().scaleFactor);
  return img.resize({ width: px, height: px, quality: 'best' });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip(APP_NAME);
  tray.on('click', () => {
    if (!win) return;
    if (!win.isVisible()) toggleVisible();
    else if (state.clickThrough) popupMenuAtTray();
    else win.focus();
  });
  tray.on('right-click', () => popupMenuAtTray());
  refreshMenu();
}

function popupMenuAtTray() {
  if (tray) tray.popUpContextMenu(buildMenu());
}

// ---------- 與 preload 的溝通 ----------
let resizeStart = null;
ipcMain.on('seal:resize', (e, msg) => {
  if (!win || !msg) return;
  if (msg.phase === 'start') {
    resizeStart = { bounds: win.getBounds(), x: msg.x, y: msg.y };
  } else if (msg.phase === 'move' && resizeStart) {
    const dx = msg.x - resizeStart.x;
    const dy = msg.y - resizeStart.y;
    const size = Math.max(resizeStart.bounds.width + dx, (resizeStart.bounds.height + dy) * ASPECT);
    setSquareBounds(resizeStart.bounds.x, resizeStart.bounds.y, size);
  } else if (msg.phase === 'end') {
    resizeStart = null;
    saveState();
  }
});

ipcMain.on('seal:menu', () => popupMenu());

// 網頁自己用 H 鍵切換面板時，把狀態同步回來
ipcMain.on('seal:panel-state', (e, visible) => {
  if (typeof visible !== 'boolean' || visible === state.showPanel) return;
  state.showPanel = visible;
  refreshMenu();
  saveState();
});

// 網頁的狀態列文字顯示在系統匣提示，出錯時用通知提醒（面板隱藏時才看得到原因）
let lastErrorText = '';
ipcMain.on('seal:status', (e, msg) => {
  if (!msg || typeof msg.text !== 'string') return;
  if (tray) tray.setToolTip(`${APP_NAME} — ${msg.text}`);
  if (msg.error && msg.text !== lastErrorText) {
    lastErrorText = msg.text;
    notify(APP_NAME, msg.text);
  }
});

// ---------- 啟動 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (!win.isVisible()) win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    // 只允許攝影機（與麥克風）權限，其他一律拒絕
    const ses = require('electron').session.defaultSession;
    const allow = (permission, origin) =>
      permission === 'media' && typeof origin === 'string' && (origin === baseUrl || origin.startsWith(baseUrl + '/'));
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      callback(allow(permission, details.requestingUrl || wc.getURL()));
    });
    ses.setPermissionCheckHandler((wc, permission, origin) => allow(permission, origin));

    loadState();
    try {
      baseUrl = await ensureServer();
      if (!baseUrl) return;
      Menu.setApplicationMenu(null);
      createWindow();
      createTray();
    } catch (e) {
      console.error(e);
      dialog.showErrorBox(`${APP_NAME} 無法啟動`, String((e && e.stack) || e));
      app.exit(1);
      return;
    }
    console.log(`海豹視窗：${pageUrl()}`);
    console.log(`OBS 顯示頁：${viewerUrl()}`);
  });

  app.on('before-quit', () => {
    quitting = true;
    saveState(true);
  });

  app.on('will-quit', () => {
    if (ownServer) ownServer.close();
    if (tray) tray.destroy();
  });

  app.on('window-all-closed', () => app.quit());
}
