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

### 一次按壓 = 一段聲音

**按壓開始發聲、對到鴨子就結束，要再有聲音得放開重按。** 握著不放不會再有第二段。

理由是追蹤輔助會**主動把準心拉到鴨子身上**並停在那裡。所以「持續發聲」這個模型下，握住
不放的時候有很大一部分時間準心都在 hitbox 裡；不管那段時間是靜音還是持續高音，都不是
在傳達任何東西。改成一段一段之後，聲音只存在於「正在接近」的那幾百毫秒，而那正好就是
它唯一有資訊量的時候 —— 對準的那一刻變成一個**結束**，空間感的掃過也才會被聽成一個
短促的手勢，而不是一個一直在那邊的背景音。

實作上是 Godot 端 gate 的：`tone_spent`（單人）和 `party_tone_spent`（每個玩家一個）
在抵達時設起來、**只有放開才清掉**。設起來之後那一格就不再被送進 `syncTracking` 的清單
—— 而清單裡沒出現的 id 本來就會被淡出，所以不需要另外一套「停止」的訊號。「放開」的門檻
`TRACK_PRESS_FLOOR = 0.01` 跟準心換紅白圖的門檻是同一個。

**「對準」是 Godot 判定的**，因為只有它知道 hitbox。單人模式用 `_is_on_duck()`，跟
`_try_hit_duck()` 同一套幾何 —— 這樣「聲音停了」和「這一槍會中」不可能不一致。
Party Mode 的 `_get_gripball_player_target()` 只回傳 Vector2、沒有 hitbox 可測，所以用
`TRACK_LOCK_RADIUS = 22.0`（比鴨子的碰撞圓稍寬）代替。

每次按壓都是一個**新的 voice**（舊的在抵達時就 stop 掉了）。這件事有個坑：剛建好、還沒
播過的 `OscillatorNode` 停在 Web Audio 預設的 440Hz，所以第一次更新如果用 glide，每一段
聲音的開頭都會從 A4 滑下來 —— gain 的淡入是同一個時間常數，蓋不掉。所以第一次更新是
直接 set，第二次以後才 glide；gain 相反，它從 0 開始、需要淡入才不會爆音。

### 音量的收尾（`TONE_LOCK_START` / `TONE_LOCK_SILENT`）

除了上面那個 gate，JS 端還有一段按距離的淡出：0.82 開始收、0.90 全靜音，用 smoothstep
不是 step。這段的作用是讓結束是「收掉」而不是「切掉」，跟 Godot 的 gate 是接在一起的
（`TONE_LOCK_MS = 55ms`，比 pitch glide 的 70ms 快，收尾才明確）。

**這兩個門檻的換算要小心 —— 這裡踩過一次坑。** viewport 只有 256×240，對角線 351px，
所以 `TRACK_TONE_RANGE` 換算出來的可聽範圍是 228px，而鴨子的 hitbox 半徑就有 22px 左右。
最早設 0.88/0.98 的時候，整段淡出（27px → 5px）**落在 hitbox 裡面**，意思是音量會一路
全開到判定把它切掉為止 —— 聽起來完全不像提示，而像「追蹤音壞了」。現在是 41px 開始淡、
23px 收乾淨，剛好在 hitbox 邊緣（22px）完成，跟 Godot 的 gate 對得上。
`test_tracking_tone.js` 有一條 assertion 直接從兩邊的常數算 px 來守這件事。

`lockEnvelope()` 還留著 `locked` 參數，作為沒有 gate 的舊版 pck 的退路；現在正常路徑
送出來的 entry 一律是 `locked: false`（已經抵達的根本不會被送），測試有守這件事。

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

Godot 端一次送出全部**還在發聲**的準心（`_send_track_tones`），JS 端把清單裡沒出現的 id
淡出。所以空陣列就是「全部停止」，不需要另外維護一個 stop 呼叫；已經抵達的玩家也是靠
「不出現在清單裡」來結束的。更新頻率 30Hz：0.22 秒的 proximity 節奏會讓音高變成一階
一階的。

## 載入策略

IR 檔不預載全部（344 個，即使只有 707KB 也沒必要）：

- 啟動只抓 `manifest.json`（約 17KB）。
- 第一次使用者互動（pointerdown / keydown，AudioContext 要有手勢才能開）後，
  背景預熱畫面上一片粗略的角度（約 30 個檔），讓第一隻鴨子就用得到真 HRIR。
- 其餘角度用到才抓，抓過就 cache。
- `spatialize()` **不會等網路** —— IR 還沒 decode 好就先用 PannerNode 播，
  同時在背景把它抓下來給下一次用。寧可退回也不要延遲出聲。

## 增益補償

這一節踩過兩個**不同**的坑，兩個都會讓聲音小到聽不見，但原因完全不一樣。分開講。

### 一、每個 IR 自己的音量（方向造成的）

