# Demucs WASM モデル形式の調査記録

## 概要

`demucs_onnx_simd.wasm` が期待するモデル形式を、WASM バイナリ解析と実験的テストにより特定した記録。

---

## WASM の素性

- **出典**: sevagh の private repo `repos-tonalmesh/cpp-core`
- **ORT build info**: `git-branch=fs-eire/w403, git-commit-id=3fe2a36ffe, build type=MinSizeRel`
- **内部ライブラリ**: ONNX Runtime 1.22.x (minimal build, SIMD有効)
- **エクスポート**:
  - `_modelInit(ptr: i32, len: i32) → void`
  - `_modelDemixSegment(inL, inR, len, out0L, out0R, ..., out5L, out5R, 0, 1, 0) → void`

---

## `_modelInit` の挙動解析

### WASM バイナリ解析で判明したこと

WASM の `_modelInit` (export "S", function[1594]) を命令列レベルで解析した結果:

1. **命令 150**: `call $41(2 * n_bytes)` → `malloc(2 * n_bytes)` でバッファ確保
2. **命令 403–404**: `local.18 = local.15` → 確保したバッファをモデルデータとして使用
3. **命令 6747**: `call_indirect` via `OrtApi[32]` → `CreateSessionFromArray` 呼び出し
4. **命令 16294 (エラーパス)**: `i32.const 0x58fa` → "Error loading Demucs model" のアドレス

`2 * n_bytes` のバッファ確保はgzip展開用のバッファ。
つまり `_modelInit` は **内部でgzip展開を行い、展開後のバイトをORT `CreateSessionFromArray` に渡す**。

### 実験的確認

```
Raw ORT bytes       → "Error loading Demucs model" + exit(1)  # gzip展開に失敗
Gzip-compressed ORT → operator error (ORT がモデルをロードできた)  ✓
Gzip-compressed GGML→ "ONNX format model is not supported in this build"  # ORT がロードするも形式不一致
```

**結論**: `_modelInit` は **gzip圧縮されたORT FlatBuffer** を期待する。

### 戻り値

`_modelInit` は `void` を返す（JS側では `undefined`）。失敗時は `exit(1)` を呼び出してプロセスを終了させる。`false` や `null` を返すわけではないので、戻り値チェックは不要。

---

## 正しいモデル形式

```
htdemucs_6s.ort.gz
└── gzip compressed
    └── ORT FlatBuffer (magic: ORTM at offset 4)
```

**注意**: GCS の旧ファイル (`1772580430729-htdemucs_6s.ort.gz`) は中身が **GGML 形式** (`6cmd` magic) であり、このWASMでは使用不可。

---

## WASM の対応オペレータセット

`--include_ops_by_config` でビルドされた minimal build のため、対応演算子は限定されている。

### 対応 (確認済み)

| Domain | Opset | Ops |
|--------|-------|-----|
| ai.onnx | 6 | InstanceNormalization |
| ai.onnx | 11 | Conv, ConvTranspose |
| ai.onnx | 13 | Erf, Gemm, MatMul, ReduceMean, Sigmoid, Slice, Softmax, Split, Sqrt, Squeeze, Transpose, Unsqueeze |
| ai.onnx | 14 | Add, Div, Mul, Reshape, Sub |
| ai.onnx | 17 | LayerNormalization |
| com.microsoft | 1 | FusedMatMul, Gelu |

### 非対応 (エラーで確認)

- `Pad(13)` — WASM バイナリに "Pad" の単体レジストリエントリが存在しない
- `ReduceMean(18)` — opset 18 は含まれていない
- `Split(18)` — `num_outputs` 属性は opset 18 で追加されたもの

---

## モデル生成手順

### 環境

```bash
python3 -m venv /tmp/.venv
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install onnx onnxruntime onnxscript dora-search diffq einops julius pyyaml tqdm
pip install -e /tmp/demucs-onnx-repo/demucs-for-onnx/ --no-deps
# openunmix は torchaudio 依存で壊れているのでスタブ化
```

### Step 1: ONNX エクスポート (dynamo exporter, opset 18)

