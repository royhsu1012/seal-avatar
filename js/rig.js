/* rig.js — 把追蹤參數套用到海豹上。
 *
 * 角色是兩張同構圖的去背 PNG（1024 x 1024）加上疊在臉上的向量圖層：
 *   - 身體 art/seal-body.png：固定不動，只跟著整體呼吸起伏
 *   - 頭 art/seal-head.png：轉頭、點頭、側傾都只動這一層（以脖子為支點平移加旋轉），身體不會跟著歪
 *   - 眼睛：先用毛色的小色塊蓋住頭圖畫好的眼睛，再用向量畫一對一樣的眼睛，這樣才能眨眼、看方向、換笑眼
 *   - 嘴巴：張嘴時疊一個嘴型在吻部上；閉嘴就是頭圖原本的微笑
 *   - 腮紅：頭圖本來就有，開心時再疊一層加深
 *   - zzz / !：反應符號
 * 疊圖層放在頭的群組裡，跟著頭一起動才不會對不準。
 *
 * 輸入參數 p：
 *   yaw     -1..1   左右轉頭（正值 = 朝畫面右邊）
 *   pitch   -1..1   上下點頭（正值 = 往下看）
 *   roll    度數    頭部側傾（正值 = 順時針）
 *   blinkL  0..1    畫面左邊那隻眼睛的閉合程度（1 = 全閉）
 *   blinkR  0..1    畫面右邊那隻眼睛的閉合程度
 *   jaw     0..1    張嘴程度
 *   smile   0..1    笑容程度
 *   handL   0..1    畫面左側（本人）的手部動作量，對應左鰭；沒有時可省略
 *   handR   0..1    畫面右側的手部動作量，對應右鰭
 *   present boolean 目前是否偵測到臉
 *
 * 狀態 state（由 SealRig.classify 決定）：idle / talking / happy / surprised / sleep
 */
