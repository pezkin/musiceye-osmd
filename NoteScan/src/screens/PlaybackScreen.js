import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
  StatusBar,
  Modal,
  FlatList,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { Feather } from '@expo/vector-icons';
import { AudioPlaybackService } from '../services/AudioPlaybackService';
import { PlaybackVisualization } from '../components/PlaybackVisualization';
import { HOMRService } from '../services/HOMRService';

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
  const [showTempoSlider, setShowTempoSlider] = useState(false);

  const [playbackTime, setPlaybackTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);

  // Instrument preset selection
  const [availablePresets, setAvailablePresets] = useState([]);
  const [selectedPresetIndex, setSelectedPresetIndex] = useState(0);
  const [showInstrumentPicker, setShowInstrumentPicker] = useState(false);

  // Cursor data
  const [cursorInfo, setCursorInfo] = useState(null);

  const audioFileUriRef = useRef(null);

  const [voiceSelection, setVoiceSelection] = useState({
    Soprano: true,
    Alto: true,
    Tenor: true,
    Bass: true,
  });

  /* ── Process score via HOMR server ── */
  const processScore = useCallback(async () => {
    if (!imageUri) return;
    setProcessing(true);
    setScoreError(null);
    setProcessingStage('Connecting to HOMR server...');
    try {
      const result = await Promise.race([
        HOMRService.processSheet(imageUri, (stage) => setProcessingStage(stage)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Processing timeout (2 min)')), 120000)),
      ]);
      setScoreData(result);
    } catch (e) {
      setScoreError(e?.message || 'Failed to process music sheet');
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

  /* ── Prepare audio when scoreData, voiceSelection, or instrument changes ── */
  useEffect(() => {
    if (!scoreData) return;
    AudioPlaybackService.initAudio();
    prepareAudio();
    return () => {
      AudioPlaybackService.stop();
    };
  }, [scoreData, tempo, voiceSelection, selectedPresetIndex]);

  const prepareAudio = async () => {
    setPreparing(true);
    try {
      AudioPlaybackService.selectPreset(selectedPresetIndex);

      const filteredNotes = scoreData.notes.filter(
        (n) => n.type === 'rest' || voiceSelection[n.voice]
      );
      const hasPlayable = filteredNotes.some((n) => n.type !== 'rest');
      if (!hasPlayable) {
        Alert.alert('No Notes', 'Select at least one voice');
        setPreparing(false);
        return;
      }

      const systemsMetadata = scoreData.metadata?.systems || null;

      const { fileUri, timingMap, totalDuration: dur } =
        await AudioPlaybackService.createCombinedAudio(filteredNotes, tempo, systemsMetadata);

      if (!timingMap.length || dur <= 0) {
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

      // Build cursor metadata
      const imgW = scoreData.metadata?.imageWidth || 1;
      const imgH = scoreData.metadata?.imageHeight || 1;

      const metaSystems = scoreData.metadata?.systems || [];
      const staffGroups = scoreData.metadata?.staffGroups || [];

      let systemBounds;
      if (metaSystems.length > 0) {
        systemBounds = metaSystems.map((sys) => ({
          top: sys.top,
          bottom: sys.bottom,
          staffIndices: sys.staffIndices,
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

      const staffToSystem = new Map();
      systemBounds.forEach((sys, idx) => {
        for (const si of sys.staffIndices) staffToSystem.set(si, idx);
      });

      const xValues = timingMap.map((e) => e.x);
      const minX = Math.min(...xValues);
      const maxX = Math.max(...xValues);
      const rangeX = Math.max(1, maxX - minX);

      const positions = timingMap.map((entry) => {
        const ratio = (entry.x - minX) / rangeX;
        const sysIdx = staffToSystem.get(entry.staffIndex) ?? 0;
        return {
          time: entry.time,
          ratio: Math.max(0, Math.min(1, ratio)),
          systemIndex: sysIdx,
        };
      });

      setCursorInfo({
        positions,
        systemBounds,
        imageWidth: imgW,
        imageHeight: imgH,
        xRange: { min: minX, max: maxX },
      });

      console.log(`✅ Audio ready: ${dur.toFixed(1)}s, ${positions.length} cursor positions`);
    } catch (e) {
      console.error('prepareAudio error:', e);
      Alert.alert('Error', 'Failed to prepare audio: ' + e.message);
    } finally {
      setPreparing(false);
    }
  };

  /* ── Playback controls ── */
  const handlePlay = async () => {
    if (!audioFileUriRef.current) {
      Alert.alert('Not Ready', 'Audio is still preparing');
      return;
    }

    if (isPaused) {
      await AudioPlaybackService.resume();
      setIsPlaying(true);
      setIsPaused(false);
      return;
    }

    setIsPlaying(true);
    setIsPaused(false);
    setPlaybackTime(0);

    try {
      await AudioPlaybackService.play(
        audioFileUriRef.current,
        (timeSec) => setPlaybackTime(timeSec),
        () => {
          setIsPlaying(false);
          setIsPaused(false);
          setPlaybackTime(totalDuration);
        }
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
    await AudioPlaybackService.seekTo(clamped);
  };

  const toggleVoice = (voice) => {
    if (isPlaying) return;
    setVoiceSelection((prev) => {
      const next = { ...prev, [voice]: !prev[voice] };
      if (!Object.values(next).some(Boolean)) {
        Alert.alert('Select Voice', 'At least one voice must be selected');
        return prev;
      }
      return next;
    });
  };

  /* ── Instrument selection ── */
  const handleSelectInstrument = (presetIndex) => {
    if (isPlaying) return;
    setSelectedPresetIndex(presetIndex);
    setShowInstrumentPicker(false);
  };

  const currentInstrumentName = availablePresets[selectedPresetIndex]?.name || 'Piano';

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
          Sending image to HOMR server for recognition
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
          imageUri={imageUri}
          currentTime={playbackTime}
          totalDuration={totalDuration}
          isPlaying={isPlaying}
          cursorInfo={cursorInfo}
          onSeek={handleSeek}
        />
      </View>

      {/* Score stats */}
      <View style={styles.statsBar}>
        <Text style={styles.statsText}>
          {scoreData.notes.filter((n) => n.type !== 'rest').length} notes
          {scoreData.metadata?.totalRests > 0 ? ` • ${scoreData.metadata.totalRests} rests` : ''}
          {' • '}{scoreData.staves} staves
          {scoreData.metadata?.keySignature ? ` • Key: ${scoreData.metadata.keySignature.type}${scoreData.metadata.keySignature.count > 0 ? ' ' + scoreData.metadata.keySignature.count : ''}` : ''}
          {totalDuration > 0 ? ` • ${totalDuration.toFixed(1)}s` : ''}
          {scoreData.metadata?.source ? ` • via ${scoreData.metadata.source}` : ''}
        </Text>
      </View>

      {/* Tempo slider drawer */}
      {showTempoSlider && !isPlaying && (
        <View style={styles.tempoDrawer}>
          <View style={styles.tempoDrawerRow}>
            <Text style={styles.tempoDrawerLabel}>Tempo</Text>
            <Text style={styles.tempoDrawerValue}>♩ = {tempo}</Text>
          </View>
          <Slider
            style={styles.tempoSlider}
            minimumValue={40}
            maximumValue={240}
            step={1}
            value={tempo}
            onSlidingComplete={(v) => setTempo(Math.round(v))}
            minimumTrackTintColor={barPalette.accent}
            maximumTrackTintColor={barPalette.barBorder}
            thumbTintColor={barPalette.accent}
          />
          <View style={styles.tempoPresets}>
            {[
              { label: 'Largo',    bpm: 50 },
              { label: 'Adagio',   bpm: 72 },
              { label: 'Andante',  bpm: 92 },
              { label: 'Moderato', bpm: 108 },
              { label: 'Allegro',  bpm: 132 },
              { label: 'Presto',   bpm: 180 },
            ].map((p) => (
              <TouchableOpacity
                key={p.label}
                style={[
                  styles.tempoPresetBtn,
                  Math.abs(tempo - p.bpm) < 10 && styles.tempoPresetBtnActive,
                ]}
                onPress={() => setTempo(p.bpm)}
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
          <TouchableOpacity
            style={styles.playPill}
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
          </TouchableOpacity>

          {/* Stop */}
          <TouchableOpacity style={styles.iconPill} onPress={handleStop}>
            <Feather name="square" size={14} color={barPalette.barText} />
          </TouchableOpacity>

          {/* Tempo */}
          <TouchableOpacity
            style={[styles.zoomPill, showTempoSlider && { borderColor: barPalette.accent }]}
            onPress={() => !isPlaying && setShowTempoSlider((v) => !v)}
            disabled={isPlaying}
          >
            <Feather name="activity" size={12} color={barPalette.barTextMuted} />
            <Text style={styles.pillText}>{tempo} BPM</Text>
          </TouchableOpacity>

          {/* Voice toggles */}
          <View style={styles.voicePill}>
            {Object.keys(voiceSelection).map((voice) => (
              <TouchableOpacity
                key={voice}
                style={[
                  styles.voiceDot,
                  voiceSelection[voice] ? styles.voiceDotActive : styles.voiceDotInactive,
                ]}
                onPress={() => toggleVoice(voice)}
                disabled={isPlaying}
              >
                <Text
                  style={[
                    styles.voiceDotText,
                    voiceSelection[voice]
                      ? styles.voiceDotTextActive
                      : styles.voiceDotTextInactive,
                  ]}
                >
                  {voice.charAt(0)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Progress indicator */}
          <View style={styles.viewPill}>
            <Text style={styles.pillText}>
              {formatTime(playbackTime)} / {formatTime(totalDuration)}
            </Text>
          </View>

          {/* Instrument selector */}
          {availablePresets.length > 0 && (
            <TouchableOpacity
              style={[
                styles.zoomPill,
                showInstrumentPicker && { borderColor: barPalette.accent },
              ]}
              onPress={() => !isPlaying && setShowInstrumentPicker(true)}
              disabled={isPlaying}
            >
              <Feather name="music" size={12} color={barPalette.barTextMuted} />
              <Text style={styles.pillText} numberOfLines={1}>
                {currentInstrumentName}
              </Text>
            </TouchableOpacity>
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
  statsBar: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: palette.surfaceStrong,
    marginHorizontal: 12,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
  },
  statsText: { fontSize: 11, color: palette.inkMuted, fontWeight: '600', textAlign: 'center' },
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
    paddingVertical: 10,
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
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  voiceDotActive: { backgroundColor: barPalette.accent, borderColor: barPalette.accent },
  voiceDotInactive: { backgroundColor: barPalette.bar, borderColor: barPalette.barBorder },
  voiceDotText: { fontSize: 12, fontWeight: '700' },
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
