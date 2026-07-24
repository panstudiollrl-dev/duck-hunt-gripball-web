# Duck Hunt Gripball Party Mode Web

這是 MB01 Gripball 的 WebHID 版 Duck Hunt。

## 使用方式

1. 用 Chrome 或 Edge 開啟網站。
2. 連接一顆或多顆 Gripball。
3. 按「連接握力球」並在瀏覽器授權視窗選取 Gripball。
4. 啟動時第 1 顆會震 1 下、第 2 顆震 2 下，以此類推。
5. 畫面會依照 Gripball 數量產生對應數量的鴨子；甩動第 N 顆 Gripball 會射第 N 隻鴨子。

## GitHub Pages

Godot 4 Web export 需要 `SharedArrayBuffer`。GitHub Pages 不能直接設定 COOP/COEP headers，因此這份輸出包含 `coi-serviceworker.js`：

- 第一次進入頁面會註冊 service worker 並自動重新整理一次。
- 重新整理後遊戲會在 cross-origin isolated 狀態下啟動。

如果公司環境封鎖 service worker 或 WebHID，請改用最新版 Chrome/Edge，或用可設定 headers 的 hosting 服務部署。
