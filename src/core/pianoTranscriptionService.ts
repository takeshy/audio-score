/**
 * Piano transcription using ByteDance's CRNN model via ONNX Runtime Web (WASM).
 *
 * Architecture: Regress_onset_offset_frame_velocity_CRNN
 * Input: raw waveform 16kHz mono → internal Conv1d STFT + mel filterbank
 * Output: 4 tensors (T, 88) — onset, offset, frame, velocity
 * frames_per_second=100, classes_num=88, begin_note=21 (MIDI A0)
 */

import { DetectedNote } from "../types";
import { midiToNoteName, midiToFrequency } from "./musicTheory";
import { getTemporary, saveTemporary } from "../storage/idb";

const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/";
const MODEL_CACHE_KEY = "piano_transcription_model_v1";

/** Model parameters */
const SAMPLE_RATE = 16000;
const SEGMENT_SECONDS = 10.0;
const HOP_SECONDS = 5.0;
const FRAMES_PER_SECOND = 100;
const CLASSES_NUM = 88;
const BEGIN_NOTE = 21; // MIDI A0

/** Post-processing thresholds */
const ONSET_THRESHOLD = 0.3;
const OFFSET_THRESHOLD = 0.3;
const FRAME_THRESHOLD = 0.1;

/** Default number of parallel ORT workers. */
export const DEFAULT_PT_WORKERS = Math.min(navigator.hardwareConcurrency ?? 2, 4);

/** Inline Web Worker code for ORT inference */
const WORKER_CODE = `
(function () {
  var session = null;

  async function handle(e) {
    var msg = e.data.msg;

    if (msg === 'INIT') {
      // Load onnxruntime-web from CDN
      var cdnBase = e.data.cdnBase;
      importScripts(cdnBase + 'ort.min.js');
      ort.env.wasm.wasmPaths = cdnBase;
      ort.env.wasm.numThreads = 1;
      postMessage({ msg: 'INIT_DONE' });

    } else if (msg === 'LOAD_MODEL') {
      // Decompress gzip if needed (model is stored as .ort.gz)
      var raw = new Uint8Array(e.data.modelBuffer);
      var isGzip = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
      var modelBuf;
      if (isGzip) {
        var ds = new DecompressionStream('gzip');
        var writer = ds.writable.getWriter();
        writer.write(raw);
        writer.close();
        var reader = ds.readable.getReader();
        var chunks = [];
        while (true) {
          var r = await reader.read();
          if (r.done) break;
          chunks.push(r.value);
        }
        var totalLen = 0;
        for (var ci = 0; ci < chunks.length; ci++) totalLen += chunks[ci].byteLength;
        var merged = new Uint8Array(totalLen);
        var off = 0;
        for (var ci = 0; ci < chunks.length; ci++) {
          merged.set(chunks[ci], off);
          off += chunks[ci].byteLength;
        }
        modelBuf = merged.buffer;
      } else {
        modelBuf = raw.buffer;
      }
      session = await ort.InferenceSession.create(modelBuf, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      postMessage({ msg: 'MODEL_LOADED' });

    } else if (msg === 'INFER') {
      var waveform = new Float32Array(e.data.waveformBuffer);
      var len = waveform.length;
      var tensor = new ort.Tensor('float32', waveform, [1, len]);
      var feeds = {};

      // Determine input name from session
      var inputName = session.inputNames[0];
      feeds[inputName] = tensor;

      var results = await session.run(feeds);
      var outputNames = session.outputNames;

      // Extract output data (onset, offset, frame, velocity — first 4 outputs)
      // The model may produce extra pedal-related outputs which we ignore.
      var onset = results[outputNames[0]].data;
      var offset = results[outputNames[1]].data;
      var frame = results[outputNames[2]].data;
      var velocity = results[outputNames[3]].data;

      var onsetBuf = new Float32Array(onset).buffer;
      var offsetBuf = new Float32Array(offset).buffer;
      var frameBuf = new Float32Array(frame).buffer;
      var velocityBuf = new Float32Array(velocity).buffer;
      var dims = results[outputNames[0]].dims;

      postMessage(
        {
          msg: 'INFER_DONE',
          onset: onsetBuf,
          offset: offsetBuf,
          frame: frameBuf,
          velocity: velocityBuf,
          numFrames: dims[1],
          numClasses: dims[2],
        },
        [onsetBuf, offsetBuf, frameBuf, velocityBuf],
      );
    }
  }

  onmessage = function (e) {
    handle(e).catch(function (err) {
      postMessage({ msg: 'ERROR', error: String(err) });
    });
  };
})();
`;

