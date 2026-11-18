/* preload.js — 在網頁載入前注入的一小層「桌面模式」
 *
 * 網頁本身（index.html、js/）完全不知道自己在 Electron 裡；這裡做的只有：
 *   - 在 <html> 加上 desktop class，css/style.css 據此把整個舞台設成可拖曳（-webkit-app-region: drag）
 *   - 放一個右下角的縮放握把 #desktop-grip，拖它會透過 IPC 請主程序改視窗大小
 *   - Ctrl + 滾輪縮放
 *   - 把面板顯示狀態與狀態列文字回報給主程序（系統匣提示、選單勾選同步）
 *
 * 跑在 contextIsolation 下，碰得到 DOM，但碰不到網頁的 window.sealVTuber；要叫網頁做事由主程序用 executeJavaScript。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sealDesktop', {
  isDesktop: true,
  openMenu: () => ipcRenderer.send('seal:menu'),
});

window.addEventListener('DOMContentLoaded', () => {
  const html = document.documentElement;
  const body = document.body;
  html.classList.add('desktop');

  // ---------- 縮放握把 ----------
  const grip = document.createElement('div');
  grip.id = 'desktop-grip';
  grip.title = '拖曳縮放海豹（也可以 Ctrl + 滾輪）';
  body.appendChild(grip);

  let resizing = false;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizing = true;
    grip.setPointerCapture(e.pointerId);
    ipcRenderer.send('seal:resize', { phase: 'start', x: e.screenX, y: e.screenY });
  });
  grip.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    ipcRenderer.send('seal:resize', { phase: 'move', x: e.screenX, y: e.screenY });
  });
  const endResize = (e) => {
    if (!resizing) return;
    resizing = false;
    try {
      grip.releasePointerCapture(e.pointerId);
    } catch (err) {
      // 已經放掉了
    }
    ipcRenderer.send('seal:resize', { phase: 'end' });
  };
  grip.addEventListener('pointerup', endResize);
  grip.addEventListener('pointercancel', endResize);

  // ---------- Ctrl + 滾輪縮放 ----------
  // 實際縮放由主程序接 WM_MOUSEWHEEL 處理（拖曳區上的滾輪進不了網頁），這裡只擋掉預設行為
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false }
  );

  // ---------- 狀態回報 ----------
  const reportPanel = () => ipcRenderer.send('seal:panel-state', !body.classList.contains('ui-hidden'));
  new MutationObserver(reportPanel).observe(body, { attributes: true, attributeFilter: ['class'] });

  const status = document.getElementById('status');
  if (status) {
    const reportStatus = () =>
      ipcRenderer.send('seal:status', { text: status.textContent.trim(), error: status.classList.contains('is-error') });
    new MutationObserver(reportStatus).observe(status, { childList: true, characterData: true, subtree: true, attributes: true });
    reportStatus();
  }
});
