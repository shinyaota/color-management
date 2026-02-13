import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import heic2any from 'heic2any';
import * as exifr from 'exifr';
import SunCalc from 'suncalc';
import { computeLabStats, rgbToLab } from './lib/color.js';
import { applyLabShift, applyReinhardTransfer } from './lib/transfer.js';
import { buildZip } from './lib/zip.js';
import { parsePaletteCsv, summarizePalette } from './lib/report.js';
import {
  base64ToBlob,
  blobToBase64,
  canvasToBlob,
  getImageDataFromFile,
  loadImageFromFile,
  resizeFileToBlob
} from './lib/image.js';

const OUTPUT_SIZES = [
  { label: 'オリジナル', value: 'original', maxSize: null },
  { label: '長辺 2400px', value: '2400', maxSize: 2400 },
  { label: '長辺 1600px', value: '1600', maxSize: 1600 }
];

const MODES = [
  { label: 'フル (L*a*b*)', value: 'full' },
  { label: '色味のみ (a*, b*)', value: 'chromatic' },
  { label: '明るさのみ (L*)', value: 'luminance' }
];

const SERVER_METHODS = [
  { label: 'Auto (最適)', value: 'auto' },
  { label: 'Cheung 2004', value: 'Cheung 2004' },
  { label: 'Finlayson 2015', value: 'Finlayson 2015' },
  { label: 'Vandermonde', value: 'Vandermonde' },
  { label: 'TPS-3D', value: 'TPS-3D' }
];

const ANALYSIS_MAX_SIZE = 2400;
const CHART_PRESETS_KEY = 'cm_chart_presets';
const PALETTE_PRESETS_KEY = 'cm_palette_presets';

const DEFAULT_PALETTE_PRESETS = [
  {
    id: 'neutral-gray',
    name: 'ニュートラルグレー',
    items: [{ name: 'Neutral Gray', lab: { L: 50, a: 0, b: 0 } }]
  },
  {
    id: 'srgb-primaries',
    name: 'sRGB 基本色',
    items: [
      { name: 'Red', lab: rgbToLab(255, 0, 0) },
      { name: 'Green', lab: rgbToLab(0, 255, 0) },
      { name: 'Blue', lab: rgbToLab(0, 0, 255) }
    ]
  }
];

const RECOVERY_TARGET_PRESETS = [
  { id: 'neutral50', name: 'ニュートラル (L*50)', target: { L: 50, a: 0, b: 0 } },
  { id: 'neutral70', name: '明るめニュートラル (L*70)', target: { L: 70, a: 0, b: 0 } },
  { id: 'white95', name: '白基準 (L*95)', target: { L: 95, a: 0, b: 0 } },
  { id: 'custom', name: 'カスタム', target: null }
];

const loadPresets = (key) => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
};

const savePresets = (key, presets) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(presets));
  } catch (error) {
    // ignore
  }
};

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
};

const isHeicFile = (file) => {
  if (!file) return false;
  const type = (file.type || '').toLowerCase();
  if (type === 'image/heic' || type === 'image/heif') return true;
  return /\.(heic|heif)$/i.test(file.name);
};

const normalizeImageFile = async (file) => {
  if (!isHeicFile(file)) return file;
  const converted = await heic2any({
    blob: file,
    toType: 'image/jpeg',
    quality: 0.92
  });
  const blob = Array.isArray(converted) ? converted[0] : converted;
  const name = file.name.replace(/\.(heic|heif)$/i, '.jpg');
  return new File([blob], name, { type: 'image/jpeg' });
};

const createRecord = (file) => ({
  id: crypto.randomUUID(),
  file,
  name: file.name,
  size: file.size,
  type: file.type,
  url: URL.createObjectURL(file),
  width: null,
  height: null,
  status: 'ready',
  processedUrl: null,
  processedBlob: null,
  processedName: null,
  jobId: null,
  methodUsed: null,
  recoveryShift: null,
  role: 'edit'
});

const revokeRecordUrls = (record) => {
  if (record.url) URL.revokeObjectURL(record.url);
  if (record.processedUrl) URL.revokeObjectURL(record.processedUrl);
};

const buildProcessedName = (record, format) => {
  const ext = format === 'image/png' ? 'png' : 'jpg';
  return `${record.name.replace(/\.[^.]+$/, '')}_matched.${ext}`;
};