Convolution 會把訊號乘上 **IR 自己的能量**。這批實測 IR 存得很小聲：L2 norm 在正面弧
是 0.055~0.130（−25~−18dB），最背面只有 0.034，整個資料集跨 11.9dB。所以
「一個固定倍數」根本不可能對 —— 原本寫死 `HRIR_BOOST = 1.8`，等於假設 norm 是 0.556，
比實際大了 13~20dB，於是 convolver 那條路比 PannerNode 那條路小了約 13dB，而且**光是換
方向就會晃 7.5dB**。

現在改成每個 IR 各算一次：

```
hrirGainFor(name, buffer) = HRIR_MATCH / max(該 IR 的 L2 norm, HRIR_MIN_NORM)
```

`HRIR_MATCH = 0.93` 是拿 offline render 對著 PannerNode 那條路解出來的。左右耳**除以
同一個數**，所以 ILD（`normalize = false` 要保護的東西）原封不動 —— 這是重點，正規化
會把雙耳音量差抹平，我們要的是補音量、不是抹線索。

補償掛在 A/B 兩個 gain 上，不是掛在後面共用的節點上：IR 一換就得跟著 crossfade 一起
移動，不然每次換方向都會在淡化中間出現一個音量階。
實測結果：方向造成的音量差 7.5dB → **2.7dB**，跟 PannerNode 那條路最多差 1.7dB。

convolver 自己沒有距離衰減模型，所以另外照 PannerNode 的參數
（refDistance 1 / rolloff 0.45）手算一份 inverse rolloff 補上。

### 二、窄頻訊號被 IR 的低頻不足吃掉（頻率造成的）

上面那件事修好之後**準心音還是幾乎聽不到**，這是第二個坑，跟方向無關。

IR 只有 **256 taps / 48kHz = 5.3ms**，大約是 190Hz 的一個週期，所以它**帶不動低頻**。
一次性音效（quack 等）是寬頻的，能量攤在整個頻譜上，幾乎不受影響；準心音是**窄頻**的
FM 音，只取樣 |H(f)| 上的一個點，於是照著 IR 的頻率響應被削。實測正面弧的中位數：

| carrier | 送出去 1.0 實際到達 | |
|---|---|---|
| 196Hz（離鴨子最遠） | 0.049 | −26.1dB |
| 294Hz | 0.096 | −20.3dB |
| 440Hz | 0.173 | −15.2dB |
| 784Hz（對到鴨子） | 0.350 | −9.1dB |

也就是 **+8.2dB/octave 的斜率**，整段掃音兩端差 16dB。而且方向剛好最壞：低音代表
「離鴨子還很遠」，也就是這個提示**最需要被聽到**的時候最小聲；原本的 swell
（`0.55 + 0.45 × closeness`）越靠近越大聲，是在**加重**這個斜率而不是抵銷它。

所以 `tiltCompensation(hz)` 按 `TONE_TILT_DB_PER_OCT = 8.2` 反向預補，以 784Hz 為基準
（只會往上補、不會往下砍）。**只補 convolver 那條路** —— PannerNode 是平的，補了會讓
遠處的準心大 16dB。

### 三、於是 `TONE_PEAK_GAIN` 是量出來的，不是挑的

原本 0.16 是拿**乾訊號**的振幅跟其他音效比出來的，忽略了上面那 19dB 中位數的損失，
實際送到喇叭是 **peak 0.033、比 quack 的 0.360 小 21dB** —— 這就是「完全無聲」的真相。
斜率補平之後又反而太大聲（0.31，快跟 quack 一樣），最後定在 **0.24**。

真實 Chrome 量到的結果（`AnalyserNode` 掛在 master 上，不是讀 AudioParam）：

| | peak | 相對 quack |
|---|---|---|
| 修之前 | 0.0025 → 0.033 | −21dB（聽不到） |
| 現在 | 0.116 ~ 0.147 | **−8dB** |

而且整段掃音變平了（−16 ~ −15dBFS，原本 −31 ~ −18dB），所以掃音的開頭不再是聽不到的
那一段。

**這裡真正的教訓是：stub 測試結構上抓不到「沒聲音」。** 它記的是排程到 AudioParam 上的
數值，gain 讀起來 0.14 一切正常，而 convolver 出來的音訊已經低了 50dB。所以現在多了
`tools/test_hrir_loudness.js`：直接讀真的 WAV、抓真的函式，斷言
`norm × gain ≈ 定值`（方向）以及補償後掃音夠平（頻率）。絕對音量那一項刻意**不**由它
斷言 —— 它只算 carrier，FM 的 sideband 落在 IR 較強的高頻，所以它比實際低約 12dB；
絕對值是瀏覽器量的。

## 測試

