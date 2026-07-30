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

## 一次性音效不做 A/B convolver 交叉淡化

SonicSquid 的 `G07_Binamix` 有一套雙 convolver crossfade，用來避免音源移動、切換 IR
角度時的爆音。**一次性音效不需要**：quack / scream / drop 播放當下算好角度、建一個
convolver、播完就丟。角度不會在播放中途改變，所以沒有需要淡化的接縫。

真的需要 crossfade 的情境是「持續發聲的音源在移動」—— 也就是下面的準心追蹤音。

## 準心追蹤音

握力球在追蹤鴨子時，每個準心會有一個持續發聲的 FM 合成音。這是唯一一個會在發聲中途
移動的音源，所以它是上面那個 crossfade 例外。

**三件事情同時在動：**

| 聽到的 | 對應到 | 為什麼 |
|---|---|---|
| 音高 | 準心離鴨子多近 | 越近越高（G3 → G5）。用 octave 內插不是 Hz 內插，不然可辨識的變化會全部堆在高音那端 |
| 空間位置 | 準心自己在畫面上的位置 | 走跟鴨子聲音同一套 HRIR。追的是**準心**不是鴨子——聽到的是自己的手在哪 |
| 消失 | 已經對準了 | 見下 |

### 對準的瞬間聲音消失

`TONE_LOCK_START` (0.82) / `TONE_LOCK_SILENT` (0.90) 把音量在最後一段收掉。設計理由是：
如果對準時是「一個持續的高音」，對準這件事就只是音高變化的延伸；改成收成靜音之後，
瞄準變成「朝著安靜的方向移動」，對準的那一刻就成為一個**事件**，那個空間感的掃過也才會
被聽成一個短促的手勢。

voice 本身不會被停掉，只是靜音，所以準心飄開音就立刻回來（`TONE_LOCK_MS = 55ms`，
比 pitch glide 的 70ms 快，讓進出都是明確的）。用 smoothstep 不是 step，避免爆音。

**這兩個門檻的換算要小心 —— 這裡踩過一次坑。** viewport 只有 256×240，對角線 351px，
所以 `TRACK_TONE_RANGE` 換算出來的可聽範圍是 228px，而鴨子的 hitbox 半徑就有 22px 左右。
最早設 0.88/0.98 的時候，整段淡出（27px → 5px）**落在 hitbox 裡面**，意思是音量會一路
全開到 `locked` 把它切掉為止 —— 聽起來完全不像 lock 提示，而像「追蹤音壞了」。現在是
41px 開始淡、23px 收乾淨，剛好在 hitbox 邊緣完成。`test_tracking_tone.js` 有一條
assertion 直接從兩邊的常數算 px 來守這件事。

還有一件本來就會這樣、不是 bug 的事：追蹤輔助會**主動把準心拉到鴨子身上**，所以握住
不放的時候準心會停在 hitbox 裡，追蹤音有很大一部分時間是靜音的。追蹤音是「接近的那個
過程」的聲音，不是「握著的時候一直有的聲音」。

**「對準」是 Godot 那邊判定的**（payload 的 `locked`），因為只有它知道 hitbox。單人
模式直接用 `_is_on_duck()`，跟 `_try_hit_duck()` 同一套幾何 —— 這樣「聲音消失了」和
「這一槍會中」不可能不一致。Party Mode 的 `_get_gripball_player_target()` 只回傳
Vector2、沒有 hitbox 可測，所以用 `TRACK_LOCK_RADIUS = 22.0` 代替；反正 Party 的準心
本來就故意在抖，pixel 級精準的判定只會讓聲音在邊緣閃爍。

沒有 `locked` 旗標時（舊版 pck）就只靠 `TONE_LOCK_SILENT` 退回純距離判定。

### P1 / P2 音色不同：FM

Party Mode 每個玩家都在掃同一段音高，所以要靠**音色**分辨誰是誰。`TONE_TIMBRES` 一人
一組 `(ratio, index)`——FM 的兩個決定性參數：

| | ratio | index | 聽起來 |
|---|---|---|---|
| P1 | 1 | 1.6 | 柔、接近純音 |
| P2 | 2 | 3.2 | 鼻音、明顯比較亮 |
| P3 | 3.5 | 2.4 | 非整數比 → 鐘聲／金屬感 |
| P4 | 0.5 | 4 | 空、粗，墊在下面 |

這比原本的 detune 好分辨得多：detune 是「同一個聲音走音了」，不同 ratio 是**整個泛音
列都不一樣**。

modulator 的頻率和深度都跟著 carrier 成比例（深度 = index × modulator 頻率，FM 的標準
定義），所以音色在音高掃動的過程中不會變 —— 固定 Hz 深度的話，聲音升上去時性格會跑掉，
就不再是穩定的玩家身分了。

### 增益分配

同時發聲的 voice 用 `1/sqrt(n)` 分配（equal-power），不是 `1/n`：總響度大致不變，
但單一個 voice 不會因為人多就消失。已經對準（靜音）的 voice **不算進** n —— 不然一個人
對準了，其他還在追的人會莫名變小聲。

Godot 端一次送出全部正在追蹤的準心（`_send_track_tones`），JS 端把清單裡沒出現的 id
淡出。所以空陣列就是「停止」，不需要另外維護一個 stop 呼叫。更新頻率 30Hz：0.22 秒的
proximity 節奏會讓音高變成一階一階的。

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
node tools/test_tracking_tone.js   # 追蹤音：音高、lock 靜音、FM 音色、A/B crossfade
```

`test_tracking_tone.js` 是把 `gripball_webhid.js` 裡的真函式抓出來、餵給一組假的
Web Audio node（每個 AudioParam 都記下所有排程事件，所以 ramp 可以被檢查）。它也用
regex 檢查 `gripball_input.gd.reference` 送出的欄位、並重建 GDScript 組出來的那串 JS
表達式丟給真的 `syncTracking()` —— 那邊的引號錯誤在 `JavaScriptBridge.eval` 裡是**靜默
失敗**的，只有這樣才抓得到。

注意 `test_hrir_mapping.js` 刻意**不**斷言 ILD 隨螢幕位置單調變化 —— 實測 HRIR 的
|ILD| 峰值在 105°/290° 附近而不是正側面 90°/270°（人頭與耳廓不對稱），要求單調會是
在要求真實資料沒有的性質。它斷言的是「挑到的角度」單調、而且每個位置都偏向正確那隻耳朵。

## 還沒做

- **追蹤音沒有在真的瀏覽器裡聽過**。上面所有的音色／時間常數都是照 FM 的數學和聽覺
  推論挑的，不是調出來的。特別要現場確認的：`TONE_PEAK_GAIN = 0.16` 會不會蓋掉 quack、
  55ms 的 lock 收尾會不會反而聽起來像爆音、P3 的非整數比在低音端會不會太吵。
  要單獨聽不用開遊戲：`tone_bench.html` 直接載入真的 `syncTracking()`，滑鼠當準心，
  lock 半徑可以拉到 0 來關掉「對準即靜音」單獨聽音高和空間感。
- 鴨子音效同樣沒在瀏覽器裡聽過（這台機器沒有 Godot、也沒有瀏覽器自動化）。
- 仰角只有 4 層，鴨子垂直移動時可能聽得出跳層。要更細就從 `hrir_wavs/` 補。
- 沒有做角度之間的內插，都是挑最近的。
- Party Mode 的 lock 是半徑判定不是 hitbox 判定，跟單人模式不完全一致。要一致的話得讓
  `main.gd` 的 `_get_gripball_player_target()` 連 duck node 一起回傳。
