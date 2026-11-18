/* app.js — 攝影機 → MediaPipe Face Landmarker → 參數 → SealRig
 *
 * 流程：
 *   1. 按「啟動攝影機」後，從 CDN 載入 MediaPipe Tasks Vision 與臉部模型（需要網路）
 *   2. 每一幀用 detectForVideo 取得 478 個臉部特徵點與 52 個 blendshape 分數
 *   3. 由特徵點算頭部 yaw / pitch / roll，由 blendshape 取眨眼、張嘴、笑容
 *   4. 平滑後交給 SealRig 畫出來
 */
(function () {
  'use strict';

  // 執行模式（網址 ?mode=）：
  //   standalone（預設）：同一頁開攝影機、追蹤、畫海豹
  //   tracker：開攝影機追蹤，並把參數 POST 到本機伺服器 /params
  //   viewer：不開攝影機，從 /params 取參數畫海豹。給 OBS 瀏覽器來源用，因為 OBS 內建瀏覽器不給攝影機權限
  const urlParams = new URLSearchParams(location.search);
  const MODE = ['tracker', 'viewer'].includes(urlParams.get('mode')) ? urlParams.get('mode') : 'standalone';

  const TUNING = {
    mediapipe: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14',
    model:
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',

    // blendshape 分數 → 0..1 的對應區間（lo 以下視為 0，hi 以上視為 1）
    // blink 是「相對於靜止基準值」的區間，基準值由校正時量測（每個人睜眼時的分數不同，約 0.1～0.3）
    blink: { lo: 0.12, hi: 0.5 },
    blinkBaseDefault: 0.15, // 尚未校正前假設的睜眼基準值
    jaw: { lo: 0.08, hi: 0.5 },
    smile: { lo: 0.12, hi: 0.65 },

    // 頭部姿勢增益；pitchNeutral 是鼻尖在「額頭～上唇」區間裡的自然位置，校正後會再修正
    yawGain: 1.8,
    pitchGain: 2.0,
    pitchNeutral: 0.6,
    rollMax: 30,

    // 校正：取這段時間內的平均當作正面，避免按下去那一瞬間剛好在動
    calibrationMs: 1200,
    autoCalibrate: true, // 啟動攝影機、第一次看到臉之後自動校正一次

    // 平滑跟隨速度（每秒），越大越跟得緊、越小越柔
    follow: { pose: 14, blink: 30, jaw: 22, smile: 8 },
    neutralReturn: 3, // 找不到臉時回到正面的速度

    sleepAfterMs: 3000, // 幾毫秒沒看到臉就進入睡覺反應
  };

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const remap = (v, r) => clamp((v - r.lo) / (r.hi - r.lo), 0, 1);
  const follow = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));

  const body = document.body;
  const video = $('cam');
  const ui = {
    status: $('status'),
    btnCam: $('btn-camera'),
    btnCal: $('btn-calibrate'),
    btnDemo: $('btn-demo'),
    chkMirror: $('chk-mirror'),
    chkPreview: $('chk-preview'),
    bgButtons: Array.from(document.querySelectorAll('[data-bg]')),
    dbg: {
      state: $('dbg-state'),
      fps: $('dbg-fps'),
      yaw: $('dbg-yaw'),
      pitch: $('dbg-pitch'),
      roll: $('dbg-roll'),
      blink: $('dbg-blink'),
      jaw: $('dbg-jaw'),
      smile: $('dbg-smile'),
    },
  };

  const STATE_LABEL = { idle: '平常', talking: '說話', happy: '開心', surprised: '驚訝', sleep: '睡覺' };
  const NEUTRAL = { yaw: 0, pitch: 0, roll: 0, blinkL: 0, blinkR: 0, jaw: 0, smile: 0, present: false };

  let rig;
  try {
    rig = new SealRig($('seal'));
  } catch (e) {
    setStatus(e.message, 'error');
    throw e;
  }

  let target = { ...NEUTRAL }; // 追蹤器算出的目標值
  let current = { ...NEUTRAL }; // 平滑後送給 rig 的值

  // 校正：calib 是正面時的原始姿勢，blinkBase 是睜眼時的 blendshape 基準值
  const calib = { yaw: 0, pitch: 0, roll: 0 };
  const blinkBase = { left: TUNING.blinkBaseDefault, right: TUNING.blinkBaseDefault };
  let calibSamples = null; // 校正進行中時累積樣本
  let autoCalibratePending = false;
  let statusKey = '';

  let landmarker = null;
  let stream = null;
  let tracking = false;
  let demo = false;
  let mirror = true;
  let lastRaw = null; // 最近一次未校正、未鏡像的原始參數（診斷用）
  let diag = false;
  let lastDiagAt = 0;
  let sendInFlight = false; // tracker：避免同時有多個 POST 在路上
  let lastRemoteAt = 0; // viewer：最近一次收到新鮮資料的時間

  let lastSeenAt = performance.now();
  let lastVideoTime = -1;
  let lastFrameAt = performance.now();
  let fpsCount = 0;
  let fpsAt = performance.now();
  let fps = 0;

  // ---------- UI ----------
  function setStatus(text, kind, key) {
    statusKey = key || text;
    ui.status.textContent = text;
    ui.status.className = 'status' + (kind ? ' is-' + kind : '');
  }

  function setBackground(name) {
    body.classList.remove('bg-soft', 'bg-green', 'bg-blue', 'bg-transparent');
    body.classList.add('bg-' + name);
    ui.bgButtons.forEach((b) => b.classList.toggle('is-active', b.dataset.bg === name));
  }

  function setMirror(on) {
    mirror = on;
    ui.chkMirror.checked = on;
    body.classList.toggle('mirror', on);
  }

  function setPreview(on) {
    ui.chkPreview.checked = on;
    body.classList.toggle('show-cam', on);
  }

  function toggleUi() {
    body.classList.toggle('ui-hidden');
  }

  function updateDebug(state) {
    const d = ui.dbg;
    d.state.textContent = STATE_LABEL[state] || state;
    d.fps.textContent = fps;
    d.yaw.textContent = current.yaw.toFixed(2);
    d.pitch.textContent = current.pitch.toFixed(2);
    d.roll.textContent = current.roll.toFixed(0) + '°';
    d.blink.textContent = Math.max(current.blinkL, current.blinkR).toFixed(2);
    d.jaw.textContent = current.jaw.toFixed(2);
    d.smile.textContent = current.smile.toFixed(2);
  }

  // ---------- MediaPipe ----------
  async function ensureLandmarker() {
    if (landmarker) return landmarker;
    const mod = await import(TUNING.mediapipe);
    const api = mod.FaceLandmarker ? mod : mod.default; // 不同打包方式的相容處理
    const files = await api.FilesetResolver.forVisionTasks(TUNING.mediapipe + '/wasm');
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: TUNING.model, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    });
    try {
      landmarker = await api.FaceLandmarker.createFromOptions(files, options('GPU'));
    } catch (e) {
      console.warn('GPU 模式失敗，改用 CPU', e);
      landmarker = await api.FaceLandmarker.createFromOptions(files, options('CPU'));
    }
    return landmarker;
  }

  /** 從偵測結果算出原始參數（尚未鏡像、尚未校正） */
  function extract(result, width, height) {
    const lm = result.faceLandmarks && result.faceLandmarks[0];
    if (!lm) return null;

    // 特徵點編號：1 鼻尖、234/454 臉頰兩側、10 額頭、0 上唇中央、33/263 兩眼外角
    // 俯仰用「額頭～上唇」而不是「額頭～下巴」當基準，張嘴時下巴會往下移、上唇幾乎不動
    const nose = lm[1];
    const cheekA = lm[234];
    const cheekB = lm[454];
    const top = lm[10];
    const lip = lm[0];
    const eyeA = lm[33];
    const eyeB = lm[263];

    const halfW = Math.abs(cheekB.x - cheekA.x) / 2 || 1e-6;
    const halfH = Math.abs(lip.y - top.y) / 2 || 1e-6;
    const yaw = ((nose.x - (cheekA.x + cheekB.x) / 2) / halfW) * TUNING.yawGain;
    const pitch = ((nose.y - (top.y + lip.y) / 2) / halfH - TUNING.pitchNeutral) * TUNING.pitchGain;

    // 兩眼連線的角度就是側傾；乘上影像寬高避免被長寬比拉歪
    let dx = (eyeB.x - eyeA.x) * width;
    let dy = (eyeB.y - eyeA.y) * height;
    if (dx < 0) {
      dx = -dx;
      dy = -dy;
    }
    const roll = (Math.atan2(dy, dx) * 180) / Math.PI;

    const bs = {};
    const cats = (result.faceBlendshapes && result.faceBlendshapes[0] && result.faceBlendshapes[0].categories) || [];
    for (const c of cats) bs[c.categoryName] = c.score;

    return {
      yaw,
      pitch,
      roll,
      blinkLeft: bs.eyeBlinkLeft || 0, // 本人的左眼
      blinkRight: bs.eyeBlinkRight || 0, // 本人的右眼
      jaw: bs.jawOpen || 0,
      smile: Math.max(bs.mouthSmileLeft || 0, bs.mouthSmileRight || 0),
    };
  }

  /** 開始校正：接下來 calibrationMs 內的平均姿勢會被當成正面、平均眨眼分數當成睜眼基準 */
  function beginCalibration() {
    calibSamples = {
      until: performance.now() + TUNING.calibrationMs,
      n: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      blinkLeft: 0,
      blinkRight: 0,
    };
    setStatus('校正中，請看著鏡頭…', null, 'calibrating');
  }

  function accumulateCalibration(raw, now) {
    const c = calibSamples;
    c.n++;
    c.yaw += raw.yaw;
    c.pitch += raw.pitch;
    c.roll += raw.roll;
    c.blinkLeft += raw.blinkLeft;
    c.blinkRight += raw.blinkRight;
    if (now < c.until) return;
    calib.yaw = c.yaw / c.n;
    calib.pitch = c.pitch / c.n;
    calib.roll = c.roll / c.n;
    blinkBase.left = c.blinkLeft / c.n;
    blinkBase.right = c.blinkRight / c.n;
    calibSamples = null;
    setStatus('已校正正面', 'live', 'calibrated');
  }

  /** 原始參數 → 校正、鏡像、重新對應成 rig 參數 */
  function toTarget(raw, now) {
    if (calibSamples) accumulateCalibration(raw, now);
    const s = mirror ? -1 : 1;
    // 眨眼分數先扣掉睜眼基準值，再對應到 0..1
    const blinkLeft = raw.blinkLeft - blinkBase.left;
    const blinkRight = raw.blinkRight - blinkBase.right;
    // 鏡像時本人的左眼在畫面左邊；非鏡像（觀眾視角）則相反
    const blinkScreenL = mirror ? blinkLeft : blinkRight;
    const blinkScreenR = mirror ? blinkRight : blinkLeft;
    return {
      yaw: clamp(s * (raw.yaw - calib.yaw), -1, 1),
      pitch: clamp(raw.pitch - calib.pitch, -1, 1),
      roll: clamp(s * (raw.roll - calib.roll), -TUNING.rollMax, TUNING.rollMax),
      blinkL: remap(blinkScreenL, TUNING.blink),
      blinkR: remap(blinkScreenR, TUNING.blink),
      jaw: remap(raw.jaw, TUNING.jaw),
      smile: remap(raw.smile, TUNING.smile),
      present: true,
    };
  }

  // ---------- 攝影機 ----------
  async function startCamera() {
    if (tracking) {
      stopCamera();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('此環境不支援攝影機（需 https 或 localhost）', 'error');
      return;
    }
    demo = false;
    ui.btnDemo.classList.remove('is-active');
    ui.btnCam.disabled = true;
    setStatus('載入追蹤模型…');
    try {
      await ensureLandmarker();
    } catch (e) {
      console.error(e);
      setStatus('模型載入失敗，請確認網路連線', 'error');
      ui.btnCam.disabled = false;
      return;
    }
    setStatus('等待攝影機授權…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
    } catch (e) {
      console.error('camera error', e.name, e.message);
      setStatus('無法開啟攝影機：' + (e.name || e.message), 'error');
      if (diag) fetch('/diag?err=' + encodeURIComponent('camera ' + e.name + ' ' + e.message)).catch(() => {});
      ui.btnCam.disabled = false;
      return;
    }
    tracking = true;
    lastVideoTime = -1;
    lastSeenAt = performance.now();
    autoCalibratePending = TUNING.autoCalibrate;
    ui.btnCam.disabled = false;
    ui.btnCam.textContent = '停止攝影機';
    ui.btnCal.disabled = false;
    setStatus('追蹤中', 'live', 'tracking');
  }

  function stopCamera() {
    tracking = false;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.srcObject = null;
    ui.btnCam.textContent = '啟動攝影機';
    ui.btnCal.disabled = true;
    calibSamples = null;
    autoCalibratePending = false;
    target = { ...NEUTRAL };
    setStatus('已停止');
  }

  // ---------- 示範模式：不用攝影機，用波形輪流演示各種反應 ----------
  function demoParams(now) {
    const t = now / 1000;
    const phase = t % 16;
    const p = {
      yaw: Math.sin(t * 0.9) * 0.55,
      pitch: Math.sin(t * 0.6) * 0.25,
      roll: Math.sin(t * 0.7) * 8,
      blinkL: 0,
      blinkR: 0,
      jaw: 0,
      smile: 0,
      present: true,
    };
    const bp = t % 3.2; // 每 3.2 秒眨一次
    const blink = bp < 0.25 ? 1 - Math.abs(bp / 0.125 - 1) : 0;
    p.blinkL = p.blinkR = blink;

    if (phase < 4) {
      // 平常
    } else if (phase < 8) {
      p.jaw = clamp(0.35 + 0.35 * Math.sin(t * 14) + 0.15 * Math.sin(t * 5.3), 0, 0.5); // 說話
    } else if (phase < 11) {
      p.smile = 1; // 開心
      p.jaw = 0.1;
    } else if (phase < 13) {
      p.jaw = 0.9; // 驚訝
      p.blinkL = p.blinkR = 0;
    } else {
      p.present = false; // 睡覺
      lastSeenAt = now - TUNING.sleepAfterMs - 1;
    }
    return p;
  }

  function toggleDemo() {
    demo = !demo;
    ui.btnDemo.classList.toggle('is-active', demo);
    if (demo) {
      if (tracking) stopCamera();
      setStatus('示範模式', 'live');
    } else {
      target = { ...NEUTRAL };
      setStatus('已停止');
    }
  }

  // ---------- 主迴圈 ----------
  function loop(now) {
    requestAnimationFrame(loop);
    tick(now);
  }

  /** 處理一幀：取得參數 → 平滑 → 判斷狀態 → 畫出來。now 為毫秒時間戳 */
  function tick(now) {
    const dt = Math.min(0.1, (now - lastFrameAt) / 1000);
    lastFrameAt = now;

    if (demo) {
      target = demoParams(now);
      if (target.present) lastSeenAt = now;
    } else if (tracking && landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      let result = null;
      try {
        result = landmarker.detectForVideo(video, now);
      } catch (e) {
        console.error(e);
      }
      const raw = result ? extract(result, video.videoWidth, video.videoHeight) : null;
      if (raw) {
        lastRaw = raw;
        if (autoCalibratePending) {
          // 第一次看到臉就自動校正一次（使用者剛按下按鈕，通常正看著鏡頭）
          autoCalibratePending = false;
          beginCalibration();
        }
        target = toTarget(raw, now);
        lastSeenAt = now;
        if (statusKey !== 'tracking' && statusKey !== 'calibrated' && statusKey !== 'calibrating') {
          setStatus('追蹤中', 'live', 'tracking');
        }
      } else {
        target = { ...target, present: false };
        if (statusKey !== 'noface') setStatus('沒有偵測到臉', null, 'noface');
      }
      if (MODE === 'tracker') sendParams();
      fpsCount++;
      if (now - fpsAt >= 1000) {
        fps = fpsCount;
        fpsCount = 0;
        fpsAt = now;
      }
    } else if (!tracking) {
      fps = 0;
    }

    // 平滑：有臉時跟隨目標，沒臉時慢慢回正
    const f = TUNING.follow;
    if (target.present) {
      current.yaw = follow(current.yaw, target.yaw, f.pose, dt);
      current.pitch = follow(current.pitch, target.pitch, f.pose, dt);
      current.roll = follow(current.roll, target.roll, f.pose, dt);
      current.blinkL = follow(current.blinkL, target.blinkL, f.blink, dt);
      current.blinkR = follow(current.blinkR, target.blinkR, f.blink, dt);
      current.jaw = follow(current.jaw, target.jaw, f.jaw, dt);
      current.smile = follow(current.smile, target.smile, f.smile, dt);
    } else {
      for (const k of ['yaw', 'pitch', 'roll', 'blinkL', 'blinkR', 'jaw', 'smile']) {
        current[k] = follow(current[k], 0, TUNING.neutralReturn, dt);
      }
    }
    current.present = target.present;

    if (MODE === 'viewer') {
      const fresh = Date.now() - lastRemoteAt < 1500;
      if (fresh && statusKey !== 'remote') setStatus('接收追蹤資料中', 'live', 'remote');
      if (!fresh && statusKey !== 'remote-wait') setStatus('等待追蹤頁的資料…', null, 'remote-wait');
    }

    // 只有在追蹤、示範或接收中才計算「多久沒看到臉」，待命時維持平常狀態
    const active = tracking || demo || MODE === 'viewer';
    const absentMs = active ? now - lastSeenAt : 0;
    const state = SealRig.classify(current, absentMs, TUNING.sleepAfterMs);
    if (!paused) {
      rig.apply(current, dt, state);
      updateDebug(state);
    }
    if (diag && (tracking || demo || MODE === 'viewer') && now - lastDiagAt >= 1000) {
      lastDiagAt = now;
      sendDiag(state);
    }
  }

  /** 診斷模式：把目前數值以 GET /diag?... 送到本機伺服器，serve.ps1 會印在終端機上 */
  function sendDiag(state) {
    const n = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));
    const q = new URLSearchParams({
      mode: MODE,
      hid: document.hidden ? '1' : '0',
      st: state,
      fps: String(fps),
      yaw: n(current.yaw),
      pitch: n(current.pitch),
      roll: n(current.roll),
      bL: n(current.blinkL),
      bR: n(current.blinkR),
      jaw: n(current.jaw),
      smile: n(current.smile),
      present: current.present ? '1' : '0',
    });
    if (lastRaw) {
      q.set('rYaw', n(lastRaw.yaw));
      q.set('rPitch', n(lastRaw.pitch));
      q.set('rRoll', n(lastRaw.roll));
      q.set('rBlinkL', n(lastRaw.blinkLeft));
      q.set('rBlinkR', n(lastRaw.blinkRight));
      q.set('rJaw', n(lastRaw.jaw));
      q.set('rSmile', n(lastRaw.smile));
      q.set('cYaw', n(calib.yaw));
      q.set('cPitch', n(calib.pitch));
      q.set('baseL', n(blinkBase.left));
      q.set('baseR', n(blinkBase.right));
    }
    fetch('/diag?' + q.toString(), { cache: 'no-store', keepalive: true }).catch(() => {});
  }

  // ---------- tracker / viewer 之間的參數中繼（經由 serve.ps1 的 /params） ----------
  function sendParams() {
    if (sendInFlight) return;
    sendInFlight = true;
    const body = JSON.stringify({ t: Date.now(), ...target });
    fetch('/params', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true })
      .catch(() => {})
      .finally(() => {
        sendInFlight = false;
      });
  }

  async function pollParams() {
    try {
      const r = await fetch('/params', { cache: 'no-store' });
      const d = await r.json();
      if (d && typeof d.t === 'number') {
        const fresh = Date.now() - d.t < 1500; // 追蹤頁停了就當作沒看到臉
        target = {
          yaw: d.yaw || 0,
          pitch: d.pitch || 0,
          roll: d.roll || 0,
          blinkL: d.blinkL || 0,
          blinkR: d.blinkR || 0,
          jaw: d.jaw || 0,
          smile: d.smile || 0,
          present: !!d.present && fresh,
        };
        if (fresh) lastRemoteAt = Date.now();
        if (target.present) lastSeenAt = performance.now();
      }
    } catch (e) {
      // 伺服器沒開或還沒有資料，下一輪再試
    }
    setTimeout(pollParams, 33);
  }

  // 除錯介面：在瀏覽器主控台可用 sealVTuber.TUNING 即時調參數，
  // sealVTuber.pause(true) 後自己呼叫 sealVTuber.rig.apply(...) 測試造型，
  // 或用 sealVTuber.tick(毫秒) 手動步進整條流程
  let paused = false;
  window.sealVTuber = {
    rig,
    TUNING,
    tick,
    calibrate: beginCalibration,
    pause: (on) => {
      paused = !!on;
    },
    // 測試用：把原始參數丟進校正、鏡像與對應流程
    _toTarget: toTarget,
    get calibration() {
      return { ...calib, blinkBase: { ...blinkBase } };
    },
    get current() {
      return { ...current };
    },
  };

  // ---------- 事件 ----------
  ui.btnCam.addEventListener('click', startCamera);
  ui.btnCal.addEventListener('click', () => {
    if (tracking) beginCalibration();
  });
  ui.btnDemo.addEventListener('click', toggleDemo);
  ui.chkMirror.addEventListener('change', () => setMirror(ui.chkMirror.checked));
  ui.chkPreview.addEventListener('change', () => setPreview(ui.chkPreview.checked));
  ui.bgButtons.forEach((b) => b.addEventListener('click', () => setBackground(b.dataset.bg)));

  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    switch (e.key.toLowerCase()) {
      case 'h':
        toggleUi();
        break;
      case 'd':
        toggleDemo();
        break;
      case 'c':
        if (tracking) beginCalibration();
        break;
      case 'm':
        setMirror(!mirror);
        break;
      case 'v':
        setPreview(!ui.chkPreview.checked);
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  // ---------- 網址參數 ----------
  const params = urlParams;
  if (params.has('bg')) setBackground(params.get('bg'));
  if (params.get('ui') === '0') body.classList.add('ui-hidden');
  if (params.has('mirror')) setMirror(params.get('mirror') !== '0');
  if (params.get('preview') === '1') setPreview(true);
  diag = params.get('diag') === '1';
  if (window.obsstudio) body.classList.add('ui-hidden'); // 放進 OBS 瀏覽器來源時自動隱藏面板
  setStatus('待命');

  if (MODE === 'viewer') {
    ui.btnCam.disabled = true;
    ui.btnCam.textContent = '顯示模式（由追蹤頁驅動）';
    ui.btnCal.disabled = true;
    pollParams();
  } else if (params.get('demo') === '1') {
    toggleDemo();
  } else if (params.get('autostart') === '1' || MODE === 'tracker' || window.obsstudio) {
    startCamera();
  }

  if (MODE === 'tracker') {
    // 追蹤頁被切到背景或被其他視窗完全蓋住時，requestAnimationFrame 會停、主執行緒的計時器會被 Chrome
    // 降到每秒一次。Web Worker 的計時器不受這個限制，所以用 worker 每 33 毫秒敲一次主執行緒來驅動 tick。
    try {
      const src = 'setInterval(function () { postMessage(0); }, 33);';
      const ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      ticker.onmessage = () => {
        if (document.hidden) tick(performance.now());
      };
    } catch (e) {
      console.warn('無法建立背景計時 worker，改用一般計時器', e);
      setInterval(() => {
        if (document.hidden) tick(performance.now());
      }, 33);
    }
  }

  requestAnimationFrame(loop);
})();
