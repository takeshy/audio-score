/**
 * Demucs WASM-based audio source separation service.
 *
 * Uses the freemusicdemixer.com WASM engine and htdemucs_6s model weights to
 * separate audio into stems (drums, bass, other, vocals, guitar, piano)
 * entirely in the browser — no server required.
 *
 * Assets are fetched via the `fetchAsset` callback, which in GemiHub is
 * backed by `api.assets.fetch(name)` — a server-side proxy that downloads
 * from upstream URLs declared in manifest.json and caches them locally.
 *
 * htdemucs_6s stem order:
 *   0: drums  1: bass  2: other  3: vocals  4: guitar  5: piano
 */

import { getTemporary, saveTemporary } from "../storage/idb";
import { StemName } from "../types";

/** htdemucs_6s stem index by name */
const STEM_INDEX: Record<StemName, number> = {
  drums: 0, bass: 1, other: 2, vocals: 3, guitar: 4, piano: 5,
};

/** Demucs native sample rate */
const DEMUCS_SAMPLE_RATE = 44100;

/** Inline Web Worker code (runs inside a Blob URL worker) */
const WORKER_CODE = `
(function () {
  var mod = null;

  async function handle(e) {
    var msg = e.data.msg;

    if (msg === 'LOAD_WASM') {
      // Load the Emscripten JS (MODULARIZE=1 → defines libdemucs factory).
      // wasmBinaryBuffer is pre-fetched and passed directly to avoid the
      // Emscripten module making a cross-origin .wasm fetch.
      var blob = new Blob([e.data.wasmJsBuffer], { type: 'application/javascript' });
      var url = URL.createObjectURL(blob);
      importScripts(url);
      URL.revokeObjectURL(url);
      // Pass the pre-fetched WASM binary via Module.wasmBinary so Emscripten
      // uses it directly and never makes a URL-based fetch for the .wasm file.
      // (instantiateAsync skips streaming when binary is provided, and
      //  getWasmBinary returns it directly without hitting the network.)
      libdemucs({
        wasmBinary: e.data.wasmBinaryBuffer
      }).then(function(instance) {
        mod = instance;
        postMessage({ msg: 'WASM_READY' });
      }).catch(function(err) {
        postMessage({ msg: 'ERROR', error: String(err) });
      });

    } else if (msg === 'INIT_MODEL') {
      // Pass raw bytes (gzip-compressed ORT FlatBuffer) directly to _modelInit.
      // The WASM handles gzip decompression internally. _modelInit returns void on
      // success and calls exit(1) on failure (no return value check needed).
      var rawData = new Uint8Array(e.data.modelBuffer);
      var ptr = mod._malloc(rawData.byteLength);
      if (!ptr) throw new Error('_malloc failed for model (' + rawData.byteLength + ' bytes)');
      mod.HEAPU8.set(rawData, ptr);
      mod._modelInit(ptr, rawData.byteLength);
      mod._free(ptr);
      postMessage({ msg: 'MODEL_READY' });

    } else if (msg === 'PROCESS') {
      var L = new Float32Array(e.data.leftChannel);
      var R = new Float32Array(e.data.rightChannel);
      var len = L.length;
      var NUM_STEMS = 6;   // htdemucs_6s
      var stemIdx = (e.data.stemIdx !== undefined) ? e.data.stemIdx : 5; // default: piano

      var inL = mod._malloc(len * 4);
      var inR = mod._malloc(len * 4);
      mod.HEAPF32.set(L, inL >> 2);
      mod.HEAPF32.set(R, inR >> 2);

      // Allocate output pointers: [stem0_L, stem0_R, stem1_L, stem1_R, ...]
      var outs = [];
      for (var i = 0; i < NUM_STEMS; i++) {
        outs.push(mod._malloc(len * 4)); // L
        outs.push(mod._malloc(len * 4)); // R
      }

      // _modelDemixSegment(inL, inR, len, out0L, out0R, ..., batch, modelTotal, modelIdx)
      mod._modelDemixSegment.apply(null, [inL, inR, len].concat(outs).concat([0, 1, 0]));

      var stemL = new Float32Array(mod.HEAPF32.buffer, outs[stemIdx * 2],     len);
      var stemR = new Float32Array(mod.HEAPF32.buffer, outs[stemIdx * 2 + 1], len);
      var left  = new Float32Array(stemL);
      var right = new Float32Array(stemR);

      mod._free(inL);
      mod._free(inR);
      for (var j = 0; j < outs.length; j++) mod._free(outs[j]);

      postMessage({ msg: 'SEPARATED', left: left.buffer, right: right.buffer }, [left.buffer, right.buffer]);
    }
  }

  onmessage = function (e) {
    handle(e).catch(function(err) { postMessage({ msg: 'ERROR', error: String(err) }); });
  };
})();
`;

