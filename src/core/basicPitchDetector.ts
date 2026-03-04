/**
 * Pitch detection using Spotify's basic-pitch ML model.
 * TensorFlow.js is loaded dynamically from CDN to avoid bundling.
 */

import { BasicPitch, noteFramesToTime, outputToNotesPoly, addPitchBendsToNoteEvents } from "@spotify/basic-pitch";
import { DetectedNote } from "../types";
import { midiToNoteName, midiToFrequency } from "./musicTheory";

// Full tf.js bundle (includes all ops). WASM backend is removed immediately
// after load to prevent "WebAssembly.instantiate(): Out of memory" crashes.
const TF_CDN = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.js";
const MODEL_URL = "https://unpkg.com/@spotify/basic-pitch@1.0.1/model/model.json";

/** Cached promise so concurrent calls don't insert duplicate script tags. */
let tfLoadPromise: Promise<void> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

/**
 * Load TF.js from CDN, remove WASM backend immediately to prevent OOM,
 * then use WebGL (GPU) or CPU.
 */
function ensureTfLoaded(): Promise<void> {
  if ((globalThis as any).tf?.ready) return Promise.resolve();
  if (tfLoadPromise) return tfLoadPromise;
  tfLoadPromise = (async () => {
    await loadScript(TF_CDN);
    const tf = (globalThis as any).tf;
    if (!tf) throw new Error("Failed to load TensorFlow.js");

    // Remove WASM backend synchronously before it can start instantiating
    try { tf.removeBackend("wasm"); } catch { /* not registered */ }

    try {
      await tf.setBackend("webgl");
      await tf.ready();
      return;
    } catch {
      console.warn("[audio-score] WebGL backend unavailable, using CPU");
    }
    await tf.setBackend("cpu");
    await tf.ready();
  })();
  tfLoadPromise.catch(() => { tfLoadPromise = null; });
  return tfLoadPromise;
}

/** Cached BasicPitch instance to avoid re-downloading the model. */
let cachedModel: BasicPitch | null = null;

/** basic-pitch requires 22050 Hz mono input */
const TARGET_SR = 22050;

/** Process at most this many seconds per evaluateModel call to avoid OOM */
const MAX_SEGMENT_SECS = 60;
const SEGMENT_SAMPLES = MAX_SEGMENT_SECS * TARGET_SR; // 1,323,000

/**
 * Resample and downmix an AudioBuffer to 22050 Hz mono Float32Array
 * using OfflineAudioContext.
 */
async function resampleToMono(buf: AudioBuffer): Promise<Float32Array> {
  const numSamples = Math.ceil(buf.duration * TARGET_SR);
  const offCtx = new OfflineAudioContext(1, numSamples, TARGET_SR);
  const src = offCtx.createBufferSource();
  src.buffer = buf;
  src.connect(offCtx.destination);
  src.start();
  const rendered = await offCtx.startRendering();
  return rendered.getChannelData(0);
}

/**
 * Run pitch detection using basic-pitch ML model.
 * Returns all detected notes (polyphonic).
 */
export async function detectPitchBasicPitch(
  audioBuffer: AudioBuffer,
  onProgress?: (percent: number) => void,
  onsetThreshold: number = 0.5,
  frameThreshold: number = 0.3,
  minNoteLength: number = 5,
): Promise<DetectedNote[]> {
  await ensureTfLoaded();

  if (!cachedModel) {
    cachedModel = new BasicPitch(MODEL_URL);
    // Yield to the event loop between frames to keep the UI responsive.
    const orig = cachedModel.evaluateSingleFrame.bind(cachedModel);
    (cachedModel as any).evaluateSingleFrame = async function (...args: any[]) {
      const result = await orig(...args);
      await new Promise<void>((r) => setTimeout(r, 0));
      return result;
    };
  }

  // basic-pitch requires 22050 Hz mono; resample if needed
  const mono = await resampleToMono(audioBuffer);

  const numSegments = Math.ceil(mono.length / SEGMENT_SAMPLES);
  const model = cachedModel;

  const segmentPromises = Array.from({ length: numSegments }, async (_, seg) => {
    const start = seg * SEGMENT_SAMPLES;
    const chunk = mono.slice(start, start + SEGMENT_SAMPLES);
    const timeOffsetSec = start / TARGET_SR;

    const frames: number[][] = [];
    const onsets: number[][] = [];
    const contours: number[][] = [];

    await model!.evaluateModel(
      chunk,
      (f: number[][], o: number[][], c: number[][]) => {
        frames.push(...f);
        onsets.push(...o);
        contours.push(...c);
      },
      (percent: number) => {
        onProgress?.((seg + percent / 100) / numSegments * 100);
      },
    );

    const notesPoly = addPitchBendsToNoteEvents(
      contours,
      outputToNotesPoly(frames, onsets, onsetThreshold, frameThreshold, minNoteLength),
    );

    return noteFramesToTime(notesPoly).map((n) => ({
      midi: n.pitchMidi,
      name: midiToNoteName(n.pitchMidi),
      startTime: n.startTimeSeconds + timeOffsetSec,
      duration: n.durationSeconds,
      durationType: "quarter" as const,
      dotted: false,
      frequency: midiToFrequency(n.pitchMidi),
      amplitude: n.amplitude,
    }));
  });

  const segmentResults = await Promise.all(segmentPromises);
  return segmentResults.flat();
}