type WorkerMsg =
  | { msg: "INIT_DONE" }
  | { msg: "MODEL_LOADED" }
  | {
      msg: "INFER_DONE";
      onset: ArrayBuffer;
      offset: ArrayBuffer;
      frame: ArrayBuffer;
      velocity: ArrayBuffer;
      numFrames: number;
      numClasses: number;
    }
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

/**
 * Resample and downmix an AudioBuffer to 16kHz mono Float32Array.
 */
async function resampleToMono16k(buf: AudioBuffer): Promise<Float32Array> {
  const numSamples = Math.ceil(buf.duration * SAMPLE_RATE);
  const offCtx = new OfflineAudioContext(1, numSamples, SAMPLE_RATE);
  const src = offCtx.createBufferSource();
  src.buffer = buf;
  src.connect(offCtx.destination);
  src.start();
  const rendered = await offCtx.startRendering();
  return rendered.getChannelData(0);
}

/** Fetch model with IndexedDB cache */
async function fetchModelCached(
  fetchAsset: (name: string) => Promise<ArrayBuffer>,
): Promise<ArrayBuffer> {
  try {
    const cached = await getTemporary(MODEL_CACHE_KEY);
    if (cached instanceof Blob) {
      return await cached.arrayBuffer();
    }
  } catch {
    // cache miss
  }
  const buffer = await fetchAsset("piano_transcription.ort.gz");
  saveTemporary(MODEL_CACHE_KEY, new Blob([buffer])).catch(() => {});
  return buffer;
}

interface NoteEvent {
  midi: number;
  startFrame: number;
  endFrame: number;
  velocity: number;
}

/**
 * Post-process onset/offset/frame/velocity tensors into note events.
 * Implements onset-offset-frame state machine.
 */
function postProcessToNotes(
  onset: Float32Array,
  offset: Float32Array,
  frame: Float32Array,
  velocity: Float32Array,
  numFrames: number,
  numClasses: number,
): NoteEvent[] {
  const notes: NoteEvent[] = [];

  for (let pitch = 0; pitch < numClasses; pitch++) {
    let noteOn = false;
    let startFrame = 0;
    let vel = 0;

    for (let t = 0; t < numFrames; t++) {
      const idx = t * numClasses + pitch;
      const onsetVal = onset[idx];
      const offsetVal = offset[idx];
      const frameVal = frame[idx];
      const velVal = velocity[idx];

      if (!noteOn) {
        // Look for onset
        if (onsetVal >= ONSET_THRESHOLD) {
          noteOn = true;
          startFrame = t;
          vel = velVal;
        }
      } else {
        // Note is on — check for offset or frame drop
        if (offsetVal >= OFFSET_THRESHOLD || frameVal < FRAME_THRESHOLD) {
          notes.push({
            midi: BEGIN_NOTE + pitch,
            startFrame,
            endFrame: t,
            velocity: vel,
          });
          noteOn = false;

          // Check if a new onset starts at this exact frame
          if (onsetVal >= ONSET_THRESHOLD) {
            noteOn = true;
            startFrame = t;
            vel = velVal;
          }
        }
      }
    }

    // Close any open note at end of segment
    if (noteOn) {
      notes.push({
        midi: BEGIN_NOTE + pitch,
        startFrame,
        endFrame: numFrames,
        velocity: vel,
      });
    }
  }

  return notes;
}

/**
 * Extract notes from a single segment's inference result.
 */
function extractSegmentNotes(
  result: Extract<WorkerMsg, { msg: "INFER_DONE" }>,
  segStart: number,
  segIndex: number,
  totalSegments: number,
): DetectedNote[] {
  const onsetData = new Float32Array(result.onset);
  const offsetData = new Float32Array(result.offset);
  const frameData = new Float32Array(result.frame);
  const velocityData = new Float32Array(result.velocity);

  const noteEvents = postProcessToNotes(
    onsetData,
    offsetData,
    frameData,
    velocityData,
    result.numFrames,
    result.numClasses,
  );

  const timeOffset = segStart / SAMPLE_RATE;

  // For overlapping segments, only use the center portion
  let validStartSec: number;
  let validEndSec: number;

  if (totalSegments === 1) {
    validStartSec = 0;
    validEndSec = SEGMENT_SECONDS;
  } else if (segIndex === 0) {
    validStartSec = 0;
    validEndSec =
      HOP_SECONDS + (SEGMENT_SECONDS - HOP_SECONDS) / 2;
  } else if (segIndex === totalSegments - 1) {
    validStartSec = (SEGMENT_SECONDS - HOP_SECONDS) / 2;
    validEndSec = SEGMENT_SECONDS;
  } else {
    validStartSec = (SEGMENT_SECONDS - HOP_SECONDS) / 2;
    validEndSec =
      HOP_SECONDS + (SEGMENT_SECONDS - HOP_SECONDS) / 2;
  }

  const notes: DetectedNote[] = [];
  for (const ev of noteEvents) {
    const noteStartSec = ev.startFrame / FRAMES_PER_SECOND;
    const noteEndSec = ev.endFrame / FRAMES_PER_SECOND;
    if (noteStartSec < validStartSec || noteStartSec >= validEndSec) continue;

    const globalStart = timeOffset + noteStartSec;
    const duration = noteEndSec - noteStartSec;
    if (duration < 0.01) continue;

    notes.push({
      midi: ev.midi,
      name: midiToNoteName(ev.midi),
      startTime: globalStart,
      duration,
      durationType: "quarter",
      dotted: false,
      frequency: midiToFrequency(ev.midi),
      amplitude: Math.min(1, ev.velocity),
    });
  }
  return notes;
}

