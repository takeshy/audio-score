/**
 * Demucs WASM-based audio source separation service.
 *
 * Uses the freemusicdemixer.com WASM engine and htdemucs_6s model weights to
 * separate audio into 6 stems (drums, bass, other, vocals, guitar, piano)
 * entirely in the browser — no server required.
 *
 * Audio is split into ~30 s overlapping chunks. A pool of 2 WASM workers
 * processes chunks in parallel. All 6 stems are extracted per chunk, then
 * crossfade-assembled.
 *
 * htdemucs_6s stem order:
 *   0: drums  1: bass  2: other  3: vocals  4: guitar  5: piano
 */

import { getTemporary, saveTemporary } from "../storage/idb";
import { StemName } from "../types";

/** Ordered stem names matching htdemucs_6s stem indices */
export const STEM_NAMES: StemName[] = ["drums", "bass", "other", "vocals", "guitar", "piano"];

/** Demucs native sample rate */
const DEMUCS_SAMPLE_RATE = 44100;

const NUM_STEMS = 6;

/**
 * Overlap added to each chunk boundary so Demucs can process the edge region
 * with full context. Covers the ~1.95-s internal transition zone (7.8 s * 0.25).
 */
const CROSSFADE_SAMPLES = Math.round(2 * DEMUCS_SAMPLE_RATE); // 2 s ~ 88 200 frames

/** Target chunk duration in samples (~60 s). */
const CHUNK_SAMPLES = 60 * DEMUCS_SAMPLE_RATE;

/** Default simultaneous WASM worker instances. */
export const DEFAULT_NUM_WORKERS = 2;

