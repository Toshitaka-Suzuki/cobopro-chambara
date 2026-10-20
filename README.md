# ロボットと、チャンバラ。

ロボットと剣を交える展示ゲームの試作UIです。React / TypeScript / Viteで開発しています。

- **プレイ画面**：機器なしのモック、またはUSBシリアルのセンサ入力でゲームを試せます。
- **管理者画面**：USBの接続・入力確認と、ROSのtopic・サービスの確認ができます。
- **会話・BGM連携**：`voice_recognition_and_bgm_app`の統合版と接続し、作戦の会話→カウントダウン→対戦→感想の会話を進めます。

実機連携は開発中です。ROSとゲーム進行の連携は未実装です。

## 2つのリポジトリをクローンして動かす

以下は、**同じPCで画面とPythonを動かし、会話は模擬・BGMは実際に再生する**手順です。LLM・マイク・USBセンサ・ロボットは不要です。

### 1. 必要なもの

- Git
- Node.js 22.18以降（npmを含む）
- Python 3.11または3.12
- ブラウザーと、音の出るスピーカーまたはヘッドホン

### 2. 両方を取得する

ターミナル（WindowsではPowerShell）で、作業用フォルダーへ移動して実行します。

```sh
git clone --branch main https://github.com/Toshitaka-Suzuki/cobopro-chambara.git
git clone --branch feat/browser-rhythm-guide https://github.com/Toshitaka-Suzuki/voice_recognition_and_bgm_app.git
```

Python側の連携変更は、現在 **Toshitaka-Suzukiのforkの`feat/browser-rhythm-guide`ブランチ**にあります。このブランチを指定してください。

```text
作業用フォルダー/
├─ cobopro-chambara/
└─ voice_recognition_and_bgm_app/
```

このPythonブランチには`data/bgm/`の`easy.ogg`・`normal.ogg`・`hard.ogg`も含まれています。BGMを別途用意する必要はありません。

### 3. Python側を準備して起動する（ターミナル1）

上記の作業用フォルダーから、使用するOSのコマンドを実行します。仮想環境のPythonを直接指定するので、有効化操作は不要です。

**Windows / PowerShell**

```powershell
cd voice_recognition_and_bgm_app
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-integration-test.txt
$env:PYTHONPATH = "src"
.\.venv\Scripts\python.exe -m chambara_app --mock-conversation
```

Python 3.12を入れた場合は、`py -3.11`を`py -3.12`に置き換えます。

**Mac**

```sh
cd voice_recognition_and_bgm_app
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements-integration-test.txt
PYTHONPATH=src .venv/bin/python -m chambara_app --mock-conversation
```

Python 3.12を入れた場合は、`python3.11`を`python3.12`に置き換えます。

`待ち受け ws://127.0.0.1:8765`と表示されたら、そのターミナルを開いたままにします。BGMはゲームの対戦が始まったときに流れます。

### 4. 画面側を準備して起動する（ターミナル2）

新しいターミナルを開き、手順2の作業用フォルダーへ移動して実行します。Windows / Mac共通です。

```sh
cd cobopro-chambara
npm ci
npm run dev
```

表示されたURL（通常は <http://127.0.0.1:5173>）をブラウザーで開きます。こちらのターミナルも開いたままにします。
PowerShellで`npm.ps1`の実行が拒否される場合は、`npm.cmd ci`と`npm.cmd run dev`を使用してください。

### 5. 接続して遊ぶ

1. 「プレイ画面」を開き、遊び方を「会話・BGM連携」にします。
2. 接続先を`ws://127.0.0.1:8765`にして「接続する」を押します。
3. 「準備完了」を確認し、入力方法を「ゲームテスト（モック）」にします。
4. 「ゲーム開始」を押すと、約3秒の模擬会話→カウントダウン→BGM付きの対戦と進みます。
5. 「タン・タン・タン・カン！」の最後の高い音に合わせてSpaceキー、または画面のSPACEボタンで受けます。成功したら、光る標的をクリックするか対応する1〜3キーで命中させます。

弱点への命中でLEVELが1→2→3へ上がり、BGMも変わります。3回命中すると勝利です。Bキーで紙風船破損による敗北も試せます。終了後の模擬会話が終わると次のゲームを始められます。

### 終了・次回の起動

