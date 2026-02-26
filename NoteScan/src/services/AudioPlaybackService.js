import { Audio } from 'expo-av';
import { File, Paths } from 'expo-file-system/next';
import { SoundFontService } from './SoundFontService';

/**
 * Piano audio synthesis and playback engine.
 * Uses SoundFont (.sf2) samples when available for high-quality output.
 * Falls back to waveform synthesis if the SoundFont is not yet loaded.
 * Generates a single combined WAV written to a temp file (not a data URL).
 * Cursor tracking is driven by onPlaybackStatusUpdate — no manual timers.
 */
export class AudioPlaybackService {
  static sound = null;
  static isPlaying = false;
  static _tempFileUri = null;
  static _soundFontReady = false;

  /* ─── SoundFont loading ─── */

  /**
   * Load the SoundFont file for high-quality instrument playback.
   * Call this once during app initialization (non-blocking).
   * Defaults to Grand Piano (first preset in the SF2).
   * @param {number} sf2Asset - result of require('./SheetMusicScanner.sf2')
   */
  static async loadSoundFont(sf2Asset) {
    try {
      await SoundFontService.loadSoundFont(sf2Asset);
      this._soundFontReady = SoundFontService.isLoaded;
      if (this._soundFontReady) {
        console.log('🎹 SoundFont loaded — using high-quality samples');
      }
    } catch (e) {
      console.warn('SoundFont load failed, using synthesis fallback:', e);
      this._soundFontReady = false;
    }
  }

  /* ─── Instrument / preset selection ─── */

  /**
   * Return the list of available instrument presets from the loaded SoundFont.
   * Each entry: { index, name, preset, bank }
   */
  static getAvailablePresets() {
    if (!this._soundFontReady) return [];
    return SoundFontService.getAvailablePresets();
  }

  /** Get the currently active preset index. */
  static getActivePresetIndex() {
    return SoundFontService.getActivePresetIndex();
  }

  /**
   * Select an instrument preset by index.
   * Forces re-generation of audio on next prepareAudio call.
   */
  static selectPreset(index) {
    if (!this._soundFontReady) return;
    SoundFontService.selectPreset(index);
  }

  /* ─── Frequency helpers ─── */

  static midiToFrequency(midiNote) {
    return 440 * Math.pow(2, (midiNote - 69) / 12);
  }

  /* ─── Waveform generation ─── */

  /**
   * Generate a note as Float32Array samples (mono 44100 Hz).
   * Uses SoundFont samples when available, otherwise falls back to synthesis.
   */
  static generatePianoNote(midiNote, duration = 1.0, velocity = 100) {
    // Try SoundFont rendering first
    if (this._soundFontReady) {
      const sfSample = SoundFontService.renderNote(midiNote, duration, velocity);
      if (sfSample) return sfSample;
    }

    // Fallback: waveform synthesis
    return this._synthesizeNote(midiNote, duration, velocity);
  }

  /**
   * Fallback waveform synthesis (used when SoundFont is unavailable).
   */
  static _synthesizeNote(midiNote, duration = 1.0, velocity = 100) {
    const frequency = this.midiToFrequency(midiNote);
    const sampleRate = 44100;
    const sampleCount = Math.floor(sampleRate * duration);
    const audioData = new Float32Array(sampleCount);
    const velocityFactor = velocity / 127;

    const attackTime = 0.008;
    const decayTime = 0.15;
    const sustainLevel = 0.6;
    const releaseTime = Math.min(0.2, duration * 0.15);

    const attackSamples = Math.floor(sampleRate * attackTime);
    const decaySamples = Math.floor(sampleRate * decayTime);
    const releaseSamples = Math.floor(sampleRate * releaseTime);
    const sustainSamples = Math.max(0, sampleCount - attackSamples - decaySamples - releaseSamples);

    for (let i = 0; i < sampleCount; i++) {
      let envelope = 0;

      if (i < attackSamples) {
        envelope = i / attackSamples;
      } else if (i < attackSamples + decaySamples) {
        const p = (i - attackSamples) / decaySamples;
        envelope = 1.0 - p * (1.0 - sustainLevel);
      } else if (i < attackSamples + decaySamples + sustainSamples) {
        const p = (i - attackSamples - decaySamples) / Math.max(1, sustainSamples);
        envelope = sustainLevel * (1.0 - p * 0.3);
      } else {
        const p = (i - attackSamples - decaySamples - sustainSamples) / Math.max(1, releaseSamples);
        envelope = sustainLevel * 0.7 * (1.0 - p);
      }

      const t = i / sampleRate;
      const fundamental = Math.sin(2 * Math.PI * frequency * t);
      const h2 = 0.35 * Math.sin(2 * Math.PI * frequency * 2 * t);
      const h3 = 0.15 * Math.sin(2 * Math.PI * frequency * 3 * t);
      const h4 = 0.06 * Math.sin(2 * Math.PI * frequency * 4 * t);

      const sample = (fundamental + h2 + h3 + h4) / 1.56;
      audioData[i] = sample * envelope * velocityFactor * 0.75;
    }
    return audioData;
  }

