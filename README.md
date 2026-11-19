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
| `mode=tracker` | 追蹤頁：開攝影機追蹤，把參數送到本機伺服器 `/params` |
| `mode=viewer` | 顯示頁：不開攝影機，從 `/params` 取參數畫海豹。給 OBS 用 |
| `diag=1` | 診斷模式：每秒把追蹤數值寫一行到 `tools\serve.ps1` 的終端機，方便調整靈敏度。只送到本機伺服器 |

## 接進 OBS、直播與 Teams

網頁本身沒辦法變成一顆攝影機，Teams、Zoom、Meet 這類軟體只認得攝影機裝置。
免費開源的橋樑是 [OBS Studio](https://obsproject.com/)（GPL），它內建虛擬攝影機，本身也是直播軟體，
所以一條管線同時解決直播和視訊會議：

```
海豹網頁 → OBS（縮放、移動、換背景、合成） → 虛擬攝影機 → Teams / Zoom / Meet
                                            └→ 直播或錄影
```

### 追蹤頁與顯示頁

OBS 內建的瀏覽器**不給攝影機權限**（實測 OBS 33 會直接拒絕），所以在 OBS 裡不能用同一頁又追蹤又顯示。
做法是拆成兩頁，中間靠本機伺服器中繼參數：

```
Chrome / Edge 的追蹤頁 (?mode=tracker) ──攝影機追蹤──▶ 本機伺服器 /params ──▶ OBS 的顯示頁 (?mode=viewer)
```

- **追蹤頁**：開著就好，可以縮小、最小化或被其他視窗蓋住，背景時改由 Web Worker 計時器驅動，實測維持每秒 30 次追蹤。它會把頭部姿勢、眨眼、張嘴、笑容送到伺服器
- **顯示頁**：OBS 裡的瀏覽器來源，只畫海豹不碰攝影機，可以同時放好幾個（Teams 場景一個、直播疊圖一個）

### 一次設定

1. 安裝 OBS Studio：

   ```powershell
   winget install --id OBSProject.OBSStudio -e
   ```

2. 雙擊 `start-server.bat` 啟動本機伺服器（OBS 開著的期間要一直開著）。
3. 用 Chrome / Edge 開追蹤頁並允許攝影機，之後整場都讓它開著：

   ```
   http://localhost:8788/?mode=tracker&preview=1
   ```

4. 匯入現成的場景集合：OBS 上方選單列 → 場景集合 → 匯入 → 選 `obs\SealVTuber.json`，再從同一個選單切換到 SealVTuber。
   裡面有兩個場景：
   - **Teams 海豹**：1920×1080，海豹置中加柔和背景，給視訊會議用
   - **直播 疊圖**：透明背景的海豹縮小放在右下角，疊在一個深色佔位背景上。把佔位背景換成你的遊戲擷取或螢幕擷取就是直播畫面

   匯入失敗的話手動加：來源 → 加號 → 瀏覽器，網址填 `http://localhost:8788/?mode=viewer&bg=soft&ui=0`，寬 1920 高 1080。
   疊圖版網址改成 `bg=transparent`，寬高都填 1080。

瀏覽器來源也可以勾「本機檔案」選 `obs\teams.html` 或 `obs\overlay.html`，它們會轉跳到對應的顯示頁網址。

### 縮放與移動

在 OBS 預覽畫面裡直接拖曳海豹就能移動，拉角落的紅點就能縮放，按住 Alt 拖邊緣可以裁切。
右鍵 → 變換 → 編輯變換可以輸入精確數字。每個場景可以放不同大小位置的海豹。

### 接進 Teams

1. OBS 右下角「控制項」→ 開始虛擬攝影機
2. Teams → 設定 → 裝置 → 攝影機 → 選「OBS Virtual Camera」。第一次可能要重開 Teams 才看得到
3. 之後開會時 Teams 的鏡頭就是 OBS 目前的場景，切場景就切畫面

### 如果海豹在 OBS 裡不動

- 先確認追蹤頁還開著、伺服器還在跑。顯示頁 3 秒收不到資料海豹就會睡著
- 追蹤頁看得到你嗎？離開鏡頭範圍或光線太暗時會變成睡覺狀態
- 完全不想用兩頁的話，也可以用視窗擷取：Chrome 開 `http://localhost:8788/?bg=green&ui=0&autostart=1`，OBS 新增「視窗擷取」選那個視窗，再加「色度鍵」濾鏡選綠色

## 桌面浮動視窗（桌寵模式）

想讓海豹直接浮在 Windows 桌面最上層、疊在任何軟體上面，不經過 OBS 也看得到，用 `desktop/` 裡的
[Electron](https://www.electronjs.org/)（MIT）版本。它就是同一個網頁包進一個透明、無邊框、永遠置頂的視窗：

- 海豹本體直接拖著走；右下角握把、Ctrl + 滾輪縮放
- 永遠在最上層、滑鼠穿透（點擊落到下面的視窗）都可以開關
- 內建一台和 `start-server.bat` 一樣的本機伺服器，所以 OBS 裡的顯示頁（`?mode=viewer`）同時照常動；
  `start-server.bat` 已經在跑的話就直接沿用那台，不會衝突
- 其他視窗取得焦點、甚至把海豹蓋住，追蹤仍然繼續
- 視窗位置、大小與各種開關會記住，下次啟動還原

### 安裝與啟動

只是要用的話不需要 Node：直接執行打包好的安裝版 `SealVTuber-<版本>-Setup.exe`（見下方「打包成安裝版與可攜版 exe」），
裝好後從開始功能表或桌面捷徑「海豹 VTuber」啟動即可。

自己跑原始碼或打包時才需要 [Node.js](https://nodejs.org/) LTS：

```powershell
winget install OpenJS.NodeJS.LTS
```

這會跳出一次管理員權限確認。沒有管理員權限的話，到 nodejs.org 下載「Windows Binary (.zip)」，
解壓到例如 `%LOCALAPPDATA%\Programs\nodejs`，再把那個資料夾加進使用者的 PATH 即可。

然後在專案目錄：

```powershell
cd desktop
npm install
npm start
```

第一次 `npm install` 會下載 Electron（約 100 MB）。`npm start` 之後海豹出現在主螢幕右下角，自動開攝影機並校正。
關掉這個終端機視窗海豹也會跟著關，想長期用請打包成 exe（見下）。

攝影機一次只能給一個程式用：如果 Chrome 的追蹤頁（`?mode=tracker`）還開著，桌面版會顯示
「無法開啟攝影機：NotReadableError」（系統匣圖示會跳通知）。先關掉 Chrome 那一頁，再從選單打開控制面板按「啟動攝影機」，
或直接重新啟動桌面版。

### 操作

| 動作 | 方式 |
|---|---|
| 移動 | 直接拖曳海豹 |
| 縮放 | 拖右下角的握把、Ctrl + 滾輪、Ctrl + `=` / Ctrl + `-`；Ctrl + 0 回到預設大小位置 |
| 選單 | 在海豹上按右鍵，或右下角系統匣的海豹圖示 |
| 永遠在最上層 | 選單勾選，或 Ctrl + T |
| 滑鼠穿透 | 選單勾選，或 Ctrl + P。開啟後點擊會穿過海豹落到下面的視窗，所以要關掉請用系統匣選單 |
| 控制面板 | 選單「顯示控制面板」或按 H。校正、鏡像、攝影機縮圖都在面板上 |
| 重新校正正面 | 選單，或 C |
| 隱藏 / 顯示海豹 | 點一下系統匣圖示（隱藏時攝影機仍在追蹤，OBS 不會斷） |
| 結束 | 選單「結束」或 Ctrl + Q |

網頁本身的快捷鍵（H、C、D、M、V）在視窗有焦點時照常可用。系統匣圖示的提示文字會顯示目前的追蹤狀態，
攝影機開不起來時會跳通知。

### 同時給 OBS 用

桌面版本身就是追蹤頁，不用再另外開瀏覽器的追蹤頁。OBS 顯示頁的網址照舊
`http://localhost:8788/?mode=viewer&bg=transparent&ui=0`，選單裡有「複製 OBS 顯示頁網址」。

### 連接埠

預設 8788，和 `start-server.bat` 相同。埠被別的程式佔用時會跳出提示，可以改用別的埠（OBS 顯示頁網址也要跟著改）：

```powershell
npm start -- --port=8790
```

### 打包成安裝版與可攜版 exe

```powershell
cd desktop
npm run dist
```

會在 `desktop\dist\` 產出兩個檔案，拿到任何 Windows 10/11 電腦都能用（執行時需要網路載入追蹤模型，與網頁版相同）：

| 檔案 | 用途 |
|---|---|
| `SealVTuber-0.1.0-Setup.exe` | **安裝版**，平常使用建議用這個。只裝給目前使用者、不需要管理員權限，可以選安裝資料夾，會建立開始功能表與桌面捷徑「海豹 VTuber」，要移除時到「設定 → 應用程式」解除安裝。安裝後啟動很快。 |
| `SealVTuber-0.1.0-portable.exe` | **可攜版**，單一檔案、不用安裝，適合放隨身碟或暫時試用。每次啟動會先解壓到暫存資料夾，所以開得比較慢。 |

兩個版本共用同一份設定（視窗位置、開關狀態存在 `%APPDATA%\SealVTuber`），不會互相干擾。
exe 沒有數位簽章（正式簽章要付費購買憑證），第一次執行時 Windows SmartScreen 可能顯示「Windows 已保護您的電腦」，
按「其他資訊」→「仍要執行」即可。打包工具是 [electron-builder](https://www.electron.build/)（MIT）。

換了正式繪圖之後，執行 `npm run icons` 會從 `index.html` 的海豹 SVG 重新產生 `desktop\assets\icon.png`（exe 與視窗圖示）
和 `tray.png`（系統匣圖示）。

### 檔案

```
desktop/package.json        相依與 electron-builder 打包設定
desktop/main.js             主程序：視窗、系統匣與右鍵選單、狀態存檔
desktop/preload.js          注入網頁的桌面層：拖曳區 class、縮放握把、狀態回報
desktop/server.js           內建靜態伺服器與 /params、/diag（同 tools/serve.ps1）
desktop/tools/make-icon.js  從海豹圖產生圖示（底圖換成 PNG 後尚未重新產生，圖示仍是舊造型）
desktop/assets/             icon.png、tray.png
```

網頁端只有 `css/style.css` 多了一段 `html.desktop` 規則；`index.html` 與 `js/` 完全不知道自己在 Electron 裡。

## 角色圖怎麼做的、怎麼換

角色是 **一張去背的 PNG 底圖**（`art/seal.png`，1024 × 1024）加上 `index.html` 裡疊在臉上的幾個向量圖層：

- **眼睛**：`eye-patches` 先用毛色的小色塊蓋住底圖畫好的眼睛，再用向量畫一對一樣的眼睛。
  這樣才能眨眼（垂直壓扁）、眼珠跟著轉頭微移、驚訝放大、開心換成笑眼。
- **嘴巴**：底圖本身是閉嘴微笑；張嘴時才疊一個嘴型在吻部上，依張嘴量從上緣往下拉開。
- **腮紅**：底圖已經有，開心時再疊一層加深。
- **zzz / !**：睡覺與驚訝的符號。

頭轉、點頭、側傾是整張圖一起位移、旋轉、略微壓扁，疊圖層跟著整張圖動才不會對不準。

程式只靠 **圖層 id** 找東西，換圖時保留這些 id：

| id | 內容 | 程式會做的事 |
|---|---|---|
| `avatar` | 整隻角色 | 呼吸起伏、開心彈跳 |
| `head` | 底圖 + 所有疊圖層 | 跟著 yaw / pitch / roll 移動旋轉 |
| `eye-left-open` `eye-right-open` | 張開的眼睛 | 眨眼時垂直壓扁，開心時淡出，眼珠微移 |
| `eye-left-closed` `eye-right-closed` | 閉眼線條 | 眼睛快閉上時淡入 |
| `eye-left-happy` `eye-right-happy` | 笑眼 | 開心時淡入 |
| `mouth-open` | 張開的嘴（含舌頭） | 依張嘴量從上緣往下拉開 |
| `blush` | 加深用的腮紅 | 笑的時候淡入 |
| `zzz` `exclaim` | 反應符號 | 睡覺 / 驚訝時出現 |

「左 / 右」一律指 **畫面上** 的左右。

### 換一張底圖的步驟

1. 準備正面、坐姿、嘴閉眼開、純綠色背景的圖（生圖工具的提示詞可參考：front view, sitting, eyes open,
   mouth closed, solid green background #3CB371, nothing cropped）。
2. 放到 `art/src/`，用 `tools/chroma-key.html` 去背成透明 PNG（伺服器開著時）：

   ```powershell
   chrome --headless=new --default-background-color=00000000 --window-size=1024,1024 --screenshot=art\seal.png "http://localhost:8788/tools/chroma-key.html?src=../art/src/你的圖.webp"
   ```

   邊緣有綠邊就把網址加上 `&hi=170` 之類調低門檻。
3. 量出新圖的眼睛中心、嘴巴上緣、腮紅位置（座標系就是圖片像素），改 `index.html` 裡疊圖層的座標，
   以及 `js/rig.js` 最上面的常數（`EYE_L`、`EYE_R`、`MOUTH_TOP` 等）。
4. `eye-patches` 的顏色改成新圖眼睛旁邊的毛色，大小要蓋得住原本畫好的眼睛。

目前這張底圖是用生圖工具依參考圖產生的，原始檔在 `art/src/seal.webp`。
注意用 file:// 開啟時 Chrome 會擋外部圖片，請一律用本機伺服器。

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
index.html          頁面、控制面板、角色（PNG 底圖 + 疊圖層）
art/seal.png        去背後的角色底圖
art/src/            底圖的原始檔
css/style.css       版面與背景模式
js/rig.js           SealRig：參數 → 位移、變形與反應
js/app.js           攝影機、MediaPipe、參數計算、平滑、主迴圈
start-server.bat    雙擊啟動本機伺服器
tools/serve.ps1     零相依的本機靜態伺服器
tools/chroma-key.html 綠底去背工具（配合無頭 Chrome 輸出透明 PNG）
obs/SealVTuber.json 可匯入 OBS 的場景集合（Teams 全畫面 + 直播疊圖）
obs/teams.html      給 OBS 本機檔案模式用的轉跳頁
obs/overlay.html    同上，透明背景版
desktop/            桌面浮動視窗（Electron），見上面「桌面浮動視窗」一節
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

已驗證：造型渲染、五種反應、真人攝影機追蹤方向正確且 50～60 fps、追蹤頁在背景時維持 30 fps、
OBS 顯示頁接收參數、OBS 虛擬攝影機進 Teams、在 OBS 裡縮放移動海豹。
OBS 的瀏覽器來源確定不給攝影機權限，所以一定要用追蹤頁加顯示頁的方式。

桌面浮動視窗（Electron）已驗證：透明置頂、拖曳、握把與 Ctrl + 滾輪縮放、右鍵選單、置頂與滑鼠穿透開關、
失去焦點時仍維持 60 fps 繪製、位置大小還原、沿用 `start-server.bat` 的伺服器。
桌面版裡的真人攝影機追蹤也已實測：Electron 自己開攝影機，追蹤資料 30 fps、方向正確，OBS 顯示頁同步跟動。
注意同一台電腦同一時間只能開一個追蹤頁（Chrome 的 `?mode=tracker` 分頁或桌面版其中之一），
後開的那個會拿不到攝影機。

正式造型已換成生圖工具產生、去背後的白海豹寶寶 PNG，五種反應都已在瀏覽器裡用疊圖層驗證；
真人攝影機追蹤與 OBS、桌面版在新造型下的實測待補。桌面版的安裝檔與可攜版要重新執行 `npm run dist` 才會包進新底圖。

接下來可以做：

- 桌面版重新打包、圖示換成新造型
- 眼珠跟著視線移動
- 更多表情（皺眉、嘟嘴、挑眉）
- 用音量輔助嘴型，說話更自然

## 授權

MIT，見 [LICENSE](LICENSE)。