type WorkerMsg =
  | { msg: "WASM_READY" }
  | { msg: "MODEL_READY" }
  | { msg: "SEPARATED"; left: ArrayBuffer; right: ArrayBuffer }
  | { msg: "ERROR"; error: string };

function workerSend(
  worker: Worker,
  data: object,
  transfer: Transferable[],
  waitFor: string,
): Promise<WorkerMsg> {
  return new Promise((resolve, reject) => {
    const listener = (e: MessageEvent<WorkerMsg>) => {
      if (e.data.msg === waitFor) {
        worker.removeEventListener("message", listener);
        resolve(e.data);
      } else if (e.data.msg === "ERROR") {
        worker.removeEventListener("message", listener);
        reject(new Error((e.data as { msg: "ERROR"; error: string }).error));
      }
    };
    worker.addEventListener("message", listener);
    worker.postMessage(data, transfer);
  });
}

/** Validate WASM magic bytes: \0asm (00 61 73 6d). */
function isValidWasm(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  const v = new Uint8Array(buf, 0, 4);
  return v[0] === 0x00 && v[1] === 0x61 && v[2] === 0x73 && v[3] === 0x6d;
}

/**
 * Fetch an asset by name, using IndexedDB as a client-side cache.
 * `fetchAsset` is the callback that actually fetches the bytes
 * (typically `api.assets.fetch` in GemiHub).
 * `validate` — optional predicate; if the cached data fails it, the cache
 * entry is discarded and the asset is re-fetched (handles corruption from
 * previous failed runs that cached non-binary data).
 */
async function fetchWithCache(
  cacheKey: string,
  assetName: string,
  fetchAsset: (name: string) => Promise<ArrayBuffer>,
  validate?: (buf: ArrayBuffer) => boolean,
): Promise<ArrayBuffer> {
  try {
    const cached = await getTemporary(cacheKey);
    if (cached instanceof Blob) {
      const buf = await cached.arrayBuffer();
      if (!validate || validate(buf)) return buf;
      // Corrupted cache entry — evict and re-fetch
      console.warn(`[demucs] cached ${assetName} failed validation, re-fetching`);
    }
  } catch {
    // ignore cache miss
  }

  const buffer = await fetchAsset(assetName);

  // Cache for future use (fire-and-forget)
  saveTemporary(cacheKey, new Blob([buffer])).catch(() => {});

  return buffer;
}

