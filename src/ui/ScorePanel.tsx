/**
 * Main sidebar panel for Audio Score plugin.
 * Handles audio file loading, analysis pipeline, and score display.
 */

import * as React from "react";
import { ScoreData, AnalysisSettings, AnalysisProgress, DEFAULT_SETTINGS, StemName } from "../types";
import { detectPitchBasicPitch } from "../core/basicPitchDetector";
import { separateAll, STEM_NAMES, DEFAULT_NUM_WORKERS } from "../core/demucsService";
import { buildScoreFromNotes } from "../core/noteSegmenter";
import { t } from "../i18n";
import { saveTemporary } from "../storage/idb";
import { playScore, PlaybackHandle } from "../core/player";
import {
  ChordAnnotation,
  analyzeChords,
  improveScore,
  convertToMusicXML,
} from "../core/aiService";
import { setState, useStore } from "../store";

interface PluginAPI {
  language?: string;
  drive: {
    createFile(name: string, content: string): Promise<{ id: string; name: string }>;
    readFile?(fileId: string): Promise<string>;
  };
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  gemini: {
    chat(
      messages: Array<{ role: string; content: string }>,
      options?: { model?: string; systemPrompt?: string },
    ): Promise<string>;
  };
  assets: {
    fetch(name: string): Promise<ArrayBuffer>;
  };
}

interface ScorePanelProps {
  api: PluginAPI;
  language?: string;
  fileId?: string;
  fileName?: string;
}

type Phase = "idle" | "loading" | "loaded" | "analyzing" | "done" | "error";

const DEFAULT_ANALYSIS_STEM: StemName = "piano";

/** Encode an AudioBuffer to a 16-bit stereo WAV Blob. */
function audioBufferToWav(buf: AudioBuffer): Blob {
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
  const n = buf.length;
  const ab = new ArrayBuffer(44 + n * 4);
  const v = new DataView(ab);
  const w = (p: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 4, true);
  w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, buf.sampleRate, true); v.setUint32(28, buf.sampleRate * 4, true);
  v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 4, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    v.setInt16(off, Math.round(Math.max(-1, Math.min(1, ch0[i])) * 32767), true); off += 2;
    v.setInt16(off, Math.round(Math.max(-1, Math.min(1, ch1[i])) * 32767), true); off += 2;
  }
  return new Blob([ab], { type: "audio/wav" });
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

