# Duck Hunt Gripball Party Mode Web

這是 MB01 Gripball 的 WebHID 版 Duck Hunt。

## 使用方式

1. 用 Chrome 或 Edge 開啟網站。
2. 連接一顆或多顆 Gripball。
3. 按「連接握力球」並在瀏覽器授權視窗選取 Gripball。
4. 按「開始遊戲」。**不用校正**：拿好球先不要按，它只花不到 1 秒讀一個靜止基準值就開始。
5. 啟動時第 1 顆會震 1 下、第 2 顆震 2 下，以此類推。
6. 畫面會依照 Gripball 數量產生對應數量的鴨子；甩動第 N 顆 Gripball 會射第 N 隻鴨子。

## 握力門檻（不校正）

按下去超過基準值 `QUICK_ENGAGE_FORCE`（目前 **3000** counts）就算「握住」，開始追蹤鴨子；
掉回一半以下才放開（hysteresis，避免手停在門檻附近時準心閃爍）。

這是固定門檻，取代了原本每顆球各自量程的三輪校正流程 —— 那個流程一個人要花約 20 秒，
而且球還在回彈時取樣就可能卡住。

**如果按到底都沒反應**，就是這顆球的量程碰不到 3000（目前唯一量過的那顆全力握約
1400 counts）。這時候不用改程式：開 tuning 面板把「追蹤啟動」調低即可，即時生效。
真的想用舊流程，面板上的「重新校正」還在。

面板三個相關數值：

| 欄位 | 意思 | 預設 |
| --- | --- | --- |
| 追蹤啟動 | 超過基準值多少算握住 | 3000 |
| 追蹤放開 | 掉到多少以下算放開 | 1500 |
| 追蹤全速 | 準心追到最快所需的力 | 4500 |

改過門檻的話 `localStorage` 會記住，key 是 `gripball-tuning-v3`（改門檻預設值時記得
一起改 key，不然舊瀏覽器存的舊值會蓋掉新預設，看起來像是沒生效）。

因為不校正，起始基準值可能量得不太準（例如上一次握完還在回彈時開始），所以遊戲中
`estimateGrip()` 會持續把基準值往靜止值拉回去。這個修正只在讀數**接近靜止**時才跑
（`engageForce * 0.15` 以內）：以前是只要低於門檻就跑，於是慢慢用力時基準值會跟著手往上爬，
門檻等於邊接近邊後退。門檻只有 60 的時候看不出來（一兩個取樣就過了），門檻是幾千就很明顯 ——
實測慢壓 3 秒要出到約 4019 counts 才過得了 3000 的門檻。`test_quick_start.js` 有守這件事。

## 空間音訊

鴨子的叫聲／慘叫／落地聲會依牠在畫面上的位置定位（建議戴耳機）。走的是實測人頭
HRIR 卷積：`assets/hrir/` 內是 344 個 48kHz stereo IR（方位角一圈 × 仰角
-15°/0°/+15°/+30°），每個音效播放當下挑最接近的角度做 convolution。另外有依距離
遞減高頻的低通（空氣吸收），讓遠近不只靠音量分辨。

瀏覽器不支援或 IR 還沒載到時，會自動退回內建的 `PannerNode` HRTF，不會沒聲音。

技術來源與更多細節見 `docs/SPATIAL_AUDIO.md`。

## 開發工具

```bash
# 改完 gripball_webhid.js 或 duck.gd.reference 之後，重新打包進 index.pck
python3 tools/patch_pck.py

# 測試（純 Node，不需要瀏覽器或 Godot）
node tools/test_source_vector.js   # 螢幕座標 → 左右定位
node tools/test_hrir_mapping.js    # 角度挑選，用 IR 實測的 ITD/ILD 當真值
node tools/test_spatial_graph.js   # Web Audio 節點圖與退回機制
node tools/test_hrir_loudness.js   # 音量補償（方向造成的 + 頻率造成的）
node tools/test_tracking_tone.js   # 準心追蹤音的音高／空間位置／收尾
node tools/test_quick_start.js     # 不校正的起始流程與固定門檻
node tools/test_calibration_release.js  # 舊的三輪校正流程（仍是備用路徑）
```

`test_quick_start.js` 會印出門檻的可達性警告：如果設定的門檻超過實測球的量程，它不會
讓測試失敗（門檻是 Pan 的決定），但會大聲印出來並建議一個數字。

`duck.gd.reference` 是 `res://scenes/duck.gd` 的來源檔（該檔只存在於 `index.pck`
裡），要改遊戲邏輯請改它再跑 `patch_pck.py`。

## GitHub Pages

Godot 4 Web export 需要 `SharedArrayBuffer`。GitHub Pages 不能直接設定 COOP/COEP headers，因此這份輸出包含 `coi-serviceworker.js`：

- 第一次進入頁面會註冊 service worker 並自動重新整理一次。
- 重新整理後遊戲會在 cross-origin isolated 狀態下啟動。

如果公司環境封鎖 service worker 或 WebHID，請改用最新版 Chrome/Edge，或用可設定 headers 的 hosting 服務部署。