```bash
node tools/test_source_vector.js   # 螢幕座標 → lateral/vertical（含 letterbox 情況）
node tools/test_hrir_mapping.js    # 角度挑選正確性，真值來自 IR 實測 ITD/ILD
node tools/test_spatial_graph.js   # 節點圖、退回路徑、距離濾波、增益匹配
node tools/test_tracking_tone.js   # 追蹤音：音高、lock 靜音、FM 音色、A/B crossfade
node tools/test_hrir_loudness.js   # 讀真 WAV：每個 IR 的增益補償、窄頻斜率補償
```

`test_hrir_loudness.js` 刻意**不依賴任何 npm 套件**（自己寫了一個極小的 float32 WAV
reader 和單點 DFT），所以整組測試不需要 `node_modules` 就能跑。

`test_tracking_tone.js` 是把 `gripball_webhid.js` 裡的真函式抓出來、餵給一組假的
Web Audio node（每個 AudioParam 都記下所有排程事件，所以 ramp 可以被檢查）。它也用
regex 檢查 `gripball_input.gd.reference` 送出的欄位、並重建 GDScript 組出來的那串 JS
表達式丟給真的 `syncTracking()` —— 那邊的引號錯誤在 `JavaScriptBridge.eval` 裡是**靜默
失敗**的，只有這樣才抓得到。

注意 `test_hrir_mapping.js` 刻意**不**斷言 ILD 隨螢幕位置單調變化 —— 實測 HRIR 的
|ILD| 峰值在 105°/290° 附近而不是正側面 90°/270°（人頭與耳廓不對稱），要求單調會是
在要求真實資料沒有的性質。它斷言的是「挑到的角度」單調、而且每個位置都偏向正確那隻耳朵。

## 還沒做

- **追蹤音的「音量」已經在真的 Chrome 裡量過了，但「好不好聽」還沒有人耳聽過。**
  量過的是：一次按壓真的會發聲、對到鴨子真的會停、放開之後 voice 真的被丟掉
  （release 之後 rms 歸零）、以及相對 quack 是 −8dB。**還沒有人耳確認的**是那些
  照 FM 數學挑出來、不是調出來的常數：55ms 的收尾會不會聽起來像爆音、P3 的非整數比在
  低音端會不會太吵、四個人同時發聲會不會糊掉。
  要單獨聽不用開遊戲：`tone_bench.html` 直接載入真的 `syncTracking()`，在框裡按住滑鼠
  就是一次按壓（準心會自己被拉向鴨子，跟遊戲一樣）。取消「一按一段」會變回持續發聲、
  lock 半徑拉到 0 則完全不靜音，方便單獨聽音高和空間感。
  bench 上的「實測輸出（RMS）」是 `AnalyserNode` 從 master 抓的真實訊號，
  不是讀回 AudioParam —— **要判斷「有沒有聲音」只能看這一欄**，「音量」那一欄是送進去的
  請求值，它正常但完全無聲是真的會發生的（見上面的增益補償）。
- **瀏覽器的 AudioContext 一定要在使用者手勢裡面 resume**。`getContext()` 裡那個
  `ctx.resume()` 是 fire-and-forget 的，在 `requestAnimationFrame` 裡才第一次發聲的話
  Chrome 會讓 context 一直停在 suspended —— 整個 graph 照跑、`debugVoice()` 回報的
  gain 都正常，就是**完全沒有聲音**。bench 因此另外開了 `resumeAudio()`，在 click
  handler 裡 `await` 它，並且把 context 的 state 顯示在畫面上。
- 鴨子音效同樣沒在瀏覽器裡聽過（這台機器沒有 Godot、也沒有瀏覽器自動化）。
- 仰角只有 4 層，鴨子垂直移動時可能聽得出跳層。要更細就從 `hrir_wavs/` 補。
- 沒有做角度之間的內插，都是挑最近的。
- Party Mode 的抵達判定是半徑不是 hitbox，跟單人模式不完全一致。要一致的話得讓
  `main.gd` 的 `_get_gripball_player_target()` 連 duck node 一起回傳。
- **一段掃音的長度完全由追蹤輔助的速度決定**（`TRACK_SPEED_MIN/MAX` = 45~300 px/s），
  握得越用力越短。實際算出來的範圍很極端：

  | 握力 | 從可聽邊緣 (228px) | 從 120px | 從 60px |
  |---|---|---|---|
  | 輕 (45 px/s) | 4.6s | 2.2s | 0.84s |
  | 中 (172 px/s) | 1.2s | 0.57s | 0.22s |
  | 重 (300 px/s) | 0.69s | 0.33s | **0.13s** |

  最短的 0.13s **比 `TONE_FADE_MS` 的淡入（90ms）長不了多少** —— 那種情況下幾乎聽不到
  掃動，只會是一聲短促的「嗶」。還沒在瀏覽器裡確認這聽起來是可接受的（也可能是好的：
  近距離用力握本來就該是「已經對準了」而不是一段瞄準過程）。如果不行，選項是給掃音一個
  最短時間、或讓音高變化率補償速度。這個要聽過再決定，不要先猜著改。
