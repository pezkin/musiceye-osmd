import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  ScrollView,
  Pressable,
  TouchableOpacity,
} from 'react-native';

const ACCENT = '#E05A2A';
const ACCENT_LIGHT = 'rgba(224, 90, 42, 0.18)';
const CURSOR_WIDTH = 3.5; // Thicker, more visible than 2.5

const CURSOR_COLORS = [
  { key: 'orange', color: '#E05A2A', highlight: 'rgba(224, 90, 42, 0.12)' },
  { key: 'green',  color: '#4CAF50', highlight: 'rgba(76, 175, 80, 0.12)' },
  { key: 'black',  color: '#1A1A1A', highlight: 'rgba(0, 0, 0, 0.06)' },
];

const VOICE_COLORS = {
  Soprano: '#E05A2A',
  Alto: '#E8A838',
  Tenor: '#4CAF50',
  Bass: '#3D7BC9',
};

const WAVEFORM_HEIGHT = 56;
const WAVEFORM_MIN_PX_PER_SEC = 12;
const SOLFEGE = ['Do', 'Re', 'Mi', 'Fa', 'So', 'La', 'Ti']; // C D E F G A B
const MIDI_TO_SOLFEGE_IDX = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]; // chromatic → solfège index

const BAR_HEIGHT = 6;

/** Memoized waveform note bars — only re-renders when the timeline data changes, not on every currentTime tick */
const WaveformBars = React.memo(({ filtered, stripW, totalDuration, minMidi, midiRange, pad, usableH }) => (
  <View style={StyleSheet.absoluteFill} pointerEvents="none">
    {filtered.map((n, i) => {
      const x = (n.time / totalDuration) * stripW;
      const w = Math.max(1.5, ((n.endTime - n.time) / totalDuration) * stripW);
      const yNorm = 1 - (n.midiNote - minMidi) / midiRange;
      const y = pad + yNorm * usableH;
      const color = VOICE_COLORS[n.voice] || '#999';
      return (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: x,
            top: y - 1.5,
            width: w,
            height: 3,
            borderRadius: 1.5,
            backgroundColor: color,
            opacity: 0.9,
          }}
        />
      );
    })}
  </View>
));

/**
 * Score viewer — fit-width with vertical scroll & native pinch-to-zoom.
 *
 *  - Image scaled to fill container width (readable on iPhone 12)
 *  - Vertical scroll through systems
 *  - Native iOS pinch-to-zoom (1×–3×)
 *  - Orange cursor bar + note highlights during playback
 *  - Auto-scroll vertically to follow the current system
 *  - Tap-to-seek on both the sheet image and progress bar
 */
