# Audio Score

音声ファイルから楽譜を自動生成する [GemiHub](https://github.com/takeshy/gemihub) プラグインです。Spotify の [basic-pitch](https://github.com/spotify/basic-pitch) ML モデルを使用してピッチ検出を行います。

[English](README.md)

## 機能

- **ML ベースピッチ検出** — basic-pitch によるポリフォニック（和音）検出
- **五線譜レンダリング** — Canvas 2D による音部記号・調号・拍子記号付き楽譜表示
- **和音対応** — 同時発音ノートを共有ステムでグルーピング
- **再生** — Web Audio API によるスコア再生
- **エクスポート** — Google Drive へ `.md` 形式で保存、PNG ダウンロード
- **自動読み込み** — `-score.md` ファイルを開くと楽譜を自動表示
- **ドラッグ＆ドロップ** — 音声ファイルの直接読み込み
- **多言語対応** — 日本語・英語

## インストール

[最新リリース](https://github.com/takeshy/audio-score/releases)から `main.js`、`manifest.json`、`styles.css` をダウンロードし、GemiHub のプラグインディレクトリに配置してください:

```
plugins/audio-score/
  main.js
  manifest.json
  styles.css
```

## 使い方

1. GemiHub サイドバーで Audio Score パネルを開く
2. **ファイルを読み込む** をクリック、またはオーディオファイル（MP3、WAV 等）をドラッグ＆ドロップ
3. 解析完了を待つと楽譜が自動表示される
4. ツールバーから再生、Drive エクスポート、PNG 保存が可能

### スコアテキスト形式

エクスポートされる `-score.md` ファイルのフォーマット:

```
BPM: 120
Key: C major
Time: 4/4
Clef: treble

M1: C4(quarter) E4(quarter) G4(quarter) [C4,E4,G4](quarter)
M2: ...
```

## 設定

| 設定 | デフォルト | 説明 |
|---|---|---|
| Onset Threshold | 0.5 | 音の立ち上がり検出感度 (0–1) |
| Frame Threshold | 0.3 | 音の存在判定感度 (0–1) |
| 最小ノート長 | 0.05秒 | これより短いノートを除外 |
| 1小節の拍数 | 4 | 拍子記号の分子 |

## 開発

```bash
npm install --legacy-peer-deps
npm run dev    # ウォッチモード
npm run build  # プロダクションビルド
npm test       # テスト実行
```

## ライセンス

MIT
