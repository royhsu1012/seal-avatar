/* rig.js — 把追蹤參數套用到 SVG 海豹上。
 *
 * 輸入參數 p：
 *   yaw     -1..1   左右轉頭（正值 = 朝畫面右邊）
 *   pitch   -1..1   上下點頭（正值 = 往下看）
 *   roll    度數    頭部側傾（正值 = 順時針）
 *   blinkL  0..1    畫面左邊那隻眼睛的閉合程度（1 = 全閉）
 *   blinkR  0..1    畫面右邊那隻眼睛的閉合程度
 *   jaw     0..1    張嘴程度
 *   smile   0..1    笑容程度
 *   present boolean 目前是否偵測到臉
 *
 * 狀態 state（由 SealRig.classify 決定）：idle / talking / happy / surprised / sleep
 */
(function (global) {
  'use strict';

  // 與 index.html 裡的 SVG 座標對應，改圖時請同步修改
  const HEAD_CX = 300, HEAD_CY = 300, BASE_Y = 600;
  const EYE_L = { x: 232, y: 282 };
  const EYE_R = { x: 368, y: 282 };
  const MOUTH_TOP = { x: 300, y: 376 };
  const WHISKER_L = { x: 245, y: 360 };
  const WHISKER_R = { x: 355, y: 360 };
  const EXCLAIM = { x: 470, y: 150 };

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
        ears: $('ears'),
        features: $('features'),
        eyeLOpen: $('eye-left-open'),
        eyeROpen: $('eye-right-open'),
        eyeLHappy: $('eye-left-happy'),
        eyeRHappy: $('eye-right-happy'),
        mouthClosed: $('mouth-closed'),
        mouthOpen: $('mouth-open'),
        blush: $('blush'),
        whiskersL: $('whiskers-left'),
        whiskersR: $('whiskers-right'),
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
      if (p.jaw > 0.55 && p.smile < 0.3) return 'surprised';
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

      // 睡著時頭垂下、側傾
      const yaw = p.yaw * (1 - sleep);
      const pitch = lerp(p.pitch, 0.55, sleep);
      const roll = lerp(p.roll, 9, sleep);

      // 呼吸起伏 + 開心時的小彈跳（以脖子底部為支點）
      const breath = 1 + 0.012 * Math.sin((t * Math.PI * 2) / 3.6);
      const bounce = happy * 0.025 * Math.max(0, Math.sin((t * Math.PI * 2) / 0.5));
      this.el.avatar.setAttribute('transform', scaleAround(HEAD_CX, BASE_Y, 1 + bounce * 0.4, breath + bounce));

      // 頭：位移 + 側傾 + 轉頭時略為變窄，做出假 3D 感
      const hx = yaw * 32;
      const hy = pitch * 26;
      this.el.head.setAttribute(
        'transform',
        `translate(${fmt(hx)} ${fmt(hy)}) rotate(${fmt(roll)} ${HEAD_CX} ${HEAD_CY}) ` +
          scaleAround(HEAD_CX, HEAD_CY, 1 - Math.abs(yaw) * 0.06, 1)
      );
      // 耳朵反向小位移、五官同向大位移 → 視差深度
      this.el.ears.setAttribute('transform', `translate(${fmt(-yaw * 12)} 0)`);
      this.el.features.setAttribute('transform', `translate(${fmt(yaw * 44)} ${fmt(pitch * 32)})`);

      // 眼睛：眨眼縮成一條線；驚訝放大；開心換成笑眼
      const eyeScale = 1 + surprised * 0.18;
      const blinkL = clamp(Math.max(p.blinkL, sleep), 0, 1);
      const blinkR = clamp(Math.max(p.blinkR, sleep), 0, 1);
      const openL = Math.max(0.05, 1 - blinkL);
      const openR = Math.max(0.05, 1 - blinkR);
      this.el.eyeLOpen.setAttribute('transform', scaleAround(EYE_L.x, EYE_L.y, eyeScale, openL * eyeScale));
      this.el.eyeROpen.setAttribute('transform', scaleAround(EYE_R.x, EYE_R.y, eyeScale, openR * eyeScale));
      const happyEyes = happy * (1 - sleep);
      this.el.eyeLOpen.setAttribute('opacity', fmt(1 - happyEyes));
      this.el.eyeROpen.setAttribute('opacity', fmt(1 - happyEyes));
      this.el.eyeLHappy.setAttribute('opacity', fmt(happyEyes));
      this.el.eyeRHappy.setAttribute('opacity', fmt(happyEyes));

      // 嘴巴：張嘴量控制開口大小，閉嘴線條淡出
      const jaw = clamp(p.jaw * (1 - sleep), 0, 1);
      const openAmt = smoothstep(0.05, 0.3, jaw);
      this.el.mouthClosed.setAttribute('opacity', fmt(1 - openAmt));
      this.el.mouthOpen.setAttribute('opacity', fmt(openAmt));
      const mw = lerp(0.7, 1.15, jaw) * (1 - surprised * 0.15);
      const mh = Math.max(0.05, jaw) * (1 + surprised * 0.35);
      this.el.mouthOpen.setAttribute('transform', scaleAround(MOUTH_TOP.x, MOUTH_TOP.y, mw, mh));

      // 腮紅：平常淡淡的，笑的時候加深
      this.el.blush.setAttribute('opacity', fmt(0.3 + 0.6 * Math.max(p.smile, happy)));

      // 鬍鬚：待機時輕輕擺動，說話時抖一下
      const wig = Math.sin((t * Math.PI * 2) / 2.8) * 2 + jaw * Math.sin(t * 40) * 2;
      this.el.whiskersL.setAttribute('transform', `rotate(${fmt(wig)} ${WHISKER_L.x} ${WHISKER_L.y})`);
      this.el.whiskersR.setAttribute('transform', `rotate(${fmt(-wig)} ${WHISKER_R.x} ${WHISKER_R.y})`);

      // 反應符號：睡著的 zzz 會漂浮，驚訝的 ! 會跳動
      const zzzFloat = Math.sin((t * Math.PI * 2) / 2.2) * 6;
      this.el.zzz.setAttribute('opacity', fmt(sleep));
      this.el.zzz.setAttribute('transform', `translate(0 ${fmt(-zzzFloat)})`);
      const pop = 1 + surprised * 0.15 * Math.sin(t * 18);
      this.el.exclaim.setAttribute('opacity', fmt(surprised));
      this.el.exclaim.setAttribute('transform', scaleAround(EXCLAIM.x, EXCLAIM.y, pop, pop));
    }
  }

  global.SealRig = SealRig;
})(window);
