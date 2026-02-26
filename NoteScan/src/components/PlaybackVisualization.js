import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  Image,
  ScrollView,
  Pressable,
  Animated,
} from 'react-native';

const ACCENT = '#E05A2A';
const ACCENT_LIGHT = 'rgba(224, 90, 42, 0.18)';
const ACCENT_GLOW = 'rgba(224, 90, 42, 0.35)';
const BAR_HEIGHT = 6;

/**
 * Score viewer with:
 *  - Orange vertical cursor bar that snaps note-by-note
 *  - Orange horizontal progress bar (scrubber) at the top
 *  - Note-position highlights during playback
 *  - Tap-to-seek: tap anywhere on the sheet or progress bar to jump
 *  - Auto-scroll to keep the active system visible
 */
export const PlaybackVisualization = ({
  imageUri,
  currentTime,
  totalDuration,
  isPlaying,
  cursorInfo,
  onSeek, // (timeSeconds: number) => void
  // cursorInfo = { positions, systemBounds, imageWidth, imageHeight, xRange }
}) => {
  const scrollViewRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [imageNaturalWidth, setImageNaturalWidth] = useState(0);
  const [imageNaturalHeight, setImageNaturalHeight] = useState(0);

  // Pulse animation for the active note highlight
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!isPlaying) {
      pulseAnim.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.55, duration: 400, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [isPlaying]);

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

  // Derive rendered image size: fit width to container, scale height proportionally
  const aspect =
    imageNaturalWidth && imageNaturalHeight ? imageNaturalWidth / imageNaturalHeight : 1;
  const renderWidth = containerWidth || Dimensions.get('window').width;
  const renderHeight = aspect > 0 ? renderWidth / aspect : 400;

  // Scale factor: image pixel coords → rendered coords
  const scaleX = imageNaturalWidth > 0 ? renderWidth / imageNaturalWidth : 1;
  const scaleY = imageNaturalHeight > 0 ? renderHeight / imageNaturalHeight : 1;

  // ─── Cursor computation ───
  const positions = cursorInfo?.positions || [];
  const systemBounds = cursorInfo?.systemBounds || [];
  const xRange = cursorInfo?.xRange || { min: 0, max: 1 };
  const rangeSpan = Math.max(1, xRange.max - xRange.min);

  // Find the current cursor position by snapping to the latest timing entry
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
  const activeSystemIndex = activeEntry?.systemIndex ?? 0;
  const activeRatio = activeEntry?.ratio ?? 0;

  // Cursor X position in rendered coordinates
  const imageX = xRange.min + activeRatio * rangeSpan;
  const cursorX = imageX * scaleX;

  // Cursor Y & height: span the active system
  const system = systemBounds[activeSystemIndex];
  let cursorTop = 0;
  let cursorHeight = renderHeight;

  if (system) {
    const padding = Math.max(4, (system.bottom - system.top) * 0.1);
    cursorTop = Math.max(0, (system.top - padding) * scaleY);
    cursorHeight = Math.max(4, (system.bottom - system.top + padding * 2) * scaleY);
  }

  const clampedX = Math.max(0, Math.min(cursorX, renderWidth - 3));

  // ─── Nearby notes for highlighting ───
  // Collect all positions that share the same time slot as the active one
  const highlightedNotes = useMemo(() => {
    if (!activeEntry || positions.length === 0) return [];
    const activeTime = activeEntry.time;
    return positions.filter((p) => Math.abs(p.time - activeTime) < 0.001);
  }, [activeIndex, positions]);

  // ─── Progress ratio for the horizontal bar ───
  const progressRatio =
    totalDuration > 0 ? Math.max(0, Math.min(1, currentTime / totalDuration)) : 0;

  // Auto-scroll to keep active system visible
  const prevSystemRef = useRef(activeSystemIndex);
  useEffect(() => {
    if (!scrollViewRef.current) return;
    if (activeSystemIndex !== prevSystemRef.current || (isPlaying && system)) {
      prevSystemRef.current = activeSystemIndex;
      if (system) {
        const scrollTarget = Math.max(0, system.top * scaleY - 40);
        scrollViewRef.current.scrollTo({ y: scrollTarget, animated: true });
      }
    }
  }, [activeSystemIndex, isPlaying]);

  // Should we show the cursor?
  const showCursor = (isPlaying || currentTime > 0) && positions.length > 0;

  // ─── Tap-to-seek on the sheet image ───
  const handleSheetPress = useCallback(
    (evt) => {
      if (!onSeek || positions.length === 0) return;

      const { locationX, locationY } = evt.nativeEvent;

      // Convert tap coords back to image-space
      const tapImgX = locationX / scaleX;
      const tapImgY = locationY / scaleY;

      // Find which system the tap is in
      let tappedSystemIdx = -1;
      for (let i = 0; i < systemBounds.length; i++) {
        const sys = systemBounds[i];
        const pad = Math.max(10, (sys.bottom - sys.top) * 0.3);
        if (tapImgY >= sys.top - pad && tapImgY <= sys.bottom + pad) {
          tappedSystemIdx = i;
          break;
        }
      }

      // Find the nearest position that matches the tapped system (or just nearest overall)
      let bestIdx = 0;
      let bestDist = Infinity;

      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        // If we identified a system, only consider positions in that system
        if (tappedSystemIdx >= 0 && pos.systemIndex !== tappedSystemIdx) continue;

        const posImgX = xRange.min + pos.ratio * rangeSpan;
        const dx = posImgX - tapImgX;
        const dist = Math.abs(dx);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      // Fallback: if no match in system, find globally closest
      if (tappedSystemIdx >= 0 && bestDist === Infinity) {
        for (let i = 0; i < positions.length; i++) {
          const posImgX = xRange.min + positions[i].ratio * rangeSpan;
          const dist = Math.abs(posImgX - tapImgX);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        }
      }

      onSeek(positions[bestIdx].time);
    },
    [onSeek, positions, systemBounds, scaleX, scaleY, xRange, rangeSpan]
  );

  // ─── Tap on the progress bar ───
  const handleProgressBarPress = useCallback(
    (evt) => {
      if (!onSeek || totalDuration <= 0) return;
      const { locationX } = evt.nativeEvent;
      const ratio = Math.max(0, Math.min(1, locationX / renderWidth));
      onSeek(ratio * totalDuration);
    },
    [onSeek, totalDuration, renderWidth]
  );

  return (
    <View
      style={styles.container}
      onLayout={(e) => {
        setContainerWidth(e.nativeEvent.layout.width);
        setContainerHeight(e.nativeEvent.layout.height);
      }}
    >
      {/* ─── Horizontal orange progress bar (scrubber) ─── */}
      <Pressable onPress={handleProgressBarPress} style={styles.progressBarOuter}>
        <View style={styles.progressBarTrack}>
          <View style={[styles.progressBarFill, { width: `${progressRatio * 100}%` }]} />
          {/* Thumb indicator */}
          {showCursor && (
            <View
              style={[
                styles.progressThumb,
                { left: `${progressRatio * 100}%` },
              ]}
            />
          )}
        </View>
      </Pressable>

      <ScrollView
        ref={scrollViewRef}
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {imageUri ? (
          <Pressable onPress={handleSheetPress}>
            <View style={[styles.imageWrapper, { width: renderWidth, height: renderHeight }]}>
              <Image
                source={{ uri: imageUri }}
                style={{ width: renderWidth, height: renderHeight }}
                resizeMode="contain"
              />

              {/* Note highlights: orange circles on each note at the active time */}
              {showCursor &&
                highlightedNotes.map((note, idx) => {
                  const nImgX = xRange.min + note.ratio * rangeSpan;
                  const nX = nImgX * scaleX;
                  const noteSys = systemBounds[note.systemIndex];
                  const nY = noteSys
                    ? ((noteSys.top + noteSys.bottom) / 2) * scaleY
                    : cursorTop + cursorHeight / 2;
                  const dotSize = Math.max(14, cursorHeight * 0.12);

                  return (
                    <Animated.View
                      key={`hl-${idx}`}
                      style={[
                        styles.noteHighlight,
                        {
                          left: nX - dotSize / 2,
                          top: nY - dotSize / 2,
                          width: dotSize,
                          height: dotSize,
                          borderRadius: dotSize / 2,
                          opacity: pulseAnim,
                        },
                      ]}
                    />
                  );
                })}

              {/* Vertical cursor bar */}
              {showCursor && (
                <View
                  style={[
                    styles.cursor,
                    {
                      left: clampedX,
                      top: cursorTop,
                      height: cursorHeight,
                    },
                  ]}
                />
              )}

              {/* Faint highlight region behind the cursor on the active system */}
              {showCursor && system && (
                <View
                  style={[
                    styles.systemHighlight,
                    {
                      top: cursorTop,
                      height: cursorHeight,
                      width: clampedX,
                    },
                  ]}
                />
              )}
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
  /* ─── Sheet area ─── */
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    alignItems: 'center',
  },
  imageWrapper: {
    position: 'relative',
  },
  /* ─── Cursor & highlights ─── */
  cursor: {
    position: 'absolute',
    width: 3,
    backgroundColor: ACCENT,
    borderRadius: 2,
    opacity: 0.9,
    zIndex: 10,
  },
  systemHighlight: {
    position: 'absolute',
    left: 0,
    backgroundColor: ACCENT_LIGHT,
    zIndex: 5,
  },
  noteHighlight: {
    position: 'absolute',
    backgroundColor: ACCENT_GLOW,
    borderWidth: 2,
    borderColor: ACCENT,
    zIndex: 11,
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
