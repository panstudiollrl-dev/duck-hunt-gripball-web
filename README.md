# Duck Hunt Gripball Party Mode Web

這是 MB01 Gripball 的 WebHID 版 Duck Hunt。

## 使用方式

1. 用 Chrome 或 Edge 開啟網站。
2. 按「連接/新增握力球」並在瀏覽器授權視窗選取 Gripball（要玩幾顆就加幾顆）。
3. **就這樣，會自動開始** —— 不用按開始，也不用校正。拿好球先不要按，最後一顆連上後
   約 2.5 秒就進遊戲，中間只花不到 1 秒讀一個靜止基準值。
4. 啟動時第 1 顆會震 1 下、第 2 顆震 2 下，以此類推。
5. 畫面會依照 Gripball 數量產生對應數量的鴨子；甩動第 N 顆 Gripball 會射第 N 隻鴨子。

下一次進來時球已經授權過，`getDevices()` 會自動恢復，所以連按鈕都不用碰就直接開始。

## 自動開始

`AUTO_START_QUIET_MS`（2500ms）是「最後一顆球連上之後多久沒有新的球就開始」。**每連上
一顆球就重新計時**，不是從第一顆算固定時間 —— 因為兩顆球是分兩次連上的，差個一兩秒，
若從第一顆就起算會把 P2 丟在外面。想多加一顆就在這個空檔按「連接/新增握力球」，計時會重來。

球在倒數期間拔掉會取消（不會開一場沒人的遊戲）；按「鍵盤測試」也會取消。自動開始失敗
時**不會**每 2.5 秒重試（那會把錯誤訊息一直洗掉），而是把控制列叫出來，等你按「開始遊戲」。

## 聲音的解鎖（autoplay policy）

瀏覽器只允許在使用者手勢裡啟動 AudioContext，而原本那個手勢就是按「開始遊戲」。自動開始把它
拿掉了，而握球是 HID 事件、不算手勢，所以不會自己解鎖。

`unlockAudioOnFirstGesture()` 在頁面上**任何**第一次點擊或按鍵時解鎖。重點是「連接/新增
握力球」那一下就算 —— WebHID 沒有手勢根本開不了選擇視窗，所以第一次玩的人本來就會點到一次，
不需要再額外點畫面。

有兩個實測踩到的細節：

- **`window.GodotAudio` 在這個 build 裡永遠是 `undefined`。** Godot 的 `GodotAudio` 物件是
  `index.js` 內的 module scope 變數，從來沒掛到 `window` 上。第一版的解鎖只看它，所以整段
  其實什麼都沒做。真正在放鴨子叫聲的是這支腳本自己建的 context（`measureOutput()` 會回報
  `sharedWithGodot:false`）。現在 `audioContexts()` 兩個都收，並且在手勢裡才 `ensureContext()`
  建立 —— 那是新 context 唯一會直接是 running 而不是 suspended 的時機。
- **resume 必須同步呼叫。** listener 不能是 `async`，先 `await` 任何東西都會把 user
  activation 花掉，之後 resume 就會被拒絕。
- Godot 自己的 context 從外面碰不到，所以改成往 canvas 補送一次真的手勢
  （`pokeCanvasForAudio()`）。那些事件會冒泡回 window 上的 listener 再觸發自己，所以有
  re-entrancy guard —— 沒有的話第一次點擊就 `Maximum call stack size exceeded`。

**唯一修不掉的情況**：老玩家的球已經授權過，`getDevices()` 自動恢復、可以全程零點擊進遊戲 ——
這時候瀏覽器就是不給聲音，任何 API 都繞不過。所以那種情況開始訊息會多一句
「點一下畫面開聲音」，而不是安靜地沒聲音讓人以為壞了。

## 控制列（HUD）

上方那一列是連接／開始／鍵盤測試／即時數值。按 × 可以收起來，右上角的「握力球選單」再打開，
偏好會記在 `localStorage`。

**但是**：當按鈕是唯一的出路時（還沒連上任何球，或自動開始失敗），這一列會強制顯示，
不管偏好是不是收起來。以前收起來之後，唯一的入口是一個寫著「數值」的小按鈕，看起來像是
除錯用的開關，不像「你的控制項都在這裡面」。偏好只是被暫時蓋過，不是被清掉：球一連上就
恢復照偏好走。

## 握力門檻（不校正，每顆球各自調整）

按下去超過門檻就算「握住」，開始追蹤鴨子；掉回一半以下才放開（hysteresis，避免手停在
門檻附近時準心閃爍）。不需要校正流程 —— 原本每顆球各自量程的三輪校正一個人要花約 20 秒，
而且球還在回彈時取樣就可能卡住。

