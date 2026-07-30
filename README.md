# Duck Hunt Gripball Party Mode Web

這是 MB01 Gripball 的 WebHID 版 Duck Hunt。

## 使用方式

1. 用 Chrome 或 Edge 開啟網站。
2. 連接一顆或多顆 Gripball。
3. 按「連接握力球」並在瀏覽器授權視窗選取 Gripball。
4. 啟動時第 1 顆會震 1 下、第 2 顆震 2 下，以此類推。
5. 畫面會依照 Gripball 數量產生對應數量的鴨子；甩動第 N 顆 Gripball 會射第 N 隻鴨子。

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
```

`duck.gd.reference` 是 `res://scenes/duck.gd` 的來源檔（該檔只存在於 `index.pck`
裡），要改遊戲邏輯請改它再跑 `patch_pck.py`。

## GitHub Pages

Godot 4 Web export 需要 `SharedArrayBuffer`。GitHub Pages 不能直接設定 COOP/COEP headers，因此這份輸出包含 `coi-serviceworker.js`：

- 第一次進入頁面會註冊 service worker 並自動重新整理一次。
- 重新整理後遊戲會在 cross-origin isolated 狀態下啟動。

如果公司環境封鎖 service worker 或 WebHID，請改用最新版 Chrome/Edge，或用可設定 headers 的 hosting 服務部署。
