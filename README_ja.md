# Audio Score - 音声から楽譜へ

音声ファイルから楽譜を自動生成する [GemiHub](https://github.com/takeshy/gemihub) プラグインです。MLベースのピッチ検出により、検出されたノートを五線譜上にレンダリングし、再生もサポートします。

[English](README.md)

## 機能

- **2種類のピッチ検出モデル**
  - **Basic Pitch** (Spotify) — TensorFlow.js による汎用ポリフォニック検出
  - **Piano Transcription** (ByteDance CRNN) — ONNX Runtime Web WASM によるピアノ専用検出（並列ワーカー推論対応）
- **音源分離** — Demucs WASM (htdemucs_6s) により解析前にステム分離（ピアノ、ボーカル、ベース、ドラム、ギター、その他）
- **自動音楽解析** — BPM検出、調号判定（Krumhansl-Schmuckler）、音部記号選択、拍子量子化
- **五線譜レンダリング** — Canvas ベースの楽譜表示（符頭、臨時記号、加線、小節線）
- **スコア再生** — Web Audio API による検出ノートの再生。小節クリックでその位置から再生開始、再生中は現在の小節がハイライト表示
- **MIDIインポート** — `.mid` / `.midi` ファイルをファイル選択、ドラッグ＆ドロップ、Driveから読み込んで楽譜表示
- **エクスポート** — MIDI、PDF、テキストスコア、ステムWAVダウンロード
- **AI改善** — Gemini連携によるコード解析・スコア改善（オプション）
- **多言語UI** — 日本語・英語

## インストール

`main.js`、`manifest.json`、`styles.css` を GemiHub のプラグインディレクトリにコピーしてください:

```
plugins/audio-score/
  main.js
  manifest.json
  styles.css
```

## 使い方

1. GemiHub サイドバーで Audio Score パネルを開く
2. **Load** をクリック、またはオーディオファイル（MP3、WAV 等）や `.mid` ファイルをドラッグ＆ドロップ
3. オーディオファイルの場合、検出モデルを選択（Basic Pitch または Piano Transcription）
4. 必要に応じて音源分離を有効にしてステムを分離
5. **Analyze** をクリック — 解析完了後に楽譜が表示される
6. ツールバーから再生、MIDI/PDFエクスポート、ステムダウンロードが可能
7. 楽譜キャンバスをクリックするとその小節から再生開始

## アーキテクチャ

```
src/
├── main.ts                           # プラグインエントリポイント
├── types.ts                          # 共有型定義 (DetectedNote, ScoreData 等)
├── i18n.ts                           # 国際化 (en/ja)
├── core/
│   ├── basicPitchDetector.ts         # Spotify basic-pitch (TF.js CDN)
│   ├── pianoTranscriptionService.ts  # ByteDance CRNN (ORT Web WASM)
│   ├── demucsService.ts              # Demucs WASM 音源分離
│   ├── musicTheory.ts                # BPM、調、量子化、小節分割
│   ├── noteSegmenter.ts              # DetectedNote[] → ScoreData パイプライン
│   ├── midiImport.ts                 # Standard MIDI File インポートパーサ
│   ├── midiExport.ts                 # Standard MIDI File エクスポート
│   ├── aiService.ts                  # Gemini AI（コード解析、スコア改善）
│   ├── scoreParser.ts                # スコアテキスト形式パーサ
│   └── player.ts                     # Web Audio 再生
├── ui/
│   ├── ScorePanel.tsx                # サイドバーパネル（操作 + 結果）
│   ├── MainView.tsx                  # メインビュー（五線譜レンダリング）
│   ├── SettingsPanel.tsx             # 設定ダイアログ
│   ├── ScoreRenderer.ts             # Canvas ベース楽譜レンダラ
│   └── pdfExport.ts                 # jsPDF による PDF 生成
└── storage/
    └── idb.ts                        # IndexedDB キャッシュ（モデル、一時データ）
```

## 解析パイプライン

1. **デコード** — Web Audio API で入力ファイルをデコード
2. **分離**（オプション） — Demucs で選択ステムを分離
3. **検出** — Basic Pitch または Piano Transcription でノート抽出
4. **BPM** — オンセット間隔のヒストグラムによるテンポ検出
5. **量子化** — 開始時刻を32分音符グリッドにスナップ、音価を最近の音楽的値に変換
6. **調判定** — ピッチクラスヒストグラムに対する Krumhansl-Schmuckler アルゴリズム
7. **小節分割** — 拍子記号とダウンビートオフセットによるノートの小節分配
8. **レンダリング** — Canvas 五線譜上に正しい記譜法で描画

## 設定

| 設定 | デフォルト | 説明 |
|---|---|---|
| 解析モデル | Basic Pitch | Basic Pitch（汎用）または Piano Transcription（ピアノ専用） |
| Onset Threshold | 0.5 | 音の立ち上がり検出感度、Basic Pitch のみ (0-1) |
| Frame Threshold | 0.3 | 音の存在判定感度、Basic Pitch のみ (0-1) |
| 最小ノート長 | 0.03秒 | これより短いノートを除外 |
| 1小節の拍数 | 4 | 拍子記号の分子 |
| 拍の単位 | 4 | 拍子記号の分母 |
| BPM指定 | 0 | BPMを固定（0 = 自動検出） |
| 音域 | 全て | 全て / 低音カット (C3+) / メロディのみ (C4-C7) |
| 最小振幅 | 0 | 振幅しきい値（0 = 無効） |
| 音源分離 | オフ | Demucs ステム分離を有効化 |
| 分離ステム | ピアノ | 対象ステム: ドラム、ベース、その他、ボーカル、ギター、ピアノ |

## 外部アセット

大容量モデルファイルは GCS でホストされ、初回使用時にダウンロードされます。以降は IndexedDB にキャッシュされます。

| アセット | サイズ | 説明 |
|---|---|---|
| `demucs_onnx_simd.wasm` | 約5 MB | Demucs WASM バイナリ（ORT minimal, SIMD） |
| `htdemucs_6s.ort.gz` | 約63 MB | Demucs モデル重み（gzip ORT FlatBuffer） |
| `piano_transcription.ort.gz` | 約134 MB | ピアノ転写モデル（gzip ORT FlatBuffer） |

Basic Pitch モデル（約10 MB）と TensorFlow.js は公開 CDN から読み込まれます。

## 開発

```bash
npm install
npm run dev      # ウォッチモード
npm run build    # 型チェック + プロダクションビルド
npm test         # vitest 実行
```

### デプロイ

```bash
cp main.js styles.css manifest.json ~/pkg/gemihub/data/plugins/audio-score/
```

## サードパーティライセンス

本プラグインは以下のサードパーティモデル・ライブラリを使用しています:

| コンポーネント | 作者 | コードライセンス | モデル/重みライセンス |
|---|---|---|---|
| [Basic Pitch](https://github.com/spotify/basic-pitch) | Spotify | Apache 2.0 | Apache 2.0 |
| [Piano Transcription](https://github.com/bytedance/piano_transcription) | ByteDance | MIT | CC BY 4.0 |
| [Demucs / htdemucs](https://github.com/adefossez/demucs) | Meta (Facebook Research) | MIT | 研究目的のみ |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | Microsoft | MIT | — |
| [TensorFlow.js](https://github.com/tensorflow/tfjs) | Google | Apache 2.0 | — |

**注意:** Demucs モデル重み（htdemucs_6s）は MUSDB18-HQ で訓練されており、研究目的での使用を意図しています。Piano Transcription モデル重みは CC BY 4.0 でライセンスされており、ByteDance への帰属表示が必要です。

## ライセンス

MIT