門檻**不是固定值**。`QUICK_ENGAGE_FORCE`（3000 counts）現在是**上限**而不是門檻本身：
每顆球會用 `engageForceFor()` 把自己的門檻縮進自己的量程裡 ——

- 還沒被按過的球：先用地板值 `ADAPTIVE_ENGAGE_FLOOR`（200），弱球第一次按就能過。
- 按過之後：門檻是「這顆球目前為止的最大力道」× `ADAPTIVE_ENGAGE_RATIO`（0.45），
  但不低於 200。實測那顆全力握約 1400 counts 的球，門檻會落在 630。
- 量程碰得到 3000 的強球：照舊用 3000，避免手只是放在球上就啟動。

為什麼要這樣：**任何**單一固定門檻都會高過某些球做得到的力道，那顆球就永遠不會啟動
（Pan 2026-08-05 回報「有一顆握力球做什麼都沒反應」就是這件事）；而把常數調低到最弱的球
過得了，強球就會被一隻放在上面的手啟動。所以現在是每顆球自己縮。

門檻是跟著在用的那個值走的，不是設定值：放開門檻、追蹤全速、靜止帶（基準值自動歸零的
範圍）、HUD 上的讀數都一起縮。萬一誤觸鎖住，原本的 `AUTOZERO_WINDOW_MS` 重新歸零會自己解開。

真的想用舊流程，面板上的「重新校正」還在。

面板三個相關數值（現在是上限／設定值，不是實際門檻）：

| 欄位 | 意思 | 預設 |
| --- | --- | --- |
| 追蹤啟動 | 算握住所需力道的**上限**，弱球會自己往下縮 | 3000 |
| 追蹤放開 | 掉到多少以下算放開（跟著實際門檻縮） | 1500 |
| 追蹤全速 | 準心追到最快所需的力（跟著實際量程縮） | 4500 |

改過門檻的話 `localStorage` 會記住，key 是 `gripball-tuning-v3`（改門檻預設值時記得
一起改 key，不然舊瀏覽器存的舊值會蓋掉新預設，看起來像是沒生效）。

因為不校正，起始基準值可能量得不太準（例如上一次握完還在回彈時開始），所以遊戲中
`estimateGrip()` 會持續把基準值往靜止值拉回去。這個修正只在讀數**接近靜止**時才跑：
以前是只要低於門檻就跑，於是慢慢用力時基準值會跟著手往上爬，門檻等於邊接近邊後退。門檻
只有 60 的時候看不出來（一兩個取樣就過了），門檻是幾千就很明顯 —— 實測慢壓 3 秒要出到約
4019 counts 才過得了 3000 的門檻。

靜止帶的算法有一個陷阱：原本是 `engageForce * 0.15`，門檻縮小之後這個帶也跟著縮，弱球的
基準值就再也拉不回來了。所以現在上限取設定值的比例（`tuning.engageForce * 0.15`），而且
**往下**的修正永遠允許 —— 讀數低於已記錄的靜止值，不可能是一次按壓。`test_quick_start.js`
有守這兩件事。

## 空間音訊

鴨子的叫聲／慘叫／落地聲會依牠在畫面上的位置定位（建議戴耳機）。走的是實測人頭
HRIR 卷積：`assets/hrir/` 內是 344 個 48kHz stereo IR（方位角一圈 × 仰角
-15°/0°/+15°/+30°），每個音效播放當下挑最接近的角度做 convolution。另外有依距離
遞減高頻的低通（空氣吸收），讓遠近不只靠音量分辨。

瀏覽器不支援或 IR 還沒載到時，會自動退回內建的 `PannerNode` HRTF，不會沒聲音。

### 瞄準音與失敗音

兩者都以 `Duck_Sound_Deisgn/` 的參考錄音為模型，實測參數而不是憑耳朵抓。

**瞄準音**（模型：`Crosshair_01.wav`）是一組兩音來回的顫音，掛在準心上：準心越靠近鴨子，
音高越高、顫得越快；鎖定的瞬間**收成靜音**，讓「對準了」變成一個事件而不是一個持續音。
參考錄音量到的是 253.2Hz / 481.8Hz（比例 1.903）、每 56ms 換一次音（8.9Hz、50/50），
振幅平坦，而且 99.6% 的能量只落在那兩個音的頻帶裡 —— 幾乎是純正弦，所以 FM 的調變量壓得
很低（1.6..4 → 0.35..0.9），不然會多出參考錄音沒有的簧片感。顫音本身用一張 ±1 的 buffer
loop 當控制訊號，不用 `OscillatorNode` 的 square：band-limited square 在轉折處會過衝振鈴，
拿來當**音高**控制的話每次換音都變成一聲 chirp。四位玩家各有自己的音色與音程。

