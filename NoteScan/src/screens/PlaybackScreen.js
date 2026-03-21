import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
  StatusBar,
  Modal,
  FlatList,
} from 'react-native';
import { File, Paths } from 'expo-file-system/next';
import * as Sharing from 'expo-sharing';
import Slider from '@react-native-community/slider';
import { Feather } from '@expo/vector-icons';
import { AudioPlaybackService } from '../services/AudioPlaybackService';
import { PlaybackVisualization } from '../components/PlaybackVisualization';
import { ScoreInfoPanel } from '../components/ScoreInfoPanel';
import { OMRSettings } from '../services/OMRSettings';
import { OMRCacheService } from '../services/OMRCacheService';

/* ─── Theme ─── */
const palette = {
  background: '#F9F7F1',
  surface: '#FBFAF5',
  surfaceStrong: '#F1EEE4',
  border: '#D6D0C4',
  ink: '#3E3C37',
  inkMuted: '#6E675E',
};

const barPalette = {
  bar: '#1C1B19',
  barRaised: '#2A2925',
  barBorder: '#3C3A35',
  barText: '#F3F1EA',
  barTextMuted: '#C8C4BA',
  accent: '#E05A2A',
};

// Temporary debug switch: disable pitch panel to isolate playback behavior.
const ENABLE_PITCH_VIEW = false;

const DURATION_TO_BEATS = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  sixteenth: 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
  dotted_whole: 6,
  dotted_half: 3,
  dotted_quarter: 1.5,
  dotted_eighth: 0.75,
  dotted_sixteenth: 0.375,
  dotted_32nd: 0.1875,
};

function buildPitchTimelineFromScoreData(notes, tempoBpm) {
  if (!Array.isArray(notes) || !notes.length || !Number.isFinite(tempoBpm) || tempoBpm <= 0) {
    return [];
  }

  const spb = 60 / tempoBpm;
  return notes
    .filter((n) => n.type === 'note' && Number.isFinite(n.midiNote) && Number.isFinite(n.beatOffset))
    .map((n) => {
      const durationBeats = Number.isFinite(n.tiedBeats)
        ? n.tiedBeats
        : Number.isFinite(n.durationBeats)
          ? n.durationBeats
          : (DURATION_TO_BEATS[n.duration] || 1);
      return {
        time: n.beatOffset * spb,
        endTime: (n.beatOffset + durationBeats) * spb,
        midiNote: n.midiNote,
        voice: n.voice,
      };
    })
    .sort((a, b) => a.time - b.time);
}

function buildRawPlaybackDataFromScoreData(notes) {
  if (!Array.isArray(notes) || !notes.length) {
    return { noteEvents: [], timingBeatData: [], totalBeats: 0 };
  }

  const noteEvents = notes
    .filter((n) => n.type === 'note' && Number.isFinite(n.midiNote) && Number.isFinite(n.beatOffset))
    .map((n) => {
      const durationBeats = Number.isFinite(n.tiedBeats)
        ? n.tiedBeats
        : Number.isFinite(n.durationBeats)
          ? n.durationBeats
          : (DURATION_TO_BEATS[n.duration] || 1);
      return {
        midiNote: n.midiNote,
        velocity: 100,
        beatOffset: n.beatOffset,
        durationBeats,
        voice: n.voice || 'Soprano',
        x: n.x || 0,
        y: n.y || 0,
        staffIndex: n.staffIndex,
        systemIndex: n.systemIndex ?? 0,
      };
    })
    .sort((a, b) => a.beatOffset - b.beatOffset);

  const beatMap = new Map();
  for (const e of noteEvents) {
    const bo = Math.round(e.beatOffset * 1000) / 1000;
    if (!beatMap.has(bo)) beatMap.set(bo, []);
    beatMap.get(bo).push(e);
  }

  const timingBeatData = [];
  for (const bo of [...beatMap.keys()].sort((a, b) => a - b)) {
    const group = beatMap.get(bo);
    const avgX = group.reduce((s, n) => s + n.x, 0) / group.length;
    const avgY = group.reduce((s, n) => s + n.y, 0) / group.length;
    timingBeatData.push({
      beatOffset: bo,
      x: avgX,
      y: avgY,
      voicePositions: group.map((n) => ({ voice: n.voice, y: n.y, x: n.x })),
      staffIndex: group[0].staffIndex,
      systemIndex: group[0].systemIndex,
      isRest: false,
    });
  }

  const rests = notes.filter((n) => n.type === 'rest' && Number.isFinite(n.beatOffset));
  for (const r of rests) {
    const bo = Math.round(r.beatOffset * 1000) / 1000;
    if (beatMap.has(bo)) continue;
    timingBeatData.push({
      beatOffset: bo,
      x: r.x || 0,
      y: r.y || 0,
      staffIndex: r.staffIndex,
      systemIndex: r.systemIndex ?? 0,
      isRest: true,
    });
  }
  timingBeatData.sort((a, b) => a.beatOffset - b.beatOffset);

  const totalBeats = noteEvents.reduce(
    (mx, e) => Math.max(mx, e.beatOffset + e.durationBeats),
    0
  );

  return { noteEvents, timingBeatData, totalBeats };
}

