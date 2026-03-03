/**
 * Build a ScoreData from DetectedNote[] produced by basic-pitch.
 * Handles BPM detection, quantization, key detection, and measure splitting.
 */

import {
  DetectedNote,
  AnalysisSettings,
  ScoreData,
  PITCH_RANGES,
} from "../types";
import {
  detectBPM,
  quantizeDuration,
  detectKey,
  chooseClef,
  splitIntoMeasures,
} from "./musicTheory";

/**
 * Quantize note durations based on detected BPM.
 */
function quantizeNotes(notes: DetectedNote[], bpm: number): DetectedNote[] {
  return notes.map((note) => {
    const { type, dotted } = quantizeDuration(note.duration, bpm);
    return { ...note, durationType: type, dotted };
  });
}

/**
 * Convert DetectedNote[] from basic-pitch into a complete ScoreData.
 */
export function buildScoreFromNotes(
  notes: DetectedNote[],
  settings: AnalysisSettings,
): ScoreData {
  // Filter by pitch range, minimum duration, and sort by startTime
  const range = PITCH_RANGES[settings.pitchRange] ?? PITCH_RANGES.all;
  let filtered = notes
    .filter((n) => n.midi >= range.min && n.midi <= range.max)
    .filter((n) => n.duration >= settings.minNoteDuration)
    .sort((a, b) => a.startTime - b.startTime);

  if (filtered.length === 0) {
    return {
      bpm: 120,
      beatsPerMeasure: settings.beatsPerMeasure,
      beatUnit: settings.beatUnit,
      key: { root: "C", mode: "major", accidentals: 0 },
      clef: "treble",
      measures: [],
      totalDuration: 0,
      pitchRange: settings.pitchRange,
    };
  }

  // Deduplicate onsets: group notes within 30ms and use one onset per group.
  // Without this, polyphonic chord notes flood the histogram with tiny intervals.
  const ONSET_TOLERANCE = 0.03;
  const deduped: number[] = [];
  let lastOnset = -Infinity;
  for (const n of filtered) {
    if (n.startTime - lastOnset > ONSET_TOLERANCE) {
      deduped.push(n.startTime);
      lastOnset = n.startTime;
    }
  }

  const bpm = settings.bpmOverride > 0 ? settings.bpmOverride : detectBPM(deduped);

  // Quantize durations
  filtered = quantizeNotes(filtered, bpm);

  // Detect key
  const midiNotes = filtered.map((n) => n.midi);
  const key = detectKey(midiNotes);

  // Choose clef
  const clef = chooseClef(midiNotes);

  // Split into measures
  const measures = splitIntoMeasures(filtered, bpm, settings.beatsPerMeasure);

  // Total duration
  const lastNote = filtered[filtered.length - 1];
  const totalDuration = lastNote.startTime + lastNote.duration;

  return {
    bpm,
    beatsPerMeasure: settings.beatsPerMeasure,
    beatUnit: settings.beatUnit,
    key,
    clef,
    measures,
    totalDuration,
    pitchRange: settings.pitchRange,
  };
}
