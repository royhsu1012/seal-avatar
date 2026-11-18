# 海豹 VTuber MVP

一隻會跟著你動的 2D 海豹。用網路攝影機追蹤臉部，海豹的頭會跟著轉、眨眼、張嘴說話，
笑的時候會瞇眼害羞，張大嘴會驚訝，你離開鏡頭太久牠就睡著。

整個專案是一個靜態網頁，沒有後端、不用安裝、不上傳任何影像。
所有用到的東西都是開源免費的：

| 元件 | 用途 | 授權 |
|---|---|---|
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) Face Landmarker | 臉部 478 個特徵點與 52 個 blendshape | Apache-2.0 |
| 瀏覽器內建 SVG | 角色繪製與動畫 | 無 |
| 本專案 | 追蹤到造型的對應、反應邏輯、OBS 用的背景切換 | MIT |

> 目前是 **MVP 階段**：角色用幾何圖形拼成佔位造型，目的是驗證「攝影機追蹤 → 驅動 2D 角色」這條路可行。
> 美術之後可以整隻換掉，程式不用大改。

## 功能

- 頭部左右轉、上下點、側傾，五官有視差做出假 3D 感
- 左右眼獨立眨眼
- 張嘴說話，嘴巴大小跟著嘴型
- 表情自動反應，不用按任何鍵：
  - 微笑 → 笑眼、腮紅加深、輕輕彈跳
  - 張大嘴 → 眼睛放大、圓嘴、冒出驚嘆號
  - 3 秒沒看到臉 → 閉眼、低頭、zzz
  - 待機時會呼吸起伏、鬍鬚輕擺
- 背景一鍵切換：柔和 / 綠幕 / 藍幕 / 透明，給 OBS 用
- 示範模式：沒有攝影機也能看到所有反應

## 需求

- Chrome 或 Edge（需要 WebGL 與 WebAssembly）
- 網路攝影機
- 第一次執行需要網路，會從 CDN 下載追蹤模型（約 4 MB），之後瀏覽器會快取

## 快速開始

### 方法一：本機伺服器（建議）

雙擊 `start-server.bat`。它用 Windows 內建的 PowerShell 跑一個小伺服器，不需要安裝任何東西。
想用指令的話：

```powershell
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

然後用瀏覽器開 <http://localhost:8788/>，按「啟動攝影機」並允許權限。

有 Python 或 Node 的話，任何靜態伺服器都可以，例如 `python -m http.server 8788`。

### 方法二：直接雙擊 index.html

在 Chrome / Edge 通常可以直接開啟。如果出現「模型載入失敗」，請改用方法一。

## 操作

| 控制 | 快捷鍵 | 說明 |
|---|---|---|
| 啟動 / 停止攝影機 | | 第一次會要求攝影機權限 |
| 校正正面 | C | 取接下來約 1.2 秒的平均姿勢當成正面，同時量測睜眼基準值。啟動攝影機後第一次看到臉會自動校正一次，所以按下按鈕後請先看著鏡頭兩秒；換了坐姿再按 C 重校 |
| 示範模式 | D | 不用攝影機，輪流演示平常 → 說話 → 開心 → 驚訝 → 睡覺 |
| 鏡像 | M | 預設開啟，像照鏡子一樣。關掉會變成觀眾視角 |
| 顯示攝影機畫面 | V | 右下角顯示攝影機縮圖，方便對位 |
| 隱藏面板 | H | 直播時把控制面板藏起來 |

網址參數可以組合使用，例如 `index.html?bg=green&ui=0&autostart=1`：

| 參數 | 說明 |
|---|---|
| `bg=soft` `green` `blue` `transparent` | 背景 |
| `ui=0` | 隱藏控制面板 |
| `autostart=1` | 載入後自動啟動攝影機 |
| `demo=1` | 直接進入示範模式 |
| `mirror=0` | 關閉鏡像 |
| `preview=1` | 顯示攝影機縮圖 |
| `diag=1` | 診斷模式：每秒把追蹤數值寫一行到 `tools\serve.ps1` 的終端機，方便調整靈敏度。只送到本機伺服器 |

## 接進 OBS、直播與 Teams

網頁本身沒辦法變成一顆攝影機，Teams、Zoom、Meet 這類軟體只認得攝影機裝置。
免費開源的橋樑是 [OBS Studio](https://obsproject.com/)（GPL），它內建虛擬攝影機，本身也是直播軟體，
所以一條管線同時解決直播和視訊會議：

```
海豹網頁 → OBS（縮放、移動、換背景、合成） → 虛擬攝影機 → Teams / Zoom / Meet
                                            └→ 直播或錄影
