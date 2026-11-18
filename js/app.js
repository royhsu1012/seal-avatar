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

  const TUNING = {
    mediapipe: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14',
    model:
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',

    // blendshape 分數 → 0..1 的對應區間（lo 以下視為 0，hi 以上視為 1）
    blink: { lo: 0.25, hi: 0.6 },
    jaw: { lo: 0.05, hi: 0.5 },
    smile: { lo: 0.12, hi: 0.65 },

    // 頭部姿勢增益；pitchNeutral 是鼻尖在臉上的自然偏下位置
    yawGain: 2.2,
    pitchGain: 2.6,
    pitchNeutral: 0.12,
    rollMax: 30,

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
  const calib = { yaw: 0, pitch: 0, roll: 0 };
  let wantCalibrate = false;

  let landmarker = null;
  let stream = null;
  let tracking = false;
  let demo = false;
  let mirror = true;
  let lastRaw = null; // 最近一次未校正、未鏡像的原始參數（診斷用）
  let diag = false;
  let lastDiagAt = 0;

  let lastSeenAt = performance.now();
  let lastVideoTime = -1;
  let lastFrameAt = performance.now();
  let fpsCount = 0;
  let fpsAt = performance.now();
  let fps = 0;

  // ---------- UI ----------
  function setStatus(text, kind) {
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

    // 特徵點編號：1 鼻尖、234/454 臉頰兩側、10 額頭、152 下巴、33/263 兩眼外角
    const nose = lm[1];
    const cheekA = lm[234];
    const cheekB = lm[454];
    const top = lm[10];
    const chin = lm[152];
    const eyeA = lm[33];
    const eyeB = lm[263];

    const halfW = Math.abs(cheekB.x - cheekA.x) / 2 || 1e-6;
    const halfH = Math.abs(chin.y - top.y) / 2 || 1e-6;
    const yaw = ((nose.x - (cheekA.x + cheekB.x) / 2) / halfW) * TUNING.yawGain;
    const pitch = ((nose.y - (top.y + chin.y) / 2) / halfH - TUNING.pitchNeutral) * TUNING.pitchGain;

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

  /** 原始參數 → 校正、鏡像、重新對應成 rig 參數 */
  function toTarget(raw) {
    if (wantCalibrate) {
      calib.yaw = raw.yaw;
      calib.pitch = raw.pitch;
      calib.roll = raw.roll;
      wantCalibrate = false;
      setStatus('已校正正面', 'live');
    }
    const s = mirror ? -1 : 1;
    // 鏡像時本人的左眼在畫面左邊；非鏡像（觀眾視角）則相反
    const blinkScreenL = mirror ? raw.blinkLeft : raw.blinkRight;
    const blinkScreenR = mirror ? raw.blinkRight : raw.blinkLeft;
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
      console.error(e);
      setStatus('無法開啟攝影機：' + (e.name || e.message), 'error');
      ui.btnCam.disabled = false;
      return;
    }
    tracking = true;
    lastVideoTime = -1;
    lastSeenAt = performance.now();
    ui.btnCam.disabled = false;
    ui.btnCam.textContent = '停止攝影機';
    ui.btnCal.disabled = false;
    setStatus('追蹤中', 'live');
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
        target = toTarget(raw);
        lastSeenAt = now;
        if (ui.status.textContent !== '追蹤中' && ui.status.textContent !== '已校正正面') setStatus('追蹤中', 'live');
      } else {
        target = { ...target, present: false };
        setStatus('沒有偵測到臉');
      }
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

    // 只有在追蹤或示範中才計算「多久沒看到臉」，待命時維持平常狀態
    const absentMs = tracking || demo ? now - lastSeenAt : 0;
    const state = SealRig.classify(current, absentMs, TUNING.sleepAfterMs);
    if (!paused) {
      rig.apply(current, dt, state);
      updateDebug(state);
    }
    if (diag && (tracking || demo) && now - lastDiagAt >= 1000) {
      lastDiagAt = now;
      sendDiag(state);
    }
  }

  /** 診斷模式：把目前數值以 GET /diag?... 送到本機伺服器，serve.ps1 會印在終端機上 */
  function sendDiag(state) {
    const n = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));
    const q = new URLSearchParams({
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
    }
    fetch('/diag?' + q.toString(), { cache: 'no-store', keepalive: true }).catch(() => {});
  }

  // 除錯介面：在瀏覽器主控台可用 sealVTuber.TUNING 即時調參數，
  // sealVTuber.pause(true) 後自己呼叫 sealVTuber.rig.apply(...) 測試造型，
  // 或用 sealVTuber.tick(毫秒) 手動步進整條流程
  let paused = false;
  window.sealVTuber = {
    rig,
    TUNING,
    tick,
    pause: (on) => {
      paused = !!on;
    },
    get current() {
      return { ...current };
    },
  };

  // ---------- 事件 ----------
  ui.btnCam.addEventListener('click', startCamera);
  ui.btnCal.addEventListener('click', () => {
    wantCalibrate = true;
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
        if (tracking) wantCalibrate = true;
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
  const params = new URLSearchParams(location.search);
  if (params.has('bg')) setBackground(params.get('bg'));
  if (params.get('ui') === '0') body.classList.add('ui-hidden');
  if (params.has('mirror')) setMirror(params.get('mirror') !== '0');
  if (params.get('preview') === '1') setPreview(true);
  diag = params.get('diag') === '1';
  if (window.obsstudio) body.classList.add('ui-hidden'); // 放進 OBS 瀏覽器來源時自動隱藏面板
  setStatus('待命');
  if (params.get('demo') === '1') toggleDemo();
  else if (params.get('autostart') === '1' || window.obsstudio) startCamera();

  requestAnimationFrame(loop);
})();
