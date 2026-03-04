/**
 * Demucs WASM-based audio source separation service.
 *
 * Uses the freemusicdemixer.com WASM engine and htdemucs_6s model weights to
 * separate audio into 6 stems (drums, bass, other, vocals, guitar, piano)
 * entirely in the browser — no server required.
 *
 * Audio is split into N chunks (one per worker) with overlap for crossfade.
 * The WASM binary is patched in-memory to reduce initial memory from 2 GB to
 * 16 MB so multiple workers can run in parallel without exceeding browser limits.
 * Chunk results are cached in IndexedDB to keep JS memory low.
 *
 * htdemucs_6s stem order:
 *   0: drums  1: bass  2: other  3: vocals  4: guitar  5: piano
 */

import { deleteTemporary, getTemporary, saveTemporary } from "../storage/idb";
import { StemName } from "../types";

/** Ordered stem names matching htdemucs_6s stem indices */
export const STEM_NAMES: StemName[] = ["drums", "bass", "other", "vocals", "guitar", "piano"];

/** Demucs native sample rate */
const DEMUCS_SAMPLE_RATE = 44100;

const NUM_STEMS = 6;
const NUM_CHANNELS = NUM_STEMS * 2; // L+R per stem

/**
 * Overlap added to each chunk boundary so Demucs can process the edge region
 * with full context. Covers the ~1.95-s internal transition zone (7.8 s * 0.25).
 */
const CROSSFADE_SAMPLES = Math.round(2 * DEMUCS_SAMPLE_RATE); // 2 s ~ 88 200 frames

/** Default number of parallel WASM workers. */
export const DEFAULT_NUM_WORKERS = 2;

/** Maximum chunk length in samples (~30 s). Longer chunks use more WASM heap during inference. */
const MAX_CHUNK_SAMPLES = Math.round(30 * DEMUCS_SAMPLE_RATE);

/** IDB key prefix for chunk results (cleaned up after assembly). */
const CHUNK_IDB_PREFIX = "demucs_chunk_";

/** Inline Web Worker code (runs inside a Blob URL worker) */
const WORKER_CODE = `
(function () {
  var mod = null;
  var workerId = Math.random().toString(36).slice(2, 6);
  var processCount = 0;
  var NUM_STEMS = 6;

  // Pre-allocated I/O buffer pointers (set by ALLOC, reused by PROCESS)
  var allocLen = 0;
  var inL = 0, inR = 0;
  var outs = [];

  function heapMB() {
    return mod ? (mod.HEAP8.buffer.byteLength / 1048576).toFixed(1) + 'MB' : '?';
  }
  function log(s) {
    console.log('[demucs-worker ' + workerId + '] ' + s);
  }

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
        log('WASM loaded, heap=' + heapMB());
        postMessage({ msg: 'WASM_READY' });
      }).catch(function(err) {
        postMessage({ msg: 'ERROR', error: String(err) });
      });

    } else if (msg === 'INIT_MODEL') {
      var rawData = new Uint8Array(e.data.modelBuffer);
      log('modelInit start, modelSize=' + (rawData.byteLength/1048576).toFixed(1) + 'MB, heap=' + heapMB());
      var ptr = mod._malloc(rawData.byteLength);
      if (!ptr) throw new Error('_malloc failed for model (' + rawData.byteLength + ' bytes)');
      mod.HEAPU8.set(rawData, ptr);
      mod._modelInit(ptr, rawData.byteLength);
      mod._free(ptr);
      log('modelInit done, heap=' + heapMB());
      postMessage({ msg: 'MODEL_READY' });

    } else if (msg === 'ALLOC') {
      // Pre-allocate I/O buffers once for max chunk length
      allocLen = e.data.maxLen;
      inL = mod._malloc(allocLen * 4);
      inR = mod._malloc(allocLen * 4);
      outs = [];
      for (var i = 0; i < NUM_STEMS; i++) {
        outs.push(mod._malloc(allocLen * 4));
        outs.push(mod._malloc(allocLen * 4));
      }
      log('ALLOC done, maxLen=' + allocLen + ' (' + (allocLen/44100).toFixed(1) + 's), heap=' + heapMB());
      postMessage({ msg: 'ALLOC_DONE' });

    } else if (msg === 'PROCESS') {
      processCount++;
      var L = new Float32Array(e.data.leftChannel);
      var R = new Float32Array(e.data.rightChannel);
      var len = L.length;

      log('PROCESS #' + processCount + ' start, len=' + len + ' (' + (len/44100).toFixed(1) + 's), heap=' + heapMB());

      // Copy into pre-allocated buffers
      mod.HEAPF32.set(L, inL >> 2);
      mod.HEAPF32.set(R, inR >> 2);

      mod._modelDemixSegment.apply(null, [inL, inR, len].concat(outs).concat([0, 1, 0]));
      log('PROCESS #' + processCount + ' inference done, heap=' + heapMB());

      // Copy results out (read from pre-allocated output buffers)
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

      log('PROCESS #' + processCount + ' done, posting results');
      postMessage({ msg: 'SEPARATED', channels: channels }, transfers);
    }
  }

  onmessage = function (e) {
    handle(e).catch(function(err) {
      log('ERROR: ' + String(err) + ', heap=' + heapMB());
      postMessage({ msg: 'ERROR', error: String(err) });
    });
  };
})();
`;