  /* ─── WAV encoding ─── */

  /**
   * Encode Float32Array samples into a WAV file and write to temp storage.
   * Returns the file URI (no huge base64 string in memory).
   */
  static async writeWavToFile(audioData) {
    const sampleRate = 44100;
    const bytesPerSample = 2;

    // Guard: ensure we have actual audio data
    if (!audioData || audioData.length === 0) {
      // Create minimum valid WAV (silence) — 0.1 s
      audioData = new Float32Array(Math.floor(sampleRate * 0.1));
    }

    const subChunk2Size = audioData.length * bytesPerSample;
    const totalBytes = 44 + subChunk2Size;
    const wavBuffer = new ArrayBuffer(totalBytes);
    const view = new DataView(wavBuffer);

    const ws = (o, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
    };
    ws(0, 'RIFF');
    view.setUint32(4, 36 + subChunk2Size, true);
    ws(8, 'WAVE');
    ws(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);      // PCM
    view.setUint16(22, 1, true);      // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);  // block align
    view.setUint16(34, 16, true);      // bits per sample
    ws(36, 'data');
    view.setUint32(40, subChunk2Size, true);

    let offset = 44;
    for (let i = 0; i < audioData.length; i++) {
      const s = Math.max(-1, Math.min(1, audioData[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }

    // Write raw WAV bytes directly to a temp file
    const bytes = new Uint8Array(wavBuffer);
    const fileName = 'notescan_playback_' + Date.now() + '.wav';
    const file = new File(Paths.cache, fileName);
    try {
      file.write(bytes);
    } catch (err) {
      console.error('❌ WAV write error:', err);
      throw err;
    }

    console.log(`🎵 WAV file written: ${(totalBytes / 1024).toFixed(0)} KB, ${(audioData.length / sampleRate).toFixed(1)}s`);
    return file.uri;
  }

  /* ─── Combined audio generation ─── */

  /**
   * Build a single WAV containing all notes with correct timestamps.
   *
   * Playback always goes **left to right** by x-position.  Notes at the
   * same x-position (within 8 px) are simultaneous — all voices sound
   * together at that beat.  Each individual note renders with its own
   * duration so that, e.g., a Soprano half-note and an Alto quarter-note
   * produce the correct lengths.  The cursor advances by the **minimum**
   * note duration at that position so the next beat event fires on time.
   *
   * Voice filtering is done by the caller — only the notes passed in
   * will be heard.
   *
   * @param {Array} notes - voiced notes/rests with midiNote, duration, x, y, staffIndex, voice
   * @param {number} tempo - BPM
   * @param {Array} [systemsMetadata] - OMR-detected systems: [{ staffIndices: [0,1], ... }]
   * @returns {Promise<{ fileUri: string, timingMap: Array, totalDuration: number }>}
   */
  static async createCombinedAudio(notes, tempo = 120, systemsMetadata = null) {
    const sampleRate = 44100;
    const secondsPerBeat = 60 / tempo;
    const durationMap = {
      whole: 4, half: 2, quarter: 1, eighth: 0.5, sixteenth: 0.25,
      '32nd': 0.125,
      dotted_whole: 6, dotted_half: 3, dotted_quarter: 1.5,
      dotted_eighth: 0.75, dotted_sixteenth: 0.375, dotted_32nd: 0.1875,
    };

    if (!notes || notes.length === 0) {
      return { fileUri: '', timingMap: [], totalDuration: 0 };
    }

    // Sort notes: first by staff system, then x position
    const sorted = [...notes].sort((a, b) => {
      const sa = Number.isFinite(a.staffIndex) ? a.staffIndex : 999;
      const sb = Number.isFinite(b.staffIndex) ? b.staffIndex : 999;
      if (sa !== sb) return sa - sb;
      return (a.x || 0) - (b.x || 0);
    });

    // Build system mapping using OMR-detected systems when available.
    const staffToSystem = new Map();
    if (systemsMetadata && systemsMetadata.length > 0) {
      systemsMetadata.forEach((sys, idx) => {
        for (const si of sys.staffIndices) {
          staffToSystem.set(si, idx);
        }
      });
    } else {
      // Fallback: pair adjacent staves into systems (grand staff pairs).
      // This handles the case where systemsMetadata is not available.
      // Without metadata, assume consecutive staves form grand staff pairs
      // (treble + bass), which is the overwhelmingly common case in hymns,
      // piano music, and choral scores.
      const staffIndices = [...new Set(sorted.map((n) => n.staffIndex).filter(Number.isFinite))].sort(
        (a, b) => a - b
      );
      let sysIdx = 0;
      for (let j = 0; j < staffIndices.length; j += 2) {
        staffToSystem.set(staffIndices[j], sysIdx);
        if (j + 1 < staffIndices.length) {
          staffToSystem.set(staffIndices[j + 1], sysIdx);
        }
        sysIdx++;
      }
    }

    // Group notes by system
    const systemNotes = new Map();
    for (const note of sorted) {
      const sys = staffToSystem.get(note.staffIndex) ?? 0;
      if (!systemNotes.has(sys)) systemNotes.set(sys, []);
      systemNotes.get(sys).push(note);
    }

    // ------------------------------------------------------------------
    //  Systems play sequentially.  Within each system, events are laid
    //  out strictly left-to-right.  Notes at the same x (within 8 px)
    //  are grouped into a "beat column" — they all start at the same
    //  time.  Each note keeps its own duration for audio generation.
    //  The column's advance time = the minimum duration, so the cursor
    //  moves to the next beat column when the shortest note finishes.
    // ------------------------------------------------------------------
    const timingMap = [];
    const chordMeta = []; // { offsetSamples, notes:[{midiNote, dur}] }
    let globalTime = 0;

    const systems = [...systemNotes.entries()].sort((a, b) => a[0] - b[0]);

    // ── Diagnostic: log first 20 notes for debugging pitch/duration accuracy ──
    const allSorted = [...notes].filter(n => n.type !== 'rest').sort((a, b) => {
      if (a.staffIndex !== b.staffIndex) return a.staffIndex - b.staffIndex;
      return (a.x || 0) - (b.x || 0);
    });
    const preview = allSorted.slice(0, 20).map(n =>
      `${n.pitch || '?'}${n.midiNote || '?'}(${n.duration || '?'}${n.voice ? ' ' + n.voice[0] : ''})`
    ).join(' ');
    console.log(`🎵 First notes: ${preview}`);

    for (const [, sysNotes] of systems) {
      // Sort by x position (left to right)
      sysNotes.sort((a, b) => (a.x || 0) - (b.x || 0));

      // Group into beat columns (events at the same rhythmic position).
      // Use a dynamic threshold proportional to the typical note spacing
      // instead of a fixed 8px — notes on treble vs bass staves at the
      // same beat can differ by 10-20px depending on image resolution.
      const xPositions = sysNotes.map(n => n.x || 0);
      const uniqueX = [...new Set(xPositions)].sort((a, b) => a - b);
      let colThreshold = 15; // default
      if (uniqueX.length > 2) {
        const gaps = [];
        for (let g = 1; g < uniqueX.length; g++) {
          const gap = uniqueX[g] - uniqueX[g - 1];
          if (gap > 2) gaps.push(gap);
        }
        if (gaps.length > 0) {
          gaps.sort((a, b) => a - b);
          const medianGap = gaps[Math.floor(gaps.length / 2)];
          // Column threshold = 40% of median gap between distinct x-positions
          // This groups notes at the same beat while separating consecutive beats
          colThreshold = Math.max(10, Math.min(30, Math.floor(medianGap * 0.4)));
        }
      }

      const columns = [];
      let col = [sysNotes[0]];
      for (let i = 1; i < sysNotes.length; i++) {
        const curr = sysNotes[i];
        const anchor = col[0];
        if (Math.abs((curr.x || 0) - (anchor.x || 0)) < colThreshold) {
          col.push(curr);
        } else {
          columns.push(col);
          col = [curr];
        }
      }
      columns.push(col);

      for (const col of columns) {
        // Separate actual notes from rests
        const realNotes = col.filter(n => n.type !== 'rest');
        const isAllRests = realNotes.length === 0;

        // Each event has its own beat-duration
        const getBeats = (n) => n.tiedBeats || durationMap[n.duration] || 1;

        // Advance time = minimum duration in this column
        // (this is when the next beat column should start)
        const minBeats = Math.min(...col.map(getBeats));
        const advanceDuration = minBeats * secondsPerBeat;

        // Average position for cursor placement
        const avgX = col.reduce((s, n) => s + (n.x || 0), 0) / col.length;
        const avgY = col.reduce((s, n) => s + (n.y || 0), 0) / col.length;
        const si = col[0].staffIndex;

        timingMap.push({
          time: globalTime, x: avgX, y: avgY, staffIndex: si, isRest: isAllRests,
        });

        if (!isAllRests) {
          // Generate audio for each note with its OWN duration
          const noteEntries = realNotes.map(n => ({
            midiNote: n.midiNote ?? 60,
            dur: getBeats(n) * secondsPerBeat,
          }));
          chordMeta.push({
            offsetSamples: Math.floor(globalTime * sampleRate),
            notes: noteEntries,
          });
        }

        globalTime += advanceDuration;
      }
    }

    // Build master buffer — generate audio per chord and mix directly
    // (avoids keeping all intermediate Float32Arrays alive simultaneously)
    const tailSec = 0.3;
    const totalSamples = Math.floor((globalTime + tailSec) * sampleRate);
    const master = new Float32Array(totalSamples);

    for (const meta of chordMeta) {
      for (const n of meta.notes) {
        // Each note renders with its own duration
        const noteAudio = this.generatePianoNote(n.midiNote, n.dur);
        const start = meta.offsetSamples;
        const len = Math.min(noteAudio.length, totalSamples - start);
        for (let i = 0; i < len; i++) master[start + i] += noteAudio[i];
      }
    }

    // Sanitize: replace any NaN / Infinity with 0, then normalize
    for (let i = 0; i < master.length; i++) {
      if (!Number.isFinite(master[i])) master[i] = 0;
    }
    let masterPeak = 0;
    for (let i = 0; i < master.length; i++) masterPeak = Math.max(masterPeak, Math.abs(master[i]));
    if (masterPeak > 1) for (let i = 0; i < master.length; i++) master[i] /= masterPeak;

    // Write to temp file instead of keeping a huge data URL string in memory
    const fileUri = await this.writeWavToFile(master);

    const source = this._soundFontReady ? 'SoundFont' : 'synthesis';
    console.log(
      `🎹 Combined audio (${source}): ${globalTime.toFixed(1)}s, ${timingMap.length} timing points`
    );

    return { fileUri, timingMap, totalDuration: globalTime };
  }

  /* ─── Playback control ─── */

  static async initAudio() {
    try {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
      });
    } catch (e) {
      console.warn('Audio init warning:', e);
    }
  }

  /**
   * Play combined audio. Calls `onPositionUpdate(timeSec)` ~20×/sec.
   * Calls `onFinished()` when playback completes.
   */
  static async play(fileUri, onPositionUpdate, onFinished) {
    await this.stop();
    this._tempFileUri = fileUri;

    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri: fileUri },
        { shouldPlay: true, progressUpdateIntervalMillis: 50 }
      );