function buildPitchTimelineFromRawEvents(noteEvents, tempoBpm) {
  if (!Array.isArray(noteEvents) || !noteEvents.length || !Number.isFinite(tempoBpm) || tempoBpm <= 0) {
    return [];
  }
  const spb = 60 / tempoBpm;
  return noteEvents
    .map((e) => ({
      time: e.beatOffset * spb,
      endTime: (e.beatOffset + e.durationBeats) * spb,
      midiNote: e.midiNote,
      voice: e.voice,
    }))
    .sort((a, b) => a.time - b.time);
}

function getLiteralPlaybackNotes(scoreData) {
  return scoreData?.notes || [];
}

/* ─── Component ─── */
export const PlaybackScreen = ({ imageUri, onNavigateBack }) => {
  /* ── State ── */
  const [scoreData, setScoreData] = useState(null);
  const [scoreError, setScoreError] = useState(null);
  const [processing, setProcessing] = useState(true);
  const [processingStage, setProcessingStage] = useState('');

  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [tempo, setTempo] = useState(120);
  const [sliderTempo, setSliderTempo] = useState(120);
  const [showTempoSlider, setShowTempoSlider] = useState(false);

  const [playbackTime, setPlaybackTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);

  // Instrument preset selection
  const [availablePresets, setAvailablePresets] = useState([]);
  const [selectedPresetIndex, setSelectedPresetIndex] = useState(0);
  const [showInstrumentPicker, setShowInstrumentPicker] = useState(false);

  // Cursor data
  const [cursorInfo, setCursorInfo] = useState(null);
  const [pitchTimeline, setPitchTimeline] = useState([]);

  const audioFileUriRef = useRef(null);
  const prepareIdRef = useRef(0);
  const renderTempoRef = useRef(120);
  const webAudioReadyRef = useRef(false);
  const mixDebounceRef = useRef(null);
  const rawNoteEventsRef = useRef([]);

  const [voiceSelection, setVoiceSelection] = useState({
    Soprano: true,
    Alto: true,
    Tenor: true,
    Bass: true,
  });

  /* ── Process score via selected OMR engine (with caching) ── */
  const processScore = useCallback(async () => {
    if (!imageUri) {
      setProcessing(false);
      setScoreError('No image selected');
      return;
    }
    setProcessing(true);
    setScoreError(null);
    const selectedEngine = OMRSettings.getEngine();

    const ENGINE_LABELS = {
      audiveris: 'Audiveris',
      ondevice: 'On-device',
      zemsky: 'Zemsky Emulator',
    };

    const ENGINE_TIMEOUTS = {
      audiveris: 360000,
      ondevice: 300000,
      zemsky: 180000,
    };

    const runEngine = async (engineKey, isFallback = false) => {
      const engineName = ENGINE_LABELS[engineKey] || engineKey;
      const timeout = ENGINE_TIMEOUTS[engineKey] || 180000;

      if (isFallback) {
        setProcessingStage(`Primary engine failed. Trying ${engineName}...`);
      } else if (engineKey === 'audiveris') {
        setProcessingStage(`Connecting to ${engineName} server...`);
      } else {
        setProcessingStage(`Starting ${engineName} analysis...`);
      }

      let service;
      if (engineKey === selectedEngine) {
        service = OMRSettings.getService();
      } else if (engineKey === 'ondevice') {
        const { OnDeviceOMRService } = require('../services/OnDeviceOMRService');
        service = OnDeviceOMRService;
      } else if (engineKey === 'zemsky') {
        const { ZemskyEmulatorService } = require('../services/ZemskyEmulatorService');
        service = ZemskyEmulatorService;
      } else {
        // Default to on-device
        const { OnDeviceOMRService } = require('../services/OnDeviceOMRService');
        service = OnDeviceOMRService;
      }

      const result = await Promise.race([
        service.processSheet(imageUri, (stage) => setProcessingStage(stage)),
        new Promise((_, rej) => setTimeout(() => rej(new Error(
          `${engineName} timed out after ${Math.round(timeout / 1000)}s`
        )), timeout)),
      ]);

      console.log(`🎼 ${engineName} result: ${result.notes?.length || 0} notes, source=${result.metadata?.source}`);
      return { result, engineKey, engineName };
    };

    // ── Check cache first ──
    setProcessingStage('Checking cache...');
    try {
      const cached = await OMRCacheService.get(imageUri, selectedEngine);
      if (cached && cached.notes && cached.notes.length > 0) {
        const cachedEngineName = ENGINE_LABELS[selectedEngine] || selectedEngine;
        console.log(`🗂️ Cache hit — ${cached.notes.length} notes, skipping ${cachedEngineName}`);
        setScoreData(cached);
        setProcessing(false);
        setProcessingStage('');
        return;
      }
    } catch (e) {
      console.warn('Cache lookup failed, proceeding with OMR:', e.message);
    }

    // ── No cache — run OMR engine ──
    try {
      let run = await runEngine(selectedEngine, false);

      if (!run.result?.notes || run.result.notes.length === 0) {
        throw new Error(`${run.engineName} could not detect any notes`);
      }

      const detectedTempo = Number(run.result?.metadata?.tempo);
      if (Number.isFinite(detectedTempo) && detectedTempo >= 40 && detectedTempo <= 240) {
        setSliderTempo(Math.round(detectedTempo));
        setTempo(Math.round(detectedTempo));
      }

      setScoreData(run.result);
      OMRCacheService.set(imageUri, run.engineKey, run.result).catch(() => {});
    } catch (e) {
      console.warn(`Primary engine (${selectedEngine}) failed:`, e?.message || e);

      const shouldTryFallback = selectedEngine !== 'ondevice';
      if (shouldTryFallback) {
        try {
          const fallback = await runEngine('ondevice', true);
          if (!fallback.result?.notes || fallback.result.notes.length === 0) {
            throw new Error('On-device could not detect any notes');
          }

          const detectedTempo = Number(fallback.result?.metadata?.tempo);
          if (Number.isFinite(detectedTempo) && detectedTempo >= 40 && detectedTempo <= 240) {
            setSliderTempo(Math.round(detectedTempo));
            setTempo(Math.round(detectedTempo));
          }

          setScoreData(fallback.result);
          OMRCacheService.set(imageUri, 'ondevice', fallback.result).catch(() => {});
        } catch (fallbackErr) {
          setScoreError(
            `${e?.message || 'Primary engine failed'}\n` +
            `Fallback also failed: ${fallbackErr?.message || 'Unknown error'}`
          );
        }
      } else {
        setScoreError(e?.message || 'Failed to process music sheet');
      }
    } finally {
      setProcessing(false);
      setProcessingStage('');
    }
  }, [imageUri]);

  useEffect(() => {
    processScore();
    // Load SoundFont for high-quality playback (non-blocking)
    AudioPlaybackService.loadSoundFont(
      require('../../assets/SheetMusicScanner.sf2')
    ).then(() => {
      const presets = AudioPlaybackService.getAvailablePresets();
      if (presets.length > 0) {
        setAvailablePresets(presets);
        setSelectedPresetIndex(0);
      }
    });
  }, [processScore]);

  /* ── Phase 1: Prepare note events when scoreData or instrument changes ── */
  /* Parse notes once, build event list. No audio rendering here — just data.  */
  useEffect(() => {
    if (!scoreData) return;
    let cancelled = false;

    AudioPlaybackService.initAudio();

    const doPrepare = async () => {
      const myId = ++prepareIdRef.current;

      // Stop current playback
      await AudioPlaybackService.stop();
      setIsPlaying(false);
      setIsPaused(false);

      setPreparing(true);
      try {
        AudioPlaybackService.selectPreset(selectedPresetIndex);
        renderTempoRef.current = tempo;

        const playbackNotes = getLiteralPlaybackNotes(scoreData);

        // Prepare playback note events through the service path.
        const evtResult = AudioPlaybackService.prepareNoteEvents(playbackNotes);
        rawNoteEventsRef.current = [];
        const canUseWebAudio = AudioPlaybackService.isWebAudioAvailable() && !!evtResult;
        if (cancelled || myId !== prepareIdRef.current) return;

        setPitchTimeline(
          ENABLE_PITCH_VIEW
            ? buildPitchTimelineFromRawEvents(rawNoteEventsRef.current, tempo)
            : []
        );

        if (canUseWebAudio) {
          // Web Audio path: note events prepared, build timing map
          AudioPlaybackService._useWebAudio = true;
          webAudioReadyRef.current = true;
          const timingMap = AudioPlaybackService.buildTimingMap(tempo);
          const dur = evtResult.totalBeats * (60 / tempo);
          setTotalDuration(dur);
          setPlaybackTime(0);
          buildCursorInfo(timingMap);
          console.log(`✅ Web Audio ready [${myId}]: ${dur.toFixed(1)}s, ${evtResult.noteEvents.length} events`);
        } else {
          // Legacy path: no beatOffset data, use expo-av
          webAudioReadyRef.current = false;
          AudioPlaybackService._useWebAudio = false;
          const result = await AudioPlaybackService.preRenderVoiceTracks(playbackNotes, tempo);
          if (cancelled || myId !== prepareIdRef.current) return;
          if (result) {
            await doMix(myId);
          } else {
            await legacyPrepare(myId);
          }
        }
      } catch (e) {
        console.error(`prepare [${myId}] error:`, e);
        if (myId === prepareIdRef.current) {
          Alert.alert('Error', 'Failed to prepare audio: ' + e.message);
        }
      } finally {
        if (myId === prepareIdRef.current) setPreparing(false);
      }
    };

    doPrepare();

    return () => { cancelled = true; };
  }, [scoreData, selectedPresetIndex]);

  /* ── Phase 2: Voice selection changes ── */
  /* Web Audio: no re-render needed, voice filtering is at play-time.          */
  /* Legacy:   re-mix pre-rendered voice buffers.                              */
  useEffect(() => {
    if (!scoreData) return;
    if (webAudioReadyRef.current) {
      // Web Audio path: voice selection is applied at play time, nothing to do
      // If currently playing, reschedule with new voice selection
      if (AudioPlaybackService.isPlaying) {
        AudioPlaybackService.changeTempo(tempo, voiceSelection);
      }
      return;
    }
    if (!AudioPlaybackService.hasPreRenderedTracks()) return;

    // Debounce legacy mix — wait 300ms after last toggle before re-mixing
    if (mixDebounceRef.current) clearTimeout(mixDebounceRef.current);

    mixDebounceRef.current = setTimeout(() => {
      const myId = ++prepareIdRef.current;

      AudioPlaybackService.stop();
      setIsPlaying(false);
      setIsPaused(false);

      doMix(myId);
    }, 150);

    return () => {
      if (mixDebounceRef.current) clearTimeout(mixDebounceRef.current);
    };
  }, [voiceSelection]);

  /** Mix pre-rendered voice buffers into a single WAV based on current voiceSelection */
  const doMix = async (myId) => {
    audioFileUriRef.current = null;
    setPreparing(true);
    try {
      // Check at least one voice has notes
      const activeVoices = Object.entries(voiceSelection)
        .filter(([, v]) => v).map(([k]) => k);
      console.log(`🎵 mix [${myId}]: voices=${activeVoices.join(',')}`);

      const { fileUri, timingMap, totalDuration: dur } =
        await AudioPlaybackService.mixVoiceTracks(voiceSelection);

      if (myId !== prepareIdRef.current) {
        console.log(`🎵 mix [${myId}]: stale, abandoning`);
        return;
      }

      if (!fileUri || !timingMap.length || dur <= 0) {
        Alert.alert('No playable notes', 'No notes detected for playback.');
        audioFileUriRef.current = null;
        setCursorInfo(null);
        setTotalDuration(0);
        setPreparing(false);
        return;
      }

      audioFileUriRef.current = fileUri;
      setTotalDuration(dur);
      setPlaybackTime(0);
      buildCursorInfo(timingMap);

      console.log(`✅ Audio ready [${myId}]: ${dur.toFixed(1)}s, file=${fileUri ? 'OK' : 'MISSING'}`);
    } catch (e) {
      console.error(`mix [${myId}] error:`, e);
      if (myId === prepareIdRef.current) {
        audioFileUriRef.current = null;
        Alert.alert('Error', 'Failed to mix audio: ' + e.message);
      }
    } finally {
      if (myId === prepareIdRef.current) {
        setPreparing(false);
      }
    }
  };

  /**
   * Change tempo — instant for Web Audio, re-render for legacy.
   */
  const reRenderForTempo = async (newTempo) => {
    if (!scoreData) return;
    if (newTempo === renderTempoRef.current) return;
    renderTempoRef.current = newTempo;

    if (webAudioReadyRef.current) {
      // Web Audio path: instant tempo change (just reschedule events)
      const result = AudioPlaybackService.changeTempo(newTempo, voiceSelection);
      if (result) {
        setTotalDuration(result.totalDuration);
        buildCursorInfo(result.timingMap);
        setPitchTimeline(
          ENABLE_PITCH_VIEW
            ? buildPitchTimelineFromRawEvents(rawNoteEventsRef.current, newTempo)
            : []
        );
        setPlaybackTime(0);
      }
      console.log(`✅ Instant tempo change: ${newTempo} BPM`);
      return;
    }

    // Legacy path: full re-render
    const myId = ++prepareIdRef.current;
    await AudioPlaybackService.stop();
    setIsPlaying(false);
    setIsPaused(false);

    setPreparing(true);
    try {
      setPitchTimeline(
        ENABLE_PITCH_VIEW
          ? buildPitchTimelineFromRawEvents(rawNoteEventsRef.current, newTempo)
          : []
      );
      const playbackNotes = getLiteralPlaybackNotes(scoreData);
      const result = await AudioPlaybackService.preRenderVoiceTracks(playbackNotes, newTempo);
      if (myId !== prepareIdRef.current) return;
      if (!result) {
        await legacyPrepare(myId);
        return;
      }
      await doMix(myId);
      console.log(`✅ Tempo re-render: ${newTempo} BPM`);
    } catch (e) {
      console.warn('Tempo re-render error:', e);
      if (myId === prepareIdRef.current) setPreparing(false);
    }
  };

  /** Legacy path: full re-render when beatOffset is unavailable */
  const legacyPrepare = async (myId) => {
    audioFileUriRef.current = null;
    setPreparing(true);
    try {
      const playbackNotes = getLiteralPlaybackNotes(scoreData);
      const filteredNotes = playbackNotes.filter(
        (n) => n.type === 'rest' || voiceSelection[n.voice]
      );
      const playableCount = filteredNotes.filter((n) => n.type !== 'rest').length;
      if (playableCount === 0) {
        Alert.alert('No Notes', 'No notes found for the selected voice(s)');
        setPreparing(false);
        return;
      }

      const systemsMetadata = scoreData.metadata?.systems || null;
      const { fileUri, timingMap, totalDuration: dur } =
        await AudioPlaybackService.createCombinedAudio(filteredNotes, tempo, systemsMetadata);

      if (myId !== prepareIdRef.current) return;

      if (!fileUri || !timingMap.length || dur <= 0) {
        Alert.alert('No playable notes', 'No notes detected for playback.');
        setPreparing(false);
        return;
      }

      audioFileUriRef.current = fileUri;
      setTotalDuration(dur);
      setPlaybackTime(0);
      buildCursorInfo(timingMap);

      console.log(`✅ Audio ready (legacy) [${myId}]: ${dur.toFixed(1)}s`);
    } catch (e) {
      console.error(`legacyPrepare [${myId}] error:`, e);
      if (myId === prepareIdRef.current) {
        Alert.alert('Error', 'Failed to prepare audio: ' + e.message);
      }
    } finally {
      if (myId === prepareIdRef.current) {
        setPreparing(false);
      }
    }
  };

  /** Build cursor positioning data from a timing map */
  const buildCursorInfo = (timingMap) => {
    const imgW = scoreData.metadata?.imageWidth || 1;
    const imgH = scoreData.metadata?.imageHeight || 1;
    const metaSystems = scoreData.metadata?.systems || [];
    const staffGroups = scoreData.metadata?.staffGroups || [];

    let systemBounds;
    if (metaSystems.length > 0) {
      systemBounds = metaSystems.map((sys) => ({
        top: sys.top, bottom: sys.bottom, staffIndices: sys.staffIndices,
      }));
    } else {
      systemBounds = [];
      let si = 0;
      while (si < staffGroups.length) {
        const a = staffGroups[si];
        const b = staffGroups[si + 1];
        const topA = Math.min(...a);
        const botA = Math.max(...a);
        if (b) {
          const topB = Math.min(...b);
          const botB = Math.max(...b);
          if (topB - botA < (botA - topA) * 2.5) {
            systemBounds.push({ top: topA, bottom: botB, staffIndices: [si, si + 1] });
            si += 2;
            continue;
          }
        }
        systemBounds.push({ top: topA, bottom: botA, staffIndices: [si] });
        si += 1;
      }
    }

    // Group timing entries by system so x-ratio is computed per-system
    const bySystem = new Map();
    for (const entry of timingMap) {
      const sysIdx = entry.systemIndex ?? 0;
      if (!bySystem.has(sysIdx)) bySystem.set(sysIdx, []);
      bySystem.get(sysIdx).push(entry);
    }

    // Compute per-system x ranges
    const systemXRanges = {};
    for (const [sysIdx, entries] of bySystem) {
      const xs = entries.map(e => e.x);
      const mn = Math.min(...xs);
      const mx = Math.max(...xs);
      systemXRanges[sysIdx] = { min: mn, max: mx, range: Math.max(1, mx - mn) };
    }

    const positions = timingMap.map((entry) => {
      const sysIdx = entry.systemIndex ?? 0;
      const sysR = systemXRanges[sysIdx];
      const ratio = (entry.x - sysR.min) / sysR.range;
      return { time: entry.time, ratio: Math.max(0, Math.min(1, ratio)), systemIndex: sysIdx, y: entry.y, voicePositions: entry.voicePositions || [] };
    });

    setCursorInfo({
      positions, systemBounds,
      imageWidth: imgW, imageHeight: imgH,
      systemXRanges,
    });
  };

  /* ── Playback controls ── */
  const handlePlay = async () => {
    if (preparing) return;

    if (isPaused) {
      await AudioPlaybackService.resume(voiceSelection);
      setIsPlaying(true);
      setIsPaused(false);
      return;
    }

    setIsPlaying(true);
    setIsPaused(false);
    setPlaybackTime(0);

    if (webAudioReadyRef.current) {
      // Web Audio path: schedule all notes, no file needed
      console.log(`▶️ handlePlay: Web Audio at ${tempo} BPM`);
      AudioPlaybackService._onPositionUpdate = (timeSec) => setPlaybackTime(timeSec);
      AudioPlaybackService._onFinished = () => {
        setIsPlaying(false);
        setIsPaused(false);
        setPlaybackTime(totalDuration);
      };
      AudioPlaybackService.playWebAudio(tempo, voiceSelection,
        (timeSec) => setPlaybackTime(timeSec),
        () => { setIsPlaying(false); setIsPaused(false); setPlaybackTime(totalDuration); }
      );
      return;
    }

    // Legacy path: expo-av file playback
    if (!audioFileUriRef.current) {
      console.warn('handlePlay: audioFileUriRef is null');
      Alert.alert('Not Ready', 'Audio is still preparing. Please wait.');
      setIsPlaying(false);
      return;
    }
    const fileUri = audioFileUriRef.current;
    console.log(`▶️ handlePlay: playing ${fileUri}`);
    try {
      await AudioPlaybackService.play(
        fileUri,
        (timeSec) => setPlaybackTime(timeSec),
        () => { setIsPlaying(false); setIsPaused(false); setPlaybackTime(totalDuration); }
      );
    } catch (e) {
      console.error('Play error:', e);
      setIsPlaying(false);
    }
  };

  const handlePause = async () => {
    await AudioPlaybackService.pause();
    setIsPlaying(false);
    setIsPaused(true);
  };

  const handleStop = async () => {
    await AudioPlaybackService.stop();
    setIsPlaying(false);
    setIsPaused(false);
    setPlaybackTime(0);
  };

  const handleSeek = async (timeSec) => {
    const clamped = Math.max(0, Math.min(timeSec, totalDuration));
    setPlaybackTime(clamped);
    await AudioPlaybackService.seekTo(clamped, voiceSelection);
  };

  const toggleVoice = (voice) => {
    // Stop playback so audio re-prepares with new voice selection
    if (isPlaying || isPaused) {
      AudioPlaybackService.stop();
      setIsPlaying(false);
      setIsPaused(false);
      setPlaybackTime(0);
    }
    setVoiceSelection((prev) => {
      const next = { ...prev, [voice]: !prev[voice] };
      if (!Object.values(next).some(Boolean)) {
        Alert.alert('Select Voice', 'At least one voice must be selected');
        return prev;
      }
      return next;
    });
  };

  const soloVoice = (voice) => {
    // Stop playback so audio re-prepares
    if (isPlaying || isPaused) {
      AudioPlaybackService.stop();
      setIsPlaying(false);
      setIsPaused(false);
      setPlaybackTime(0);
    }
    setVoiceSelection((prev) => {
      const activeCount = Object.values(prev).filter(Boolean).length;
      const onlyThisActive = prev[voice] && activeCount === 1;

      if (onlyThisActive) {
        // Already solo'd on this voice — re-enable all
        console.log(`🎤 unsolo ${voice} → all voices on`);
        return { Soprano: true, Alto: true, Tenor: true, Bass: true };
      }

      // Solo this voice (deactivate all others)
      console.log(`🎤 solo ${voice}`);
      return {
        Soprano: voice === 'Soprano',
        Alto: voice === 'Alto',
        Tenor: voice === 'Tenor',
        Bass: voice === 'Bass',
      };
    });
  };

  const allVoicesOn = () => {
    if (isPlaying || isPaused) {
      AudioPlaybackService.stop();
      setIsPlaying(false);
      setIsPaused(false);
      setPlaybackTime(0);
    }
    setVoiceSelection({ Soprano: true, Alto: true, Tenor: true, Bass: true });
  };

  /* ── Instrument selection ── */
  const handleSelectInstrument = (presetIndex) => {
    if (isPlaying) return;
    setSelectedPresetIndex(presetIndex);
    setShowInstrumentPicker(false);
  };

  const handleExportMusicXml = async () => {
    const musicXml = scoreData?.musicXml;
    if (!musicXml || musicXml.length < 20) {
      Alert.alert('No MusicXML', 'This scan result does not include exportable MusicXML. Please rescan the score.');
      return;
    }

    try {
      const titleBase = (scoreData?.metadata?.title || 'notescan_score')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 50) || 'notescan_score';

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `${titleBase}_${stamp}.musicxml`;
      const file = new File(Paths.document, fileName);

      file.write(musicXml);

      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert('Exported', `Saved MusicXML to: ${file.uri}`);
        return;
      }

      await Sharing.shareAsync(file.uri, {
        mimeType: 'application/vnd.recordare.musicxml+xml',
        dialogTitle: 'Export MusicXML',
        UTI: 'public.xml',
      });
    } catch (e) {
      console.error('MusicXML export failed:', e);
      Alert.alert('Export failed', e?.message || 'Could not export MusicXML file.');
    }
  };

  const currentInstrumentName = availablePresets[selectedPresetIndex]?.name || 'Piano';

  // Compute current beat position from playback time + tempo
  const currentBeat = totalDuration > 0 ? (playbackTime / (60 / tempo)) : 0;

  /* ── Render ── */
  if (processing) {
    return (
      <View style={styles.centerContainer}>
        <StatusBar barStyle="dark-content" backgroundColor={palette.background} />
        <ActivityIndicator size="large" color={palette.ink} />
        <Text style={styles.loadingText}>Analyzing score...</Text>
        {processingStage ? (
          <Text style={styles.stageText}>{processingStage}</Text>
        ) : null}
        <Text style={styles.hintText}>
          Sending image to server for recognition
        </Text>
      </View>
    );
  }

  if (scoreError || !scoreData) {
    return (
      <View style={styles.centerContainer}>
        <StatusBar barStyle="dark-content" backgroundColor={palette.background} />
        <Text style={styles.errorTitle}>Unable to load score</Text>
        <Text style={styles.errorText}>{scoreError || 'Unknown error'}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={processScore}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.retryButton, { marginTop: 10 }]} onPress={onNavigateBack}>
          <Text style={styles.retryButtonText}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={palette.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onNavigateBack}>
          <Text style={styles.linkText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>
          {scoreData.metadata?.title || 'Score Viewer'}
        </Text>
        <View style={{ width: 60 }} />
      </View>

      {/* Score + cursor */}
      <View style={styles.viewerArea}>
        <PlaybackVisualization
          imageUri={scoreData?.processedImageUri || imageUri}
          currentTime={playbackTime}
          totalDuration={totalDuration}
          isPlaying={isPlaying}
          cursorInfo={cursorInfo}
          onSeek={handleSeek}
          measureBeats={scoreData.metadata?.measureBeats}
          tempo={tempo}
          pitchTimeline={ENABLE_PITCH_VIEW ? pitchTimeline : []}
          voiceSelection={voiceSelection}
          debugNotes={scoreData?.notes}
        />
      </View>

      {/* Tempo slider drawer */}
      {showTempoSlider && (
        <View style={styles.tempoDrawer}>
          <View style={styles.tempoDrawerRow}>
            <Text style={styles.tempoDrawerLabel}>Tempo</Text>
            <Text style={styles.tempoDrawerValue}>♩ = {sliderTempo}</Text>
          </View>
          <Slider
            style={styles.tempoSlider}
            minimumValue={40}
            maximumValue={240}
            step={1}
            value={sliderTempo}
            onValueChange={(v) => {
              const bpm = Math.round(v);
              setSliderTempo(bpm);
              // Web Audio: instant live tempo change while dragging
              if (webAudioReadyRef.current) {
                setTempo(bpm);
                reRenderForTempo(bpm);
              }
            }}
            onSlidingComplete={(v) => {
              const bpm = Math.round(v);
              setSliderTempo(bpm);
              setTempo(bpm);
              reRenderForTempo(bpm);
            }}
            minimumTrackTintColor={barPalette.accent}
            maximumTrackTintColor={barPalette.barBorder}
            thumbTintColor={barPalette.accent}
          />
          <View style={styles.tempoPresets}>
            {[
              { label: 'Slow',    bpm: 72 },
              { label: 'Original', bpm: scoreData?.metadata?.tempo || 120 },
              { label: 'Fast',    bpm: 160 },
            ].map((p) => (
              <TouchableOpacity
                key={p.label}
                style={[
                  styles.tempoPresetBtn,
                  Math.abs(tempo - p.bpm) < 10 && styles.tempoPresetBtnActive,
                ]}
                onPress={() => { setSliderTempo(p.bpm); setTempo(p.bpm); reRenderForTempo(p.bpm); }}
              >
                <Text
                  style={[
                    styles.tempoPresetText,
                    Math.abs(tempo - p.bpm) < 10 && styles.tempoPresetTextActive,
                  ]}
                >
                  {p.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {/* Transport bar */}
      <View style={styles.bottomBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.barScroll}
        >
          {/* Play / Pause */}
          <Pressable
            style={({ pressed }) => [styles.playPill, pressed && styles.pressedPill]}
            onPress={isPlaying ? handlePause : handlePlay}
            disabled={preparing}
          >
            <Feather
              name={isPlaying ? 'pause' : 'play'}
              size={14}
              color={barPalette.barText}
            />
            <Text style={styles.playPillText}>
              {preparing ? 'Preparing...' : isPlaying ? 'Pause' : isPaused ? 'Resume' : 'Play'}
            </Text>
          </Pressable>

          {/* Stop */}
          <Pressable style={({ pressed }) => [styles.iconPill, pressed && styles.pressedPill]} onPress={handleStop}>
            <Feather name="square" size={14} color={barPalette.barText} />
          </Pressable>

          {/* Tempo */}
          <Pressable
            style={({ pressed }) => [styles.zoomPill, showTempoSlider && { borderColor: barPalette.accent }, pressed && styles.pressedPill]}
            onPress={() => setShowTempoSlider((v) => !v)}
          >
            <Feather name="activity" size={12} color={barPalette.barTextMuted} />
            <Text style={styles.pillText}>{tempo} BPM</Text>
          </Pressable>

          {/* Export MusicXML */}
          <Pressable
            style={({ pressed }) => [styles.zoomPill, pressed && styles.pressedPill]}
            onPress={handleExportMusicXml}
          >
            <Feather name="download" size={12} color={barPalette.barTextMuted} />
            <Text style={styles.pillText}>Export XML</Text>
          </Pressable>

          {/* Voice toggles: tap = solo, long press = toggle */}
          <View style={styles.voicePill}>
            {/* All button */}
            <Pressable
              style={({ pressed }) => [
                styles.voiceDot,
                Object.values(voiceSelection).every(Boolean)
                  ? styles.voiceDotAll
                  : styles.voiceDotInactive,
                pressed && styles.pressedDot,
              ]}
              onPress={allVoicesOn}
            >
              <Text
                style={[
                  styles.voiceDotText,
                  Object.values(voiceSelection).every(Boolean)
                    ? styles.voiceDotTextActive
                    : styles.voiceDotTextInactive,
                ]}
              >
                All
              </Text>
            </Pressable>
            {Object.keys(voiceSelection).map((voice) => {
              const vc = scoreData?.metadata?.voiceCounts || {};
              const hasVoiceCounts = Object.keys(vc).length > 0;
              const cnt = vc[voice] || 0;
              // Only disable if we KNOW voice counts and this voice has 0 notes
              const isEmpty = hasVoiceCounts && cnt === 0;
              return (
              <Pressable
                key={voice}
                style={({ pressed }) => [
                  styles.voiceDot,
                  isEmpty
                    ? styles.voiceDotEmpty
                    : voiceSelection[voice]
                      ? styles.voiceDotActive
                      : styles.voiceDotInactive,
                  pressed && !isEmpty && styles.pressedDot,
                ]}
                onPress={() => isEmpty ? null : soloVoice(voice)}
                onLongPress={() => isEmpty ? null : toggleVoice(voice)}
                disabled={isEmpty}
              >
                <Text
                  style={[
                    styles.voiceDotText,
                    isEmpty
                      ? styles.voiceDotTextInactive
                      : voiceSelection[voice]
                        ? styles.voiceDotTextActive
                        : styles.voiceDotTextInactive,
                  ]}
                >
                  {voice.charAt(0)}{isEmpty ? '⊘' : ''}
                </Text>
              </Pressable>
              );
            })}
          </View>

          {/* Progress indicator */}
          <View style={styles.viewPill}>
            <Text style={styles.pillText}>
              {formatTime(playbackTime)} / {formatTime(totalDuration)}
            </Text>
          </View>

          {/* Score info button (compact pill) */}
          <ScoreInfoPanel
            metadata={scoreData.metadata}
            currentBeat={currentBeat}
            isPlaying={isPlaying}
          />

          {/* Instrument selector */}
          {availablePresets.length > 0 && (
            <Pressable
              style={({ pressed }) => [
                styles.zoomPill,
                showInstrumentPicker && { borderColor: barPalette.accent },
                pressed && styles.pressedPill,
              ]}
              onPress={() => !isPlaying && setShowInstrumentPicker(true)}
              disabled={isPlaying}
            >
              <Feather name="music" size={12} color={barPalette.barTextMuted} />
              <Text style={styles.pillText} numberOfLines={1}>
                {currentInstrumentName}
              </Text>
            </Pressable>
          )}
        </ScrollView>
      </View>

      {/* Instrument picker modal */}
      <Modal
        visible={showInstrumentPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowInstrumentPicker(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Instrument</Text>
              <TouchableOpacity onPress={() => setShowInstrumentPicker(false)}>
                <Feather name="x" size={22} color={palette.ink} />
              </TouchableOpacity>
            </View>
            <FlatList
              data={availablePresets}
              keyExtractor={(item) => String(item.index)}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[
                    styles.instrumentRow,
                    item.index === selectedPresetIndex && styles.instrumentRowActive,
                  ]}
                  onPress={() => handleSelectInstrument(item.index)}
                >
                  <Text
                    style={[
                      styles.instrumentName,
                      item.index === selectedPresetIndex && styles.instrumentNameActive,
                    ]}
                  >
                    {item.name}
                  </Text>
                  {item.index === selectedPresetIndex && (
                    <Feather name="check" size={16} color={barPalette.accent} />
                  )}
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
};

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/* ─── Styles ─── */
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.background },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: palette.background,
  },
  loadingText: { marginTop: 16, fontSize: 15, color: palette.inkMuted, fontWeight: '600' },
  stageText: { marginTop: 8, fontSize: 13, color: barPalette.accent, fontWeight: '600' },
  hintText: { marginTop: 12, fontSize: 12, color: palette.inkMuted, textAlign: 'center' },
  errorTitle: { fontSize: 18, fontWeight: '700', color: palette.ink, marginBottom: 8 },
  errorText: { fontSize: 13, color: palette.inkMuted, textAlign: 'center', marginBottom: 16, paddingHorizontal: 16 },
  retryButton: {
    backgroundColor: palette.surface,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: palette.border,
  },
  retryButtonText: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  header: {
    paddingHorizontal: 24,
    paddingBottom: 12,
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 0) + 20 : 36,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: palette.background,
  },
  title: { fontSize: 24, fontWeight: '800', color: palette.ink, letterSpacing: -0.4 },
  linkText: { fontSize: 14, color: palette.inkMuted, fontWeight: '600' },
  viewerArea: {
    flex: 1,
    backgroundColor: '#fff',
    marginHorizontal: 12,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#E6E2D8',
  },
  tempoDrawer: {
    backgroundColor: barPalette.barRaised,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: barPalette.barBorder,
  },
  tempoDrawerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  tempoDrawerLabel: {
    color: barPalette.barTextMuted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  tempoDrawerValue: {
    color: barPalette.accent,
    fontSize: 14,
    fontWeight: '800',
  },
  tempoSlider: {
    width: '100%',
    height: 32,
  },
  tempoPresets: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  tempoPresetBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: barPalette.bar,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  tempoPresetBtnActive: {
    backgroundColor: barPalette.accent,
    borderColor: barPalette.accent,
  },
  tempoPresetText: {
    color: barPalette.barTextMuted,
    fontSize: 10,
    fontWeight: '700',
  },
  tempoPresetTextActive: {
    color: barPalette.barText,
  },
  bottomBar: {
    backgroundColor: barPalette.bar,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 38 : 24,
    borderTopWidth: 1,
    borderTopColor: barPalette.barBorder,
  },
  barScroll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
  },
  playPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: barPalette.barRaised,
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  playPillText: { color: barPalette.barText, fontSize: 12, fontWeight: '700' },
  zoomPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: barPalette.barRaised,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  pillText: { color: barPalette.barText, fontSize: 12, fontWeight: '600' },
  voicePill: {
    flexDirection: 'row',
    gap: 6,
    backgroundColor: barPalette.barRaised,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  voiceDot: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    paddingHorizontal: 4,
  },
  voiceDotActive: { backgroundColor: barPalette.accent, borderColor: barPalette.accent },
  voiceDotAll: { backgroundColor: '#2A7B3D', borderColor: '#2A7B3D' },
  voiceDotEmpty: { backgroundColor: barPalette.bar, borderColor: '#555', opacity: 0.4 },
  voiceDotInactive: { backgroundColor: barPalette.bar, borderColor: barPalette.barBorder },
  voiceDotText: { fontSize: 11, fontWeight: '700' },
  voiceDotTextActive: { color: barPalette.barText },
  voiceDotTextInactive: { color: barPalette.barTextMuted },
  viewPill: {
    backgroundColor: barPalette.barRaised,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  iconPill: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: barPalette.barRaised,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  pressedPill: {
    opacity: 0.6,
    transform: [{ scale: 0.96 }],
  },
  pressedDot: {
    opacity: 0.6,
    transform: [{ scale: 0.9 }],
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: palette.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '60%',
    paddingBottom: Platform.OS === 'ios' ? 34 : 16,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: palette.ink,
    letterSpacing: -0.3,
  },
  instrumentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  instrumentRowActive: {
    backgroundColor: palette.surfaceStrong,
  },
  instrumentName: {
    fontSize: 14,
    fontWeight: '600',
    color: palette.ink,
    flex: 1,
  },
  instrumentNameActive: {
    color: barPalette.accent,
    fontWeight: '800',
  },
});