type WorkerMsg =
  | { msg: "WASM_READY" }
  | { msg: "MODEL_READY" }
  | { msg: "ALLOC_DONE" }
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

/** Target initial memory: 256 pages = 16 MB (enough for static data + stack). */
const WASM_INITIAL_PAGES = 256;

/**
 * Patch the WASM binary in-memory to reduce its initial memory declaration.
 * The original binary ships with initial=32768 pages (2 GB) which prevents
 * running multiple workers simultaneously. We rewrite the LEB128-encoded
 * initial-pages value in the Memory section (section id 5) so each worker
 * starts small and grows via memory.grow as needed.
 */
function patchWasmInitialMemory(buf: ArrayBuffer): ArrayBuffer {
  console.log(`[demucs] patchWasmInitialMemory called, buf.byteLength=${buf.byteLength}`);
  const bytes = new Uint8Array(buf);

  // Fast scan for section id=5 (Memory)
  let pos = 8; // skip WASM header
  while (pos < bytes.length) {
    const sectionId = bytes[pos++];
    // read section size (LEB128)
    let sectionSize = 0;
    let shift = 0;
    while (bytes[pos] & 0x80) {
      sectionSize |= (bytes[pos++] & 0x7f) << shift;
      shift += 7;
    }
    sectionSize |= (bytes[pos++] & 0x7f) << shift;

    if (sectionId === 5) {
      // Memory section: count(1 byte LEB) + flags(1 byte) + initial(LEB) + [max(LEB)]
      const memStart = pos;
      // count
      let p = memStart;
      while (bytes[p] & 0x80) p++;
      p++; // past count LEB
      // flags
      p++; // past flags byte
      // initial pages — this is what we patch
      const initialStart = p;
      // read current LEB length
      while (bytes[p] & 0x80) p++;
      p++;
      const initialEnd = p;
      const lebLen = initialEnd - initialStart;

      // Encode new value in exactly the same number of LEB128 bytes
      let val = WASM_INITIAL_PAGES;
      const newBytes = new Uint8Array(lebLen);
      for (let i = 0; i < lebLen; i++) {
        newBytes[i] = val & 0x7f;
        val >>= 7;
        if (i < lebLen - 1) newBytes[i] |= 0x80;
      }

      // Copy and patch
      const patched = new Uint8Array(buf.slice(0));
      console.log(`[demucs] patching initial memory at offset ${initialStart}, lebLen=${lebLen}, old=[${Array.from(bytes.slice(initialStart, initialEnd)).map(b => '0x'+b.toString(16)).join(',')}], new=[${Array.from(newBytes).map(b => '0x'+b.toString(16)).join(',')}]`);
      patched.set(newBytes, initialStart);
      // Verify patch
      const verify = new Uint8Array(patched.buffer.slice(initialStart, initialEnd));
      console.log(`[demucs] verify after patch: [${Array.from(verify).map(b => '0x'+b.toString(16)).join(',')}]`);
      console.log(`[demucs] patched WASM initial memory: ${WASM_INITIAL_PAGES} pages (${WASM_INITIAL_PAGES * 64 / 1024}MB)`);
      return patched.buffer;
    }

    pos += sectionSize;
  }

  // Memory section not found — return as-is
  console.warn(`[demucs] Memory section (id=5) NOT FOUND in WASM binary!`);
  return buf;
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

/** Create a fresh worker, load WASM runtime, model weights, and pre-allocate I/O buffers. */
async function createInitedWorker(
  wasmJsBuffer: ArrayBuffer,
  wasmBinaryBuffer: ArrayBuffer,
  modelBuffer: ArrayBuffer,
  maxChunkLen: number,
): Promise<Worker> {
  const blob = new Blob([WORKER_CODE], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  const wasmJs = wasmJsBuffer.slice(0);
  const wasmBin = wasmBinaryBuffer.slice(0);
  await workerSend(
    w,
    { msg: "LOAD_WASM", wasmJsBuffer: wasmJs, wasmBinaryBuffer: wasmBin },
    [wasmJs, wasmBin],
    "WASM_READY",
  );
  const model = modelBuffer.slice(0);
  await workerSend(w, { msg: "INIT_MODEL", modelBuffer: model }, [model], "MODEL_READY");
  await workerSend(w, { msg: "ALLOC", maxLen: maxChunkLen }, [], "ALLOC_DONE");
  return w;
}

/** Serialize 12 same-length Float32Array channels into a single Blob. */
function serializeChannels(channels: ArrayBuffer[]): Blob {
  return new Blob(channels.map(ab => new Uint8Array(ab)));
}

/** Deserialize only the L/R pair for the given stem index from a chunk Blob. */
async function deserializeStemChannels(
  blob: Blob,
  stemIndex: number,
): Promise<{ L: ArrayBuffer; R: ArrayBuffer }> {
  const buf = await blob.arrayBuffer();
  const bytesPerCh = buf.byteLength / NUM_CHANNELS;
  const baseL = stemIndex * 2 * bytesPerCh;
  const baseR = (stemIndex * 2 + 1) * bytesPerCh;
  return {
    L: buf.slice(baseL, baseL + bytesPerCh),
    R: buf.slice(baseR, baseR + bytesPerCh),
  };
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
  L: Float32Array | null;
  R: Float32Array | null;
  inputStart: number;
  coreStart: number;
  coreEnd: number;
}

/**
 * Separate all 6 stems from a mixed AudioBuffer.
 *
 * Audio is split into numWorkers chunks processed in parallel. Each worker loads
 * a memory-patched WASM binary (16 MB initial instead of 2 GB). Chunk results
 * are saved to IndexedDB so JS memory stays bounded.
 *
 * @param audioBuffer  Input audio (any sample rate — resampled to 44 100 Hz internally).
 * @param fetchAsset   Callback to fetch a named asset. In GemiHub: `(name) => api.assets.fetch(name)`.
 * @param onProgress   Optional progress callback.
 * @param numWorkers   Number of parallel WASM workers per batch (default: DEFAULT_NUM_WORKERS).
 * @returns Record mapping each StemName to its separated AudioBuffer at 44 100 Hz.
 */
export async function separateAll(
  audioBuffer: AudioBuffer,
  fetchAsset: (name: string) => Promise<ArrayBuffer>,
  onProgress?: (p: SeparationProgress) => void,
  numWorkers: number = DEFAULT_NUM_WORKERS,
): Promise<Record<StemName, AudioBuffer>> {
  const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ── 1. Resample ──────────────────────────────────────────────────────────
  const resampled = await resampleTo(audioBuffer, DEMUCS_SAMPLE_RATE);
  const totalFrames = resampled.length;
  console.log(`[demucs] totalFrames=${totalFrames} (${(totalFrames/DEMUCS_SAMPLE_RATE).toFixed(1)}s), numWorkers=${numWorkers}`);

  // ── 2. Fetch shared assets ────────────────────────────────────────────────
  onProgress?.({ stage: "downloading_wasm", percent: 0 });
  const wasmJsBuffer = await fetchWithCache(
    "demucs_wasm_js_v2", "demucs_onnx_simd.js", fetchAsset,
  );
  onProgress?.({ stage: "downloading_wasm", percent: 50 });
  const wasmBinaryRaw = await fetchWithCache(
    "demucs_wasm_bin_v3", "demucs_onnx_simd.wasm", fetchAsset, isValidWasm,
  );
  const wasmBinaryBuffer = patchWasmInitialMemory(wasmBinaryRaw);
  onProgress?.({ stage: "downloading_wasm", percent: 100 });

  onProgress?.({ stage: "downloading_model", percent: 0 });
  const modelBuffer = await fetchWithCache(
    "demucs_model_ort_patched_v1", "htdemucs_6s.ort.gz", fetchAsset,
  );
  onProgress?.({ stage: "downloading_model", percent: 100 });

  // ── 3. Build overlapping chunk descriptors (≤30 s core each) ────────────
  const ch0 = resampled.getChannelData(0);
  const ch1 = resampled.getChannelData(resampled.numberOfChannels > 1 ? 1 : 0);

  const nChunks = Math.max(1, Math.ceil(totalFrames / MAX_CHUNK_SAMPLES));
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

  // ── 4. Create worker pool and process via work-stealing ────────────────
  const actualWorkers = Math.min(numWorkers, nChunks);
  onProgress?.({ stage: "initializing", percent: 0 });

  const maxChunkLen = Math.max(...chunks.map(c => c.L!.length));
  console.log(`[demucs] nChunks=${nChunks}, workers=${actualWorkers}, maxChunkLen=${maxChunkLen}, chunkLens=[${chunks.map(c => c.L!.length).join(',')}]`);
  const created: Worker[] = [];
  let doneCount = 0;
  let nextChunk = 0;

  try {
    const workers = await Promise.all(
      Array.from({ length: actualWorkers }, async () => {
        const w = await createInitedWorker(wasmJsBuffer, wasmBinaryBuffer, modelBuffer, maxChunkLen);
        created.push(w);
        return w;
      }),
    );

    onProgress?.({ stage: "initializing", percent: 100 });
    onProgress?.({ stage: "separating", percent: 0 });

    async function workerLoop(w: Worker): Promise<void> {
      while (nextChunk < nChunks) {
        const idx = nextChunk++;
        const chunk = chunks[idx];
        const L = new Float32Array(chunk.L!);
        const R = new Float32Array(chunk.R!);
        chunk.L = null;
        chunk.R = null;

        const result = (await workerSend(
          w,
          { msg: "PROCESS", leftChannel: L.buffer, rightChannel: R.buffer },
          [L.buffer, R.buffer],
          "SEPARATED",
        )) as { msg: "SEPARATED"; channels: ArrayBuffer[] };

        await saveTemporary(
          `${CHUNK_IDB_PREFIX}${sessionId}_${idx}`,
          serializeChannels(result.channels),
        );

        doneCount++;
        onProgress?.({ stage: "separating", percent: Math.round(doneCount / nChunks * 100) });
      }
    }

    await Promise.all(workers.map((w) => workerLoop(w)));
  } catch (e) {
    for (let i = 0; i < nChunks; i++) {
      deleteTemporary(`${CHUNK_IDB_PREFIX}${sessionId}_${i}`).catch(() => {});
    }
    throw e;
  } finally {
    created.forEach(w => w.terminate());
  }

  // ── 5. Crossfade-assemble output per stem (read from IDB one chunk at a time)
  const CF = CROSSFADE_SAMPLES;
  const stems = {} as Record<StemName, AudioBuffer>;

  for (let s = 0; s < NUM_STEMS; s++) {
    const outL = new Float32Array(totalFrames);
    const outR = new Float32Array(totalFrames);

    for (let i = 0; i < nChunks; i++) {
      const { inputStart, coreStart, coreEnd } = chunks[i];
      const isFirst = i === 0;
      const isLast  = i === nChunks - 1;

      const blob = await getTemporary(`${CHUNK_IDB_PREFIX}${sessionId}_${i}`);
      const { L: chL, R: chR } = await deserializeStemChannels(blob as Blob, s);
      const resL = new Float32Array(chL);
      const resR = new Float32Array(chR);

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

    const outBuf = new OfflineAudioContext(2, totalFrames, DEMUCS_SAMPLE_RATE)
      .createBuffer(2, totalFrames, DEMUCS_SAMPLE_RATE);
    outBuf.copyToChannel(outL, 0);
    outBuf.copyToChannel(outR, 1);
    stems[STEM_NAMES[s]] = outBuf;
  }

  // ── 6. Clean up IDB entries ─────────────────────────────────────────────
  for (let i = 0; i < nChunks; i++) {
    deleteTemporary(`${CHUNK_IDB_PREFIX}${sessionId}_${i}`).catch(() => {});
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