```

### 一次設定

1. 安裝 OBS Studio：

   ```powershell
   winget install --id OBSProject.OBSStudio -e
   ```

2. 雙擊 `start-server.bat` 啟動本機伺服器（OBS 開著的期間要一直開著）。
3. 匯入現成的場景集合：OBS 選單 → 場景集合 → 匯入 → 選 `obs\SealVTuber.json`，再從場景集合選單切換到 SealVTuber。
   裡面有兩個場景：
   - **Teams 海豹**：1920×1080，海豹置中加柔和背景，給視訊會議用
   - **直播 疊圖**：透明背景的海豹縮小放在右下角，疊在一個深色佔位背景上。把佔位背景換成你的遊戲擷取或螢幕擷取就是直播畫面

   匯入失敗的話手動加：來源 → 加號 → 瀏覽器，網址填 `http://localhost:8788/?bg=soft&ui=0&autostart=1`，寬 1920 高 1080。
   疊圖版網址改成 `bg=transparent`，寬高都填 1080。

4. 放進 OBS 後頁面會自動隱藏面板並啟動攝影機，第一次看到臉會自動校正，請先看著鏡頭兩秒。

不想開伺服器的話，瀏覽器來源可以勾「本機檔案」，選 `obs\teams.html` 或 `obs\overlay.html`，
這兩頁會自動帶參數轉跳到 `index.html`。

### 縮放與移動

在 OBS 預覽畫面裡直接拖曳海豹就能移動，拉角落的紅點就能縮放，按住 Alt 拖邊緣可以裁切。
右鍵 → 變換 → 編輯變換可以輸入精確數字。每個場景可以放不同大小位置的海豹。

### 接進 Teams

1. OBS 右下角「控制項」→ 開始虛擬攝影機
2. Teams → 設定 → 裝置 → 攝影機 → 選「OBS Virtual Camera」。第一次可能要重開 Teams 才看得到
3. 之後開會時 Teams 的鏡頭就是 OBS 目前的場景，切場景就切畫面

### 如果海豹在 OBS 裡不動

OBS 的瀏覽器來源沒有權限提示視窗。如果狀態卡在「無法開啟攝影機」，表示你的 OBS 版本沒有放行攝影機，請改用視窗擷取：

1. 用 Chrome / Edge 開啟頁面，背景選「綠幕」，按 H 隱藏面板，視窗不要最小化
2. OBS 新增來源 → 視窗擷取，選那個瀏覽器視窗
3. 對該來源加「色度鍵」濾鏡，顏色選綠色

## 換成你自己的圖

角色就是 `index.html` 裡的一段 SVG，程式只靠 **圖層 id** 找東西。
保留下面這些 id，裡面的形狀、顏色、數量都可以隨意換：

| id | 內容 | 程式會做的事 |
|---|---|---|
| `avatar` | 整隻角色 | 呼吸起伏、開心彈跳 |
| `head` | 整顆頭 | 跟著 yaw / pitch / roll 移動旋轉 |
| `ears` | 耳朵 | 轉頭時反向小位移（深度感） |
| `features` | 五官群組 | 轉頭時同向大位移（視差） |
| `eye-left-open` `eye-right-open` | 張開的眼睛 | 眨眼時垂直壓扁，開心時淡出 |
| `eye-left-happy` `eye-right-happy` | 笑眼 | 開心時淡入 |
| `mouth-closed` | 閉嘴線條 | 張嘴時淡出 |
| `mouth-open` | 張開的嘴（含舌頭） | 依張嘴量從上緣往下拉開 |
| `blush` | 腮紅 | 笑的時候加深 |
| `whiskers-left` `whiskers-right` | 鬍鬚 | 待機擺動、說話抖動 |
| `zzz` `exclaim` | 反應符號 | 睡覺 / 驚訝時出現 |