```python
# dynamo=False (old exporter) は Pad(13) ノードを生成するため使用不可
# dynamo=True (新exporter) は Pad なし、ただし ReduceMean(18)/Split(18) を使用
torch.onnx.export(
    core_model, (dummy_waveform, magspec),
    "htdemucs_6s.onnx",
    dynamo=True,   # ← Pad ノードを回避するために必須
)
```

**なぜ dynamo=True が必要か**:

- `dynamo=False` (旧エクスポータ): 時間エンコーダで動的パディング (`Pad(13)`) を生成する。動的Padは Conv と融合できず、WASM の minimal build に Pad カーネルが含まれていないため失敗。
- `dynamo=True` (新エクスポータ): Pad ノードを生成しない代わりに `ReduceMean(18)` と `Split(18)` を使用。これらも WASM 非対応だが、後工程でパッチ可能。

### Step 2: ReduceMean(18) と Split(18) のダウングレード

```python
for node in graph.node:
    if node.op_type == 'ReduceMean':
        # axes を input[1] から attribute に移動 (opset 13 形式)
        axes = numpy_helper.to_array(init_map[node.input[1]]).tolist()
        new_node = helper.make_node('ReduceMean', [node.input[0]], list(node.output),
                                    axes=[int(x) for x in axes], keepdims=1)
    if node.op_type == 'Split':
        # num_outputs attribute を削除 (opset 13 では不要)
        new_node = helper.make_node('Split', list(node.input), list(node.output),
                                    axis=axis)  # num_outputs なし

model.opset_import[0].version = 17
```

**変更理由**:
- `ReduceMean(18)`: opset 18 で axes が動的入力になったが、WASM は opset 13 (axes が静的属性) しか含まない
- `Split(18)`: `num_outputs` 属性が opset 18 で追加されたが、opset 13 では出力テンソルの個数から自動推論

### Step 3: ORT FlatBuffer に変換

```bash
python -m onnxruntime.tools.convert_onnx_models_to_ort \
    htdemucs_6s_patched.onnx \
    --enable_type_reduction
```

### Step 4: gzip 圧縮

```bash
gzip -9 -c htdemucs_6s_patched.ort > htdemucs_6s.ort.gz
```

---

## 動作確認

Node.js でのエンドツーエンドテスト結果:

```
WASM ready, loading model...
Model loaded!
Running inference...
Beginning Demucs inference
Doing inference, writing results in-place
ONNX inference completed.
Segment inference complete
ONNX inference completed.
Segment inference complete
Copying waveforms
Done in 33834ms
drums: max=0.0016, rms=0.0000
bass:  max=0.0271, rms=0.0004
other: max=0.0548, rms=0.0320
vocals:max=0.0002, rms=0.0001
guitar:max=0.0002, rms=0.0000
piano: max=0.0006, rms=0.0001
```

6 ステム全て正常に抽出できることを確認。

---

## `demucsService.ts` の実装上の注意点

### _modelInit の呼び出し

```javascript
// ✗ 誤り: _modelInit は void を返すので ok は常に undefined
var ok = mod._modelInit(ptr, len);
if (!ok) throw new Error('returned false');  // 常に throw してしまう

// ✓ 正しい: 戻り値チェック不要。失敗時は WASM が exit(1) で終了する
mod._modelInit(ptr, len);
mod._free(ptr);
postMessage({ msg: 'MODEL_READY' });
```

### IDB キャッシュキー

モデルを差し替えた際はキャッシュキーを変更してブラウザのキャッシュを無効化すること。

```typescript
// 現在のキー
"demucs_model_ort_patched_v1"
```

---

## 成果物の場所

| ファイル | 場所 |
|---------|------|
| 生成済みモデル (ORT, 150MB) | `/tmp/htdemucs_6s_onnx/htdemucs_6s_patched.ort` |
| gzip圧縮モデル (63MB) | `/tmp/htdemucs_6s_patched.ort.gz` |
| GCS URL | `https://storage.googleapis.com/takeshy-work-public-files/htdemucs_6s_patched.ort.gz` |
| PyTorchチェックポイント | `~/.cache/torch/hub/checkpoints/5c90dfd2-34c22ccb.th` (htdemucs_6s) |
| Python環境 | `/tmp/.venv` |
| demucs-onnxリポジトリ | `/tmp/demucs-onnx-repo/` |
