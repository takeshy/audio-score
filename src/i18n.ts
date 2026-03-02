export interface Translations {
  pluginName: string;
  settingsTitle: string;
  // Score panel
  loadFile: string;
  loadFromDrive: string;
  orDragDrop: string;
  analyze: string;
  analyzing: string;
  export: string;
  exportSuccess: string;
  exportError: string;
  noNotes: string;
  totalNotes: string;
  duration: string;
  bpm: string;
  key: string;
  measures: string;
  clef: string;
  treble: string;
  bass: string;
  // Progress stages
  stageDecoding: string;
  stageLoadingModel: string;
  stagePitch: string;
  stageQuantizing: string;
  stageDone: string;
  // Settings
  onsetThreshold: string;
  frameThreshold: string;
  minNoteDuration: string;
  beatsPerMeasure: string;
  beatUnit: string;
  bpmOverride: string;
  bpmOverrideHint: string;
  pitchRange: string;
  pitchRangeAll: string;
  pitchRangeCutBass: string;
  pitchRangeMelody: string;
  resetDefaults: string;
  save: string;
  cancel: string;
  // Errors
  errorDecode: string;
  errorAnalysis: string;
  errorNoAudio: string;
  // Current file
  currentFile: string;
  analyzeCurrentFile: string;
  // Playback & image
  saveImage: string;
  saveImageSuccess: string;
  play: string;
  stop: string;
  // AI features
  aiSection: string;
  aiChords: string;
  aiChordsLoading: string;
  aiChordsSuccess: string;
  aiAnalysis: string;
  aiAnalysisLoading: string;
  aiAnalysisTitle: string;
  aiAnalysisCollapse: string;
  aiAnalysisExpand: string;
  aiSimplify: string;
  aiSimplifyLoading: string;
  aiSimplifyMelody: string;
  aiSimplifyBass: string;
  aiSimplifySimplified: string;
  aiSimplifySuccess: string;
  aiMusicXML: string;
  aiMusicXMLSuccess: string;
  aiError: string;
  // Main view
  tabCanvas: string;
  tabMidi: string;
  mainViewEmpty: string;
}

const en: Translations = {
  pluginName: "Audio Score",
  settingsTitle: "Audio Score Settings",
  loadFile: "Load Audio File",
  loadFromDrive: "Load from Drive",
  orDragDrop: "or drag & drop an audio file",
  analyze: "Analyze",
  analyzing: "Analyzing...",
  export: "Export to Drive",
  exportSuccess: "Exported successfully",
  exportError: "Export failed",
  noNotes: "No notes detected. Try adjusting the threshold settings.",
  totalNotes: "Notes",
  duration: "Duration",
  bpm: "BPM",
  key: "Key",
  measures: "Measures",
  clef: "Clef",
  treble: "Treble",
  bass: "Bass",
  stageDecoding: "Decoding audio...",
  stageLoadingModel: "Loading pitch model...",
  stagePitch: "Detecting pitch...",
  stageQuantizing: "Quantizing durations...",
  stageDone: "Analysis complete",
  onsetThreshold: "Onset Threshold",
  frameThreshold: "Frame Threshold",
  minNoteDuration: "Min Note Duration (s)",
  beatsPerMeasure: "Beats per Measure",
  beatUnit: "Beat Unit",
  bpmOverride: "BPM Override",
  bpmOverrideHint: "0 = auto-detect",
  pitchRange: "Pitch Range",
  pitchRangeAll: "All (full range)",
  pitchRangeCutBass: "Cut Bass (C3+)",
  pitchRangeMelody: "Melody Only (C4–C7)",
  resetDefaults: "Reset to Defaults",
  save: "Save",
  cancel: "Cancel",
  errorDecode: "Failed to decode audio file",
  errorAnalysis: "Analysis error",
  errorNoAudio: "Please load an audio file first",
  currentFile: "Current file",
  analyzeCurrentFile: "Analyze",
  saveImage: "Save Image",
  saveImageSuccess: "Image saved",
  play: "Play",
  stop: "Stop",
  aiSection: "AI Features",
  aiChords: "Chords",
  aiChordsLoading: "Analyzing chords...",
  aiChordsSuccess: "Chord annotations added",
  aiAnalysis: "Analysis",
  aiAnalysisLoading: "Analyzing music...",
  aiAnalysisTitle: "Music Analysis",
  aiAnalysisCollapse: "Collapse",
  aiAnalysisExpand: "Expand",
  aiSimplify: "Simplify",
  aiSimplifyLoading: "Simplifying...",
  aiSimplifyMelody: "Melody only",
  aiSimplifyBass: "Bass only",
  aiSimplifySimplified: "Simplified",
  aiSimplifySuccess: "Score simplified",
  aiMusicXML: "MusicXML",
  aiMusicXMLSuccess: "MusicXML downloaded",
  aiError: "AI processing failed",
  tabCanvas: "Score",
  tabMidi: "Piano Roll",
  mainViewEmpty: "Load an audio file from the sidebar",
};