export const PlaybackVisualization = ({
  imageUri,
  currentTime,
  totalDuration,
  isPlaying,
  cursorInfo,
  onSeek,
  measureBeats,
  tempo,
  pitchTimeline,
  voiceSelection,
  debugNotes,
}) => {
  const scrollViewRef = useRef(null);
  const waveformScrollRef = useRef(null);
  const [cursorColorIdx, setCursorColorIdx] = useState(0);
  const [showWaveform, setShowWaveform] = useState(false);
  const [showDebugNotes, setShowDebugNotes] = useState(false);
  const cursorTheme = CURSOR_COLORS[cursorColorIdx];
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [imageNaturalWidth, setImageNaturalWidth] = useState(0);
  const [imageNaturalHeight, setImageNaturalHeight] = useState(0);
  const prevSystemRef = useRef(-1);



  // Load natural image dimensions
  useEffect(() => {
    if (!imageUri) return;
    Image.getSize(
      imageUri,
      (w, h) => {
        setImageNaturalWidth(w);
        setImageNaturalHeight(h);
      },
      () => {}
    );
  }, [imageUri]);

  // ─── Cursor data ───
  const positions = cursorInfo?.positions || [];
  const systemBounds = cursorInfo?.systemBounds || [];
  const systemXRanges = cursorInfo?.systemXRanges || {};

  // Find active cursor index
  let activeIndex = 0;
  if (positions.length > 0) {
    for (let i = 0; i < positions.length; i++) {
      if (currentTime >= positions[i].time) {
        activeIndex = i;
      } else {
        break;
      }
    }
  }

  const activeEntry = positions[activeIndex] || null;
  const nextEntry = positions[activeIndex + 1] || null;
  const activeSystemIndex = activeEntry?.systemIndex ?? 0;

  // ─── Smooth lerp between current and next position ───
  let activeRatio = activeEntry?.ratio ?? 0;
  if (activeEntry && nextEntry) {
    const elapsed = currentTime - activeEntry.time;
    const span = nextEntry.time - activeEntry.time;
    if (span > 0) {
      const t = Math.max(0, Math.min(1, elapsed / span));
      const sameSystem = activeEntry.systemIndex === nextEntry.systemIndex;
      if (sameSystem) {
        activeRatio = activeEntry.ratio + t * (nextEntry.ratio - activeEntry.ratio);
      } else {
        // Cross-system: glide to end of current system, then snap at ~95%
        activeRatio = activeEntry.ratio + t * (1 - activeEntry.ratio);
      }
    }
  }

  const system = systemBounds[activeSystemIndex];

  // ─── Layout: fit WIDTH to container, vertical scroll for height ───
  const hasImage = imageNaturalWidth > 0 && imageNaturalHeight > 0;
  let zoomScale = 1;
  let renderWidth = containerWidth || 390;
  let renderHeight = 400;

  if (hasImage && containerWidth > 0) {
    zoomScale = containerWidth / imageNaturalWidth;
    renderWidth = containerWidth;
    renderHeight = imageNaturalHeight * zoomScale;
  }

  // ─── Cursor position in zoomed-image coordinates (per-system x range) ───
  const sysR = systemXRanges[activeSystemIndex] || { min: 0, max: 1, range: 1 };
  const cursorImageX = sysR.min + activeRatio * sysR.range;
  const cursorX = cursorImageX * zoomScale;
  const clampedCursorX = Math.max(0, Math.min(cursorX, renderWidth - 3));

  if (showCursor && (currentTime === 0 || activeIndex === 0 || activeIndex % 10 === 0)) {
    console.log('🔴 CURSOR DEBUG:', {
      currentTime,
      activeIndex,
      positions_length: positions.length,
      activeRatio: activeRatio.toFixed(3),
      systemIndex: activeSystemIndex,
      sysR: { min: sysR.min.toFixed(0), max: sysR.max.toFixed(0), range: sysR.range.toFixed(0) },
      cursorImageX: cursorImageX.toFixed(0),
      zoomScale: zoomScale.toFixed(3),
      cursorX: cursorX.toFixed(0),
      renderWidth: renderWidth.toFixed(0),
      clampedCursorX: clampedCursorX.toFixed(0),
      imageNaturalWidth,
    });
  }

  let cursorTop = 0;
  let cursorHeight = renderHeight;
  if (system) {
    const pad = Math.max(4, (system.bottom - system.top) * 0.1);
    cursorTop = (system.top - pad) * zoomScale;
    cursorHeight = (system.bottom - system.top + pad * 2) * zoomScale;
  }

  // ─── Progress ratio ───
  const progressRatio =
    totalDuration > 0 ? Math.max(0, Math.min(1, currentTime / totalDuration)) : 0;

  // ─── Vertical auto-scroll to current system ───
  useEffect(() => {
    if (!scrollViewRef.current || !system) return;
    if (!(isPlaying || currentTime > 0) || positions.length === 0) return;
    // Only scroll when the system changes (don't fight user's manual scrolling)
    if (activeSystemIndex === prevSystemRef.current) return;
    prevSystemRef.current = activeSystemIndex;

    const sysMidY = ((system.top + system.bottom) / 2) * zoomScale;
    const targetY = Math.max(0, sysMidY - containerHeight * 0.35);
    scrollViewRef.current.scrollTo({ y: targetY, animated: true });
  }, [activeSystemIndex, isPlaying]);

  // ─── Auto-scroll waveform to keep playhead visible ───
  useEffect(() => {
    if (!waveformScrollRef.current || !isPlaying || totalDuration <= 0 || containerWidth <= 0) return;
    const viewW = containerWidth - 24;
    const naturalW = totalDuration * WAVEFORM_MIN_PX_PER_SEC;
    const stripW = Math.max(viewW, naturalW);
    if (stripW <= viewW) return; // fits — no scrolling needed
    const playheadX = (currentTime / totalDuration) * stripW;
    const targetX = Math.max(0, playheadX - viewW * 0.35);
    waveformScrollRef.current.scrollTo({ x: targetX, animated: false });
  }, [currentTime, isPlaying, totalDuration, containerWidth]);

  const showCursor = (isPlaying || currentTime > 0) && positions.length > 0;

  // ─── Tap-to-seek on the sheet image ───
  const handleSheetPress = useCallback(
    (evt) => {
      if (!onSeek || positions.length === 0) return;

      const { locationX, locationY } = evt.nativeEvent;
      const tapImgX = locationX / zoomScale;
      const tapImgY = locationY / zoomScale;

      // Find which system was tapped
      let tappedSystemIdx = -1;
      for (let i = 0; i < systemBounds.length; i++) {
        const sys = systemBounds[i];
        const pad = Math.max(10, (sys.bottom - sys.top) * 0.3);
        if (tapImgY >= sys.top - pad && tapImgY <= sys.bottom + pad) {
          tappedSystemIdx = i;
          break;
        }
      }

      // Find nearest cursor position in that system
      let bestIdx = 0;
      let bestDist = Infinity;

      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        if (tappedSystemIdx >= 0 && pos.systemIndex !== tappedSystemIdx) continue;
        const sr = systemXRanges[pos.systemIndex] || { min: 0, range: 1 };
        const posImgX = sr.min + pos.ratio * sr.range;
        const dist = Math.abs(posImgX - tapImgX);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      // Fallback: global nearest
      if (bestDist === Infinity) {
        for (let i = 0; i < positions.length; i++) {
          const sr = systemXRanges[positions[i].systemIndex] || { min: 0, range: 1 };
          const posImgX = sr.min + positions[i].ratio * sr.range;
          const dist = Math.abs(posImgX - tapImgX);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        }
      }

      onSeek(positions[bestIdx].time);
    },
    [onSeek, positions, systemBounds, zoomScale, systemXRanges]
  );

  // ─── Tap on the progress bar ───
  const handleProgressBarPress = useCallback(
    (evt) => {
      if (!onSeek || totalDuration <= 0) return;
      const { locationX } = evt.nativeEvent;
      const ratio = Math.max(0, Math.min(1, locationX / containerWidth));
      onSeek(ratio * totalDuration);
    },
    [onSeek, totalDuration, containerWidth]
  );

  return (
    <View
      style={styles.container}
      onLayout={(e) => {
        setContainerWidth(e.nativeEvent.layout.width);
        setContainerHeight(e.nativeEvent.layout.height);
      }}
    >
      {/* ─── Playhead color picker + waveform toggle ─── */}
      <View style={styles.colorPicker}>
        {CURSOR_COLORS.map((c, i) => (
          <TouchableOpacity
            key={c.key}
            onPress={() => setCursorColorIdx(i)}
            style={[
              styles.colorDot,
              { backgroundColor: c.color },
              i === cursorColorIdx && styles.colorDotActive,
            ]}
          />
        ))}
        {pitchTimeline && pitchTimeline.length > 0 && (
          <>
            <View style={styles.pickerDivider} />
            <TouchableOpacity
              onPress={() => setShowWaveform(v => !v)}
              style={[styles.waveformToggle, showWaveform && styles.waveformToggleActive]}
            >
              <Text style={[styles.waveformToggleText, showWaveform && styles.waveformToggleTextActive]}>
                {showWaveform ? '▼ Pitch' : '▶ Pitch'}
              </Text>
            </TouchableOpacity>
          </>
        )}
        {debugNotes && debugNotes.length > 0 && (
          <>
            <View style={styles.pickerDivider} />
            <TouchableOpacity
              onPress={() => setShowDebugNotes(v => !v)}
              style={[styles.waveformToggle, showDebugNotes && styles.waveformToggleActive]}
            >
              <Text style={[styles.waveformToggleText, showDebugNotes && styles.waveformToggleTextActive]}>
                {showDebugNotes ? '▼ Notes' : '▶ Notes'}
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* ─── Pitch waveform (scrollable for long pieces) ─── */}
      {showWaveform && pitchTimeline && pitchTimeline.length > 0 && totalDuration > 0 && containerWidth > 0 && (() => {
        const filtered = voiceSelection
          ? pitchTimeline.filter(n => voiceSelection[n.voice])
          : pitchTimeline;
        if (filtered.length === 0) return null;

        const allMidi = filtered.map(n => n.midiNote);
        const minMidi = Math.min(...allMidi);
        const maxMidi = Math.max(...allMidi);
        const midiRange = Math.max(1, maxMidi - minMidi);
        const pad = 4;
        const usableH = WAVEFORM_HEIGHT - pad * 2;
        const viewW = containerWidth - 24;
        const naturalW = totalDuration * WAVEFORM_MIN_PX_PER_SEC;
        const stripW = Math.max(viewW, naturalW);
        const playheadX = totalDuration > 0 ? (currentTime / totalDuration) * stripW : 0;

        // Show solfège labels only when individual voice(s) selected (not all)
        const allSelected = voiceSelection && Object.values(voiceSelection).every(Boolean);
        const showSolfege = !allSelected && (isPlaying || currentTime > 0);

        // Find notes currently being played (within their time range)
        const activeNotes = showSolfege
          ? filtered.filter(n => currentTime >= n.time && currentTime < n.endTime)
          : [];

        return (
          <View style={styles.waveformOuter}>
            <ScrollView
              ref={waveformScrollRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              scrollEventThrottle={16}
              style={{ width: viewW }}
              contentContainerStyle={{ width: stripW }}
            >
              <Pressable
                onPress={(evt) => {
                  if (!onSeek || totalDuration <= 0) return;
                  const { locationX } = evt.nativeEvent;
                  const ratio = Math.max(0, Math.min(1, locationX / stripW));
                  onSeek(ratio * totalDuration);
                }}
              >
                <View style={[styles.waveformStrip, { width: stripW, height: WAVEFORM_HEIGHT }]}>
                  {/* Static note bars (memoized) */}
                  <WaveformBars
                    filtered={filtered}
                    stripW={stripW}
                    totalDuration={totalDuration}
                    minMidi={minMidi}
                    midiRange={midiRange}
                    pad={pad}
                    usableH={usableH}
                  />
                  {/* Dim overlay on unplayed region */}
                  {(isPlaying || currentTime > 0) && (
                    <View
                      style={{
                        position: 'absolute',
                        left: playheadX,
                        top: 0,
                        right: 0,
                        height: WAVEFORM_HEIGHT,
                        backgroundColor: 'rgba(250, 250, 247, 0.6)',
                      }}
                      pointerEvents="none"
                    />
                  )}
                  {/* Solfège labels above/below currently playing notes */}
                  {(() => {
                    // Dedup: keep one label per distinct solfège at similar Y
                    const seen = new Set();
                    return activeNotes.reduce((acc, n) => {
                      const solIdx = MIDI_TO_SOLFEGE_IDX[n.midiNote % 12];
                      const solLabel = SOLFEGE[solIdx];
                      const yNorm = 1 - (n.midiNote - minMidi) / midiRange;
                      const y = pad + yNorm * usableH;
                      const bucketKey = `${solLabel}-${Math.round(y / 8)}`;
                      if (seen.has(bucketKey)) return acc;
                      seen.add(bucketKey);

                      const x = (n.time / totalDuration) * stripW;
                      const w = Math.max(1.5, ((n.endTime - n.time) / totalDuration) * stripW);
                      const color = VOICE_COLORS[n.voice] || '#999';
                      // Always above the bar, clamped within waveform bounds
                      const labelTop = Math.max(0, y - 17);

                      acc.push(
                        <View
                          key={`sol-${acc.length}`}
                          style={{
                            position: 'absolute',
                            left: x + w / 2 - 11,
                            top: labelTop,
                            minWidth: 22,
                            paddingHorizontal: 3,
                            paddingVertical: 1,
                            borderRadius: 4,
                            backgroundColor: 'rgba(255,255,255,0.92)',
                            alignItems: 'center',
                            shadowColor: '#000',
                            shadowOpacity: 0.08,
                            shadowRadius: 2,
                            shadowOffset: { width: 0, height: 1 },
                            elevation: 2,
                          }}
                          pointerEvents="none"
                        >
                          <Text style={[styles.solfegeLabel, { color }]}>{solLabel}</Text>
                        </View>
                      );
                      return acc;
                    }, []);
                  })()}
                  {/* Playhead line */}
                  {(isPlaying || currentTime > 0) && (
                    <View
                      style={{
                        position: 'absolute',
                        left: playheadX,
                        top: 0,
                        width: 1.5,
                        height: WAVEFORM_HEIGHT,
                        backgroundColor: cursorTheme.color,
                        opacity: 0.7,
                      }}
                      pointerEvents="none"
                    />
                  )}
                </View>
              </Pressable>
            </ScrollView>
          </View>
        );
      })()}

      {/* ─── Progress bar (scrubber) ─── */}
      <Pressable onPress={handleProgressBarPress} style={styles.progressBarOuter}>
        <View style={styles.progressBarTrack}>
          {measureBeats && measureBeats.length > 1 && totalDuration > 0 && tempo > 0 && (
            measureBeats.slice(1).map((mb, i) => {
              const secPerBeat = 60 / tempo;
              const markerTime = mb.startBeat * secPerBeat;
              const pct = (markerTime / totalDuration) * 100;
              if (pct <= 0 || pct >= 100) return null;
              return (
                <View key={`m-${i}`} style={[styles.measureMarker, { left: `${pct}%` }]}>
                  {(mb.measureNum % Math.max(1, Math.ceil(measureBeats.length / 12)) === 0 ||
                    mb.measureNum === 1) && (
                    <Text style={styles.measureMarkerNum}>{mb.measureNum}</Text>
                  )}
                </View>
              );
            })
          )}
          <View style={[styles.progressBarFill, { width: `${progressRatio * 100}%` }]} />
          {showCursor && (
            <View style={[styles.progressThumb, { left: `${progressRatio * 100}%` }]} />
          )}
        </View>
      </Pressable>

      {/* ─── Vertically-scrolling sheet music with native pinch-to-zoom ─── */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        maximumZoomScale={3}
        minimumZoomScale={1}
        bouncesZoom
      >
        {imageUri ? (
          <Pressable onPress={handleSheetPress}>
            <View style={{ width: renderWidth, height: renderHeight, position: 'relative' }}>
              <Image
                source={{ uri: imageUri }}
                style={{ width: renderWidth, height: renderHeight }}
                resizeMode="contain"
              />

              {/* Vertical cursor bar — playhead */}
              {showCursor && (
                <View
                  style={[
                    styles.cursor,
                    { left: clampedCursorX, top: cursorTop, height: cursorHeight, backgroundColor: cursorTheme.color },
                  ]}
                  pointerEvents="none"
                />
              )}

              {/* Played-region highlight */}
              {showCursor && system && (
                <View
                  style={[
                    styles.systemHighlight,
                    { top: cursorTop, height: cursorHeight, width: clampedCursorX, backgroundColor: cursorTheme.highlight },
                  ]}
                />
              )}

              {/* Debug overlay: detected note positions */}
              {showDebugNotes && debugNotes && debugNotes.length > 0 && hasImage && (() => {
                const realNotes = debugNotes.filter(n => n.type !== 'rest' && n.midiNote != null && n.x > 0);
                return realNotes.map((n, i) => {
                  const sx = n.x * zoomScale;
                  const sy = n.y * zoomScale;
                  const color = VOICE_COLORS[n.voice] || '#999';
                  return (
                    <View
                      key={`dn-${i}`}
                      style={{
                        position: 'absolute',
                        left: sx - 4,
                        top: sy - 4,
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: color,
                        opacity: 0.85,
                        borderWidth: 1,
                        borderColor: '#fff',
                      }}
                      pointerEvents="none"
                    />
                  );
                });
              })()}
              {showDebugNotes && debugNotes && debugNotes.length > 0 && hasImage && (() => {
                const realNotes = debugNotes.filter(n => n.type !== 'rest' && n.midiNote != null && n.x > 0);
                return realNotes.map((n, i) => {
                  const sx = n.x * zoomScale;
                  const sy = n.y * zoomScale;
                  const color = VOICE_COLORS[n.voice] || '#999';
                  return (
                    <View
                      key={`dl-${i}`}
                      style={{
                        position: 'absolute',
                        left: sx - 12,
                        top: sy - 18,
                        minWidth: 24,
                        paddingHorizontal: 2,
                        paddingVertical: 1,
                        borderRadius: 3,
                        backgroundColor: 'rgba(255,255,255,0.9)',
                        alignItems: 'center',
                      }}
                      pointerEvents="none"
                    >
                      <Text style={{ fontSize: 7, fontWeight: '700', color }}>{n.pitch}</Text>
                    </View>
                  );
                });
              })()}
            </View>
          </Pressable>
        ) : (
          <View style={styles.noImage}>
            <Text style={styles.noImageText}>No sheet image</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  /* ─── Progress bar ─── */
  progressBarOuter: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: '#FAFAF7',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E6E2D8',
  },
  progressBarTrack: {
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    backgroundColor: '#E8E4DA',
    overflow: 'visible',
    position: 'relative',
  },
  measureMarker: {
    position: 'absolute',
    top: -2,
    width: 1,
    height: BAR_HEIGHT + 4,
    backgroundColor: 'rgba(62, 60, 55, 0.2)',
    zIndex: 1,
  },
  measureMarkerNum: {
    position: 'absolute',
    top: BAR_HEIGHT + 5,
    fontSize: 7,
    color: '#999',
    fontWeight: '700',
    textAlign: 'center',
    width: 16,
    marginLeft: -8,
  },
  progressBarFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    backgroundColor: ACCENT,
  },
  progressThumb: {
    position: 'absolute',
    top: -(10 - BAR_HEIGHT) / 2,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: ACCENT,
    marginLeft: -5,
    borderWidth: 2,
    borderColor: '#fff',
    elevation: 3,
    shadowColor: ACCENT,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.4,
    shadowRadius: 2,
  },
  /* ─── Pitch waveform ─── */
  waveformOuter: {
    paddingHorizontal: 12,
    paddingVertical: 2,
    backgroundColor: '#FAFAF7',
  },
  waveformStrip: {
    position: 'relative',
    backgroundColor: '#F2F0EB',
    borderRadius: 6,
    overflow: 'visible',
  },
  solfegeLabel: {
    fontSize: 9,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  /* ─── Sheet area ─── */
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  /* ─── Playhead color picker ─── */
  colorPicker: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 5,
    backgroundColor: '#FAFAF7',
  },
  colorDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  colorDotActive: {
    borderColor: '#555',
    transform: [{ scale: 1.2 }],
  },
  pickerDivider: {
    width: 1,
    height: 14,
    backgroundColor: '#D0CCC4',
  },
  waveformToggle: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: '#E8E4DA',
  },
  waveformToggleActive: {
    backgroundColor: '#3E3C37',
  },
  waveformToggleText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#888',
  },
  waveformToggleTextActive: {
    color: '#fff',
  },
  /* ─── Cursor & highlights ─── */
  cursor: {
    position: 'absolute',
    width: 3.5,
    borderRadius: 2,
    opacity: 1,
    zIndex: 10,
    shadowColor: '#E05A2A',
    shadowOpacity: 0.6,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  systemHighlight: {
    position: 'absolute',
    left: 0,
    backgroundColor: 'rgba(224, 90, 42, 0.12)',
    zIndex: 5,
  },
  noImage: {
    height: 200,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
  },
  noImageText: {
    fontSize: 14,
    color: '#999',
  },
});