(function (global) {
  'use strict';

  // 與 index.html 裡的 SVG 座標對應（1024 x 1024，由 art/seal-head.png、seal-body.png 量出來），換圖時請同步修改
  const BASE_CX = 512, BASE_BOTTOM = 964; // 呼吸與彈跳的支點：身體底部中央
  const NECK = { x: 535, y: 600 }; // 頭部旋轉的支點：頭圖下緣中央偏上（頭圖範圍 x 252-817、y 157-671）
  const FLIPPER_L = { x: 240, y: 800 }; // 前鰭的支點（肩膀）；鰭只往離開身體的方向轉，轉回來會壓到肚子上
  const FLIPPER_R = { x: 784, y: 800 };
  const HEAD_MOVE = { x: 18, y: 12, roll: 6 }; // 頭最多平移幾像素、側傾幾度；再大會在肩膀處露出身體圓頂的遮罩邊
  const EYE_L = { x: 401, y: 350 };
  const EYE_R = { x: 636, y: 350 };
  const MOUTH_TOP = { x: 515, y: 456 }; // 張嘴嘴型的上緣（吻部微笑線），張嘴時以這點為支點往下拉
  const EXCLAIM = { x: 800, y: 250 };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const fmt = (n) => Math.round(n * 1000) / 1000;
  const scaleAround = (cx, cy, sx, sy) =>
    `translate(${fmt(cx)} ${fmt(cy)}) scale(${fmt(sx)} ${fmt(sy)}) translate(${fmt(-cx)} ${fmt(-cy)})`;

  class SealRig {
    constructor(root) {
      const $ = (id) => {
        const el = root.querySelector('#' + id);
        if (!el) throw new Error('SVG 缺少圖層 #' + id);
        return el;
      };
      this.el = {
        avatar: $('avatar'),
        head: $('head'),
        flipperL: $('flipper-left'),
        flipperR: $('flipper-right'),
        eyeLOpen: $('eye-left-open'),
        eyeROpen: $('eye-right-open'),
        eyeLClosed: $('eye-left-closed'),
        eyeRClosed: $('eye-right-closed'),
        eyeLHappy: $('eye-left-happy'),
        eyeRHappy: $('eye-right-happy'),
        mouthOpen: $('mouth-open'),
        blush: $('blush'),
        zzz: $('zzz'),
        exclaim: $('exclaim'),
      };
      this.t = 0;
      this.fx = { happy: 0, surprised: 0, sleep: 0 }; // 平滑後的反應強度
      this.state = 'idle';
    }

    /** 依參數判斷目前反應狀態 */
    static classify(p, absentMs, sleepAfterMs) {
      if (!p.present && absentMs >= sleepAfterMs) return 'sleep';
      if (p.smile > 0.5) return 'happy';
      if (p.jaw > 0.7 && p.smile < 0.3) return 'surprised';
      if (p.jaw > 0.15) return 'talking';
      return 'idle';
    }

    /** 每一幀呼叫：p 為平滑後的參數，dt 為秒 */
    apply(p, dt, state) {
      this.t += dt;
      const t = this.t;
      this.state = state;

      // 反應強度淡入淡出
      const k = 1 - Math.exp(-dt * 6);
      this.fx.happy = lerp(this.fx.happy, state === 'happy' ? 1 : 0, k);
      this.fx.surprised = lerp(this.fx.surprised, state === 'surprised' ? 1 : 0, k);
      this.fx.sleep = lerp(this.fx.sleep, state === 'sleep' ? 1 : 0, k * 0.5);
      const { happy, surprised, sleep } = this.fx;

      // 睡著時頭回到正位、微微低下；身體永遠不動
      const yaw = clamp(p.yaw, -1, 1) * (1 - sleep);
      const pitch = clamp(p.pitch, -1, 1) * (1 - sleep) + 0.5 * sleep;
      const roll = clamp(p.roll, -HEAD_MOVE.roll, HEAD_MOVE.roll) * (1 - sleep) + 3 * sleep;

      // 呼吸起伏 + 開心時的小彈跳（以身體底部為支點，整隻一起）
      const breath = 1 + 0.01 * Math.sin((t * Math.PI * 2) / 3.6);
      const bounce = happy * 0.02 * Math.max(0, Math.sin((t * Math.PI * 2) / 0.5));
      this.el.avatar.setAttribute('transform', scaleAround(BASE_CX, BASE_BOTTOM, 1 + bounce * 0.4, breath + bounce));

      // 頭：只動頭這一層。轉頭 = 左右平移，點頭 = 上下平移，側傾 = 繞脖子旋轉
      const hx = yaw * HEAD_MOVE.x;
      const hy = pitch * HEAD_MOVE.y - surprised * 10; // 驚訝時頭往上彈一下
      this.el.head.setAttribute('transform', `translate(${fmt(hx)} ${fmt(hy)}) rotate(${fmt(roll)} ${NECK.x} ${NECK.y})`);

      // 前鰭：平常輕輕起伏（0～1.5 度）、開心時拍動（最多再加 6 度）、驚訝時抬起 4 度、睡著時放下；
      // 本人哪隻手在動（p.handL / p.handR，0..1），那一側的鰭就跟著微微晃（最多再抬 5 度並以 2 Hz 抖動）。
      // 角度一律 ≥ 0（左鰭順時針、右鰭逆時針 = 往外抬，不往肚子裡壓），兩邊相位稍微錯開才不會像機器
      const awake = 1 - sleep * 0.7;
      const flap = happy * 3 * (1 + Math.sin((t * Math.PI * 2) / 0.45));
      const wiggle = 2.5 + 2.5 * Math.sin((t * Math.PI * 2) / 0.5);
      const handL = clamp(p.handL || 0, 0, 1);
      const handR = clamp(p.handR || 0, 0, 1);
      const liftL = (0.75 + 0.75 * Math.sin((t * Math.PI * 2) / 3.1) + flap + surprised * 4 + handL * wiggle) * awake;
      const liftR = (0.75 + 0.75 * Math.sin((t * Math.PI * 2) / 3.1 + 1.3) + flap + surprised * 4 + handR * wiggle) * awake;
      this.el.flipperL.setAttribute('transform', `rotate(${fmt(liftL)} ${FLIPPER_L.x} ${FLIPPER_L.y})`);
      this.el.flipperR.setAttribute('transform', `rotate(${fmt(-liftR)} ${FLIPPER_R.x} ${FLIPPER_R.y})`);

      // 眼睛：眨眼縮成一條線；驚訝放大；開心換成笑眼；眼珠順著轉頭方向微移
      const eyeScale = 1 + surprised * 0.3; // 放大後仍要在 eye-patches 的遮色塊範圍內
      const blinkL = clamp(Math.max(p.blinkL, sleep), 0, 1);
      const blinkR = clamp(Math.max(p.blinkR, sleep), 0, 1);
      const openL = Math.max(0.05, 1 - blinkL);
      const openR = Math.max(0.05, 1 - blinkR);
      const look = `translate(${fmt(yaw * 8)} ${fmt(pitch * 5)}) `; // 眼珠再順著方向多看一點
      this.el.eyeLOpen.setAttribute('transform', look + scaleAround(EYE_L.x, EYE_L.y, eyeScale, openL * eyeScale));
      this.el.eyeROpen.setAttribute('transform', look + scaleAround(EYE_R.x, EYE_R.y, eyeScale, openR * eyeScale));
      const happyEyes = happy * (1 - sleep);
      this.el.eyeLOpen.setAttribute('opacity', fmt(1 - happyEyes));
      this.el.eyeROpen.setAttribute('opacity', fmt(1 - happyEyes));
      this.el.eyeLClosed.setAttribute('opacity', fmt(smoothstep(0.55, 0.95, blinkL) * (1 - happyEyes)));
      this.el.eyeRClosed.setAttribute('opacity', fmt(smoothstep(0.55, 0.95, blinkR) * (1 - happyEyes)));
      this.el.eyeLHappy.setAttribute('opacity', fmt(happyEyes));
      this.el.eyeRHappy.setAttribute('opacity', fmt(happyEyes));

      // 嘴巴：張嘴量控制嘴型大小，閉嘴時完全隱藏（露出底圖的微笑）
      const jaw = clamp(p.jaw * (1 - sleep), 0, 1);
      const openAmt = smoothstep(0.05, 0.3, jaw);
      this.el.mouthOpen.setAttribute('opacity', fmt(openAmt));
      const mw = lerp(0.7, 1.15, jaw) * (1 - surprised * 0.15);
      const mh = Math.max(0.05, jaw) * (1 + surprised * 0.35);
      this.el.mouthOpen.setAttribute('transform', scaleAround(MOUTH_TOP.x, MOUTH_TOP.y, mw, mh));

      // 腮紅：底圖已有淡淡的，笑的時候再疊一層
      this.el.blush.setAttribute('opacity', fmt(0.7 * Math.max(p.smile, happy)));

      // 反應符號：睡著的 zzz 會漂浮，驚訝的 ! 會跳動
      const zzzFloat = Math.sin((t * Math.PI * 2) / 2.2) * 8;
      this.el.zzz.setAttribute('opacity', fmt(sleep));
      this.el.zzz.setAttribute('transform', `translate(0 ${fmt(-zzzFloat)})`);
      const pop = 1 + surprised * 0.15 * Math.sin(t * 18);
      this.el.exclaim.setAttribute('opacity', fmt(surprised));
      this.el.exclaim.setAttribute('transform', scaleAround(EXCLAIM.x, EXCLAIM.y, pop, pop));
    }
  }

  global.SealRig = SealRig;
})(window);
