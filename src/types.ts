/** A detected note after segmentation */
export interface DetectedNote {
  /** MIDI note number (0-127, -1 = rest) */
  midi: number;
  /** Note name (e.g. "C4", "F#5") */
  name: string;
  /** Start time in seconds */
  startTime: number;
  /** Duration in seconds */
  duration: number;
  /** Quantized duration type */
  durationType: DurationType;
  /** Whether the note is dotted */
  dotted: boolean;
  /** Average frequency in Hz */
  frequency: number;
  /** Average amplitude */
  amplitude: number;
}

/** Musical duration types */
export type DurationType =
  | "whole"
  | "half"
  | "quarter"
  | "eighth"
  | "sixteenth";

/** Duration type to beat ratio (in quarter-note beats) */
export const DURATION_BEATS: Record<DurationType, number> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  sixteenth: 0.25,
};

/** A measure containing notes */
export interface Measure {
  /** Measure number (1-based) */
  number: number;
  /** Notes in this measure */
  notes: DetectedNote[];
  /** Total beats in this measure */
  totalBeats: number;
}

/** Clef type */
export type ClefType = "treble" | "bass";

/** Key signature */
export interface KeySignature {
  /** Root note name (e.g. "C", "G", "F") */
  root: string;
  /** Major or minor */
  mode: "major" | "minor";
  /** Number of sharps (positive) or flats (negative) */
  accidentals: number;
}

/** Complete score data */
export interface ScoreData {
  /** Detected BPM */
  bpm: number;
  /** Beats per measure (time signature numerator) */
  beatsPerMeasure: number;
  /** Beat unit (time signature denominator) */
  beatUnit: number;
  /** Key signature */
  key: KeySignature;
  /** Which clef to use */
  clef: ClefType;
  /** Measures with notes */
  measures: Measure[];
  /** Total duration in seconds */
  totalDuration: number;
}

/** Analysis settings */
export interface AnalysisSettings {
  /** Onset detection threshold (0-1) */
  onsetThreshold: number;
  /** Frame activation threshold (0-1) */
  frameThreshold: number;
  /** Minimum note duration in seconds */
  minNoteDuration: number;
  /** Beats per measure */
  beatsPerMeasure: number;
  /** Beat unit (4 = quarter note) */
  beatUnit: number;
}

/** Default analysis settings */
export const DEFAULT_SETTINGS: AnalysisSettings = {
  onsetThreshold: 0.5,
  frameThreshold: 0.3,
  minNoteDuration: 0.05,
  beatsPerMeasure: 4,
  beatUnit: 4,
};

/** Analysis pipeline progress */
export interface AnalysisProgress {
  stage: "decoding" | "loading_model" | "pitch" | "quantizing" | "done";
  percent: number;
}