/** Resample an AudioBuffer to the target sample rate. */
async function resampleTo(buffer: AudioBuffer, targetRate: number): Promise<AudioBuffer> {
  if (buffer.sampleRate === targetRate) return buffer;
  const numFrames = Math.ceil(buffer.duration * targetRate);
  const ctx = new OfflineAudioContext(buffer.numberOfChannels, numFrames, targetRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

export interface SeparationProgress {
  stage: "downloading_wasm" | "downloading_model" | "initializing" | "separating";
  /** 0–100 */
  percent: number;
}

/**
 * Overlap added to each chunk boundary so Demucs can process the edge region
 * with full context. Covers the ~1.95-s internal transition zone (7.8 s × 0.25).
 */
const CROSSFADE_SAMPLES = Math.round(2 * DEMUCS_SAMPLE_RATE); // 2 s ≈ 88 200 frames

/** Number of parallel workers. Bounded to avoid excessive memory use (66 MB model × N). */
const MAX_WORKERS = 4;

/**
 * Separate a stem from a mixed AudioBuffer using the Demucs htdemucs_6s model
 * compiled to WebAssembly.
 *
 * Audio is split into N equal chunks, each extended by CROSSFADE_SAMPLES on
 * both sides so Demucs has context at the boundaries. After parallel inference,
 * adjacent chunks are crossfaded over the 2×CROSSFADE overlap region.
 * N = min(hardwareConcurrency, MAX_WORKERS).
 *
 * @param audioBuffer  Input audio (any sample rate — resampled to 44 100 Hz internally).
 * @param stem         Stem to extract: "drums" | "bass" | "other" | "vocals" | "guitar" | "piano".
 * @param fetchAsset   Callback to fetch a named asset by name. In GemiHub use
 *                     `(name) => api.assets.fetch(name)`.
 * @param onProgress   Optional progress callback.
 * @returns AudioBuffer containing only the requested stem at 44 100 Hz.
 */
export async function separateStem(
  audioBuffer: AudioBuffer,
  stem: StemName,
  fetchAsset: (name: string) => Promise<ArrayBuffer>,
  onProgress?: (p: SeparationProgress) => void,
): Promise<AudioBuffer> {
  const stemIdx = STEM_INDEX[stem];
  // ── 1. Resample ──────────────────────────────────────────────────────────
  const resampled = await resampleTo(audioBuffer, DEMUCS_SAMPLE_RATE);
  const totalFrames = resampled.length;

  // ── 2. Fetch shared assets ────────────────────────────────────────────────
  onProgress?.({ stage: "downloading_wasm", percent: 0 });
  const wasmJsBuffer = await fetchWithCache(
    "demucs_wasm_js_v2", "demucs_onnx_simd.js", fetchAsset,
  );
  onProgress?.({ stage: "downloading_wasm", percent: 50 });
  const wasmBinaryBuffer = await fetchWithCache(
    "demucs_wasm_bin_v2", "demucs_onnx_simd.wasm", fetchAsset, isValidWasm,
  );
  onProgress?.({ stage: "downloading_wasm", percent: 100 });

  onProgress?.({ stage: "downloading_model", percent: 0 });
  const modelBuffer = await fetchWithCache(
    "demucs_model_ort_patched_v1", "htdemucs_6s.ort.gz", fetchAsset,
  );
  onProgress?.({ stage: "downloading_model", percent: 100 });

  // ── 3. Determine parallelism ──────────────────────────────────────────────
  // Each core chunk must be wider than 2×CF so the pure (non-crossfade) region
  // is non-empty.
  const hwConcurrency = typeof navigator !== "undefined"
    ? (navigator.hardwareConcurrency ?? 2) : 2;
  const nWorkers = Math.max(
    1,
    Math.min(hwConcurrency, MAX_WORKERS, Math.floor(totalFrames / (2 * CROSSFADE_SAMPLES + 1))),
  );
  const coreSize = Math.ceil(totalFrames / nWorkers);

  // ── 4. Build overlapping chunk descriptors ────────────────────────────────
  const ch0 = resampled.getChannelData(0);
  const ch1 = resampled.getChannelData(resampled.numberOfChannels > 1 ? 1 : 0);

  const chunks = Array.from({ length: nWorkers }, (_, i) => {
    const coreStart  = i * coreSize;
    const coreEnd    = Math.min(coreStart + coreSize, totalFrames);
    const inputStart = i === 0            ? 0           : coreStart - CROSSFADE_SAMPLES;
    const inputEnd   = i === nWorkers - 1 ? totalFrames : coreEnd   + CROSSFADE_SAMPLES;
    return {
      L: new Float32Array(ch0.subarray(inputStart, inputEnd)),
      R: new Float32Array(ch1.subarray(inputStart, inputEnd)),
      inputStart,
      coreStart,
      coreEnd,
    };
  });

  // ── 5. Init all workers in parallel ──────────────────────────────────────
  onProgress?.({ stage: "initializing", percent: 0 });

  const createdWorkers: Worker[] = [];
  let workers: Worker[];
  try {
    workers = await Promise.all(chunks.map(async () => {
      const blob = new Blob([WORKER_CODE], { type: "application/javascript" });
      const url  = URL.createObjectURL(blob);
      const w    = new Worker(url);
      URL.revokeObjectURL(url);
      createdWorkers.push(w);
      const wasmJs  = wasmJsBuffer.slice(0);
      const wasmBin = wasmBinaryBuffer.slice(0);
      await workerSend(w, { msg: "LOAD_WASM", wasmJsBuffer: wasmJs, wasmBinaryBuffer: wasmBin }, [wasmJs, wasmBin], "WASM_READY");
      const model = modelBuffer.slice(0);
      await workerSend(w, { msg: "INIT_MODEL", modelBuffer: model }, [model], "MODEL_READY");
      return w;
    }));
  } catch (e) {
    createdWorkers.forEach(w => w.terminate());
    throw e;
  }

  onProgress?.({ stage: "initializing", percent: 100 });

  // ── 6. Separate each chunk in parallel ───────────────────────────────────
  onProgress?.({ stage: "separating", percent: 0 });

  const results = await Promise.all(
    workers.map(async (w, i): Promise<{ left: ArrayBuffer; right: ArrayBuffer }> => {
      const chunk = chunks[i];
      try {
        return (await workerSend(
          w,
          { msg: "PROCESS", leftChannel: chunk.L.buffer, rightChannel: chunk.R.buffer, stemIdx },
          [chunk.L.buffer, chunk.R.buffer],
          "SEPARATED",
        )) as { msg: "SEPARATED"; left: ArrayBuffer; right: ArrayBuffer };
      } finally {
        w.terminate();
      }
    }),
  );

  onProgress?.({ stage: "separating", percent: 100 });

  // ── 7. Crossfade-assemble output ─────────────────────────────────────────
  //
  // Each boundary B = coreEnd[i] = coreStart[i+1] has a crossfade region
  // [B - CF, B + CF) of length 2×CF:
  //   - chunk i   fade-out: weight 1→0 over [B-CF, B+CF)
  //   - chunk i+1 fade-in:  weight 0→1 over [B-CF, B+CF)
  //   - weights sum to 1 everywhere → seamless blend
  //
  const outL = new Float32Array(totalFrames);
  const outR = new Float32Array(totalFrames);
  const CF   = CROSSFADE_SAMPLES;

  for (let i = 0; i < results.length; i++) {
    const { inputStart, coreStart, coreEnd } = chunks[i];
    const resL    = new Float32Array(results[i].left);
    const resR    = new Float32Array(results[i].right);
    const isFirst = i === 0;
    const isLast  = i === results.length - 1;

    // Fade-in region [coreStart-CF, coreStart+CF): blend 0→1 (skipped for first chunk)
    if (!isFirst) {
      const fStart = coreStart - CF;
      for (let g = fStart; g < coreStart + CF; g++) {
        const t = (g - fStart) / (2 * CF);
        const idx = g - inputStart;
        outL[g] += resL[idx] * t;
        outR[g] += resR[idx] * t;
      }
    }

    // Pure region: sole contributor, written directly
    const pureStart = isFirst ? coreStart : coreStart + CF;
    const pureEnd   = isLast  ? coreEnd   : coreEnd   - CF;
    for (let g = pureStart; g < pureEnd; g++) {
      outL[g] = resL[g - inputStart];
      outR[g] = resR[g - inputStart];
    }

    // Fade-out region [coreEnd-CF, coreEnd+CF): blend 1→0 (skipped for last chunk)
    if (!isLast) {
      const fStart = coreEnd - CF;
      for (let g = fStart; g < coreEnd + CF; g++) {
        const t = 1 - (g - fStart) / (2 * CF);
        const idx = g - inputStart;
        outL[g] += resL[idx] * t;
        outR[g] += resR[idx] * t;
      }
    }
  }

  // ── 8. Build output AudioBuffer ──────────────────────────────────────────
  const outBuf = new OfflineAudioContext(2, totalFrames, DEMUCS_SAMPLE_RATE)
    .createBuffer(2, totalFrames, DEMUCS_SAMPLE_RATE);
  outBuf.copyToChannel(outL, 0);
  outBuf.copyToChannel(outR, 1);
  return outBuf;
}
