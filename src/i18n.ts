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
  resetDefaults: string;
  save: string;
  cancel: string;
  // Errors
  errorDecode: string;
  errorAnalysis: string;
  errorNoAudio: string;
  // Drive
  driveFileId: string;
  driveLoad: string;
  driveLoading: string;
  // Playback & image
  saveImage: string;
  saveImageSuccess: string;
  play: string;
  stop: string;
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
  resetDefaults: "Reset to Defaults",
  save: "Save",
  cancel: "Cancel",
  errorDecode: "Failed to decode audio file",
  errorAnalysis: "Analysis error",
  errorNoAudio: "Please load an audio file first",
  driveFileId: "Drive File ID",
  driveLoad: "Load",
  driveLoading: "Loading...",
  saveImage: "Save Image",
  saveImageSuccess: "Image saved",
  play: "Play",
  stop: "Stop",
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
  resetDefaults: "デフォルトに戻す",
  save: "保存",
  cancel: "キャンセル",
  errorDecode: "音声ファイルのデコードに失敗しました",
  errorAnalysis: "解析エラー",
  errorNoAudio: "先に音声ファイルを読み込んでください",
  driveFileId: "Drive ファイル ID",
  driveLoad: "読み込む",
  driveLoading: "読み込み中...",
  saveImage: "画像を保存",
  saveImageSuccess: "画像を保存しました",
  play: "再生",
  stop: "停止",
};

const translations: Record<string, Translations> = { en, ja };

export function t(locale?: string): Translations {
  if (locale && locale.startsWith("ja")) return ja;
  return translations[locale ?? "en"] ?? en;
}