**失敗音**（模型：`Didn't_Hit_00.wav`）在打空時響，位置放在**準心**而不是鴨子身上 ——
它回答的是「你這一槍去了哪裡」，從鴨子的方向響出來反而像打中了卻沒算分。同樣走 HRIR 卷積，
Party Mode 下四個人各有自己的音高，同時開槍才分得出是誰。

瞄準音的音量（`TONE_PEAK_GAIN`）是 **0.36**，送出來大約在一聲鴨叫的 -6dB。這個值調得太小
過兩次（0.16、然後 0.13），兩次都是同一個推論錯：兩個音來回的顫音在**注意力**上確實比同
音量的持續音顯眼，但在**聽得到**這件事上不是，0.13 送出來比音樂和槍聲都低（Pan
2026-08-05：「瞄準的音量太小了」）。`test_hrir_loudness.js` 的下限現在設在那兩個值之上，
而且會另外檢查最不利的情況（四人同時、離鴨子最遠）仍在混音之上 —— 只看峰值會漏掉這一格。

音高與音量的推導都寫在 `gripball_webhid.js` 的註解裡（含 IR 低頻不足要補多少 dB 的實測），
`tools/test_tracking_tone.js`、`tools/test_hrir_loudness.js`、`tools/test_shot_miss.js` 有守。

技術來源與更多細節見 `docs/SPATIAL_AUDIO.md`。

## 開頭畫面：一定要有辦法離開

開頭那張「每人打一隻鴨子」的字卡，以前是 `await intro_screen_continued`，而那個 signal
只在**所有**登記到的玩家都打中之後才發 —— 沒有 timeout、沒有略過鍵、沒有回頭路。球一連上就
算一位玩家，所以一顆按不動的球會分到一隻鴨子、而沒有人打得到它，遊戲在開始之前就結束了
（Pan 2026-08-05：「畫面卡在開頭打兩隻鴨子的地方」）。

現在有四條出路，全部走同一個 idempotent 的 `_finish_intro_screen()`：

1. 只等**證明過**的球。`player_proven` 在一顆球第一次真的按下去（過了它自己的門檻）時才發，
   登記本身不算證據。一顆都還沒證明過的時候仍然等全部人，否則字卡會在出現的瞬間被跳過。
2. 有人打中之後起算 `INTRO_PARTY_GRACE_SEC`（8 秒）。一隻鴨子倒下就證明輸入路徑是通的，
   所以還缺的那個是硬體問題，不是慢。
3. `INTRO_PARTY_TIMEOUT_SEC`（20 秒）硬性 timeout，會 `push_warning` 印出還在等誰。
4. 鍵盤 `ui_accept` 直接略過 —— 玩家不會知道有 timeout 在跑。

`test_intro_and_dog.js` 守的是這個結構本身，包括「party mode 不可以裸 `await` 那個 signal」。

## 狗把鴨子叼回來

沒有被刪掉過，是 `_ready()` 在 party mode 裡把 `present_hit_duck` 關掉了（而 Gripball 一律是
party mode）。現在打開了（Pan 2026-08-05：「我記得 先前版本都把狗抓到鴨子的橋段刪掉了
但其實那很可愛」）。

兩件事跟單人版不一樣：

- `_on_next_duck()` 的 party 分支以前在碰到那段呼叫之前就 return 了，所以只把 flag 打開
  是不會有狗的 —— 得另外接上。
- 接上的是 `_queue_hit_duck_for_dog()`，而且**故意不 await**。party mode 下每位玩家有自己的
  鴨子和自己的重生時鐘，await 一段約 1.7 秒的動畫等於每次都把那位玩家的下一隻鴨子往後推，
  四個人就是一直推。

`play_dog_intro`（第一隻鴨子之前那段嗅聞加跳躍）仍然關著：那段是 `_ready()` 會 await 的，
會讓四個人在一張靜止畫面前面等約 7 秒，而且不是在回應他們剛做的任何事。

### 為什麼狗會在不對的時間點叼著不對的鴨子出來

Pan 2026-08-06 回報「狗都在不對的時間點爬出來 根本就不是我們打到的鴨子」。真的不是我們打到的
那隻 —— 是**開頭字卡上的那隻**。

開頭那幾隻鴨子是 `intro_screen` 的子節點，而 `_exit_intro_screen()` 的 `hide()` 會觸發每隻鴨子
的 `VisibleOnScreenNotifier2D`（那個函式自己的註解就寫了「hide() 會殺掉鴨子」）。於是每隻開頭
鴨子都會再發一次 `next_duck`，而且是在 `intro_screen.visible` 已經變成 false 之後 —— 剛好掉進
遊戲中的分支：加分、推進 `ducks_shot`、排一隻新鴨子，然後叫狗叼著一隻**字卡上的**鴨子在正式
遊戲開始的那一刻爬出來。所以那隻狗從來不是在展示這一局打到的鴨子。