プレイ中なら画面の「中断する」を押し、両方のターミナルでCtrl+Cを押して終了します。
次回は手順3・4の依存インストールと仮想環境作成を省き、各リポジトリで起動コマンドだけ実行します。Windowsでは新しいターミナルごとに`$env:PYTHONPATH = "src"`も設定してください。

### うまく動かない場合

| 症状 | 確認すること |
| --- | --- |
| `chambara_app`が見つからない | Pythonリポジトリ直下で実行し、上記の`PYTHONPATH`と`.venv`のPythonを使っているか確認します。 |
| 通信仕様が古い、`--mock-conversation`が認識されない | Python側で`git branch --show-current`を実行し、`feat/browser-rhythm-guide`か確認します。 |
| 接続できない | Python側に「待ち受け」が出ているか、接続先が`ws://127.0.0.1:8765`か確認します。制御接続は1つだけなので、別タブの接続も確認してください。 |
| ポート8765が使用中 | 既に起動しているPythonを使うか停止します。別ポートで起動するならPythonの起動コマンドに`--port 8766`を追加し、画面側も8766へ変更します。 |
| BGMが聞こえない | 対戦開始後か、PCの音量・出力先・Pythonのエラーを確認します。画面の「効果音」はPythonのBGMの音量には作用しません。 |
| 音声デバイスなしで通信だけ確認したい | Pythonの起動コマンドに`--silent-audio`を追加します。BGMと予告音は鳴りません。 |