export default function App() {
  const [images, setImages] = useState([]);
  const [referenceId, setReferenceId] = useState(null);
  const [strength, setStrength] = useState(1);
  const [mode, setMode] = useState('full');
  const [outputSize, setOutputSize] = useState(OUTPUT_SIZES[1].value);
  const [outputFormat, setOutputFormat] = useState('image/jpeg');
  const [quality, setQuality] = useState(0.92);
  const [processing, setProcessing] = useState(false);
  const [chartFile, setChartFile] = useState(null);
  const [chartFromImageId, setChartFromImageId] = useState('');
  const [chartStatus, setChartStatus] = useState('idle');
  const [chartResult, setChartResult] = useState(null);
  const [chartError, setChartError] = useState(null);
  const [chartExif, setChartExif] = useState(null);
  const [chartEnvironment, setChartEnvironment] = useState(null);
  const [chartPresets, setChartPresets] = useState([]);
  const [chartPresetName, setChartPresetName] = useState('');
  const [chartPresetId, setChartPresetId] = useState('');
  const [referenceMode, setReferenceMode] = useState('colorchecker');
  const [referenceStatsPreview, setReferenceStatsPreview] = useState(null);
  const [referenceExif, setReferenceExif] = useState(null);
  const [environmentInfo, setEnvironmentInfo] = useState(null);
  const [recoveryEnabled, setRecoveryEnabled] = useState(true);
  const [recoveryAutoWB, setRecoveryAutoWB] = useState(true);
  const [recoveryAutoExposure, setRecoveryAutoExposure] = useState(true);
  const [recoveryTargetL, setRecoveryTargetL] = useState(50);
  const [recoveryTargetA, setRecoveryTargetA] = useState(0);
  const [recoveryTargetB, setRecoveryTargetB] = useState(0);
  const [recoveryStrength, setRecoveryStrength] = useState(1);
  const [serverMode, setServerMode] = useState(false);
  const [asyncMode, setAsyncMode] = useState(false);
  const [serverMethod, setServerMethod] = useState(SERVER_METHODS[0].value);
  const [apiError, setApiError] = useState(null);
  const [palette, setPalette] = useState([]);
  const [paletteFile, setPaletteFile] = useState(null);
  const [paletteTarget, setPaletteTarget] = useState('');
  const [palettePresets, setPalettePresets] = useState([]);
  const [palettePresetId, setPalettePresetId] = useState('');
  const [palettePresetName, setPalettePresetName] = useState('');
  const [backgroundSample, setBackgroundSample] = useState(null);
  const [sampleSource, setSampleSource] = useState('background');
  const [samplePickMode, setSamplePickMode] = useState('average');
  const [samplePreviewUrl, setSamplePreviewUrl] = useState(null);
  const [samplePreviewData, setSamplePreviewData] = useState(null);
  const [samplePickLab, setSamplePickLab] = useState(null);
  const [spotShift, setSpotShift] = useState(null);
  const [reportBlob, setReportBlob] = useState(null);
  const [reportSummary, setReportSummary] = useState(null);
  const [viewMode, setViewMode] = useState('list');
  const [filterText, setFilterText] = useState('');
  const [excludeReferenceFromProcess, setExcludeReferenceFromProcess] = useState(true);
  const [recoveryPresetId, setRecoveryPresetId] = useState(RECOVERY_TARGET_PRESETS[0].id);
  const [compareMode, setCompareMode] = useState('corrected');
  const fileInputRef = useRef(null);
  const chartInputRef = useRef(null);
  const paletteInputRef = useRef(null);
  const sampleInputRef = useRef(null);

  useEffect(() => {
    if (asyncMode && serverMode) {
      setServerMode(false);
    }
  }, [asyncMode, serverMode]);

  useEffect(() => {
    if (referenceMode === 'reference-image') {
      if (serverMode) setServerMode(false);
      if (asyncMode) setAsyncMode(false);
    }
    if (referenceMode === 'colorchecker' && !serverMode && !asyncMode) {
      setServerMode(true);
    }
  }, [referenceMode, serverMode, asyncMode]);

  useEffect(() => {
    setChartPresets(loadPresets(CHART_PRESETS_KEY));
    setPalettePresets(loadPresets(PALETTE_PRESETS_KEY));
  }, []);

  useEffect(() => {
    const preset = RECOVERY_TARGET_PRESETS.find((item) => item.id === recoveryPresetId);
    if (!preset || !preset.target) return;
    setRecoveryTargetL(preset.target.L);
    setRecoveryTargetA(preset.target.a);
    setRecoveryTargetB(preset.target.b);
  }, [recoveryPresetId]);

  const outputConfig = useMemo(
    () => OUTPUT_SIZES.find((item) => item.value === outputSize) ?? OUTPUT_SIZES[0],
    [outputSize]
  );

  const hasCalibration = Boolean(chartResult?.swatches?.length);
  const recoveryAvailable = referenceMode === 'reference-image';
  const filteredImages = useMemo(() => {
    if (!filterText.trim()) return images;
    const term = filterText.trim().toLowerCase();
    return images.filter((item) => item.name.toLowerCase().includes(term));
  }, [images, filterText]);
  const editImages = useMemo(
    () => filteredImages.filter((item) => item.role !== 'reference'),
    [filteredImages]
  );
  const referenceImages = useMemo(
    () => filteredImages.filter((item) => item.role === 'reference'),
    [filteredImages]
  );
  const referenceCandidates = referenceImages.length ? referenceImages : images;
  const chartCandidates = referenceImages.length ? referenceImages : images;

  useEffect(() => {
    if (!referenceCandidates.length) {
      setReferenceId(null);
      return;
    }
    const exists = referenceCandidates.some((item) => item.id === referenceId);
    if (!exists) {
      setReferenceId(referenceCandidates[0].id);
    }
  }, [referenceCandidates, referenceId]);

  const confidence = useMemo(() => {
    let score = 40;
    if (chartResult?.qualityScore != null) {
      score = chartResult.qualityScore;
    } else if (recoveryAvailable) {
      score = recoveryEnabled ? 55 : 35;
    }
    const risk = chartEnvironment?.risk || environmentInfo?.risk;
    if (risk === 'high') score -= 15;
    if (risk === 'medium') score -= 7;
    score = Math.max(0, Math.min(100, score));
    let label = '低';
    if (score >= 70) label = '高';
    else if (score >= 50) label = '中';
    return { score, label };
  }, [chartResult, chartEnvironment, environmentInfo, recoveryAvailable, recoveryEnabled]);

  const updateRecord = useCallback((id, patch) => {
    setImages((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const nextPatch = typeof patch === 'function' ? patch(item) : patch;
        return { ...item, ...nextPatch };
      })
    );
  }, []);

  const addFiles = useCallback(async (fileList) => {
    setApiError(null);
    const list = Array.from(fileList).filter(
      (file) => file.type.startsWith('image/') || isHeicFile(file)
    );
    if (!list.length) return;

    const normalizedFiles = [];
    for (const file of list) {
      try {
        normalizedFiles.push(await normalizeImageFile(file));
      } catch (error) {
        setApiError('HEICの変換に失敗しました。JPEG/PNGで再保存してください。');
      }
    }

    if (!normalizedFiles.length) return;

    const newRecords = normalizedFiles.map(createRecord);
    setImages((prev) => [...prev, ...newRecords]);

    for (const record of newRecords) {
      try {
        const img = await loadImageFromFile(record.file);
        updateRecord(record.id, { width: img.width, height: img.height });
      } catch (error) {
        updateRecord(record.id, { status: 'error' });
      }
    }

    if (!referenceId && newRecords.length) {
      setReferenceId(newRecords[0].id);
    }
  }, [referenceId, updateRecord]);

  const handleFileChange = (event) => {
    if (!event.target.files) return;
    addFiles(event.target.files);
    event.target.value = '';
  };

  const handleDrop = (event) => {
    event.preventDefault();
    if (event.dataTransfer?.files?.length) {
      addFiles(event.dataTransfer.files);
    }
  };

  const handleRemove = (id) => {
    setImages((prev) => {
      const next = prev.filter((item) => item.id !== id);
      const removed = prev.find((item) => item.id === id);
      if (removed) revokeRecordUrls(removed);
      if (referenceId === id && next.length) {
        setReferenceId(next[0].id);
      } else if (!next.length) {
        setReferenceId(null);
      }
      if (chartFromImageId === id) {
        setChartFromImageId('');
        setChartFile(null);
        setChartResult(null);
        setChartStatus('idle');
        setChartExif(null);
        setChartEnvironment(null);
      }
      return next;
    });
  };

  const toggleReferenceRole = (id) => {
    updateRecord(id, (item) => {
      const nextRole = item.role === 'reference' ? 'edit' : 'reference';
      return { role: nextRole };
    });
  };

  const handleClear = () => {
    setImages((prev) => {
      prev.forEach(revokeRecordUrls);
      return [];
    });
    setReferenceId(null);
    setChartFromImageId('');
    setChartFile(null);
    setChartResult(null);
    setChartStatus('idle');
    setChartExif(null);
    setChartEnvironment(null);
    setChartPresetId('');
    setChartPresetName('');
    setChartError(null);
    setPalette([]);
    setPaletteFile(null);
    setPalettePresetId('');
    setPalettePresetName('');
    setBackgroundSample(null);
    setSamplePreviewUrl(null);
    setSamplePreviewData(null);
    setSamplePickLab(null);
    setSpotShift(null);
    setReportBlob(null);
    setReportSummary(null);
  };

  const handleChartChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setChartFromImageId('');
    setChartPresetId('');
    setChartFile(file);
    setChartResult(null);
    setChartStatus('idle');
    setChartError(null);
    setChartExif(null);
    setChartEnvironment(null);
    setApiError(null);
    event.target.value = '';
  };

  const handleChartFromListChange = (event) => {
    const id = event.target.value;
    setChartFromImageId(id);
    if (!id) {
      setChartFile(null);
      setChartResult(null);
      setChartStatus('idle');
      setChartError(null);
      setChartExif(null);
      setChartEnvironment(null);
      return;
    }
    setChartPresetId('');
    const record = images.find((item) => item.id === id);
    if (record) {
      setChartFile(record.file);
      setChartResult(null);
      setChartStatus('idle');
      setChartError(null);
      setChartExif(null);
      setChartEnvironment(null);
    }
  };

  const computeStats = async (file) => {
    const { imageData } = await getImageDataFromFile(file, 256);
    return computeLabStats(imageData, 2);
  };

  const computeAverageLab = async (file) => {
    const { imageData } = await getImageDataFromFile(file, 256);
    const stats = computeLabStats(imageData, 1);
    return stats.mean;
  };

  const computeLabFromPatch = (imageData, x, y, radius = 6) => {
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;
    let count = 0;
    let sumL = 0;
    let sumA = 0;
    let sumB = 0;
    const minX = Math.max(0, x - radius);
    const maxX = Math.min(width - 1, x + radius);
    const minY = Math.max(0, y - radius);
    const maxY = Math.min(height - 1, y + radius);
    for (let yy = minY; yy <= maxY; yy += 1) {
      for (let xx = minX; xx <= maxX; xx += 1) {
        const idx = (yy * width + xx) * 4;
        const lab = rgbToLab(data[idx], data[idx + 1], data[idx + 2]);
        sumL += lab.L;
        sumA += lab.a;
        sumB += lab.b;
        count += 1;
      }
    }
    return {
      L: sumL / count,
      a: sumA / count,
      b: sumB / count
    };
  };

  const computeRecoveryShift = (stats) => {
    const shift = { L: 0, a: 0, b: 0 };
    if (recoveryAutoExposure) {
      shift.L = recoveryTargetL - stats.mean.L;
    }
    if (recoveryAutoWB) {
      shift.a = recoveryTargetA - stats.mean.a;
      shift.b = recoveryTargetB - stats.mean.b;
    }
    return shift;
  };

  const applyRecovery = (imageData) => {
    if (!recoveryAvailable || !recoveryEnabled) {
      return { shift: null, stats: computeLabStats(imageData, 2) };
    }
    const stats = computeLabStats(imageData, 2);
    const shift = computeRecoveryShift(stats);
    applyLabShift(imageData, shift, recoveryStrength);
    return { shift, stats };
  };

  const loadExif = async (file) => {
    try {
      const data = await exifr.parse(file, { gps: true, translateValues: true });
      return data ?? null;
    } catch (error) {
      return null;
    }
  };

  const computeEnvironment = (exif) => {
    if (!exif) return null;
    const latitude = exif.latitude ?? exif.GPSLatitude;
    const longitude = exif.longitude ?? exif.GPSLongitude;
    const timestamp =
      exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || exif.DateTime;
    if (latitude == null || longitude == null || !timestamp) return null;

    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    const position = SunCalc.getPosition(date, latitude, longitude);
    const altitudeDeg = (position.altitude * 180) / Math.PI;
    let risk = 'low';
    if (altitudeDeg < 10) risk = 'high';
    else if (altitudeDeg < 25) risk = 'medium';

    return {
      latitude,
      longitude,
      timestamp: date.toISOString(),
      sunAltitudeDeg: altitudeDeg,
      risk
    };
  };

  const handlePaletteChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPaletteFile(file);
    setPalettePresetId('');
    try {
      const parsed = await parsePaletteCsv(file);
      setPalette(parsed);
      if (parsed.length) {
        setPaletteTarget(parsed[0].name);
      }
    } catch (error) {
      setApiError('パレットCSVの読み込みに失敗しました。');
    }
  };

  const handleSampleChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const normalized = await normalizeImageFile(file);
      setBackgroundSample(normalized);
      setSampleSource('background');
    } catch (error) {
      setApiError('サンプル画像の読み込みに失敗しました。');
    }
  };

  const handleChartPresetSelect = (id) => {
    setChartPresetId(id);
    if (!id) return;
    const preset = chartPresets.find((item) => item.id === id);
    if (!preset) return;
    setChartResult(preset.chartResult);
    setChartStatus('done');
    setChartError(null);
    setChartFile(null);
    setChartFromImageId('');
  };

  const handleSaveChartPreset = () => {
    if (!chartResult?.swatches?.length || !chartPresetName.trim()) return;
    const preset = {
      id: crypto.randomUUID(),
      name: chartPresetName.trim(),
      chartResult,
      createdAt: new Date().toISOString()
    };
    const next = [preset, ...chartPresets];
    setChartPresets(next);
    savePresets(CHART_PRESETS_KEY, next);
    setChartPresetName('');
    setChartPresetId(preset.id);
  };

  const handleDeleteChartPreset = () => {
    if (!chartPresetId) return;
    const next = chartPresets.filter((item) => item.id !== chartPresetId);
    setChartPresets(next);
    savePresets(CHART_PRESETS_KEY, next);
    setChartPresetId('');
  };

  const applyPalettePreset = (preset) => {
    if (!preset?.items?.length) return;
    setPalette(preset.items);
    setPaletteTarget(preset.items[0].name);
    setPaletteFile(null);
  };

  const handlePalettePresetSelect = (id) => {
    setPalettePresetId(id);
    if (!id) return;
    const saved = palettePresets.find((item) => item.id === id);
    if (saved) {
      applyPalettePreset(saved);
      return;
    }
    const builtIn = DEFAULT_PALETTE_PRESETS.find((item) => item.id === id);
    if (builtIn) {
      applyPalettePreset(builtIn);
    }
  };

  const handleSavePalettePreset = () => {
    if (!palette.length || !palettePresetName.trim()) return;
    const preset = {
      id: crypto.randomUUID(),
      name: palettePresetName.trim(),
      items: palette
    };
    const next = [preset, ...palettePresets];
    setPalettePresets(next);
    savePresets(PALETTE_PRESETS_KEY, next);
    setPalettePresetName('');
    setPalettePresetId(preset.id);
  };

  const handleDeletePalettePreset = () => {
    if (!palettePresetId) return;
    const next = palettePresets.filter((item) => item.id !== palettePresetId);
    setPalettePresets(next);
    savePresets(PALETTE_PRESETS_KEY, next);
    setPalettePresetId('');
  };

  const analyzeChart = async () => {
    if (!chartFile) {
      setApiError('ColorChecker画像を選択してください。');
      return;
    }
    setApiError(null);
    setChartError(null);
    setChartStatus('processing');
    try {
      const exif = await loadExif(chartFile);
      setChartExif(exif);
      setChartEnvironment(computeEnvironment(exif));
      const normalized = await normalizeImageFile(chartFile);
      const resized = await resizeFileToBlob(normalized, ANALYSIS_MAX_SIZE, 'image/jpeg', 0.9);
      const base64 = await blobToBase64(resized);
      const response = await fetch('/api/colorchecker/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 })
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || 'Chart analysis failed.');
      }
      const data = await response.json();
      setChartResult(data);
      setChartStatus('done');
    } catch (error) {
      setChartStatus('error');
      const message = error?.message || 'Chart analysis failed.';
      setChartError(message);
      setApiError(message);
    }
  };

  const handleSamplePick = (event) => {
    if (!samplePreviewData) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = samplePreviewData.width / rect.width;
    const scaleY = samplePreviewData.height / rect.height;
    const x = Math.round((event.clientX - rect.left) * scaleX);
    const y = Math.round((event.clientY - rect.top) * scaleY);
    const lab = computeLabFromPatch(samplePreviewData.imageData, x, y, 6);
    setSamplePickLab(lab);
  };

  const prepareOutputBlob = async (file) => {
    const normalized = await normalizeImageFile(file);
    return resizeFileToBlob(normalized, outputConfig.maxSize, outputFormat, quality);
  };

  const runLocalCorrection = async (record, referenceStats) => {
    updateRecord(record.id, { status: 'processing' });
    const { imageData, canvas, ctx } = await getImageDataFromFile(record.file, outputConfig.maxSize);
    const recovery = applyRecovery(imageData);
    const targetStats = computeLabStats(imageData, 2);
    applyReinhardTransfer({
      imageData,
      referenceStats,
      targetStats,
      strength,
      mode
    });
    applyLabShift(imageData, spotShift, strength);
    ctx.putImageData(imageData, 0, 0);
    const blob = await canvasToBlob(canvas, outputFormat, quality);
    const url = URL.createObjectURL(blob);
    updateRecord(record.id, {
      status: 'done',
      processedBlob: blob,
      processedUrl: url,
      processedName: buildProcessedName(record, outputFormat),
      methodUsed: 'Reinhard',
      recoveryShift: recovery.shift
    });
  };

  const runServerCorrection = async (record, swatches) => {
    updateRecord(record.id, { status: 'processing' });
    const blob = await prepareOutputBlob(record.file);
    const base64 = await blobToBase64(blob);
    const response = await fetch('/api/colorchecker/correct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: base64,
        swatches,
        method: serverMethod,
        format: outputFormat,
        quality,
        spotShift
      })
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || 'Server correction failed.');
    }
    const data = await response.json();
    const correctedBlob = base64ToBlob(data.image, outputFormat);
    const correctedUrl = URL.createObjectURL(correctedBlob);
    updateRecord(record.id, {
      status: 'done',
      processedBlob: correctedBlob,
      processedUrl: correctedUrl,
      processedName: buildProcessedName(record, outputFormat),
      methodUsed: data.methodUsed || serverMethod
    });
  };

  const pollJob = async (jobId, recordId) => {
    const maxAttempts = 120;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await fetch(`/api/jobs/status/${jobId}`);
      if (response.ok) {
        const status = await response.json();
        if (status.status === 'processing') {
          updateRecord(recordId, { status: 'processing' });
        }
        if (status.status === 'error') {
          updateRecord(recordId, { status: 'error' });
          return;
        }
        if (status.status === 'done') {
          const resultResponse = await fetch(`/api/jobs/result/${jobId}`);
          if (!resultResponse.ok) {
            updateRecord(recordId, { status: 'error' });
            return;
          }
          const result = await resultResponse.json();
          const download = await fetch(result.downloadUrl);
          const blob = await download.blob();
          const url = URL.createObjectURL(blob);
          const record = images.find((item) => item.id === recordId);
          const name = record?.name ?? `job-${jobId}`;
          updateRecord(recordId, {
            status: 'done',
            processedBlob: blob,
            processedUrl: url,
            processedName: buildProcessedName({ name }, outputFormat),
            methodUsed: status.methodUsed || serverMethod
          });
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    updateRecord(recordId, { status: 'error' });
  };

  const runAsyncJob = async (record, swatches) => {
    updateRecord(record.id, { status: 'queued' });
    const uploadBlob = await prepareOutputBlob(record.file);
    const sasResponse = await fetch('/api/jobs/sas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: record.name })
    });
    if (!sasResponse.ok) {
      const message = await sasResponse.text();
      throw new Error(message || 'Failed to request SAS.');
    }
    const sasData = await sasResponse.json();
    await fetch(sasData.uploadUrl, {
      method: 'PUT',
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': outputFormat
      },
      body: uploadBlob
    });

    const submitResponse = await fetch('/api/jobs/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: sasData.jobId,
        inputBlob: sasData.blobName,
        swatches,
        method: serverMethod,
        format: outputFormat,
        quality,
        spotShift
      })
    });
    if (!submitResponse.ok) {
      const message = await submitResponse.text();
      throw new Error(message || 'Failed to enqueue job.');
    }
    updateRecord(record.id, { status: 'queued', jobId: sasData.jobId, methodUsed: serverMethod });
    await pollJob(sasData.jobId, record.id);
  };

  const handleProcess = async () => {
    if (!images.length) return;
    setApiError(null);

    if (referenceMode === 'colorchecker' && !chartResult?.swatches?.length) {
      setApiError('ColorChecker診断を先に実行してください。');
      return;
    }

    const processTargets = excludeReferenceFromProcess
      ? images.filter((item) => item.role !== 'reference')
      : images;

    setProcessing(true);
    try {
      if (referenceMode === 'reference-image') {
        const reference = images.find((img) => img.id === referenceId) ?? images[0];
        if (!reference) throw new Error('参照画像が見つかりません。');
        const { imageData: referenceData } = await getImageDataFromFile(
          reference.file,
          outputConfig.maxSize
        );
        applyRecovery(referenceData);
        const referenceStats = computeLabStats(referenceData, 2);
        let lastError = null;
        for (const record of processTargets) {
          try {
            await runLocalCorrection(record, referenceStats);
          } catch (error) {
            updateRecord(record.id, { status: 'error' });
            lastError = error;
          }
        }
        if (lastError) {
          setApiError(lastError?.message || '一部の画像で処理に失敗しました。');
        }
        return;
      }

      const swatches = chartResult?.swatches;
      if (asyncMode) {
        let lastError = null;
        for (const record of processTargets) {
          try {
            await runAsyncJob(record, swatches);
          } catch (error) {
            updateRecord(record.id, { status: 'error' });
            lastError = error;
          }
        }
        if (lastError) {
          setApiError(lastError?.message || '一部の画像で処理に失敗しました。');
        }
        return;
      }
      if (serverMode) {
        let lastError = null;
        for (const record of processTargets) {
          try {
            await runServerCorrection(record, swatches);
          } catch (error) {
            updateRecord(record.id, { status: 'error' });
            lastError = error;
          }
        }
        if (lastError) {
          setApiError(lastError?.message || '一部の画像で処理に失敗しました。');
        }
        return;
      }

      throw new Error('ColorChecker補正はサーバー補正のみ対応しています。');
    } catch (error) {
      setApiError(error?.message || '処理に失敗しました。');
    } finally {
      setProcessing(false);
    }
  };

  const handleDownloadAll = async () => {
    const entries = [];
    for (const record of images) {
      let blob = record.processedBlob;
      if (!blob && record.processedUrl) {
        const response = await fetch(record.processedUrl);
        blob = await response.blob();
      }
      if (blob) {
        entries.push({
          name: record.processedName ?? buildProcessedName(record, outputFormat),
          blob
        });
      }
    }
    if (!entries.length) return;
    const extras = [];
    if (reportBlob) {
      const buffer = await reportBlob.arrayBuffer();
      extras.push({ name: 'report.json', data: new Uint8Array(buffer) });
    }
    const zipped = await buildZip(entries, extras);
    const url = URL.createObjectURL(zipped);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'color-matched.zip';
    link.click();
    URL.revokeObjectURL(url);
  };

  const buildReport = () => {
    const generatedAt = new Date().toISOString();
    const steps = [];
    if (referenceMode === 'colorchecker') {
      steps.push('ColorChecker CCM');
      if (serverMethod === 'auto' && chartResult?.recommendedMethod) {
        steps.push(`Method auto -> ${chartResult.recommendedMethod}`);
      } else {
        steps.push(`Method ${serverMethod}`);
      }
    } else {
      if (recoveryAvailable && recoveryEnabled) {
        const recoveryParts = [];
        if (recoveryAutoWB) recoveryParts.push('Auto WB');
        if (recoveryAutoExposure) recoveryParts.push('Auto Exposure');
        steps.push(`Recovery ${recoveryParts.join(' + ') || 'On'}`);
      }
      steps.push('Reference Reinhard');
    }
    if (spotShift) steps.push('Palette Lab Shift');
    const report = {
      generatedAt,
      referenceMode,
      referenceId,
      processing: {
        mode,
        strength,
        outputSize,
        outputFormat,
        quality,
        serverMode,
        asyncMode,
        serverMethod
      },
      recovery: {
        enabled: recoveryAvailable && recoveryEnabled,
        autoWB: recoveryAutoWB,
        autoExposure: recoveryAutoExposure,
        target: {
          L: recoveryTargetL,
          a: recoveryTargetA,
          b: recoveryTargetB
        },
        strength: recoveryStrength
      },
      whiteBalance: referenceMode === 'colorchecker'
        ? {
          source: 'ColorChecker neutral patches',
          neutralStats: chartResult?.neutralStats ?? null
        }
        : {
          source: 'Reference image average',
          referenceStats: referenceStatsPreview
        },
      confidence,
      steps,
      colorChecker: chartResult
        ? {
          deltaEAvg: chartResult.deltaEAvg,
          deltaEMax: chartResult.deltaEMax,
          qualityScore: chartResult.qualityScore,
          methodScores: chartResult.methodScores,
          recommendedMethod: chartResult.recommendedMethod
        }
        : null,
      presets: {
        chartPresetId: chartPresetId || null,
        chartPresetName: chartPresets.find((item) => item.id === chartPresetId)?.name || null,
        palettePresetId: palettePresetId || null,
        palettePresetName: palettePresets.find((item) => item.id === palettePresetId)?.name || null
      },
      palette: {
        target: paletteTarget || null,
        shift: spotShift || null,
        sampleSource,
        samplePickMode,
        samplePickLab,
        items: summarizePalette(palette)
      },
      environment: environmentInfo,
      chartEnvironment,
      chartExif,
      referenceExif,
      images: images.map((item) => ({
        id: item.id,
        name: item.name,
        size: item.size,
        width: item.width,
        height: item.height,
        status: item.status,
        jobId: item.jobId,
        methodUsed: item.methodUsed,
        recoveryShift: item.recoveryShift
      }))
    };

    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: 'application/json'
    });
    setReportBlob(blob);
    setReportSummary({ generatedAt, imageCount: images.length });
  };

  const renderImageCard = (item) => (
    <article key={item.id} className={`card ${referenceId === item.id ? 'is-reference' : ''}`}>
      <div className="card-media">
        {compareMode === 'side' && item.processedUrl ? (
          <div className="compare">
            <div className="compare-item">
              <img src={item.url} alt={`${item.name} original`} />
              <span className="compare-label">元画像</span>
            </div>
            <div className="compare-item">
              <img src={item.processedUrl} alt={`${item.name} corrected`} />
              <span className="compare-label">補正後</span>
            </div>
          </div>
        ) : (
          <>
            <img
              src={
                compareMode === 'original' || !item.processedUrl
                  ? item.url
                  : item.processedUrl
              }
              alt={item.name}
            />
            <span className="badge">
              {compareMode === 'original' || !item.processedUrl ? '元画像' : '補正後'}
            </span>
          </>
        )}
      </div>
      <div className="card-body">
        <div className="card-title">{item.name}</div>
        <div className="meta">
          <span>{item.width ? `${item.width}×${item.height}` : '読み込み中…'}</span>
          <span>{formatBytes(item.size)}</span>
        </div>
        <div className="controls">
          {referenceMode === 'reference-image' && (
            <label className="radio">
              <input
                type="radio"
                name="reference"
                checked={referenceId === item.id}
                onChange={() => setReferenceId(item.id)}
              />
              参照にする
            </label>
          )}
          <span className={`status status-${item.status}`}>
            {item.status === 'processing'
              ? '処理中'
              : item.status === 'queued'
                ? 'キュー待ち'
                : item.status === 'done'
                  ? '完了'
                  : item.status === 'error'
                    ? 'エラー'
                    : '待機中'}
          </span>
        </div>
        <div className="card-actions">
          {item.processedUrl && (
            <a className="ghost" href={item.processedUrl} download={item.processedName ?? item.name}>
              ダウンロード
            </a>
          )}
          <button className="ghost" onClick={() => toggleReferenceRole(item.id)} disabled={processing}>
            {item.role === 'reference' ? '編集に戻す' : '基準へ移動'}
          </button>
          <button className="ghost" onClick={() => handleRemove(item.id)} disabled={processing}>
            削除
          </button>
        </div>
      </div>
    </article>
  );

  const renderImageRow = (item) => (
    <div key={item.id} className="table-row">
      <div className="table-cell table-name">
        <div className="card-title">{item.name}</div>
        <div className="meta">
          <span>{item.width ? `${item.width}×${item.height}` : '読み込み中…'}</span>
          <span>{formatBytes(item.size)}</span>
        </div>
      </div>
      <div className="table-cell">
        <span className={`status status-${item.status}`}>
          {item.status === 'processing'
            ? '処理中'
            : item.status === 'queued'
              ? 'キュー待ち'
              : item.status === 'done'
                ? '完了'
                : item.status === 'error'
                  ? 'エラー'
                  : '待機中'}
        </span>
      </div>
      <div className="table-cell table-actions">
        {referenceMode === 'reference-image' && (
          <label className="radio">
            <input
              type="radio"
              name="reference"
              checked={referenceId === item.id}
              onChange={() => setReferenceId(item.id)}
            />
            参照
          </label>
        )}
        {item.processedUrl && (
          <a className="ghost" href={item.processedUrl} download={item.processedName ?? item.name}>
            DL
          </a>
        )}
        <button className="ghost" onClick={() => toggleReferenceRole(item.id)} disabled={processing}>
          {item.role === 'reference' ? '編集へ' : '基準へ'}
        </button>
        <button className="ghost" onClick={() => handleRemove(item.id)} disabled={processing}>
          削除
        </button>
      </div>
    </div>
  );

  useEffect(() => {
    if (referenceMode !== 'reference-image') {
      setReferenceStatsPreview(null);
      setReferenceExif(null);
      setEnvironmentInfo(null);
      return;
    }
    const reference = images.find((img) => img.id === referenceId);
    if (!reference) return;
    let cancelled = false;
    computeStats(reference.file)
      .then((stats) => {
        if (!cancelled) setReferenceStatsPreview(stats);
      })
      .catch(() => {
        if (!cancelled) setReferenceStatsPreview(null);
      });
    loadExif(reference.file).then((exif) => {
      if (cancelled) return;
      setReferenceExif(exif);
      setEnvironmentInfo(computeEnvironment(exif));
    });
    return () => {
      cancelled = true;
    };
  }, [referenceMode, images, referenceId]);

  useEffect(() => {
    let active = true;
    const sourceFile =
      sampleSource === 'reference'
        ? images.find((item) => item.id === referenceId)?.file
        : backgroundSample;
    if (!sourceFile) {
      setSamplePreviewUrl(null);
      setSamplePreviewData(null);
      setSamplePickLab(null);
      return undefined;
    }
    const url = URL.createObjectURL(sourceFile);
    setSamplePreviewUrl(url);
    getImageDataFromFile(sourceFile, 512)
      .then((data) => {
        if (!active) return;
        setSamplePreviewData(data);
      })
      .catch(() => {
        if (!active) return;
        setSamplePreviewData(null);
      });
    setSamplePickLab(null);
    return () => {
      active = false;
      URL.revokeObjectURL(url);
    };
  }, [backgroundSample, sampleSource, images, referenceId]);

  return (
    <div className="app" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
      <header className="hero">
        <div className="hero-inner">
          <span className="eyebrow">Color Management</span>
          <h1>複数画像の色合わせを、現場基準で。</h1>
          <p className="hero-copy">
            ColorCheckerと標準色パレットを基準に、補正の根拠（ΔE・WB・EXIF）を可視化しながら
            バッチ処理します。PC・スマホ対応。
          </p>
          <div className="hero-actions">
            <button className="primary" onClick={() => fileInputRef.current?.click()}>
              画像を追加
            </button>
          </div>
          {apiError && <div className="inline-error">{apiError}</div>}
        </div>
      </header>

      <section className="uploader step">
        <div className="section-title">
          <h2>Step 1. 画像を追加</h2>
          <span>処理対象の画像</span>
        </div>
        <div className="dropzone" onClick={() => fileInputRef.current?.click()}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            onChange={handleFileChange}
          />
          <div>
            <strong>画像をドラッグ&ドロップ</strong>
            <p>補正したい画像を追加してください。JPEG / PNG / HEICに対応します。</p>
            <p>基準・チャート画像も追加後「基準へ移動」で分離できます。</p>
          </div>
        </div>
        <div className="helper">
          <strong>ポイント</strong>
          <div>後から設定を変えて再処理できます（元画像は保持）。</div>
          <div>基準/チャートに使う画像も、ここで追加して「基準へ移動」で分離します。</div>
        </div>
      </section>

      <section className="gallery-controls">
        <input
          type="search"
          placeholder="ファイル名で検索"
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
        />
        <div className="view-toggle">
          <button
            className={`ghost ${viewMode === 'grid' ? 'is-active' : ''}`}
            onClick={() => setViewMode('grid')}
          >
            サムネイル
          </button>
          <button
            className={`ghost ${viewMode === 'list' ? 'is-active' : ''}`}
            onClick={() => setViewMode('list')}
          >
            タイトル
          </button>
        </div>
        <label>
          表示
          <select value={compareMode} onChange={(event) => setCompareMode(event.target.value)}>
            <option value="corrected">補正後</option>
            <option value="original">元画像</option>
            <option value="side">比較</option>
          </select>
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={excludeReferenceFromProcess}
            onChange={(event) => setExcludeReferenceFromProcess(event.target.checked)}
          />
          <span>基準画像を処理対象から除外</span>
        </label>
      </section>

      <section className="gallery">
        <div className="section-title">
          <h2>編集対象画像</h2>
          <span>{editImages.length} 枚</span>
        </div>
        {viewMode === 'grid' ? (
          <div className="cards">
            {editImages.map(renderImageCard)}
            {!editImages.length && (
              <div className="empty">編集対象の画像がありません。</div>
            )}
          </div>
        ) : (
          <div className="table">
            <div className="table-row header">
              <div className="table-cell table-name">ファイル</div>
              <div className="table-cell">状態</div>
              <div className="table-cell table-actions">操作</div>
            </div>
            {editImages.map(renderImageRow)}
            {!editImages.length && (
              <div className="empty">編集対象の画像がありません。</div>
            )}
          </div>
        )}
      </section>

      <section className="gallery">
        <div className="section-title">
          <h2>基準/チャート候補</h2>
          <span>{referenceImages.length} 枚</span>
        </div>
        <p className="muted">
          参照画像やColorChecker画像はこのリストに移動してください。
        </p>
        <div className="table">
          <div className="table-row header">
            <div className="table-cell table-name">ファイル</div>
            <div className="table-cell">状態</div>
            <div className="table-cell table-actions">操作</div>
          </div>
          {referenceImages.map(renderImageRow)}
          {!referenceImages.length && (
            <div className="empty">基準画像がありません。</div>
          )}
        </div>
      </section>

      <section className="calibration step">
        <div className="section-title">
          <h2>Step 2. 基準の指定</h2>
          <span>どこを基準に補正するか</span>
        </div>
        <div className="summary-card">
          <strong>処理サマリー</strong>
          <div className="summary-lines">
            <div>基準: {referenceMode === 'colorchecker' ? 'ColorChecker' : '参照画像'}</div>
            <div>
              適合:
              {referenceMode === 'colorchecker'
                ? ' チャート撮影済み / 高精度'
                : ' チャート無し / 近似補正'}
            </div>
            <div>
              処理:
              {referenceMode === 'colorchecker'
                ? ' サーバー補正 + パレット補正'
                : ' リカバリー + Reinhard + パレット補正'}
            </div>
            <div>再処理: 設定を変えて何度でも可能</div>
          </div>
        </div>
        <div className="helper">
          <strong>用語の意味</strong>
          <div>ΔE: 色差（小さいほど基準に近い）</div>
          <div>WB: ホワイトバランス（白基準）</div>
          <div>パレット: 基準色の一覧（Pantone/DIC等）</div>
        </div>
        <div className="calibration-grid">
          <div className="calibration-card">
            <div>
              <strong>基準方式</strong>
              <p className="muted">ColorChecker基準（推奨）または参照画像基準を選びます。</p>
            </div>
            <div className="choice-group">
              <label className="radio">
                <input
                  type="radio"
                  name="referenceMode"
                  checked={referenceMode === 'colorchecker'}
                  onChange={() => setReferenceMode('colorchecker')}
                />
                ColorChecker基準
              </label>
              <label className="radio">
                <input
                  type="radio"
                  name="referenceMode"
                  checked={referenceMode === 'reference-image'}
                  onChange={() => setReferenceMode('reference-image')}
                />
                参照画像基準
              </label>
            </div>
            {referenceMode === 'reference-image' && (
              <label>
                参照画像
                <select
                  value={referenceId ?? ''}
                  onChange={(event) => setReferenceId(event.target.value)}
                >
                  {referenceCandidates.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {referenceMode === 'reference-image' && referenceStatsPreview && (
              <div className="delta-summary">
                <div>
                  <span className="label">平均L*</span>
                  <strong>{referenceStatsPreview.mean.L.toFixed(2)}</strong>
                </div>
                <div>
                  <span className="label">平均a*</span>
                  <strong>{referenceStatsPreview.mean.a.toFixed(2)}</strong>
                </div>
                <div>
                  <span className="label">平均b*</span>
                  <strong>{referenceStatsPreview.mean.b.toFixed(2)}</strong>
                </div>
              </div>
            )}
            {environmentInfo && (
              <div className="chart-meta">
                <span>環境推定</span>
                <span>
                  Sun {environmentInfo.sunAltitudeDeg.toFixed(1)}° / Risk {environmentInfo.risk}
                </span>
              </div>
            )}
          </div>

          <div className="calibration-card">
            <div>
              <strong>ColorChecker診断</strong>
              <p className="muted">
                ColorChecker Classic（24パッチ推奨）を大きく写した画像を使用します。
              </p>
              <p className="muted">
                目安: チャートが画面の25%以上 / ピントが合う / 反射がない状態。
              </p>
            </div>
            <label>
              画像リストから選ぶ
              <select
                value={chartFromImageId}
                onChange={handleChartFromListChange}
                disabled={!chartCandidates.length}
              >
                <option value="">選択しない</option>
                {chartCandidates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">ここで指定した画像が診断対象になります（補正対象にも含まれます）。</p>
            <div className="calibration-actions">
              <input
                ref={chartInputRef}
                type="file"
                accept="image/*"
                onChange={handleChartChange}
                hidden
              />
              <button className="ghost" onClick={() => chartInputRef.current?.click()}>
                チャートを選択
              </button>
              <button
                className="primary"
                onClick={analyzeChart}
                disabled={!chartFile || chartStatus === 'processing'}
              >
                {chartStatus === 'processing' ? '解析中…' : 'ΔEを解析'}
              </button>
            </div>
            <label>
              診断プリセット
              <select
                value={chartPresetId}
                onChange={(event) => handleChartPresetSelect(event.target.value)}
              >
                <option value="">選択しない</option>
                {chartPresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">チャート画像が無い場合は保存済みプリセットを使用できます。</p>
            <div className="calibration-actions">
              <input
                type="text"
                placeholder="プリセット名"
                value={chartPresetName}
                onChange={(event) => setChartPresetName(event.target.value)}
              />
              <button
                className="ghost"
                onClick={handleSaveChartPreset}
                disabled={!chartResult?.swatches?.length || !chartPresetName.trim()}
              >
                現在の診断を保存
              </button>
              <button
                className="ghost"
                onClick={handleDeleteChartPreset}
                disabled={!chartPresetId}
              >
                削除
              </button>
            </div>
            <div className="chart-meta">
              <span>
                {chartFile
                  ? `${chartFile.name} (${chartFromImageId ? '画像リスト' : 'アップロード'})`
                  : '未選択'}
              </span>
              <span className={`status status-${chartStatus}`}>
                {chartStatus === 'processing'
                  ? '解析中'
                  : chartStatus === 'done'
                    ? '完了'
                    : chartStatus === 'error'
                      ? 'エラー'
                      : '待機中'}
              </span>
            </div>
            {chartError && (
              <div className="inline-error">{chartError}</div>
            )}
            {chartEnvironment && (
              <div className="chart-meta">
                <span>撮影環境</span>
                <span>
                  Sun {chartEnvironment.sunAltitudeDeg.toFixed(1)}° / Risk {chartEnvironment.risk}
                </span>
              </div>
            )}
            {chartResult && (
              <div className="chart-results">
                <div className="delta-summary">
                  <div>
                    <span className="label">平均ΔE</span>
                    <strong>{chartResult.deltaEAvg?.toFixed(2)}</strong>
                  </div>
                  <div>
                    <span className="label">最大ΔE</span>
                    <strong>{chartResult.deltaEMax?.toFixed(2)}</strong>
                  </div>
                  <div>
                    <span className="label">品質スコア</span>
                    <strong>{chartResult.qualityScore?.toFixed(0)}</strong>
                  </div>
                </div>
                {chartResult.neutralStats && (
                  <div className="chart-meta">
                    <span>WB基準</span>
                    <span>
                      a* {chartResult.neutralStats.meanA.toFixed(2)} / b* {chartResult.neutralStats.meanB.toFixed(2)}
                    </span>
                  </div>
                )}
                {chartResult.recommendedMethod && (
                  <div className="chart-meta">
                    <span>推奨メソッド</span>
                    <span>{chartResult.recommendedMethod}</span>
                  </div>
                )}
                {chartPresetId && (
                  <div className="chart-meta">
                    <span>プリセット</span>
                    <span>{chartPresets.find((item) => item.id === chartPresetId)?.name || '選択中'}</span>
                  </div>
                )}
                {chartResult.methodScores && (
                  <div className="delta-summary">
                    {Object.entries(chartResult.methodScores).map(([method, score]) => (
                      <div key={method}>
                        <span className="label">{method}</span>
                        <strong>{score == null ? '—' : score.toFixed(2)}</strong>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="calibration step">
        <div className="section-title">
          <h2>Step 3. 標準色（Pantone/DIC）</h2>
          <span>基準色との整合</span>
        </div>
        <div className="calibration-grid">
          <div className="calibration-card">
            <div>
              <strong>基準色の読み込み</strong>
              <p className="muted">CSVパレットと基準色サンプルからLab補正量を算出します。</p>
            </div>
            <p className="muted">CSV例: `name,lab_l,lab_a,lab_b` または `name,r,g,b`</p>
            <div className="helper">
              <strong>必要なもの</strong>
              <div>パレットCSV（Pantone/DICはCSVで読み込み）</div>
              <div>基準色が写っている画像（背景サンプル or 参照画像）</div>
            </div>
            <label>
              パレットプリセット
              <select value={palettePresetId} onChange={(event) => handlePalettePresetSelect(event.target.value)}>
                <option value="">選択しない</option>
                {DEFAULT_PALETTE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
                {palettePresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="calibration-actions">
              <input
                ref={paletteInputRef}
                type="file"
                accept=".csv"
                onChange={handlePaletteChange}
                hidden
              />
              <button className="ghost" onClick={() => paletteInputRef.current?.click()}>
                パレットCSVを選択
              </button>
              <input
                ref={sampleInputRef}
                type="file"
                accept="image/*"
                onChange={handleSampleChange}
                hidden
              />
              <button className="ghost" onClick={() => sampleInputRef.current?.click()}>
                背景サンプル画像
              </button>
            </div>
            <p className="muted">背景サンプル画像は基準色（背景や指定色）を含むカットを選びます。</p>
            <div className="calibration-actions">
              <input
                type="text"
                placeholder="パレット名（保存用）"
                value={palettePresetName}
                onChange={(event) => setPalettePresetName(event.target.value)}
              />
              <button
                className="ghost"
                onClick={handleSavePalettePreset}
                disabled={!palette.length || !palettePresetName.trim()}
              >
                現在のパレットを保存
              </button>
              <button
                className="ghost"
                onClick={handleDeletePalettePreset}
                disabled={!palettePresetId}
              >
                削除
              </button>
            </div>
            {palette.length > 0 && (
              <label>
                目標色
                <select value={paletteTarget} onChange={(event) => setPaletteTarget(event.target.value)}>
                  {palette.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              基準色の取得元
              <select value={sampleSource} onChange={(event) => setSampleSource(event.target.value)}>
                <option value="background">背景サンプル画像</option>
                <option value="reference">参照画像</option>
              </select>
            </label>
            <label>
              基準色の取得方法
              <select value={samplePickMode} onChange={(event) => setSamplePickMode(event.target.value)}>
                <option value="average">画像全体平均</option>
                <option value="picker">スポイト（クリック）</option>
              </select>
            </label>
            {samplePickMode === 'picker' && samplePreviewUrl && (
              <div className="picker">
                <img src={samplePreviewUrl} alt="sample" onClick={handleSamplePick} />
                <span className="muted">画像の基準色にしたい箇所をクリックしてください。</span>
              </div>
            )}
            {samplePickMode === 'picker' && !samplePreviewUrl && (
              <p className="muted">スポイトを使うには基準色の取得元画像が必要です。</p>
            )}
            {samplePickLab && (
              <div className="chart-meta">
                <span>スポイト結果</span>
                <span>
                  L* {samplePickLab.L.toFixed(2)} / a* {samplePickLab.a.toFixed(2)} / b* {samplePickLab.b.toFixed(2)}
                </span>
              </div>
            )}
            {samplePickLab && sampleSource === 'reference' && referenceMode === 'reference-image' && (
              <button
                className="ghost"
                onClick={() => {
                  setRecoveryPresetId('custom');
                  setRecoveryTargetL(samplePickLab.L);
                  setRecoveryTargetA(samplePickLab.a);
                  setRecoveryTargetB(samplePickLab.b);
                }}
              >
                参照基準（リカバリー目標）に採用
              </button>
            )}
            <button
              className="primary"
              onClick={async () => {
                const hasSampleSource =
                  sampleSource === 'reference'
                    ? Boolean(images.find((item) => item.id === referenceId))
                    : Boolean(backgroundSample);
                if (!palette.length || !hasSampleSource) {
                  setApiError('パレットと基準色サンプルの両方が必要です。');
                  return;
                }
                const target = palette.find((item) => item.name === paletteTarget) ?? palette[0];
                const sourceFile =
                  sampleSource === 'reference'
                    ? images.find((item) => item.id === referenceId)?.file
                    : backgroundSample;
                if (!sourceFile) {
                  setApiError('基準色を取得する画像が見つかりません。');
                  return;
                }
                let measured;
                if (samplePickMode === 'picker' && samplePickLab) {
                  measured = samplePickLab;
                } else {
                  measured = await computeAverageLab(sourceFile);
                }
                const shift = {
                  L: target.lab.L - measured.L,
                  a: target.lab.a - measured.a,
                  b: target.lab.b - measured.b
                };
                setSpotShift(shift);
              }}
              disabled={!palette.length || !backgroundSample}
            >
              補正量を計算
            </button>
            {spotShift && (
              <div className="chart-meta">
                <span>Lab補正量</span>
                <span>{`ΔL ${spotShift.L.toFixed(2)} / Δa ${spotShift.a.toFixed(2)} / Δb ${spotShift.b.toFixed(2)}`}</span>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="calibration step">
        <div className="section-title">
          <h2>Step 4. 処理設定</h2>
          <span>補正アルゴリズムと出力</span>
        </div>
        <div className="helper">
          <strong>処理の適合</strong>
          <div>ColorChecker基準: チャート撮影済みの高精度案件向け</div>
          <div>参照画像基準: チャート無し画像の近似補正向け</div>
          <div>リカバリー: 撮影条件が整っていない画像の救済向け</div>
        </div>
        <div className="calibration-grid">
          <div className="calibration-card">
            <div className="panel-grid">
              <label>
                モード
                <select value={mode} onChange={(event) => setMode(event.target.value)}>
                  {MODES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                強さ（参照画像基準のみ）
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={strength}
                  onChange={(event) => setStrength(parseFloat(event.target.value))}
                  disabled={referenceMode === 'colorchecker'}
                />
                <span className="hint">{Math.round(strength * 100)}%</span>
              </label>
              <label>
                出力サイズ
                <select value={outputSize} onChange={(event) => setOutputSize(event.target.value)}>
                  {OUTPUT_SIZES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                出力形式
                <select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value)}>
                  <option value="image/jpeg">JPEG</option>
                  <option value="image/png">PNG</option>
                </select>
              </label>
              <label>
                JPEG品質
                <input
                  type="range"
                  min="0.6"
                  max="1"
                  step="0.02"
                  value={quality}
                  onChange={(event) => setQuality(parseFloat(event.target.value))}
                  disabled={outputFormat !== 'image/jpeg'}
                />
                <span className="hint">{quality.toFixed(2)}</span>
              </label>
            </div>
          </div>
          <div className="calibration-card">
            <div>
              <strong>未準備画像リカバリー</strong>
              <p className="muted">
                チャートが無い画像の色かぶりや露出を推定で整えます（参照画像基準のみ）。
              </p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={recoveryEnabled}
                onChange={(event) => setRecoveryEnabled(event.target.checked)}
                disabled={!recoveryAvailable}
              />
              <span>リカバリーを有効化</span>
            </label>
            <label>
              目標プリセット
              <select
                value={recoveryPresetId}
                onChange={(event) => setRecoveryPresetId(event.target.value)}
                disabled={!recoveryAvailable || !recoveryEnabled}
              >
                {RECOVERY_TARGET_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={recoveryAutoWB}
                onChange={(event) => setRecoveryAutoWB(event.target.checked)}
                disabled={!recoveryAvailable || !recoveryEnabled}
              />
              <span>Auto WB（平均a*/b* → 目標値）</span>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={recoveryAutoExposure}
                onChange={(event) => setRecoveryAutoExposure(event.target.checked)}
                disabled={!recoveryAvailable || !recoveryEnabled}
              />
              <span>Auto Exposure（平均L* → 目標値）</span>
            </label>
            <div className="panel-grid">
              <label>
                目標L*
                <input
                  type="number"
                  step="0.5"
                  value={recoveryTargetL}
                  onChange={(event) => {
                    setRecoveryPresetId('custom');
                    setRecoveryTargetL(parseFloat(event.target.value));
                  }}
                  disabled={!recoveryAvailable || !recoveryEnabled || recoveryPresetId !== 'custom'}
                />
              </label>
              <label>
                目標a*
                <input
                  type="number"
                  step="0.5"
                  value={recoveryTargetA}
                  onChange={(event) => {
                    setRecoveryPresetId('custom');
                    setRecoveryTargetA(parseFloat(event.target.value));
                  }}
                  disabled={!recoveryAvailable || !recoveryEnabled || recoveryPresetId !== 'custom'}
                />
              </label>
              <label>
                目標b*
                <input
                  type="number"
                  step="0.5"
                  value={recoveryTargetB}
                  onChange={(event) => {
                    setRecoveryPresetId('custom');
                    setRecoveryTargetB(parseFloat(event.target.value));
                  }}
                  disabled={!recoveryAvailable || !recoveryEnabled || recoveryPresetId !== 'custom'}
                />
              </label>
              <label>
                リカバリー強さ
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={recoveryStrength}
                  onChange={(event) => setRecoveryStrength(parseFloat(event.target.value))}
                  disabled={!recoveryAvailable || !recoveryEnabled}
                />
                <span className="hint">{Math.round(recoveryStrength * 100)}%</span>
              </label>
            </div>
            {referenceStatsPreview && recoveryAvailable && recoveryEnabled && (
              <div className="chart-meta">
                <span>参照画像の推定補正量</span>
                <span>
                  ΔL {(recoveryTargetL - referenceStatsPreview.mean.L).toFixed(2)} /
                  Δa {(recoveryTargetA - referenceStatsPreview.mean.a).toFixed(2)} /
                  Δb {(recoveryTargetB - referenceStatsPreview.mean.b).toFixed(2)}
                </span>
              </div>
            )}
          </div>
          <div className="calibration-card">
            <div>
              <strong>サーバー補正 / 非同期</strong>
              <p className="muted">ColorChecker基準時のみ使用できます。</p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={serverMode}
                onChange={(event) => setServerMode(event.target.checked)}
                disabled={!hasCalibration || asyncMode || referenceMode !== 'colorchecker'}
              />
              <span>ColorChecker補正を使う</span>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={asyncMode}
                onChange={(event) => setAsyncMode(event.target.checked)}
                disabled={!hasCalibration || referenceMode !== 'colorchecker'}
              />
              <span>非同期処理を使う</span>
            </label>
            <label>
              補正アルゴリズム
              <select
                value={serverMethod}
                onChange={(event) => setServerMethod(event.target.value)}
                disabled={!hasCalibration || referenceMode !== 'colorchecker'}
              >
                {SERVER_METHODS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {referenceMode !== 'colorchecker' && (
              <p className="muted">参照画像基準ではローカル補正のみ利用可能です。</p>
            )}
          </div>
        </div>
      </section>

      <section className="calibration step">
        <div className="section-title">
          <h2>Step 5. 実行 & レポート</h2>
          <span>処理と根拠出力</span>
        </div>
        <div className="helper">
          <strong>再処理について</strong>
          <div>設定を変更して何度でも再実行できます（元画像は保持）。</div>
          <div>レポートに「どの処理を適用したか」を保存します。</div>
        </div>
        <div className="calibration-grid">
          <div className="calibration-card">
            <div className="calibration-actions">
              <button className="primary" onClick={handleProcess} disabled={processing || !images.length}>
                {processing ? '処理中…' : '解析して色を揃える'}
              </button>
              <button
                className="ghost"
                onClick={handleDownloadAll}
                disabled={!images.some((item) => item.processedBlob || item.processedUrl)}
              >
                まとめてダウンロード
              </button>
              <button className="ghost" onClick={handleClear} disabled={!images.length || processing}>
                クリア
              </button>
            </div>
            <div className="chart-meta">
              <span>基準</span>
              <span>{referenceMode === 'colorchecker' ? 'ColorChecker' : '参照画像'}</span>
            </div>
            <div className="chart-meta">
              <span>処理対象</span>
              <span>{excludeReferenceFromProcess ? '編集対象のみ' : '全画像'}</span>
            </div>
            <div className="chart-meta">
              <span>推定信頼度</span>
              <span>{confidence.label} ({confidence.score.toFixed(0)})</span>
            </div>
            {referenceMode === 'colorchecker' && chartResult?.neutralStats && (
              <div className="chart-meta">
                <span>WB基準</span>
                <span>
                  a* {chartResult.neutralStats.meanA.toFixed(2)} / b* {chartResult.neutralStats.meanB.toFixed(2)}
                </span>
              </div>
            )}
            {referenceMode === 'reference-image' && referenceStatsPreview && (
              <div className="chart-meta">
                <span>WB基準</span>
                <span>
                  平均L* {referenceStatsPreview.mean.L.toFixed(2)} / a* {referenceStatsPreview.mean.a.toFixed(2)} / b* {referenceStatsPreview.mean.b.toFixed(2)}
                </span>
              </div>
            )}
            {spotShift && (
              <div className="chart-meta">
                <span>基準色補正</span>
                <span>{`ΔL ${spotShift.L.toFixed(2)} / Δa ${spotShift.a.toFixed(2)} / Δb ${spotShift.b.toFixed(2)}`}</span>
              </div>
            )}
          </div>
          <div className="calibration-card">
            <div>
              <strong>レポート</strong>
              <p className="muted">処理根拠（ΔE/品質スコア/EXIF/パレット）をJSONで出力します。</p>
            </div>
            <p className="muted">設定を変えて再実行しても元画像は保持されます。</p>
            <div className="calibration-actions">
              <button className="ghost" onClick={buildReport}>
                レポート生成
              </button>
              {reportBlob && (
                <a className="ghost" href={URL.createObjectURL(reportBlob)} download="report.json">
                  レポートをダウンロード
                </a>
              )}
            </div>
            {reportSummary && (
              <div className="chart-meta">
                <span>生成日時</span>
                <span>{new Date(reportSummary.generatedAt).toLocaleString()}</span>
              </div>
            )}
          </div>
        </div>
      </section>

      <footer className="footer">
        <div>
          <strong>処理ログ</strong> : ColorChecker診断・パレット補正・非同期処理などの根拠はレポートに出力されます。
        </div>
      </footer>
    </div>
  );
}
