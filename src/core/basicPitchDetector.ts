/**
 * Pitch detection using Spotify's basic-pitch ML model.
 * TensorFlow.js is loaded dynamically from CDN to avoid bundling.
 */

import { BasicPitch, noteFramesToTime, outputToNotesPoly, addPitchBendsToNoteEvents } from "@spotify/basic-pitch";
import { DetectedNote } from "../types";
import { midiToNoteName, midiToFrequency } from "./musicTheory";

const TF_CDN = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.js";
const TF_WASM_CDN = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@3.21.0/dist/tf-backend-wasm.js";
const WASM_BINS = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@3.21.0/dist/";
const MODEL_URL = "https://unpkg.com/@spotify/basic-pitch@1.0.1/model/model.json";

/** Cached promise so concurrent calls don't insert duplicate script tags. */
let tfLoadPromise: Promise<void> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

/**
 * Patch the WASM backend's Fill kernel to default dtype to 'float32'.
 * The kernel passes attrs.dtype to BackendWasm.makeOutput without
 * defaulting, causing "Unknown dtype undefined" when tf.signal.frame
 * internally calls fill() without specifying dtype.
 *
 * We re-register the kernel at the registry level so internal TF.js
 * calls (not just globalThis.tf.fill) are patched.
 */
function patchWasmFillKernel(tf: any): void {
  const kernels = tf.getKernelsForBackend?.("wasm");
  if (!kernels) return;
  const fillCfg = kernels.find((k: any) => k.kernelName === "Fill");
  if (!fillCfg) return;
  const origFunc = fillCfg.kernelFunc;
  tf.unregisterKernel("Fill", "wasm");
  tf.registerKernel({
    kernelName: "Fill",
    backendName: "wasm",
    kernelFunc: (args: any) => {
      if (args.attrs && args.attrs.dtype == null) {
        args.attrs = {
          ...args.attrs,
          dtype: typeof args.attrs.value === "string" ? "string" : "float32",
        };
      }
      return origFunc(args);
    },
  });
}

/**
 * Dynamically load TensorFlow.js from CDN if not already loaded.
 * Tries WASM backend, falls back to CPU.
 */
function ensureTfLoaded(): Promise<void> {
  if ((globalThis as Record<string, unknown>).tf) {
    return Promise.resolve();
  }
  if (tfLoadPromise) return tfLoadPromise;
  tfLoadPromise = (async () => {
    await loadScript(TF_CDN);
    const tf = (globalThis as Record<string, any>).tf;
    if (!tf) throw new Error("Failed to load TensorFlow.js");

    // Try WASM backend
    try {
      await loadScript(TF_WASM_CDN);
      if (tf.wasm?.setWasmPaths) {
        tf.wasm.setWasmPaths(WASM_BINS);
      }
      await tf.setBackend("wasm");
      await tf.ready();
      patchWasmFillKernel(tf);
      return;
    } catch (e) {
      console.warn("[audio-score] WASM backend failed, falling back to CPU:", e);
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

  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];

  await cachedModel.evaluateModel(
    mono,
    (f: number[][], o: number[][], c: number[][]) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    (percent: number) => {
      onProgress?.(percent);
    },
  );

  const notesPoly = addPitchBendsToNoteEvents(
    contours,
    outputToNotesPoly(frames, onsets, onsetThreshold, frameThreshold, minNoteLength),
  );

  const notesTime = noteFramesToTime(notesPoly);

  return notesTime.map((n) => ({
    midi: n.pitchMidi,
    name: midiToNoteName(n.pitchMidi),
    startTime: n.startTimeSeconds,
    duration: n.durationSeconds,
    durationType: "quarter" as const,
    dotted: false,
    frequency: midiToFrequency(n.pitchMidi),
    amplitude: n.amplitude,
  }));
}
