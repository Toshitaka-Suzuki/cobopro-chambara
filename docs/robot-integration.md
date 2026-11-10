# ロボット連携の手順と通信仕様

Web側への依頼資料（2026-11-11共有の画像2枚）に合わせた連携です。
パリィの判定はESPを継続使用し、成功通知をWebからロボットへ送ります。この点は資料の「カメラから送る」構成から変更しています。
ロボットの移動・退避・停止・復帰の制御はロボット側が担当し、Webは開始・終了指示と状態監視を担当します。

## 構成

```text
Python（会話・BGM） ← WebSocket → Webアプリ
                                 ├─ USB → XIAO・ESP（判定・弱点A）
                                 └─ WebSocket → rosbridge → ROS 2ロボット
```

- `command`・`heartbeat`・`/parry`の送信元は、このWebアプリ1つに統一します。複数のタブ・PCから同時に制御しません。
- カメラからの障害物位置の通知は既存構成を維持できます。カメラから`/parry`への送信は併用しません。
- 勝敗は現在のゲームルール（弱点3命中で勝利、60秒経過・紙風船破損で敗北）を使用します。カメラによる勝敗通知は今回追加していません。
- ロボット連動は初期OFFで、プレイの準備画面から有効にします。機器なしのモックや従来センサはそのまま使用できます。

## 接続手順

1. ロボット側を共有資料の手順で起動します。パリィの受信には`parry_topic:=/parry`を指定します（資料上の既定は無効）。
2. ROS 2環境でrosbridgeを起動します。同じPCだけから接続する場合の例です。

   ```sh
   ros2 launch rosbridge_server rosbridge_websocket_launch.xml address:=127.0.0.1
   ```

   別PCのWebから接続する場合は、待受アドレスをROS側PCのLAN IPに合わせ、Webにも`ws://そのIP:9090`を指定します。ロボットのROSグラフがrosbridgeから見える環境で起動してください。管理画面の一覧探索にはrosapiも使用します。
3. PythonとXIAOの接続は[README](../README.md)のESP連携手順を実施します。
4. 「会話・BGM連携」＋「ESP連携（既存仕様）」を選択し、「ロボットと連動する」を有効にしてROSへ接続します。管理画面の接続と共用します。
5. 「WebSocket接続済み」に加え、状態通知の継続受信と「ロボット準備完了」を確認します。接続後の保持された状態1件だけでは開始できません。
6. ゲームを開始し、終了後はロボットが`standby`へ復帰するまで待ちます。通信記録は準備画面で確認できます。

