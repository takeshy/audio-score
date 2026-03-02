/**
 * AI service functions using Gemini API for score analysis and transformation.
 */

import { ScoreData } from "../types";
import { scoreToText } from "../ui/ScoreRenderer";
import { parseScoreText } from "./scoreParser";

export interface GeminiAPI {
  chat(
    messages: Array<{ role: string; content: string }>,
    options?: { model?: string; systemPrompt?: string },
  ): Promise<string>;
}

export interface ChordAnnotation {
  measureNumber: number;
  beatIndex: number;
  chordName: string;
}

export type SimplificationType = "melody" | "bass" | "simplified";

/**
 * Analyze chords in the score and return chord annotations.
 */
export async function analyzeChords(
  gemini: GeminiAPI,
  score: ScoreData,
): Promise<ChordAnnotation[]> {
  const text = scoreToText(score);
  const response = await gemini.chat(
    [
      {
        role: "user",
        content: text,
      },
    ],
    {
      systemPrompt: `You are a music theory expert. Analyze the following score and identify the chord at each beat position.
Return ONLY a JSON array with no other text. Each element should have:
- "measureNumber": the measure number (integer, 1-based)
- "beatIndex": the beat index within the measure (integer, 0-based)
- "chordName": the chord symbol (e.g. "C", "Am", "G7", "Dm7", "F#dim")

Analyze the harmony by looking at the notes sounding at each beat position. Group consecutive beats with the same chord.
Only output one chord annotation per chord change, not for every single beat.

Example output:
[{"measureNumber":1,"beatIndex":0,"chordName":"C"},{"measureNumber":2,"beatIndex":0,"chordName":"G7"}]`,
    },
  );

  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown) =>
        item &&
        typeof item === "object" &&
        typeof (item as ChordAnnotation).measureNumber === "number" &&
        typeof (item as ChordAnnotation).beatIndex === "number" &&
        typeof (item as ChordAnnotation).chordName === "string",
    ) as ChordAnnotation[];
  } catch {
    return [];
  }
}

/**
 * Analyze the music and return a markdown analysis.
 */
export async function analyzeMusic(
  gemini: GeminiAPI,
  score: ScoreData,
  lang: string,
): Promise<string> {
  const text = scoreToText(score);
  const isJa = lang.startsWith("ja");
  const response = await gemini.chat(
    [
      {
        role: "user",
        content: text,
      },
    ],
    {
      systemPrompt: isJa
        ? `あなたは音楽分析の専門家です。以下の楽譜を分析して、Markdown形式で以下の項目を説明してください：
- **構造**: セクション分け（イントロ、Aメロ、Bメロ、サビなど）と対応する小節番号
- **コード進行**: 主要なコード進行パターンとその特徴
- **メロディの特徴**: 音域、動き、特徴的なフレーズ
- **リズムの特徴**: リズムパターン、シンコペーション
- **全体的な雰囲気**: 曲の印象、ジャンルの推測

簡潔に、わかりやすく記述してください。`
        : `You are a music analysis expert. Analyze the following score and provide a Markdown-formatted analysis covering:
- **Structure**: Section breakdown (intro, verse, chorus, etc.) with measure numbers
- **Chord Progression**: Main chord progression patterns and their characteristics
- **Melody**: Range, movement, characteristic phrases
- **Rhythm**: Rhythmic patterns, syncopation
- **Overall Character**: Mood, genre estimation

Be concise and clear.`,
    },
  );

  return response;
}

/**
 * Simplify the score (melody only, bass only, or simplified arrangement).
 */
export async function simplifyScore(
  gemini: GeminiAPI,
  score: ScoreData,
  type: SimplificationType,
): Promise<ScoreData | null> {
  const text = scoreToText(score);

  const instructions: Record<SimplificationType, string> = {
    melody: `Extract only the melody (highest note) from each beat position. Remove all harmony/accompaniment notes.
Keep the same rhythm and structure. Return single notes only, no chords.`,
    bass: `Extract only the bass line (lowest note) from each beat position. Remove all melody/harmony notes.
Keep the same rhythm and structure. Return single notes only, no chords.`,
    simplified: `Simplify this score for a beginner:
- Simplify complex rhythms (convert sixteenth notes to eighth notes, remove dotted rhythms)
- Reduce chords to single notes (keep the melody)
- Keep the overall structure and key intact
- Make it playable for a beginner musician`,
  };

  const response = await gemini.chat(
    [
      {
        role: "user",
        content: text,
      },
    ],
    {
      systemPrompt: `You are a music arrangement expert. ${instructions[type]}

Return the result in EXACTLY the same text format as the input. Do not add explanations.
Keep the header (BPM, Key, Time, Clef, Measures, Duration) and all measure lines (M1:, M2:, etc.).`,
    },
  );

  return parseScoreText(response);
}