/**
 * Run pitch detection using ByteDance's piano_transcription CRNN model.
 * Uses a pool of workers for parallel inference across segments.
 * Returns detected notes compatible with the existing pipeline.
 */
export async function detectPitchPianoTranscription(
  audioBuffer: AudioBuffer,
  fetchAsset: (name: string) => Promise<ArrayBuffer>,
  onProgress?: (percent: number) => void,
  numWorkersOpt?: number,
): Promise<DetectedNote[]> {
  onProgress?.(0);

  // --- 1. Resample & fetch model in parallel ---
  const [mono, modelBuffer] = await Promise.all([
    resampleToMono16k(audioBuffer),
    fetchModelCached(fetchAsset),
  ]);
  onProgress?.(15);

  // --- 2. Build segments ---
  const segmentSamples = Math.round(SEGMENT_SECONDS * SAMPLE_RATE);
  const hopSamples = Math.round(HOP_SECONDS * SAMPLE_RATE);
  const totalSamples = mono.length;

  const segments: { start: number; data: Float32Array }[] = [];
  for (let start = 0; start < totalSamples; start += hopSamples) {
    const end = Math.min(start + segmentSamples, totalSamples);
    const chunk = mono.slice(start, end);
    if (chunk.length < segmentSamples) {
      const padded = new Float32Array(segmentSamples);
      padded.set(chunk);
      segments.push({ start, data: padded });
    } else {
      segments.push({ start, data: chunk });
    }
  }
  if (segments.length === 0) {
    segments.push({ start: 0, data: new Float32Array(segmentSamples) });
  }

  // --- 3. Create worker pool ---
  const numWorkers = Math.min(numWorkersOpt ?? DEFAULT_PT_WORKERS, segments.length);
  const blob = new Blob([WORKER_CODE], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  const workers: Worker[] = [];
  for (let i = 0; i < numWorkers; i++) {
    workers.push(new Worker(blobUrl));
  }
  URL.revokeObjectURL(blobUrl);

  try {
    // --- 4. Init ORT + load model on all workers in parallel ---
    await Promise.all(
      workers.map((w) =>
        workerSend(w, { msg: "INIT", cdnBase: ORT_CDN }, [], "INIT_DONE"),
      ),
    );
    onProgress?.(20);

    // Load model sequentially to avoid N copies of 134MB in main thread
    for (const w of workers) {
      const copy = modelBuffer.slice(0);
      await workerSend(
        w,
        { msg: "LOAD_MODEL", modelBuffer: copy },
        [copy],
        "MODEL_LOADED",
      );
    }
    onProgress?.(30);

    // --- 5. Parallel inference with work-stealing queue ---
    let completedCount = 0;
    const progressBase = 30;
    const progressRange = 65;

    const segmentResults: DetectedNote[][] = new Array(segments.length);
    let nextSeg = 0;

    async function workerLoop(worker: Worker): Promise<void> {
      while (nextSeg < segments.length) {
        const seg = nextSeg++;
        const { start, data } = segments[seg];
        const waveformBuf = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        );

        const result = (await workerSend(
          worker,
          { msg: "INFER", waveformBuffer: waveformBuf },
          [waveformBuf],
          "INFER_DONE",
        )) as Extract<WorkerMsg, { msg: "INFER_DONE" }>;

        segmentResults[seg] = extractSegmentNotes(
          result,
          start,
          seg,
          segments.length,
        );

        completedCount++;
        onProgress?.(
          progressBase + (completedCount / segments.length) * progressRange,
        );
      }
    }

    await Promise.all(workers.map((w) => workerLoop(w)));

    onProgress?.(100);
    const allNotes = segmentResults.flat();
    allNotes.sort((a, b) => a.startTime - b.startTime);
    return allNotes;
  } finally {
    workers.forEach((w) => w.terminate());
  }
}