起動コマンドの定義は[rosbridgeのlaunchファイル](https://github.com/RobotWebTools/rosbridge_suite/blob/ros2/rosbridge_server/launch/rosbridge_websocket_launch.xml)を参照してください。
実機側のrosbridgeバージョンは未確認です。下記の`qos`指定に対応した版を使用し、ROS側で実際のQoSを確認する必要があります。

## ゲームとの連動

1. 新しい`standby`通知を継続受信し、ゲーム開始を許可する。
2. 作戦の会話・カウントダウンを行う。この間はロボットへの開始指示を送らない。
3. heartbeatを開始し、`/parry=0`で初期化してから`start`を1回送る。
4. `command_accepted`は受付表示にとどめ、`fighting`を確認してからPythonへBGM開始を要求する。Pythonの開始確認後に60秒のゲーム時計を開始する。
5. ESPの確定パリィ成功を受けたら、`/parry=1`、100ms後に`0`を送る。1のまま連続送信せず、次回の立ち上がりに備える。
6. 勝敗確定で`finish`を1回送る。感想の会話中・終了後も、ロボットの停止・復帰を監視する。
7. 次の`standby`で復帰完了とし、heartbeatを停止する。感想の会話も終了してから次のゲームを許可する。

`holding`は「目標位置へ到着し、終了指示を待っている状態」です。到着だけで勝敗を決めず、ゲームを継続します。`/parry`は`fighting`時だけ送信し、ロボットの退避完了を表すACKとしては扱いません。
正常終了後に準備画面へ戻っても復帰監視は続きます。ページの終了・非表示では監視を継続できないため、進行中の連動を異常中断します。

## トピックとメッセージ

| 方向 | トピック | 型 | 内容 |
| --- | --- | --- | --- |
| ロボット→Web | `/chambara/battle/status` | `std_msgs/msg/String` | `data`内のJSON。500ms周期と状態変化時 |
| Web→ロボット | `/chambara/battle/command` | `std_msgs/msg/String` | `start SESSION ROUND` / `finish SESSION ROUND 1または0` / `abort SESSION ROUND` |
| Web→ロボット | `/chambara/battle/heartbeat` | `std_msgs/msg/UInt8` | `data: 1`、250ms周期 |
| Web→ロボット | `/parry` | `std_msgs/msg/UInt8` | 成功ごとに`0→1→0`。1の重複は保留・再送しない |

状態通知の例：

```json
{"data":"{\"type\":\"status\",\"session\":\"123456789\",\"round\":1,\"state\":\"standby\",\"human_result\":null,\"event\":\"state\"}"}
```

`state`は`initializing`・`standby`・`fighting`・`holding`・`stopping`・`returning`・`fault`を受け付けます。
不正なJSONや必要項目のない通知は、生存確認に使いません。

- `start`は新しい`standby`でのみ送信し、`finish`は`fighting`または`holding`でのみ送ります。
- `finish ... 1`が人間の勝利、`finish ... 0`が人間の敗北です。
- `session`・`round`はロボット通知の値を使用し、Webで新規採番しません。開始受付でroundが1増える実装にも対応し、以降の指示には通知された新しい値を使います。
- 自分の開始指示と無関係なsession変更・戦闘中のround変更は中断扱いにし、新しいゲームへ中断指示を送りません。正常復帰後のstandbyでのround更新は許容します。
- `command_accepted`は受付、`command_rejected`は拒否です。動作開始は`fighting`、復帰完了は`standby`で確認します。
- 切断や再接続では指示を自動再送せず、ゲームを自動再開しません。

## QoS

| 用途 | Reliability | Durability | History | Depth |
| --- | --- | --- | --- | --- |
| command / heartbeat / parry | Reliable | Volatile | Keep Last | 10 |
| status | Reliable | Transient Local | Keep Last | 1 |

Webはrosbridgeのadvertise/subscribeに`qos`を明示します。管理画面のログ表示用購読と、ゲーム用の状態購読は独立しています。
ゲーム用は状態遷移・受付イベントを間引かないよう、`throttle_rate: 0`・`queue_length: 10`を指定します。

rosbridge側で指定が適用されているか、ROS側の`ros2 topic info --verbose`などで確認してください。古いrosbridgeが未知の指定を無視した場合、Webの接続成功表示だけでは判別できません。
設定項目は[rosbridge公式プロトコル](https://github.com/RobotWebTools/rosbridge_suite/blob/ros2/ROSBRIDGE_PROTOCOL.md)を参照してください。

## 中断・通信途絶

- 状態を受信してから2秒経過、またはheartbeatの送信処理が2秒以上止まった場合は、ゲームを中断してheartbeatを停止します。画面を再表示しても遅れた指示をまとめて送りません。
- 状態の鮮度・接続・sessionを確認できない場合、古い状態を使って`abort`を送信しません。資料では、ロボットがheartbeatの3秒途絶を検知して停止処理後に`fault`へ移行します。
- Esc・戻る等によるゲーム中断、ページ終了・非表示、異常中断ボタンでは、接続と同一ゲームの新しい状態が確認できれば`abort`を1回送ります。送信失敗やページ終了時の到達は保証できません。
- `abort`は異常中断で、正常終了時の復帰動作を行いません。`fault`の解除は機器側で行い、新しい`standby`の継続受信後に手動で開始します。
- 開始・終了指示後の状態変化は10秒を初期の待ち時間とします。`stopping`・`returning`が確認できた後は所要時間を決めつけず、新しい状態通知が続く間は復帰を待ちます。
- heartbeat・abortは安全規格に対応した非常停止の代替ではありません。

## 試験と未確認事項

```sh
npm test
npm run build
CHAMBARA_PYTHON=../voice_recognition_and_bgm_app/.venv/bin/python npm run test:robot-integration
```

単体試験では状態の鮮度、開始待ち、結果通知、切断、再送防止を確認します。結合試験は実際のPythonとWebの制御クラスを使用し、ROSロボット・ESP・会話・音声を模擬します。

実際のROS 2通信、QoSの適用、ロボットの動作・停止、音と動作のずれは未確認です。ROS側の起動方法・バージョン、roundの更新タイミング、100msのパリィ通知と10秒の状態変化待ちが実機で適切かを合わせて確認してください。画像の資料には動作開始の予約時刻がないため、ロボット動作とBGMの厳密な同時開始は保証しません。