「左 / 右」一律指 **畫面上** 的左右。

座標系是 600 × 600。如果你改了眼睛或嘴巴的位置，請同步修改 `js/rig.js` 最上面的常數
（`EYE_L`、`EYE_R`、`MOUTH_TOP` 等），眨眼和張嘴才會以正確的點為中心縮放。

要用點陣圖（PNG）的話，把對應圖層換成 `<image href="..." />` 即可，id 一樣放在包住它的 `<g>` 上。
注意用 file:// 開啟時 Chrome 可能擋外部圖片，這種情況請用本機伺服器。

## 調整靈敏度

`js/app.js` 最上面的 `TUNING` 物件集中了所有可調參數：

- `blink` / `jaw` / `smile`：blendshape 分數對應到 0～1 的區間，覺得太敏感就把 `lo` 調高。`blink` 是相對於校正時量到的睜眼基準值
- `autoCalibrate` / `calibrationMs`：是否在啟動後自動校正、校正取樣多久
- `yawGain` / `pitchGain`：轉頭幅度
- `follow`：平滑速度，數字越大越跟手、越小越柔
- `sleepAfterMs`：多久沒看到臉進入睡覺

不用改檔案也能試：開瀏覽器主控台（F12），直接改 `sealVTuber.TUNING.yawGain = 3`，立即生效。
`sealVTuber.pause(true)` 之後可以自己呼叫 `sealVTuber.rig.apply(參數, 0.1, '狀態')` 測試造型。

## 專案結構

```
index.html          頁面、控制面板、海豹 SVG
css/style.css       版面與背景模式
js/rig.js           SealRig：參數 → SVG 變形與反應
js/app.js           攝影機、MediaPipe、參數計算、平滑、主迴圈
start-server.bat    雙擊啟動本機伺服器
tools/serve.ps1     零相依的本機靜態伺服器
obs/SealVTuber.json 可匯入 OBS 的場景集合（Teams 全畫面 + 直播疊圖）
obs/teams.html      給 OBS 本機檔案模式用的轉跳頁
obs/overlay.html    同上，透明背景版
```

## 運作原理

1. `getUserMedia` 取得攝影機畫面
2. MediaPipe Face Landmarker 在瀏覽器內（GPU 或 WASM）算出臉部特徵點與 blendshape
3. 由鼻尖相對臉頰中點算 yaw、相對額頭到上唇區間算 pitch（不用下巴，張嘴才不會誤判成抬頭），由兩眼連線角度算 roll
4. 從 blendshape 取 `eyeBlinkLeft/Right`、`jawOpen`、`mouthSmileLeft/Right`
5. 指數平滑後交給 `SealRig`，用 SVG `transform` 與 `opacity` 畫出來
6. 依 smile / jaw / 多久沒看到臉判斷狀態，驅動對應反應

影像完全在你的電腦裡處理，不會送到任何伺服器。

## 目前狀態與下一步

已驗證：造型渲染、五種反應、極限角度、眨眼與說話、模型從 CDN 載入、真人攝影機追蹤方向正確且 50～60 fps。
尚未驗證：OBS 瀏覽器來源的攝影機權限、OBS 虛擬攝影機在 Teams 裡的顯示。

接下來可以做：

- 桌面浮動視窗：把網頁包成透明置頂的小程式（Tauri 或 Electron），海豹像桌寵一樣浮在任何軟體上面、可拖曳縮放
- 換上正式繪圖
- 眼珠跟著視線移動
- 更多表情（皺眉、嘟嘴、挑眉）
- 用音量輔助嘴型，說話更自然

## 授權

MIT，見 [LICENSE](LICENSE)。