      this.sound = sound;
      this.isPlaying = true;

      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded) return;

        if (status.isPlaying && status.positionMillis != null) {
          if (onPositionUpdate) onPositionUpdate(status.positionMillis / 1000);
        }

        if (status.didJustFinish) {
          this.isPlaying = false;
          if (onFinished) onFinished();
        }
      });
    } catch (err) {
      console.error('Play error:', err);
      this.isPlaying = false;
      if (onFinished) onFinished();
    }
  }

  static async pause() {
    if (this.sound) {
      try {
        const status = await this.sound.getStatusAsync();
        if (status.isLoaded && status.isPlaying) await this.sound.pauseAsync();
      } catch (e) {
        /* ignore */
      }
    }
    this.isPlaying = false;
  }

  static async resume() {
    if (this.sound) {
      try {
        const status = await this.sound.getStatusAsync();
        if (status.isLoaded && !status.isPlaying) {
          await this.sound.playAsync();
          this.isPlaying = true;
        }
      } catch (e) {
        /* ignore */
      }
    }
  }

  static async stop() {
    if (this.sound) {
      try {
        await this.sound.stopAsync();
        await this.sound.unloadAsync();
      } catch (e) {
        /* already unloaded */
      }
      this.sound = null;
    }
    // Clean up temp file
    if (this._tempFileUri) {
      try {
        const tmpFile = new File(this._tempFileUri);
        if (tmpFile.exists) tmpFile.delete();
      } catch (_) { /* already removed */ }
      this._tempFileUri = null;
    }
    this.isPlaying = false;
  }

  static async seekTo(timeSeconds) {
    if (this.sound) {
      try {
        await this.sound.setPositionAsync(Math.floor(timeSeconds * 1000));
      } catch (e) {
        /* ignore */
      }
    }
  }
}
