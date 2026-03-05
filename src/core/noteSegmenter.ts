/**
 * Build a ScoreData from DetectedNote[] produced by basic-pitch.
 * Handles BPM detection, quantization, key detection, and measure splitting.
 */

import {
  DetectedNote,
  AnalysisSettings,
  ScoreData,
  Measure,
  DurationType,
  DURATION_BEATS,
  PITCH_RANGES,
} from "../types";
import {
  detectBPM,
  quantizeDuration,
  detectKey,
  chooseClef,
  splitIntoMeasures,
  detectDownbeatOffset,
  quantizeStartTimes,
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

/** Create a rest DetectedNote. */
function makeRest(startTime: number, durationSec: number, durationType: DurationType, dotted: boolean): DetectedNote {
  return {
    midi: -1,
    name: "rest",
    startTime,
    duration: durationSec,
    durationType,
    dotted,
    frequency: 0,
    amplitude: 0,
  };
}

/** Rest duration types, largest first. */
const REST_TYPES: DurationType[] = ["whole", "half", "quarter", "eighth", "sixteenth", "thirty_second"];

/**
 * Fill gaps between notes (and at measure start/end) with rest notes.
 * Mutates measure.notes in place.
 */
function fillRests(measures: Measure[], bpm: number, beatsPerMeasure: number, downbeatOffset: number): void {
  const beatDur = 60 / bpm;
  const measureDur = beatDur * beatsPerMeasure;

  for (const measure of measures) {
    const measureStart = downbeatOffset + (measure.number - 1) * measureDur;
    const measureEnd = measureStart + measureDur;
    const filled: DetectedNote[] = [];
    let cursor = measureStart;

    // Sort notes by startTime
    const sorted = [...measure.notes].sort((a, b) => a.startTime - b.startTime);

    // Group simultaneous notes (chords) so we advance cursor past all of them
    let i = 0;
    while (i < sorted.length) {
      const noteStart = sorted[i].startTime;

      // Fill gap before this note/chord
      if (noteStart > cursor + beatDur * 0.06) {
        emitRests(filled, cursor, noteStart, beatDur);
      }

      // Collect all simultaneous notes (chord)
      let maxEnd = 0;
      while (i < sorted.length && Math.abs(sorted[i].startTime - noteStart) < beatDur * 0.06) {
        filled.push(sorted[i]);
        const noteEnd = sorted[i].startTime + sorted[i].duration;
        if (noteEnd > maxEnd) maxEnd = noteEnd;
        i++;
      }
      cursor = Math.max(cursor, maxEnd);
    }

    // Fill gap at end of measure
    if (measureEnd > cursor + beatDur * 0.06) {
      emitRests(filled, cursor, measureEnd, beatDur);
    }

    measure.notes = filled;
  }
}

/** Emit rest notes to fill the gap from `from` to `to` (in seconds). */
function emitRests(out: DetectedNote[], from: number, to: number, beatDur: number): void {
  let cursor = from;
  const tolerance = beatDur * 0.06;
  for (const rt of REST_TYPES) {
    const beats = DURATION_BEATS[rt];
    const dur = beats * beatDur;
    while (cursor + dur <= to + tolerance) {
      out.push(makeRest(cursor, dur, rt, false));
      cursor += dur;
    }
  }
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
    .filter((n) => settings.minAmplitude <= 0 || n.amplitude >= settings.minAmplitude)
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

  // Detect downbeat offset and quantize start times to beat grid
  const downbeatOffset = detectDownbeatOffset(deduped, bpm);
  filtered = quantizeStartTimes(filtered, bpm, downbeatOffset);

  // Quantize durations
  filtered = quantizeNotes(filtered, bpm);

  // Detect key
  const midiNotes = filtered.map((n) => n.midi);
  const key = detectKey(midiNotes);

  // Choose clef
  const clef = chooseClef(midiNotes);

  // Split into measures and fill gaps with rests
  const measures = splitIntoMeasures(filtered, bpm, settings.beatsPerMeasure, downbeatOffset);
  fillRests(measures, bpm, settings.beatsPerMeasure, downbeatOffset);

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
    downbeatOffset,
    pitchRange: settings.pitchRange,
  };
}