export function ScorePanel({ api, language, fileId: activeFileId, fileName: activeFileName }: ScorePanelProps) {
  const i = t(language ?? api.language);

  const [phase, setPhase] = React.useState<Phase>("idle");
  const [progress, setProgress] = React.useState<AnalysisProgress | null>(null);
  const [score, setScore] = React.useState<ScoreData | null>(null);
  const [error, setError] = React.useState<string>("");
  const [fileName, setFileName] = React.useState<string>("");
  const [settings, setSettings] = React.useState<AnalysisSettings>(DEFAULT_SETTINGS);
  const [playing, setPlaying] = React.useState(false);
  const [bpmInput, setBpmInput] = React.useState("");

  // AI state
  const [aiLoading, setAiLoading] = React.useState("");
  const [aiMessage, setAiMessage] = React.useState("");
  const [aiError, setAiError] = React.useState("");
  const [chordAnnotations, setChordAnnotations] = React.useState<ChordAnnotation[]>([]);
  const [aiProgress, setAiProgress] = React.useState<{ completed: number; total: number; stage?: string } | null>(null);

  const playbackRef = React.useRef<PlaybackHandle | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Raw decoded audio (always the original file audio)
  const audioRef = React.useRef<AudioBuffer | null>(null);

  // Demucs state: all 6 stems cached after a single separateAll() run
  const demucsBufferRef = React.useRef<AudioBuffer | null>(null);
  const stemBuffers = React.useRef<Map<StemName, AudioBuffer>>(new Map());
  const [demucsStem, setDemucsStem] = React.useState<StemName | null>(null);
  const [demucsDone, setDemucsDone] = React.useState(false);
  const [demucsWorkers, setDemucsWorkers] = React.useState(DEFAULT_NUM_WORKERS);
  const [demucsRunning, setDemucsRunning] = React.useState(false);
  const [demucsProgress, setDemucsProgress] = React.useState(0);
  const [demucsError, setDemucsError] = React.useState("");
  const stemPlaybackRef = React.useRef<{ ctx: AudioContext; src: AudioBufferSourceNode } | null>(null);
  const [stemPlaying, setStemPlaying] = React.useState(false);

  // Load settings on mount
  React.useEffect(() => {
    api.storage.get("analysisSettings").then((saved) => {
      if (saved && typeof saved === "object") {
        setSettings({ ...DEFAULT_SETTINGS, ...(saved as Partial<AnalysisSettings>) });
      }
    });
  }, [api]);

  const AUDIO_EXTS = /\.(mp3|wav|ogg|flac|aac|m4a|webm|wma)$/i;

  // Whether the currently open file is an audio file
  const isCurrentFileAudio = !!(activeFileId && activeFileName && AUDIO_EXTS.test(activeFileName));

  // Auto-load if the currently open file is a .audioscore or .musicxml
  React.useEffect(() => {
    if (!activeFileId || !activeFileName) return;
    const isAudioScore = activeFileName.endsWith(".audioscore");
    const isMusicXml = activeFileName.endsWith(".musicxml") || activeFileName.endsWith(".xml");
    if (!isAudioScore && !isMusicXml) return;

    setPhase("loading");
    setError("");

    const loadText = api.drive.readFile
      ? api.drive.readFile(activeFileId)
      : fetch(`/api/drive/files?action=raw&fileId=${encodeURIComponent(activeFileId)}`)
          .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });

    loadText.then(
      async (text) => {
        try {
          let parsed: ScoreData;
          if (isMusicXml) {
            const { parseMusicXML } = await import("../core/musicXmlImport");
            parsed = parseMusicXML(text);
          } else {
            parsed = JSON.parse(text) as ScoreData;
          }
          if (parsed && parsed.measures) {
            setScore(parsed);
            setChordAnnotations(parsed.chordAnnotations ?? []);
            setFileName(activeFileName.replace(/\.(audioscore|musicxml|xml)$/, ""));
            setPhase("done");
          } else {
            setPhase("idle");
          }
        } catch {
          setPhase("idle");
        }
      },
      () => {
        setPhase("idle");
      },
    );
  }, [activeFileId, activeFileName, api]);

  // Stop playback when score changes or on unmount
  React.useEffect(() => {
    return () => {
      if (playbackRef.current) {
        playbackRef.current.stop();
        playbackRef.current = null;
        setPlaying(false);
      }
    };
  }, [score]);

  // Stop stem playback when stem selection changes
  React.useEffect(() => {
    return () => {
      if (stemPlaybackRef.current) {
        stemPlaybackRef.current.src.stop();
        stemPlaybackRef.current.ctx.close();
        stemPlaybackRef.current = null;
        setStemPlaying(false);
      }
    };
  }, [demucsStem]);

  // Sync score, chordAnnotations, and fileName to shared store for main view
  React.useEffect(() => { setState({ score }); }, [score]);
  React.useEffect(() => { setState({ chordAnnotations }); }, [chordAnnotations]);
  React.useEffect(() => { setState({ fileName }); }, [fileName]);

  // Watch playFromMeasure from store (set by MainView canvas click)
  const { playFromMeasure } = useStore();
  React.useEffect(() => {
    if (playFromMeasure == null || !score) return;
    // Stop current playback
    if (playbackRef.current) {
      playbackRef.current.stop();
      playbackRef.current = null;
    }
    const handle = playScore(score, playFromMeasure);
    playbackRef.current = handle;
    setState({ playbackHandle: handle, playFromMeasure: null });
    setPlaying(true);
    handle.finished.then(() => {
      if (playbackRef.current !== handle) return;
      playbackRef.current = null;
      setState({ playbackHandle: null });
      setPlaying(false);
    });
  }, [playFromMeasure, score]);

  const progressLabel = (p: AnalysisProgress): string => {
    const labels: Record<AnalysisProgress["stage"], string> = {
      decoding: i.stageDecoding,
      loading_demucs: i.stageLoadingDemucs,
      separating: i.stageSeparating,
      loading_model: i.stageLoadingModel,
      loading_ort: i.stageLoadingOrt,
      pitch: i.stagePitch,
      quantizing: i.stageQuantizing,
      done: i.stageDone,
    };
    return labels[p.stage] ?? "";
  };

  /**
   * Decode an ArrayBuffer to AudioBuffer and enter "loaded" state.
   * Does NOT run analysis — user triggers that separately.
   */
  const decodeAudio = React.useCallback(
    async (arrayBuffer: ArrayBuffer, name: string) => {
      setPhase("loading");
      setError("");
      setFileName(name);
      setScore(null);
      audioRef.current = null;
      demucsBufferRef.current = null;
      stemBuffers.current.clear();
      setDemucsStem(null);
      setDemucsDone(false);
      setDemucsError("");

      const audioCtx = new AudioContext();
      try {
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        audioRef.current = audioBuffer;
        setPhase("loaded");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`${i.errorDecode}: ${msg}`);
        setPhase("error");
      } finally {
        await audioCtx.close();
      }
    },
    [i],
  );

  /**
   * Run pitch detection and build score.
   * Uses the Demucs-separated buffer if available, otherwise the raw audio.
   */
  const runAnalysis = React.useCallback(async () => {
    if (!audioRef.current) return;
    setPhase("analyzing");
    setError("");
    setScore(null);

    const analysisBuffer = demucsBufferRef.current ?? audioRef.current;

    try {
      let notes;
      if (settings.detectorType === "piano_transcription") {
        setProgress({ stage: "loading_ort", percent: 5 });
        const { detectPitchPianoTranscription } = await import("../core/pianoTranscriptionService");
        notes = await detectPitchPianoTranscription(
          analysisBuffer,
          (assetName) => api.assets.fetch(assetName),
          (pct) => setProgress({ stage: "pitch", percent: 10 + pct * 0.75 }),
        );
      } else {
        setProgress({ stage: "loading_model", percent: 10 });
        notes = await detectPitchBasicPitch(
          analysisBuffer,
          (pct) => setProgress({ stage: "pitch", percent: 10 + pct * 75 }),
          settings.onsetThreshold,
          settings.frameThreshold,
        );
      }

      setProgress({ stage: "quantizing", percent: 85 });
      await new Promise((r) => setTimeout(r, 0));

      const bpmOverride = bpmInput ? parseInt(bpmInput, 10) || 0 : 0;
      const scoreData = buildScoreFromNotes(notes, { ...settings, bpmOverride });

      setProgress({ stage: "done", percent: 100 });
      setScore(scoreData);
      setPhase("done");

      const baseName = fileName.replace(/\.[^.]+$/, "");
      const stemSuffix = demucsStem ? `_${demucsStem}` : "";
      saveTemporary(`${baseName}${stemSuffix}.json`, JSON.stringify(scoreData)).catch(() => {});
      api.drive.createFile(`${baseName}${stemSuffix}.audioscore`, JSON.stringify(scoreData)).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`${i.errorAnalysis}: ${msg}`);
      setPhase("error");
    }
  }, [settings, bpmInput, i, api, fileName, demucsStem]);

  /**
   * Run Demucs separateAll to get all 6 stems at once.
   * Default analysis stem is "piano".
   */
  const handleDemucsRun = React.useCallback(async () => {
    if (!audioRef.current || demucsRunning) return;
    setDemucsRunning(true);
    setDemucsProgress(0);
    setDemucsError("");
    demucsBufferRef.current = null;
    stemBuffers.current.clear();
    setDemucsDone(false);
    setDemucsStem(null);

    try {
      const all = await separateAll(
        audioRef.current,
        (assetName) => api.assets.fetch(assetName),
        (p) => {
          if (p.stage === "downloading_wasm")       setDemucsProgress(p.percent * 0.1);
          else if (p.stage === "downloading_model") setDemucsProgress(10 + p.percent * 0.3);
          else if (p.stage === "initializing")      setDemucsProgress(40 + p.percent * 0.1);
          else                                      setDemucsProgress(50 + p.percent * 0.5);
        },
        demucsWorkers,
      );
      for (const [name, buf] of Object.entries(all)) {
        stemBuffers.current.set(name as StemName, buf);
      }
      setDemucsStem(DEFAULT_ANALYSIS_STEM);
      demucsBufferRef.current = all[DEFAULT_ANALYSIS_STEM];
      setDemucsDone(true);
    } catch (err) {
      setDemucsError(err instanceof Error ? err.message : String(err));
    } finally {
      setDemucsRunning(false);
      setDemucsProgress(0);
    }
  }, [demucsRunning, api.assets, demucsWorkers]);

  /**
   * Handle file input change — decode only, don't analyze yet.
   */
  const loadFile = React.useCallback(
    (file: File) => {
      if (file.name.endsWith(".musicxml") || file.name.endsWith(".xml")) {
        file.text().then(
          async (xml) => {
            try {
              const { parseMusicXML } = await import("../core/musicXmlImport");
              const parsed = parseMusicXML(xml);
              setScore(parsed);
              setChordAnnotations(parsed.chordAnnotations ?? []);
              setFileName(file.name.replace(/\.(musicxml|xml)$/, ""));
              setPhase("done");
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setPhase("error");
            }
          },
          (err) => {
            setError(err instanceof Error ? err.message : String(err));
            setPhase("error");
          }
        );
        return;
      }
      file.arrayBuffer().then(
        (buf) => decodeAudio(buf, file.name),
        (err) => {
          setError(`${i.errorDecode}: ${err instanceof Error ? err.message : String(err)}`);
          setPhase("error");
        }
      );
    },
    [decodeAudio, i]
  );

  const handleFileChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) loadFile(file);
    },
    [loadFile]
  );

  const handleDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files[0];
      if (file) loadFile(file);
    },
    [loadFile]
  );

  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  /**
   * Load (decode) the currently open audio file from Drive.
   */
  const handleCurrentFileLoad = React.useCallback(async () => {
    if (!activeFileId || !activeFileName) return;

    setPhase("loading");
    setError("");

    try {
      const resp = await fetch(
        `/api/drive/files?action=raw&fileId=${encodeURIComponent(activeFileId)}`,
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      await decodeAudio(buf, activeFileName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`${i.errorDecode}: ${msg}`);
      setPhase("error");
    }
  }, [activeFileId, activeFileName, decodeAudio, i]);

  /**
   * Toggle score playback.
   */
  const handlePlayStop = React.useCallback(() => {
    if (playing && playbackRef.current) {
      playbackRef.current.stop();
      playbackRef.current = null;
      setState({ playbackHandle: null });
      setPlaying(false);
      return;
    }

    if (!score) return;

    const handle = playScore(score);
    playbackRef.current = handle;
    setState({ playbackHandle: handle });
    setPlaying(true);

    handle.finished.then(() => {
      if (playbackRef.current !== handle) return;
      playbackRef.current = null;
      setState({ playbackHandle: null });
      setPlaying(false);
    });
  }, [playing, score]);

  // AI helper: show success message for 3 seconds
  const showAiSuccess = React.useCallback((msg: string) => {
    setAiMessage(msg);
    setTimeout(() => setAiMessage(""), 3000);
  }, []);

  // AI helper: show error message
  const showAiError = React.useCallback((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    setAiError(`${i.aiError}: ${msg}`);
    setTimeout(() => setAiError(""), 5000);
  }, [i]);

  /**
   * AI: Analyze chords
   */
  const handleAiChords = React.useCallback(async () => {
    if (!score || aiLoading) return;
    setAiLoading("chords");
    setAiError("");
    try {
      const annotations = await analyzeChords(api.gemini, score);
      setChordAnnotations(annotations);

      const updatedScore = { ...score, chordAnnotations: annotations };
      setScore(updatedScore);
      const baseName = fileName ? fileName.replace(/\.[^.]+$/, "") : "score";
      const stemSuffix = demucsStem ? `_${demucsStem}` : "";
      const json = JSON.stringify(updatedScore);
      saveTemporary(`${baseName}${stemSuffix}.json`, json).catch(() => {});
      api.drive.createFile(`${baseName}${stemSuffix}.audioscore`, json).catch(() => {});

      showAiSuccess(i.aiChordsSuccess);
    } catch (err) {
      showAiError(err);
    } finally {
      setAiLoading("");
    }
  }, [score, aiLoading, api.gemini, i, fileName, demucsStem, showAiSuccess, showAiError, api.drive]);

  /**
   * AI: Improve score (remove ML artifacts)
   */
  const handleAiImprove = React.useCallback(async () => {
    if (!score || aiLoading) return;
    setAiLoading("improve");
    setAiError("");
    setAiProgress(null);
    try {
      const improved = await improveScore(api.gemini, score, (completed, total, stage) => {
        setAiProgress({ completed, total, stage });
      });
      if (improved) {
        setScore(improved);
        setChordAnnotations(improved.chordAnnotations ?? []);

        const baseName = fileName ? fileName.replace(/\.[^.]+$/, "") : "score";
        const stemSuffix = demucsStem ? `_${demucsStem}` : "";
        const improvedName = `${baseName}${stemSuffix}_improved`;
        const json = JSON.stringify(improved);
        saveTemporary(`${improvedName}.json`, json).catch(() => {});
        api.drive.createFile(`${improvedName}.audioscore`, json).catch(() => {});

        showAiSuccess(i.aiImproveSuccess);
      }
    } catch (err) {
      showAiError(err);
    } finally {
      setAiLoading("");
      setAiProgress(null);
    }
  }, [score, aiLoading, api.gemini, i, fileName, demucsStem, showAiSuccess, showAiError, api.drive]);

  /**
   * Convert to MusicXML and download.
   */
  const handleMusicXML = React.useCallback(() => {
    if (!score) return;
    try {
      const xml = convertToMusicXML(score);
      const blob = new Blob([xml], { type: "application/vnd.recordare.musicxml+xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const baseName = fileName ? fileName.replace(/\.[^.]+$/, "") : "score";
      const stemSuffix = demucsStem ? `_${demucsStem}` : "";
      a.download = `${baseName}${stemSuffix}.musicxml`;
      a.click();
      URL.revokeObjectURL(url);
      showAiSuccess(i.aiMusicXMLSuccess);
    } catch (err) {
      showAiError(err);
    }
  }, [score, fileName, demucsStem, i, showAiSuccess, showAiError]);

  /**
   * Export the selected stem as a WAV file (from cached buffers).
   */
  const handleStemExport = React.useCallback(() => {
    if (!demucsStem) return;
    const cached = stemBuffers.current.get(demucsStem);
    if (!cached) return;
    const baseName = fileName ? fileName.replace(/\.[^.]+$/, "") : "audio";
    downloadBlob(audioBufferToWav(cached), `${baseName}_${demucsStem}.wav`);
  }, [fileName, demucsStem]);

  /**
   * Play/stop the selected stem audio directly.
   */
  const handleStemPlayStop = React.useCallback(() => {
    if (stemPlaying && stemPlaybackRef.current) {
      stemPlaybackRef.current.src.stop();
      stemPlaybackRef.current.ctx.close();
      stemPlaybackRef.current = null;
      setStemPlaying(false);
      return;
    }
    if (!demucsStem) return;
    const buf = stemBuffers.current.get(demucsStem);
    if (!buf) return;
    const ctx = new AudioContext();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    stemPlaybackRef.current = { ctx, src };
    setStemPlaying(true);
    src.onended = () => {
      ctx.close();
      stemPlaybackRef.current = null;
      setStemPlaying(false);
    };
  }, [stemPlaying, demucsStem]);

  // Count total notes
  const totalNotes = score
    ? score.measures.reduce((sum, m) => sum + m.notes.length, 0)
    : 0;

  // Whether audio is loaded (and we can run Demucs or Analyze)
  const audioLoaded = phase === "loaded" || phase === "analyzing" || phase === "done";

  // Hide Demucs on mobile (WASM OOM)
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  return (
    <div
      className="audio-score-container"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <div className="audio-score-panel">
        {/* Header */}
        <div className="audio-score-header">
          <h2>{i.pluginName}</h2>
        </div>

        {/* File loading section */}
        <div className="audio-score-input-section">
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.musicxml,.xml"
            onChange={handleFileChange}
            style={{ display: "none" }}
          />

          <div className="audio-score-bpm-row">
            <label className="audio-score-bpm-label">{i.bpmOverride}</label>
            <input
              type="number"
              className="audio-score-bpm-input"
              placeholder={i.bpmOverrideHint}
              value={bpmInput}
              min={0}
              max={300}
              onChange={(e) => setBpmInput(e.target.value)}
              disabled={phase === "analyzing" || demucsRunning}
            />
          </div>

          <button
            className="audio-score-btn mod-cta audio-score-load-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={phase === "analyzing" || demucsRunning}
          >
            {i.loadFile}
          </button>
          <p className="audio-score-hint">{i.orDragDrop}</p>
        </div>

        {/* Current audio file from Drive */}
        {isCurrentFileAudio && (
          <div className="audio-score-drive-card">
            <span className="audio-score-current-file-name">{activeFileName}</span>
            <button
              className="audio-score-btn mod-cta"
              onClick={handleCurrentFileLoad}
              disabled={phase === "analyzing" || phase === "loading" || demucsRunning}
            >
              {phase === "loading" ? i.analyzing : i.loadAudio}
            </button>
          </div>
        )}

        {/* Source Separation + Analyze — shown once audio is decoded */}
        {audioLoaded && (
          <div className="audio-score-demucs-section">
            {/* Demucs: hidden on mobile (WASM OOM) */}
            {!isMobile && (
              <>
                {!demucsDone && (
                  <>
                    <div className="audio-score-workers-row">
                      <label className="audio-score-workers-label">Workers</label>
                      <select
                        className="audio-score-workers-select"
                        value={demucsWorkers}
                        onChange={(e) => setDemucsWorkers(Number(e.target.value))}
                        disabled={demucsRunning}
                      >
                        {[1, 2].map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </div>
                    <button
                      className={`audio-score-btn mod-cta audio-score-load-btn${demucsRunning ? " is-loading" : ""}`}
                      onClick={handleDemucsRun}
                      disabled={demucsRunning || phase === "analyzing"}
                    >
                      {demucsRunning ? i.stageSeparating : i.sourceSeparation}
                    </button>
                  </>
                )}
                {demucsRunning && (
                  <div className="audio-score-progress">
                    <div className="audio-score-progress-bar">
                      <div className="audio-score-progress-fill" style={{ width: `${demucsProgress}%` }} />
                    </div>
                  </div>
                )}
                {demucsError && <div className="audio-score-error">{demucsError}</div>}

                {/* After separation: stem selector + Analyze / Download / Play */}
                {demucsDone && (
                  <>
                    <div className="audio-score-stem-grid">
                      {STEM_NAMES.map((stem) => (
                        <button
                          key={stem}
                          className={`audio-score-stem-btn${demucsStem === stem ? " is-selected" : ""}`}
                          onClick={() => {
                            setDemucsStem(stem);
                            demucsBufferRef.current = stemBuffers.current.get(stem) ?? null;
                          }}
                        >
                          <span className="audio-score-stem-name">{stem}</span>
                        </button>
                      ))}
                    </div>
                    <div className="audio-score-model-row">
                      <select
                        className="audio-score-model-select"
                        value={settings.detectorType}
                        onChange={(e) => setSettings((prev) => ({ ...prev, detectorType: e.target.value as any }))}
                        disabled={phase === "analyzing"}
                      >
                        <option value="basic_pitch">{i.detectorBasicPitch}</option>
                        <option value="piano_transcription">{i.detectorPianoTranscription}</option>
                      </select>
                    </div>
                    <div className="audio-score-demucs-actions">
                      <button
                        className="audio-score-btn mod-cta"
                        onClick={runAnalysis}
                        disabled={phase === "analyzing" || !demucsStem}
                      >
                        {phase === "analyzing" ? i.analyzing : i.analyze}
                      </button>
                      <button
                        className="audio-score-btn"
                        onClick={handleStemExport}
                        disabled={!demucsStem}
                      >
                        {i.download}
                      </button>
                      <button
                        className="audio-score-btn"
                        onClick={handleStemPlayStop}
                        disabled={!demucsStem}
                      >
                        {stemPlaying ? i.stop : i.play}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}

            {/* Analyze button: secondary on desktop (skip separation), primary on mobile */}
            {(!demucsDone && !demucsRunning) && (
              <div className="audio-score-analyze-row">
                <select
                  className="audio-score-model-select"
                  value={settings.detectorType}
                  onChange={(e) => setSettings((prev) => ({ ...prev, detectorType: e.target.value as any }))}
                  disabled={phase === "analyzing"}
                >
                  <option value="basic_pitch">{i.detectorBasicPitch}</option>
                  <option value="piano_transcription">{i.detectorPianoTranscription}</option>
                </select>
                <button
                  className={isMobile ? "audio-score-btn mod-cta audio-score-load-btn" : "audio-score-btn audio-score-analyze-secondary"}
                  onClick={runAnalysis}
                  disabled={phase === "analyzing"}
                >
                  {phase === "analyzing" ? i.analyzing : i.analyze}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Progress */}
        {phase === "analyzing" && progress && (
          <div className="audio-score-progress">
            <div className="audio-score-progress-bar">
              <div
                className="audio-score-progress-fill"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <span className="audio-score-progress-label">
              {progressLabel(progress)}
            </span>
          </div>
        )}

        {/* Error */}
        {phase === "error" && error && (
          <div className="audio-score-error">{error}</div>
        )}

        {/* Score info */}
        {score && phase === "done" && (
          <>
            <div className="audio-score-info">
              <div className="audio-score-info-grid">
                <span className="audio-score-info-label">{i.bpm}:</span>
                <span>{score.bpm}</span>
                <span className="audio-score-info-label">{i.key}:</span>
                <span>
                  {score.key.root} {score.key.mode}
                </span>
                <span className="audio-score-info-label">{i.clef}:</span>
                <span>{score.clef === "treble" ? i.treble : i.bass}</span>
                <span className="audio-score-info-label">{i.totalNotes}:</span>
                <span>{totalNotes}</span>
                <span className="audio-score-info-label">{i.measures}:</span>
                <span>{score.measures.length}</span>
                <span className="audio-score-info-label">{i.duration}:</span>
                <span>{score.totalDuration.toFixed(1)}s</span>
              </div>
            </div>

            {/* AI Section */}
            {totalNotes > 0 && api.gemini && (
              <div className="audio-score-ai-section">
                <div className="audio-score-ai-section-title">{i.aiSection}</div>
                <div className="audio-score-ai-buttons">
                  <button
                    className={`audio-score-btn${aiLoading === "chords" ? " is-loading" : ""}`}
                    onClick={handleAiChords}
                    disabled={!!aiLoading}
                  >
                    {aiLoading === "chords" ? i.aiChordsLoading : i.aiChords}
                  </button>
                  <button
                    className={`audio-score-btn${aiLoading === "improve" ? " is-loading" : ""}`}
                    onClick={handleAiImprove}
                    disabled={!!aiLoading}
                  >
                    {aiLoading === "improve" ? i.aiImproveLoading : i.aiImprove}
                  </button>
                </div>
                {aiLoading === "improve" && aiProgress && (
                  <div className="audio-score-progress">
                    <div className="audio-score-progress-bar">
                      <div
                        className="audio-score-progress-fill"
                        style={{ width: aiProgress.stage === "filter" ? "5%" : `${(aiProgress.completed / aiProgress.total) * 100}%` }}
                      />
                    </div>
                    <span className="audio-score-progress-label">
                      {aiProgress.stage === "filter"
                        ? i.aiImproveFiltering
                        : `${aiProgress.completed}/${aiProgress.total}`}
                    </span>
                  </div>
                )}
                {aiMessage && <div className="audio-score-ai-msg">{aiMessage}</div>}
                {aiError && <div className="audio-score-ai-error">{aiError}</div>}
              </div>
            )}

            {totalNotes === 0 && (
              <div className="audio-score-no-notes">{i.noNotes}</div>
            )}

            {/* Actions */}
            {totalNotes > 0 && (
              <div className="audio-score-actions">
                <button className="audio-score-btn" onClick={handlePlayStop}>
                  {playing ? i.stop : i.play}
                </button>
                <button className="audio-score-btn" onClick={handleMusicXML}>
                  {i.aiMusicXML}
                </button>
              </div>
            )}

          </>
        )}

      </div>
    </div>
  );
}