修法是在 `_on_next_duck()` 開頭認出這種 emission（開頭鴨子帶 `set_meta("intro_duck", true)`）
並且直接 return。條件是「而且字卡已經不可見」，不能無條件 return：**單人版靠的正是相反的行為**
—— 單人版的開頭鴨子是在字卡還開著的時候掉出畫面下緣，那次 emission 就是繼續遊戲的觸發點。

順帶修掉的兩件事：

- 狗現在排隊而不是被丟掉。以前 `dog_presenting` 為真時後來的鴨子直接沒有狗；四個人的話大部分
  的擊落都不會有狗。
- 排隊有保鮮期（`DOG_PRESENT_MAX_AGE_SEC` = 2.5 秒，從**擊中的時刻**算起，不是從排到隊伍前面
  算起）。過期的直接跳過不演 —— 一隻遲到半個回合才爬出來的狗，叼的是玩家早就不記得的鴨子，
  那比沒有狗更糟。另外排隊時間也往前挪了：以前是在 `_increase_ducks_shot()` 的 0.5 秒
  （回合最後一隻是 1 秒）之後才排，白白離擊中那一刻更遠。

## 開發工具

```bash
# 改完 gripball_webhid.js 或 *.gd.reference 之後，重新打包進 index.pck
python3 tools/patch_pck.py          # 打包到根目錄（正式版）
python3 tools/patch_pck.py preview  # 只打包到 preview/（正式版不動）

# 測試（純 Node，不需要瀏覽器或 Godot）
node tools/test_source_vector.js   # 螢幕座標 → 左右定位
node tools/test_hrir_mapping.js    # 角度挑選，用 IR 實測的 ITD/ILD 當真值
node tools/test_spatial_graph.js   # Web Audio 節點圖與退回機制
node tools/test_hrir_loudness.js   # 音量補償（方向造成的 + 頻率造成的）
node tools/test_tracking_tone.js   # 準心追蹤音的音高／空間位置／收尾
node tools/test_shot_miss.js       # 失敗音效：素材本身、定位、以及命中不該響
node tools/test_quick_start.js     # 不校正的起始流程與每顆球各自的門檻
node tools/test_auto_start.js      # 自動開始的時序／競態，與控制列的顯示規則
node tools/test_calibration_release.js  # 舊的三輪校正流程（仍是備用路徑）
node tools/test_intro_and_dog.js   # 開頭畫面的每一條出路，與狗把鴨子叼回來
```

`test_quick_start.js` 以前只是**印出**門檻的可達性警告 —— 設定的門檻超過實測球的量程時
不讓測試失敗，因為門檻是 Pan 的決定。那個警告後來真的發生在玩的時候（有一顆球完全沒反應），
所以現在改成硬性斷言：三種強度的球（1400 / 350 / 6000 counts）都必須按得動。

`test_intro_and_dog.js` 讀的是 `.gd.reference` 的原始碼而不是執行它（`main.gd` 只存在於
`index.pck` 裡，Node 跑不了 GDScript）。它守的是「開頭畫面一定有辦法離開」這個結構：
每一個 `await` 都有對應的 timeout／略過路徑，而且離開的動作是 idempotent 的。

`duck.gd.reference`、`gripball_input.gd.reference`、`main.gd.reference` 是
`res://scenes/` 下對應 `.gd` 的來源檔（那些檔只存在於 `index.pck` 裡），要改遊戲邏輯
請改它們再跑 `patch_pck.py`。

### 兩份輸出：根目錄是正式版，`preview/` 是試玩版

`preview/` 是一份完整、可獨立執行的 web export（`index.html` 裡所有路徑都是相對的，
所以放在子目錄就能跑）。新的音效先只進 `preview/`，根目錄的 `index.pck` / `index.html`
維持 byte-for-byte 不動，線上正式版就不會被影響。

`patch_pck.py` 兩邊讀的都是根目錄的來源檔，只有輸出位置不同。也就是說「根目錄來源檔比
根目錄 index.pck 新」是正常狀態：正式版凍結在某一版，來源檔繼續走，`preview/` 才跟上。
試玩滿意之後要上線，就跑一次不帶參數的 `patch_pck.py`。

## GitHub Pages

Godot 4 Web export 需要 `SharedArrayBuffer`。GitHub Pages 不能直接設定 COOP/COEP headers，因此這份輸出包含 `coi-serviceworker.js`：

- 第一次進入頁面會註冊 service worker 並自動重新整理一次。
- 重新整理後遊戲會在 cross-origin isolated 狀態下啟動。

如果公司環境封鎖 service worker 或 WebHID，請改用最新版 Chrome/Edge，或用可設定 headers 的 hosting 服務部署。
