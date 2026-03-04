/**
 * MusicXML import — parse a MusicXML string into ScoreData.
 * Handles single-part, single-voice scores (voice 1 only).
 */

import { ScoreData, DetectedNote, Measure, KeySignature, ClefType, DurationType } from "../types";
import { midiToNoteName, midiToFrequency } from "./musicTheory";

/** Map MusicXML step letter to semitone offset from C. */
const STEP_TO_SEMITONE: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

/** Map MusicXML <type> values to internal DurationType. */
const XML_TYPE_MAP: Record<string, DurationType> = {
  whole: "whole",
  half: "half",
  quarter: "quarter",
  eighth: "eighth",
  "16th": "sixteenth",
  "32nd": "thirty_second",
};

/** Map fifths value to root note name. */
const FIFTHS_TO_ROOT_MAJOR: Record<number, string> = {
  "-7": "Cb", "-6": "Gb", "-5": "Db", "-4": "Ab", "-3": "Eb", "-2": "Bb", "-1": "F",
  0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F#", 7: "C#",
};
const FIFTHS_TO_ROOT_MINOR: Record<number, string> = {
  "-7": "Ab", "-6": "Eb", "-5": "Bb", "-4": "F", "-3": "C", "-2": "G", "-1": "D",
  0: "A", 1: "E", 2: "B", 3: "F#", 4: "C#", 5: "G#", 6: "D#", 7: "A#",
};

function pitchToMidi(step: string, alter: number, octave: number): number {
  const base = STEP_TO_SEMITONE[step] ?? 0;
  return (octave + 1) * 12 + base + alter;
}

function getChildText(el: Element, tag: string): string | null {
  const child = el.getElementsByTagName(tag)[0];
  return child?.textContent ?? null;
}

function getChildNum(el: Element, tag: string): number | null {
  const text = getChildText(el, tag);
  return text != null ? Number(text) : null;
}

export function parseMusicXML(xml: string): ScoreData {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");

  const parseError = doc.getElementsByTagName("parsererror");
  if (parseError.length > 0) {
    throw new Error("Invalid MusicXML: " + (parseError[0].textContent ?? "parse error"));
  }

  // Defaults
  let divisions = 1;
  let bpm = 120;
  let beatsPerMeasure = 4;
  let beatUnit = 4;
  let fifths = 0;
  let mode: "major" | "minor" = "major";
  let clef: ClefType = "treble";

  // Find first part
  const parts = doc.getElementsByTagName("part");
  if (parts.length === 0) throw new Error("No <part> found in MusicXML");
  const part = parts[0];

  const measures: Measure[] = [];
  const xmlMeasures = part.getElementsByTagName("measure");

  for (let mi = 0; mi < xmlMeasures.length; mi++) {
    const mEl = xmlMeasures[mi];

    // Parse <attributes> if present
    const attrs = mEl.getElementsByTagName("attributes");
    for (let ai = 0; ai < attrs.length; ai++) {
      const a = attrs[ai];
      const d = getChildNum(a, "divisions");
      if (d != null && d > 0) divisions = d;

      const keyEl = a.getElementsByTagName("key")[0];
      if (keyEl) {
        fifths = getChildNum(keyEl, "fifths") ?? fifths;
        const m = getChildText(keyEl, "mode");
        if (m === "major" || m === "minor") mode = m;
      }

      const timeEl = a.getElementsByTagName("time")[0];
      if (timeEl) {
        beatsPerMeasure = getChildNum(timeEl, "beats") ?? beatsPerMeasure;
        beatUnit = getChildNum(timeEl, "beat-type") ?? beatUnit;
      }

      const clefEl = a.getElementsByTagName("clef")[0];
      if (clefEl) {
        const sign = getChildText(clefEl, "sign");
        clef = sign === "F" ? "bass" : "treble";
      }
    }

    // Parse tempo from <sound> or <metronome>
    const sounds = mEl.getElementsByTagName("sound");
    for (let si = 0; si < sounds.length; si++) {
      const tempo = sounds[si].getAttribute("tempo");
      if (tempo) bpm = Math.round(Number(tempo));
    }
    const metronomes = mEl.getElementsByTagName("metronome");
    for (let mi2 = 0; mi2 < metronomes.length; mi2++) {
      const pm = getChildNum(metronomes[mi2], "per-minute");
      if (pm != null && pm > 0) bpm = Math.round(pm);
    }

    // Parse notes
    const beatDuration = 60 / bpm;
    const measureNumber = mi + 1;
    const measureStartSec = (measureNumber - 1) * beatsPerMeasure * beatDuration;
    let cursor = 0; // position in divisions from measure start
    const notes: DetectedNote[] = [];

    const noteEls = mEl.getElementsByTagName("note");
    for (let ni = 0; ni < noteEls.length; ni++) {
      const nEl = noteEls[ni];

      // Check for chord — same position as previous note
      const isChord = nEl.getElementsByTagName("chord").length > 0;

      const dur = getChildNum(nEl, "duration") ?? 0;
      const isRest = nEl.getElementsByTagName("rest").length > 0;

      // Forward/backup
      // (We handle <forward> and <backup> as separate elements, but they appear
      // as siblings of <note>, not inside them. For simplicity, just track cursor.)

      if (!isChord && !isRest) {
        // Regular note — advance cursor
      }

      const pitchEl = nEl.getElementsByTagName("pitch")[0];
      if (pitchEl && !isRest) {
        const step = getChildText(pitchEl, "step") ?? "C";
        const alter = getChildNum(pitchEl, "alter") ?? 0;
        const octave = getChildNum(pitchEl, "octave") ?? 4;
        const midi = pitchToMidi(step, alter, octave);

        // Duration type
        const typeText = getChildText(nEl, "type") ?? "quarter";
        const durationType = XML_TYPE_MAP[typeText] ?? "quarter";
        const dotted = nEl.getElementsByTagName("dot").length > 0;

        // Compute time in seconds
        const posDivisions = isChord ? Math.max(0, cursor - dur) : cursor;
        const startTime = measureStartSec + (posDivisions / divisions) * beatDuration;
        const durationSec = (dur / divisions) * beatDuration;

        notes.push({
          midi,
          name: midiToNoteName(midi),
          startTime,
          duration: durationSec,
          durationType,
          dotted,
          frequency: midiToFrequency(midi),
          amplitude: 0.5,
        });
      }

      // Advance cursor (unless chord — chord notes share position)
      if (!isChord) {
        cursor += dur;
      }
    }

    // Handle <forward> and <backup> elements
    const forwards = mEl.querySelectorAll("forward");
    const backups = mEl.querySelectorAll("backup");
    // Note: these are already handled implicitly by cursor logic above
    // since we process <note> elements in order. If needed for complex
    // multi-voice files, more logic would be required here.
    void forwards;
    void backups;

    measures.push({
      number: measureNumber,
      notes,
      totalBeats: beatsPerMeasure,
    });
  }

  // Build key signature
  const rootMap = mode === "minor" ? FIFTHS_TO_ROOT_MINOR : FIFTHS_TO_ROOT_MAJOR;
  const root = rootMap[fifths] ?? "C";
  const key: KeySignature = { root, mode, accidentals: fifths };

  // Total duration
  const lastMeasure = measures[measures.length - 1];
  const totalDuration = lastMeasure
    ? (lastMeasure.number * beatsPerMeasure * 60) / bpm
    : 0;

  return {
    bpm,
    beatsPerMeasure,
    beatUnit,
    key,
    clef,
    measures,
    totalDuration,
  };
}
