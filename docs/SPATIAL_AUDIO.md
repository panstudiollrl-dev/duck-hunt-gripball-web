# 空間音訊：實測 HRIR 卷積

鴨子的聲音怎麼被定位到畫面上的位置。技術來源是 SonicSquid
（`github.com/breampan/SonicSquid`，同一位作者的另一個空間音訊專案），
資料集是本專案自己的 `assets/hrir/`。

## 訊號鏈

```
mono buffer → envelope gain → airFilter(lowpass) → convolver(HRIR) → gain → master
                                                 ↘ 退回：PannerNode(HRTF)
```

1. **單聲道化**：來源音效先攤平成 mono。立體聲來源會讓 HRIR 的左右耳資訊被原本的
   立體聲影像汙染。
2. **airFilter（空氣吸收）**：距離越遠、高頻濾掉越多（16kHz → 下限 1200Hz）。
   來源是 SonicSquid `G02.html` 的 `DraggableSound.airFilter`。加這個的理由是
   「只靠音量變小」很難聽出遠近 —— 變小聲容易被誤認成別的音效，變悶才會被聽成變遠。
3. **convolver（HRIR）**：拿最接近角度的實測 IR 做卷積。`normalize = false`
   ——IR 本身就帶著正確的雙耳音量差（ILD），讓瀏覽器正規化會把我們要的線索抹平。
4. **退回 PannerNode**：資料集載入失敗、或該角度的 IR 還沒 decode 完時，走瀏覽器
   內建的 HRTF panner。**永遠不會因為 IR 沒到就沒聲音。**

## 資料集

`assets/hrir/`：344 個檔案，48kHz / float32 / stereo / 256 taps（5.3ms）。
命名 `ir_azi{方位角}_ele{仰角}.wav`，仰角負值寫成 `eleM015`。

| 仰角 | 方位角數量 |
|---|---|
| +30° | 78 |
| +15° | 88 |
| 0° | 90 |
| -15° | 88 |

方位角在正面附近密（2~3° 一格），側面較疏（5° 一格）。仰角只取 4 層是刻意的：
仰角的聽覺辨識度本來就遠低於方位角，而且鴨子只出現在畫面上半到中段。

完整資料集（1551 檔、23 個仰角層）沒有進 repo，見 `.gitignore` 的 `hrir_wavs/`。
要加仰角層的話從那裡撈。

## 座標對應

```
螢幕左邊 (lateral -1) → 方位角 90°  → 左耳
螢幕正中 (lateral  0) → 方位角  0°  → 正前方
螢幕右邊 (lateral +1) → 方位角 270° → 右耳
```

**這個資料集的方位角是逆時針增加的**，所以螢幕右邊要對到 270°，不是 90°。
這件事是量出來的、不是猜的：`ir_azi090_ele000.wav` 的左耳峰值比右耳早 28 個 sample
到、RMS 高 20.4dB，所以 90° 是左耳。`tools/test_hrir_mapping.js` 直接讀 IR 量
ITD/ILD 當真值，所以如果哪天換了資料集而慣例相反，測試會抓到。

只用正面 ±90° 這段弧：鴨子在螢幕上（在前方），不會在腦後。

方位角查最近角度時要處理繞圈：358° 距離 2° 只有 4°。直接取絕對值差會在正面附近
挑到頭的另一邊，所以 `nearestAzimuth()` 用 `min(|a-b|, 360-|a-b|)`。

## 為什麼不做 A/B convolver 交叉淡化

SonicSquid 的 `G07_Binamix` 有一套雙 convolver crossfade，用來避免音源移動、切換 IR
角度時的爆音。**這裡不需要**：quack / scream / drop 都是一次性短音效，播放當下算好
角度、建一個 convolver、播完就丟。角度不會在播放中途改變，所以沒有需要淡化的接縫。

真的需要 crossfade 的情境是「持續發聲的音源在移動」。之後如果要做「準心追蹤鴨子時
的連續 pitch bend」那類效果，就會需要，屆時照 `G07_Binamix/src/App.jsx` 的
`updateSpatialPosition()` 抄（`fadeTime` 0.05~0.1 秒）。

## 載入策略

IR 檔不預載全部（344 個，即使只有 707KB 也沒必要）：

- 啟動只抓 `manifest.json`（約 17KB）。
- 第一次使用者互動（pointerdown / keydown，AudioContext 要有手勢才能開）後，
  背景預熱畫面上一片粗略的角度（約 30 個檔），讓第一隻鴨子就用得到真 HRIR。
- 其餘角度用到才抓，抓過就 cache。
- `spatialize()` **不會等網路** —— IR 還沒 decode 好就先用 PannerNode 播，
  同時在背景把它抓下來給下一次用。寧可退回也不要延遲出聲。

## 增益補償

Convolution 之後普遍偏小聲（`HRIR_BOOST = 1.8`），而且 convolver 自己沒有距離衰減
模型，所以照 PannerNode 那條路的參數（refDistance 1 / rolloff 0.45）手算一份
inverse rolloff 補上，兩條路的音量才不會在退回時忽大忽小。
`tools/test_spatial_graph.js` 有驗這件事。

## 測試

```bash
node tools/test_source_vector.js   # 螢幕座標 → lateral/vertical（含 letterbox 情況）
node tools/test_hrir_mapping.js    # 角度挑選正確性，真值來自 IR 實測 ITD/ILD
node tools/test_spatial_graph.js   # 節點圖、退回路徑、距離濾波、增益匹配
```

注意 `test_hrir_mapping.js` 刻意**不**斷言 ILD 隨螢幕位置單調變化 —— 實測 HRIR 的
|ILD| 峰值在 105°/290° 附近而不是正側面 90°/270°（人頭與耳廓不對稱），要求單調會是
在要求真實資料沒有的性質。它斷言的是「挑到的角度」單調、而且每個位置都偏向正確那隻耳朵。

## 還沒做

- 沒有在真的瀏覽器裡聽過（這台機器沒有 Godot、也沒有瀏覽器自動化）。
- 仰角只有 4 層，鴨子垂直移動時可能聽得出跳層。要更細就從 `hrir_wavs/` 補。
- 沒有做角度之間的內插，都是挑最近的。