/**
 * Convert ScoreData to MusicXML format (no AI needed).
 */
export function convertToMusicXML(score: ScoreData): string {
  const divisions = 4; // divisions per quarter note

  const durationMap: Record<string, { dur: number; type: string }> = {
    whole:     { dur: divisions * 4, type: "whole" },
    half:      { dur: divisions * 2, type: "half" },
    quarter:   { dur: divisions,     type: "quarter" },
    eighth:    { dur: divisions / 2, type: "eighth" },
    sixteenth: { dur: divisions / 4, type: "16th" },
  };

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<score-partwise version="4.0">`);
  lines.push(`  <part-list>`);
  lines.push(`    <score-part id="P1"><part-name>Music</part-name></score-part>`);
  lines.push(`  </part-list>`);
  lines.push(`  <part id="P1">`);

  for (const measure of score.measures) {
    lines.push(`    <measure number="${measure.number}">`);

    if (measure.number === 1) {
      // Attributes
      lines.push(`      <attributes>`);
      lines.push(`        <divisions>${divisions}</divisions>`);
      lines.push(`        <key><fifths>${score.key.accidentals}</fifths><mode>${score.key.mode}</mode></key>`);
      lines.push(`        <time><beats>${score.beatsPerMeasure}</beats><beat-type>${score.beatUnit}</beat-type></time>`);
      lines.push(`        <clef><sign>${score.clef === "treble" ? "G" : "F"}</sign><line>${score.clef === "treble" ? 2 : 4}</line></clef>`);
      lines.push(`      </attributes>`);
      // Tempo
      lines.push(`      <direction placement="above">`);
      lines.push(`        <direction-type>`);
      lines.push(`          <metronome><beat-unit>quarter</beat-unit><per-minute>${score.bpm}</per-minute></metronome>`);
      lines.push(`        </direction-type>`);
      lines.push(`        <sound tempo="${score.bpm}"/>`);
      lines.push(`      </direction>`);
    }

    // Group notes by startTime for chords
    const sorted = [...measure.notes].sort((a, b) => a.startTime - b.startTime);
    const groups: Array<{ notes: typeof sorted; durationType: string; dotted: boolean }> = [];
    if (sorted.length > 0) {
      let cur = [sorted[0]];
      for (let n = 1; n < sorted.length; n++) {
        if (Math.abs(sorted[n].startTime - cur[0].startTime) <= 0.02) {
          cur.push(sorted[n]);
        } else {
          groups.push({ notes: cur, durationType: cur[0].durationType, dotted: cur[0].dotted });
          cur = [sorted[n]];
        }
      }
      groups.push({ notes: cur, durationType: cur[0].durationType, dotted: cur[0].dotted });
    }

    for (const group of groups) {
      const info = durationMap[group.durationType] ?? durationMap.quarter;
      const dur = group.dotted ? Math.round(info.dur * 1.5) : info.dur;

      for (let ni = 0; ni < group.notes.length; ni++) {
        const note = group.notes[ni];
        lines.push(`      <note>`);

        if (ni > 0) {
          lines.push(`        <chord/>`);
        }

        if (note.midi < 0) {
          lines.push(`        <rest/>`);
        } else {
          const p = midiToPitch(note.midi);
          lines.push(`        <pitch>`);
          lines.push(`          <step>${p.step}</step>`);
          if (p.alter !== 0) {
            lines.push(`          <alter>${p.alter}</alter>`);
          }
          lines.push(`          <octave>${p.octave}</octave>`);
          lines.push(`        </pitch>`);
        }

        lines.push(`        <duration>${dur}</duration>`);
        lines.push(`        <type>${info.type}</type>`);
        if (group.dotted) {
          lines.push(`        <dot/>`);
        }
        lines.push(`      </note>`);
      }
    }

    lines.push(`    </measure>`);
  }

  lines.push(`  </part>`);
  lines.push(`</score-partwise>`);
  return lines.join("\n");
}

/** Convert MIDI number to MusicXML pitch (step, alter, octave). */
function midiToPitch(midi: number): { step: string; alter: number; octave: number } {
  const noteNames = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
  const alters     = [ 0,   1,   0,   1,   0,   0,   1,   0,   1,   0,   1,   0];
  const pc = midi % 12;
  const octave = Math.floor(midi / 12) - 1;
  return { step: noteNames[pc], alter: alters[pc], octave };
}