const ja: Translations = {
  pluginName: "Audio Score",
  settingsTitle: "Audio Score 設定",
  loadFile: "音声ファイルを読み込む",
  loadFromDrive: "Drive から読み込む",
  orDragDrop: "または音声ファイルをドラッグ＆ドロップ",
  analyze: "解析",
  analyzing: "解析中...",
  export: "Drive にエクスポート",
  exportSuccess: "エクスポート成功",
  exportError: "エクスポート失敗",
  noNotes: "音符が検出されませんでした。閾値設定を調整してください。",
  totalNotes: "音符数",
  duration: "長さ",
  bpm: "BPM",
  key: "調",
  measures: "小節数",
  clef: "音部記号",
  treble: "ト音記号",
  bass: "ヘ音記号",
  stageDecoding: "音声デコード中...",
  stageLoadingModel: "ピッチモデル読み込み中...",
  stagePitch: "ピッチ検出中...",
  stageQuantizing: "音価量子化中...",
  stageDone: "解析完了",
  onsetThreshold: "オンセット閾値",
  frameThreshold: "フレーム閾値",
  minNoteDuration: "最小音符長 (秒)",
  beatsPerMeasure: "拍子（分子）",
  beatUnit: "拍子（分母）",
  bpmOverride: "BPM 指定",
  bpmOverrideHint: "0 = 自動検出",
  pitchRange: "音域フィルタ",
  pitchRangeAll: "全帯域",
  pitchRangeCutBass: "低音カット (C3以上)",
  pitchRangeMelody: "メロディのみ (C4〜C7)",
  resetDefaults: "デフォルトに戻す",
  save: "保存",
  cancel: "キャンセル",
  errorDecode: "音声ファイルのデコードに失敗しました",
  errorAnalysis: "解析エラー",
  errorNoAudio: "先に音声ファイルを読み込んでください",
  currentFile: "現在のファイル",
  analyzeCurrentFile: "解析",
  saveImage: "画像を保存",
  saveImageSuccess: "画像を保存しました",
  play: "再生",
  stop: "停止",
  aiSection: "AI 機能",
  aiChords: "コード名",
  aiChordsLoading: "コード分析中...",
  aiChordsSuccess: "コード注釈を追加しました",
  aiAnalysis: "分析",
  aiAnalysisLoading: "楽曲分析中...",
  aiAnalysisTitle: "楽曲分析",
  aiAnalysisCollapse: "折りたたむ",
  aiAnalysisExpand: "展開する",
  aiSimplify: "簡略化",
  aiSimplifyLoading: "簡略化中...",
  aiSimplifyMelody: "メロディのみ",
  aiSimplifyBass: "ベースのみ",
  aiSimplifySimplified: "簡略化",
  aiSimplifySuccess: "楽譜を簡略化しました",
  aiMusicXML: "MusicXML",
  aiMusicXMLSuccess: "MusicXML をダウンロードしました",
  aiError: "AI 処理に失敗しました",
  tabCanvas: "楽譜",
  tabMidi: "ピアノロール",
  mainViewEmpty: "サイドバーから音声ファイルを読み込んでください",
};

const translations: Record<string, Translations> = { en, ja };

export function t(locale?: string): Translations {
  if (locale && locale.startsWith("ja")) return ja;
  return translations[locale ?? "en"] ?? en;
}