実際の音声会話も使う場合はWindowsでLLM・マイク・音声認識・TTSの準備が必要です。
Python側の[README](https://github.com/Toshitaka-Suzuki/voice_recognition_and_bgm_app/blob/feat/browser-rhythm-guide/README.md)と[統合動作確認ガイド](https://github.com/Toshitaka-Suzuki/voice_recognition_and_bgm_app/blob/feat/browser-rhythm-guide/docs/integration-guide.md)を参照してください。通常の会話は、全依存と設定の準備後に`--mock-conversation`を外して起動します。

## 起動

Node.js 22.18以降を用意し、プロジェクト直下で実行します。

```sh
npm ci
npm run dev
```

ターミナルに表示されたURL（通常は <http://127.0.0.1:5173>）を開きます。
「プレイ画面」→「画面単独テスト」→「ゲームテスト（モック）」で、機器なしで試せます。

USB接続にはPC版ChromeなどのWeb Serial対応ブラウザー、ROSの確認には別途rosbridgeとrosapiが必要です。

センサ入力は改行区切りの `1` を接触信号として扱います。残信号やチャタリングによる連続判定を防ぐため、最後の接触信号から250ms以上途切れた後の信号を次の接触として受け付けます。受けから攻撃への切り替えや一時停止でも、この抑制は維持します。管理画面の受信数には、抑制した信号も含まれます。待ち時間は [src/swordSensor.ts](src/swordSensor.ts) の `SENSOR_QUIET_PERIOD_MS` で調整できます。

## 会話・BGMアプリと接続

1. 更新した`voice_recognition_and_bgm_app`側で`python -m chambara_app`を起動します。
2. この画面の「プレイ画面」で「会話・BGM連携」を選び、`ws://127.0.0.1:8765`へ接続します。
3. 「準備完了」を確認し、入力方法を選んで「ゲーム開始」を押します。

会話完了後にカウントダウンし、Pythonの`battle_started`通知を受けて60秒の時計を開始します。
受け入力は`parry`として送り、対応する`parry_result`の成功を待って弱点を点灯します。
命中時はロボットHPの絶対値を`weak_point_count`で送り、残り2でnormal、1でhard、0で人間勝利になります。
紙風船の破損・時間切れは`battle_end`を送り、ロボット勝利として感想の会話へ進みます。
会話が終わって`standby`を受けるまでは次のゲームを開始できません。

### 4拍のパリィガイド

更新した統合版は「タン・タン・タン・カン！」の4拍を案内します。3つの予告音で構え、最後の高い音と輪が重なる瞬間にSpaceを押します。画面の剣も同じタイミングで振り下ろします。
受けの見出しは拍ごとに切り替えず固定し、中央へ迫る剣と縮む輪でタイミングを示します。文字の補助には短い英語も併記します。
成功すると弱点攻撃へ進み、失敗するとEARLY／LATEと、目標の左右に置くマーカーでずれを表示します。
受け成功の約0.9秒間は、火花・外へ広がる輪・相手の剣の跳ね返りと「✓ PARRY!」を表示し、ブラウザーで金属音を鳴らします。
画面上部には現在のLEVELを常設し、弱点への命中時には「LEVEL UP」と1→2／2→3を大きく表示します。パリィだけではレベルは上がらず、最後の命中はレベル3のまま勝利になります。
これらの演出は既存の成功・命中表示の時間内に収まり、制限時間や判定を延長しません。動きを減らすOS設定では火花などの動きを省略します。
モックでは中央のSPACEボタンでも受けを入力でき、攻撃中は光る標的をクリックするか数字キーで叩けます。
攻撃・構え直し中は予告音を止め、次の受けでは途中の拍から入らず、完全な4拍から再開します。
判定は試作用に全難易度で目標の前後150ms（合計300ms）。難易度によってBGMのテンポと攻撃チャンスの長さが変わります。
実機のロボットは動かず、画面の剣は動きのガイドです。

予告音はPythonでBGMと同じ音声ストリームへ混ぜます。画面は`rhythm_sync`で200msごとに実際の音声出力位置を取得し、往復時間の半分を補正して輪・拍・剣を描画します。
同期が750ms以上途絶える、往復が180msを超える、または音声位置が不明な場合は予告表示を待機にします。
入力判定はPythonへの到着時刻が基準です。ネットワーク・ディスプレイ・USBの遅延の厳密な補正は未実装なので、別PCや実機では調整が必要です。
ブラウザーの「効果音」スイッチで予告音は消えません。Pythonを`--no-rhythm-guide`で起動すると従来の毎拍判定へ戻ります。

音声とBGMはPython側のPCで出力します。連携中はブラウザーの仮BGMを再生せず、効果音だけを出します。
画面の「効果音」スイッチはPythonのBGM・音声には作用しません。
ブラウザーには会話フェーズと案内を表示し、認識文・生成された返答はPythonのターミナルに表示します。
ROSによるロボット動作・実物の弱点ライト制御はまだ連動していません。

連携中のEsc／「中断する」／準備画面への移動は`game_cancel`で両側を待機状態へ戻します。
一時停止して途中から再開する機能は画面単独テストのみです。
センサ切断でも連携ゲームを中断します。通信切断・応答タイムアウトは接続を閉じ、再接続後は新しいゲームから始めます。
信号は再送せず、古い接続や古い受けの結果も適用しません。

別PCの場合、Pythonを`--host <Python側のLAN IP>`で起動し、画面にも同じIPを指定してください。
USBセンサを使う画面は、そのPCのlocalhostまたはHTTPSから開く必要があります。
HTTPSの画面からは`wss://`が必要です。
rosbridgeの9090番とは別の接続です。古いPython側には開始を許可せず、通信仕様v2への更新を案内します。

### LLMなしで確認

Python側で次のどちらかを起動し、上記と同じ画面から接続します。

```sh
# 会話のみ模擬。実際のBGMとパリイ判定を確認
python -m chambara_app --mock-conversation

# 会話・音声出力を省略。通信と状態遷移を確認
python -m chambara_app --mock-conversation --silent-audio
```

模擬会話は約3秒で完了し、LLM・マイク・音声認識・読み上げを使用しません。
無音版でもパリイは設定された時間帯で判定するため、Spaceを押すたびに成功するわけではありません。
両方ともMacで実行できます。軽量な準備手順はPython側の`docs/integration-guide.md`を参照してください。

## ビルド

依存関係をインストールした状態で実行します。

```sh
npm run build
```

型検査後、本番用ファイルを `dist/` に生成します。生成結果をローカルで確認する場合は次を実行します。

```sh
npm run preview
```

## 開発時の確認

```sh
npm test
```

Python側の軽量依存がある場合、別ポートに無音の統合サーバーを自動起動して、実際のWebSocketで勝利・敗北・会話中断まで確認できます。起動したテスト用サーバーは終了時に停止します。

```sh
npm run test:integration
```

既定では隣の`../voice_recognition_and_bgm_app`と`python`コマンドを使用します。
必要に応じて`CHAMBARA_APP_DIR`と`CHAMBARA_PYTHON`環境変数で変更してください。
この確認は実音声の同期精度・LLM・USB・ロボットの実機検証を含みません。

実装は [src/](src/) を参照してください。