/** Inline Web Worker code (runs inside a Blob URL worker) */
const WORKER_CODE = `
(function () {
  var mod = null;

  async function handle(e) {
    var msg = e.data.msg;

    if (msg === 'LOAD_WASM') {
      var blob = new Blob([e.data.wasmJsBuffer], { type: 'application/javascript' });
      var url = URL.createObjectURL(blob);
      importScripts(url);
      URL.revokeObjectURL(url);
      libdemucs({
        wasmBinary: e.data.wasmBinaryBuffer
      }).then(function(instance) {
        mod = instance;
        postMessage({ msg: 'WASM_READY' });
      }).catch(function(err) {
        postMessage({ msg: 'ERROR', error: String(err) });
      });

    } else if (msg === 'INIT_MODEL') {
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
      var NUM_STEMS = 6;

      var inL = mod._malloc(len * 4);
      var inR = mod._malloc(len * 4);
      mod.HEAPF32.set(L, inL >> 2);
      mod.HEAPF32.set(R, inR >> 2);

      var outs = [];
      for (var i = 0; i < NUM_STEMS; i++) {
        outs.push(mod._malloc(len * 4)); // L
        outs.push(mod._malloc(len * 4)); // R
      }

      mod._modelDemixSegment.apply(null, [inL, inR, len].concat(outs).concat([0, 1, 0]));

      var transfers = [];
      var channels = [];
      for (var s = 0; s < NUM_STEMS; s++) {
        var sL = new Float32Array(mod.HEAPF32.buffer, outs[s * 2], len);
        var sR = new Float32Array(mod.HEAPF32.buffer, outs[s * 2 + 1], len);
        var copyL = new Float32Array(sL);
        var copyR = new Float32Array(sR);
        channels.push(copyL.buffer, copyR.buffer);
        transfers.push(copyL.buffer, copyR.buffer);
      }

      mod._free(inL);
      mod._free(inR);
      for (var j = 0; j < outs.length; j++) mod._free(outs[j]);

      postMessage({ msg: 'SEPARATED', channels: channels }, transfers);
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
  | { msg: "SEPARATED"; channels: ArrayBuffer[] }
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
      console.warn(`[demucs] cached ${assetName} failed validation, re-fetching`);
    }
  } catch {
    // ignore cache miss
  }

  const buffer = await fetchAsset(assetName);
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

interface ChunkDesc {
  L: Float32Array;
  R: Float32Array;
  inputStart: number;
  coreStart: number;
  coreEnd: number;
}

type ChunkResult = { channels: ArrayBuffer[] };

/**
 * Separate all 6 stems from a mixed AudioBuffer.
 *
 * Audio is split into ~60 s overlapping chunks. A configurable pool of WASM
 * workers processes chunks from a queue in parallel, keeping memory usage
 * bounded while still utilising concurrency.
 *
 * @param audioBuffer  Input audio (any sample rate — resampled to 44 100 Hz internally).
 * @param fetchAsset   Callback to fetch a named asset. In GemiHub: `(name) => api.assets.fetch(name)`.
 * @param onProgress   Optional progress callback.
 * @param numWorkers   Number of parallel WASM workers (default: DEFAULT_NUM_WORKERS).
 * @returns Record mapping each StemName to its separated AudioBuffer at 44 100 Hz.
 */
export async function separateAll(
  audioBuffer: AudioBuffer,
  fetchAsset: (name: string) => Promise<ArrayBuffer>,
  onProgress?: (p: SeparationProgress) => void,
  numWorkers: number = DEFAULT_NUM_WORKERS,
): Promise<Record<StemName, AudioBuffer>> {
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

  // ── 3. Build overlapping chunk descriptors (~30 s each) ───────────────────
  const ch0 = resampled.getChannelData(0);
  const ch1 = resampled.getChannelData(resampled.numberOfChannels > 1 ? 1 : 0);

  const nChunks = Math.max(1, Math.ceil(totalFrames / CHUNK_SAMPLES));
  const coreSize = Math.ceil(totalFrames / nChunks);

  const chunks: ChunkDesc[] = Array.from({ length: nChunks }, (_, i) => {
    const coreStart  = i * coreSize;
    const coreEnd    = Math.min(coreStart + coreSize, totalFrames);
    const inputStart = i === 0           ? 0           : coreStart - CROSSFADE_SAMPLES;
    const inputEnd   = i === nChunks - 1 ? totalFrames : coreEnd   + CROSSFADE_SAMPLES;
    return {
      L: new Float32Array(ch0.subarray(inputStart, inputEnd)),
      R: new Float32Array(ch1.subarray(inputStart, inputEnd)),
      inputStart,
      coreStart,
      coreEnd,
    };
  });

  // ── 4. Init worker pool ──────────────────────────────────────────────────
  const nWorkers = Math.min(numWorkers, nChunks);

  onProgress?.({ stage: "initializing", percent: 0 });

  const createdWorkers: Worker[] = [];
  let workers: Worker[];
  try {
    workers = await Promise.all(Array.from({ length: nWorkers }, async () => {
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

  // ── 5. Process chunks via worker pool ────────────────────────────────────
  onProgress?.({ stage: "separating", percent: 0 });

  const results: ChunkResult[] = new Array(nChunks);
  let nextChunk = 0;
  let doneCount = 0;

  async function workerLoop(w: Worker) {
    while (nextChunk < nChunks) {
      const idx = nextChunk++;
      const chunk = chunks[idx];
      const L = new Float32Array(chunk.L);
      const R = new Float32Array(chunk.R);
      results[idx] = (await workerSend(
        w,
        { msg: "PROCESS", leftChannel: L.buffer, rightChannel: R.buffer },
        [L.buffer, R.buffer],
        "SEPARATED",
      )) as ChunkResult;
      doneCount++;
      onProgress?.({ stage: "separating", percent: Math.round(doneCount / nChunks * 100) });
    }
  }

  try {
    await Promise.all(workers.map(w => workerLoop(w)));
  } finally {
    workers.forEach(w => w.terminate());
  }

  // ── 6. Crossfade-assemble output per stem ─────────────────────────────────
  const CF = CROSSFADE_SAMPLES;
  const outArrays = Array.from({ length: NUM_STEMS }, () => [
    new Float32Array(totalFrames), // L
    new Float32Array(totalFrames), // R
  ]);

  for (let i = 0; i < results.length; i++) {
    const { inputStart, coreStart, coreEnd } = chunks[i];
    const isFirst = i === 0;
    const isLast  = i === results.length - 1;
    const chans = results[i].channels;

    for (let s = 0; s < NUM_STEMS; s++) {
      const resL = new Float32Array(chans[s * 2]);
      const resR = new Float32Array(chans[s * 2 + 1]);
      const outL = outArrays[s][0];
      const outR = outArrays[s][1];

      if (!isFirst) {
        const fStart = coreStart - CF;
        for (let g = fStart; g < coreStart + CF; g++) {
          const t = (g - fStart) / (2 * CF);
          const idx = g - inputStart;
          outL[g] += resL[idx] * t;
          outR[g] += resR[idx] * t;
        }
      }

      const pureStart = isFirst ? coreStart : coreStart + CF;
      const pureEnd   = isLast  ? coreEnd   : coreEnd   - CF;
      for (let g = pureStart; g < pureEnd; g++) {
        outL[g] = resL[g - inputStart];
        outR[g] = resR[g - inputStart];
      }

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
  }

  // ── 7. Build output AudioBuffers ──────────────────────────────────────────
  const stems = {} as Record<StemName, AudioBuffer>;
  for (let s = 0; s < NUM_STEMS; s++) {
    const outBuf = new OfflineAudioContext(2, totalFrames, DEMUCS_SAMPLE_RATE)
      .createBuffer(2, totalFrames, DEMUCS_SAMPLE_RATE);
    outBuf.copyToChannel(outArrays[s][0], 0);
    outBuf.copyToChannel(outArrays[s][1], 1);
    stems[STEM_NAMES[s]] = outBuf;
  }

  return stems;
}

/**
 * Separate a single stem. Convenience wrapper around separateAll.
 */
export async function separateStem(
  audioBuffer: AudioBuffer,
  stem: StemName,
  fetchAsset: (name: string) => Promise<ArrayBuffer>,
  onProgress?: (p: SeparationProgress) => void,
): Promise<AudioBuffer> {
  const all = await separateAll(audioBuffer, fetchAsset, onProgress);
  return all[stem];
}
