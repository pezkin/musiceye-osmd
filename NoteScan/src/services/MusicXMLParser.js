/**
 * MusicXML Parser
 *
 * Parses MusicXML returned by the OMR server into the note/rest format
 * expected by AudioPlaybackService and PlaybackScreen.
 *
 * Key improvement: properly tracks beat position using MusicXML's
 * <duration>, <backup>, <forward>, and <chord> elements so that
 * notes that should play simultaneously (e.g. treble + bass) get
 * the same beat offset.
 *
 * Output note format:
 *   { type, pitch, midiNote, duration, durationBeats, dotted, voice,
 *     staffIndex, systemIndex, measureIndex, accidental, tiedBeats,
 *     beatOffset }
 *
 * `beatOffset` is the absolute beat position (in quarter-note beats)
 * from the start of the piece. This drives correct audio timing —
 * notes with the same beatOffset play together.
 */

// Pitch name → semitone offset from C
const PITCH_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// MusicXML duration type → our duration name
const DURATION_TYPE_MAP = {
  'whole': 'whole',
  'half': 'half',
  'quarter': 'quarter',
  'eighth': 'eighth',
  '16th': 'sixteenth',
  '32nd': '32nd',
  '64th': '64th',
  'breve': 'whole',
};

// Duration name → beats (quarter-note beats)
const DURATION_BEATS = {
  'whole': 4, 'half': 2, 'quarter': 1, 'eighth': 0.5, 'sixteenth': 0.25,
  '32nd': 0.125, '64th': 0.0625,
  'dotted_whole': 6, 'dotted_half': 3, 'dotted_quarter': 1.5,
  'dotted_eighth': 0.75, 'dotted_sixteenth': 0.375, 'dotted_32nd': 0.1875,
};

// If a measure's theoretical duration is much larger than parsed voice content,
// prefer content length to avoid audible silent gaps.
const MEASURE_CONTENT_GAP_RATIO = 1.35;

// Voice number → voice name (fallback when staff info is unavailable)
const VOICE_NAMES = { 1: 'Soprano', 2: 'Alto', 3: 'Tenor', 4: 'Bass' };

/**
 * Map staff number + voice number → SATB voice name.
 * For piano/grand staff: treble (staff 1) → Soprano/Alto,
 *                        bass   (staff 2) → Tenor/Bass.
 * For multi-part: uses the global staff index to determine position.
 */
function staffVoiceToSATB(staffNum, voiceNum, stavesInPart, globalStaffOffset = 0) {
  if (stavesInPart >= 2) {
    // Grand staff (piano, organ, etc.)
    // Staff 1 (treble): voice 1→Soprano, voice 2→Alto
    // Staff 2 (bass):   voice 1→Tenor,   voice 2→Bass
    if (staffNum <= 1) {
      return voiceNum <= 1 ? 'Soprano' : 'Alto';
    } else {
      return voiceNum <= 1 ? 'Tenor' : 'Bass';
    }
  }

  // Single-staff part: infer SATB from GLOBAL staff ordering across parts.
  // Example from Zemsky output: P1 staff1 + P2 staff1.
  // P1 should map to upper voices (S/A), P2 to lower voices (T/B).
  const globalStaffIndex = globalStaffOffset + staffNum - 1;
  const isUpperInPair = globalStaffIndex % 2 === 0;

  if (isUpperInPair) {
    return voiceNum <= 1 ? 'Soprano' : 'Alto';
  }
  return voiceNum <= 1 ? 'Tenor' : 'Bass';
}

function assignUpperVoices(group) {
  if (!group || group.length === 0) return;
  group.sort((a, b) => (b.midiNote || 0) - (a.midiNote || 0));
  group[0].voice = 'Soprano';
  for (let i = 1; i < group.length; i++) group[i].voice = 'Alto';
}

function assignLowerVoices(group) {
  if (!group || group.length === 0) return;
  group.sort((a, b) => (b.midiNote || 0) - (a.midiNote || 0));
  group[0].voice = 'Tenor';
  for (let i = 1; i < group.length; i++) group[i].voice = 'Bass';
}

function recoverChoirSATB(notes, voiceCounts) {
  const allFourVoices = ['Soprano', 'Alto', 'Tenor', 'Bass'];
  const emptyVoices = allFourVoices.filter(v => !voiceCounts[v]);
  if (emptyVoices.length < 2) return false;

  const pitched = notes.filter(n => n.type === 'note' && n.midiNote != null);
  if (pitched.length < 2) return false;

  const beatGroups = new Map();
  for (const n of pitched) {
    const key = (typeof n.beatOffset === 'number' ? n.beatOffset : 0).toFixed(4);
    if (!beatGroups.has(key)) beatGroups.set(key, []);
    beatGroups.get(key).push(n);
  }

  // Prefer part-aware mapping for choir-like XML where each part is single-staff,
  // voice 1-heavy, and upper/lower lines are separated by part.
  const partIds = [...new Set(pitched.map(n => n.partIndex).filter(Number.isFinite))].sort((a, b) => a - b);
  const hasPartSplit = partIds.length >= 2;

  if (hasPartSplit) {
    const midpoint = (partIds.length - 1) / 2;
    for (const group of beatGroups.values()) {
      const byPart = new Map();
      for (const n of group) {
        const pk = Number.isFinite(n.partIndex) ? n.partIndex : -1;
        if (!byPart.has(pk)) byPart.set(pk, []);
        byPart.get(pk).push(n);
      }

      for (const [pk, pgroup] of byPart.entries()) {
        const partPos = partIds.indexOf(pk);
        const isUpper = partPos >= 0 ? partPos <= midpoint : true;
        if (isUpper) assignUpperVoices(pgroup);
        else assignLowerVoices(pgroup);
      }
    }
    return true;
  }

  // Fallback: no usable part split. Use beat-local pitch split.
  for (const group of beatGroups.values()) {
    if (group.length <= 1) continue;
    const sorted = [...group].sort((a, b) => (b.midiNote || 0) - (a.midiNote || 0));
    const half = Math.ceil(sorted.length / 2);
    assignUpperVoices(sorted.slice(0, half));
    assignLowerVoices(sorted.slice(half));
  }
  return true;
}

export class MusicXMLParser {
  /**
   * Parse a MusicXML string into notes and metadata.
   * @param {string} xml - raw MusicXML string
   * @param {{ strictMusicXml?: boolean, strictTiming?: boolean, strictVoices?: boolean }} [options]
   * @returns {{ notes: Array, metadata: Object }}
   */
  static parse(xml, options = {}) {
    // Backward compatibility: strictMusicXml enables strict timing and disables
    // heuristic voice reassignment so parsed voices remain literal.
    const strictTiming = !!(options.strictMusicXml || options.strictTiming);
    const strictVoices = !!(options.strictVoices || options.strictMusicXml);
    const notes = [];
    const metadata = {
      title: '',
      staves: 0,
      systems: 0,
      timeSignature: { beats: 4, beatType: 4 },
      keySignature: { type: 'None', count: 0 },
      clefs: [],
      stavesPerSystem: 2,
    };

    // Extract title
    const titleMatch = xml.match(/<work-title>([^<]*)<\/work-title>/) ||
                       xml.match(/<movement-title>([^<]*)<\/movement-title>/);
    if (titleMatch) metadata.title = titleMatch[1].trim();

    // Extract part IDs
    const partIds = [];
    for (const m of xml.matchAll(/<score-part\s+id="([^"]+)"/g)) {
      partIds.push(m[1]);
    }
    if (partIds.length === 0) {
      for (const m of xml.matchAll(/<part\s+id="([^"]+)"/g)) {
        if (!partIds.includes(m[1])) partIds.push(m[1]);
      }
    }

    // Parse each part
    let globalStaffOffset = 0;
    let systemIndex = 0;
    let globalBeatOffset = 0; // Absolute beat position across all measures

    for (let partIdx = 0; partIdx < partIds.length; partIdx++) {
      const partId = partIds[partIdx];
      const partRegex = new RegExp(
        `<part\\s+id="${partId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([\\s\\S]*?)<\\/part>`,
        'i'
      );
      const partMatch = xml.match(partRegex);
      if (!partMatch) continue;

      const measures = this._extractMeasures(partMatch[1]);

      let divisions = 1; // divisions per quarter note
      let currentKey = { fifths: 0 };
      let currentTime = { beats: 4, beatType: 4 };
      let currentClefs = {};
      let stavesInPart = 1;
      let measureIndex = -1;
      globalBeatOffset = 0;

      for (const measureXml of measures) {
        measureIndex++;

        // Check for new system
        if (measureIndex > 0 &&
            (/<print[^>]*new-system="yes"/.test(measureXml) ||
             /<print[^>]*new-page="yes"/.test(measureXml))) {
          systemIndex++;
        }

        // Parse ALL <attributes> blocks in this measure (there can be multiple)
        for (const attrM of measureXml.matchAll(/<attributes>([\s\S]*?)<\/attributes>/g)) {
          const attr = attrM[1];

          const divM = attr.match(/<divisions>(\d+)<\/divisions>/);
          if (divM) divisions = parseInt(divM[1]);

          const keyM = attr.match(/<key>([\s\S]*?)<\/key>/);
          if (keyM) {
            const fifths = parseInt(keyM[1].match(/<fifths>(-?\d+)<\/fifths>/)?.[1] || '0');
            currentKey = { fifths };
          }

          const timeM = attr.match(/<time>([\s\S]*?)<\/time>/);
          if (timeM) {
            const beats = parseInt(timeM[1].match(/<beats>(\d+)<\/beats>/)?.[1] || '4');
            const beatType = parseInt(timeM[1].match(/<beat-type>(\d+)<\/beat-type>/)?.[1] || '4');
            currentTime = { beats, beatType };
          }

          const stavesM = attr.match(/<staves>(\d+)<\/staves>/);
          if (stavesM) stavesInPart = parseInt(stavesM[1]);

          for (const cm of attr.matchAll(/<clef[^>]*(?:number="(\d+)")?[^>]*>([\s\S]*?)<\/clef>/g)) {
            const clefNum = cm[1] ? parseInt(cm[1]) : 1;
            const sign = cm[2].match(/<sign>(\w)<\/sign>/)?.[1] || 'G';
            currentClefs[clefNum] = sign === 'G' ? 'treble' : sign === 'F' ? 'bass' : sign === 'C' ? 'alto' : 'treble';
            // Auto-detect stavesInPart from clef numbers (OMR engines sometimes omit <staves>)
            if (clefNum > stavesInPart) stavesInPart = clefNum;
          }

          // Also auto-detect from staff numbers used in this measure's notes
          for (const sm of measureXml.matchAll(/<staff>(\d+)<\/staff>/g)) {
            const sn = parseInt(sm[1]);
            if (sn > stavesInPart) stavesInPart = sn;
          }
        }

        // ─── Parse note/rest/backup/forward events IN DOCUMENT ORDER ───
        // Track beat position PER VOICE within the measure.
        // Some OMR engines interleave staves without <backup> elements,
        // so when a note switches to a different voice/staff, we must
        // track each voice independently to avoid treating concurrent
        // notes as sequential.
        const measureStartBeat = globalBeatOffset;

        // voiceBeatPos: Map<"staff_voice" → current beat position in measure>
        const voiceBeatPos = new Map();
        // "active" voice key — tracks which voice the linear position belongs to
        let activeVoiceKey = null;
        // Fallback linear position (used for backup/forward which are voice-independent)
        let linearBeatPos = 0;

        const getVoiceKey = (staffNum, voiceNum) => `${staffNum}_${voiceNum}`;

        // Match all relevant elements in document order
        const eventRegex = /<(note|backup|forward)\b[^>]*>([\s\S]*?)<\/\1>/g;
        let em;
        while ((em = eventRegex.exec(measureXml)) !== null) {
          const tag = em[1];
          const content = em[2];

          if (tag === 'backup') {
            const durDivs = parseInt(content.match(/<duration>(\d+)<\/duration>/)?.[1] || '0');
            const beats = durDivs / divisions;
            linearBeatPos -= beats;
            if (linearBeatPos < 0) linearBeatPos = 0;
            // Reset active voice — next note determines the voice
            activeVoiceKey = null;
            continue;
          }

          if (tag === 'forward') {
            const durDivs = parseInt(content.match(/<duration>(\d+)<\/duration>/)?.[1] || '0');
            const beats = durDivs / divisions;
            linearBeatPos += beats;
            // Update active voice if set
            if (activeVoiceKey && voiceBeatPos.has(activeVoiceKey)) {
              voiceBeatPos.set(activeVoiceKey, voiceBeatPos.get(activeVoiceKey) + beats);
            }
            continue;
          }

          // It's a <note>
          const noteXml = content;
          const isChord = /<chord\s*\/>/.test(noteXml);
          const isRest = /<rest\s*\/>/.test(noteXml) || /<rest>/.test(noteXml);

          // Duration in divisions → quarter-note beats
          const durationDivs = parseInt(noteXml.match(/<duration>(\d+)<\/duration>/)?.[1] || String(divisions));
          const durationBeats = durationDivs / divisions;

          // Type name
          const typeStr = noteXml.match(/<type>([^<]+)<\/type>/)?.[1] || '';
          const durName = DURATION_TYPE_MAP[typeStr] || this._beatsToType(durationBeats);

          // Dotted?
          const dotted = /<dot\s*\/>/.test(noteXml);
          const fullDurName = dotted ? `dotted_${durName}` : durName;

          // Staff and voice
          const staffNum = parseInt(noteXml.match(/<staff>(\d+)<\/staff>/)?.[1] || '1');
          const staffIdx = globalStaffOffset + staffNum - 1;
          const voiceNum = parseInt(noteXml.match(/<voice>(\d+)<\/voice>/)?.[1] || '1');
          const voiceName = staffVoiceToSATB(staffNum, voiceNum, stavesInPart, globalStaffOffset);
          const vKey = getVoiceKey(staffNum, voiceNum);

          // Initialize voice position on first encounter
          if (!voiceBeatPos.has(vKey)) {
            // Each voice/staff starts at the BEGINNING of the measure (beat 0).
            // OMR engines may interleave notes from different staves without <backup>
            // elements, so we can't use the linear (cumulative) position.
            // For proper MusicXML with <backup>, the backup resets
            // linearBeatPos to 0 anyway, so starting at 0 is correct either way.
            voiceBeatPos.set(vKey, 0);
          }

          activeVoiceKey = vKey;

          // Get this voice's current beat position
          let voicePos = voiceBeatPos.get(vKey);

          // Compute beat offset for this note
          let noteBeatOffset;
          if (isChord) {
            // Chord: same onset as previous note in this voice
            noteBeatOffset = measureStartBeat + Math.max(0, voicePos - durationBeats);
          } else {
            noteBeatOffset = measureStartBeat + voicePos;
          }

          // Ties
          const tieStart = /<tie\s+type="start"\s*\/>/.test(noteXml);
          const tieStop = /<tie\s+type="stop"\s*\/>/.test(noteXml);

          if (isRest) {
            notes.push({
              type: 'rest',
              pitch: null,
              midiNote: null,
              duration: fullDurName,
              durationBeats,
              dotted,
              voice: voiceName,
              staffIndex: staffIdx,
              partIndex: partIdx,
              systemIndex,
              measureIndex,
              accidental: null,
              tiedBeats: null,
              beatOffset: noteBeatOffset,
            });
          } else {
            // Parse pitch
            const pitchMatch = noteXml.match(/<pitch>([\s\S]*?)<\/pitch>/);
            if (pitchMatch) {
              const pitchXml = pitchMatch[1];
              const step = pitchXml.match(/<step>([A-G])<\/step>/)?.[1] || 'C';
              const octave = parseInt(pitchXml.match(/<octave>(\d+)<\/octave>/)?.[1] || '4');
              const alter = parseInt(pitchXml.match(/<alter>(-?\d+)<\/alter>/)?.[1] || '0');
              const midiNote = this._pitchToMidi(step, octave, alter);
              const pitchName = `${step}${alter > 0 ? '#' : alter < 0 ? 'b' : ''}${octave}`;

              let accidental = null;
              const accMatch = noteXml.match(/<accidental>([^<]+)<\/accidental>/);
              if (accMatch) {
                accidental = accMatch[1] === 'sharp' ? 'sharp'
                  : accMatch[1] === 'flat' ? 'flat'
                  : accMatch[1] === 'natural' ? 'natural' : null;
              }

              notes.push({
                type: 'note',
                pitch: pitchName,
                midiNote,
                duration: fullDurName,
                durationBeats,
                dotted,
                voice: voiceName,
                staffIndex: staffIdx,
                partIndex: partIdx,
                systemIndex,
                measureIndex,
                accidental,
                tiedBeats: null,
                beatOffset: noteBeatOffset,
                _tieStart: tieStart,
                _tieStop: tieStop,
              });
            }
          }

          // Advance this voice's beat position (only for non-chord notes)
          if (!isChord) {
            voiceBeatPos.set(vKey, voicePos + durationBeats);
            // Also update linear position to track the furthest point
            linearBeatPos = Math.max(linearBeatPos, voiceBeatPos.get(vKey));
          }
        }

        // Advance global beat offset by this measure's duration.
        // ALWAYS use theoretical beats to keep measure boundaries stable.
        // The MusicXML divisions and time signature define the true measure structure.
        // Underfilled content (e.g., only 0.5 beat of notes in a 3-beat measure)
        // should NOT cause the measure to be shortened — this cascades timing errors.
        const theoreticalBeats = currentTime.beats * (4 / currentTime.beatType);
        const maxVoicePos = voiceBeatPos.size > 0
          ? Math.max(...voiceBeatPos.values())
          : 0;
        
        // Use theoretical beats consistently; allow overflow if content exceeds
        let measureBeats = Math.max(theoreticalBeats, maxVoicePos);
        
        if (measureIndex < 3) {
          console.log(`  M${measureIndex + 1}: theoretical=${theoreticalBeats.toFixed(1)} beats, voiceContent=${maxVoicePos.toFixed(1)} beats → measureBeats=${measureBeats.toFixed(1)}`);
        }
        
        globalBeatOffset += measureBeats;
      }

      // Update global staff offset for next part
      globalStaffOffset += stavesInPart;

      // Update metadata
      if (metadata.clefs.length === 0) {
        for (const [, clef] of Object.entries(currentClefs)) {
          metadata.clefs.push(clef);
        }
      }
      metadata.timeSignature = currentTime;
      metadata.keySignature = this._fifthsToKey(currentKey.fifths);
    }

    // Resolve ties
    this._resolveTies(notes);

    metadata.systems = Math.max(1, systemIndex + 1);
    metadata.staves = globalStaffOffset;
    metadata.stavesPerSystem = globalStaffOffset > 0
      ? Math.max(1, Math.round(globalStaffOffset / metadata.systems))
      : 2;
    metadata.totalBeats = globalBeatOffset;

    const noteCount = notes.filter(n => n.type === 'note').length;
    const restCount = notes.filter(n => n.type === 'rest').length;
    metadata.totalRests = restCount;

    // Count per-voice for diagnostics
    const voiceCounts = {};
    for (const n of notes) {
      if (n.type === 'note') voiceCounts[n.voice] = (voiceCounts[n.voice] || 0) + 1;
    }

    if (!strictVoices && noteCount > 1 && recoverChoirSATB(notes, voiceCounts)) {
      for (const k of Object.keys(voiceCounts)) delete voiceCounts[k];
      for (const n of notes) {
        if (n.type === 'note') voiceCounts[n.voice] = (voiceCounts[n.voice] || 0) + 1;
      }
      console.log(`🎤 Choir SATB recovery: ${JSON.stringify(voiceCounts)}`);
    }

    metadata.voiceCounts = voiceCounts;

    // Note range (lowest / highest MIDI and pitch names)
    const realNotes = notes.filter(n => n.type === 'note' && n.midiNote != null);
    if (realNotes.length > 0) {
      const sorted = [...realNotes].sort((a, b) => a.midiNote - b.midiNote);
      metadata.noteRange = {
        low: { midi: sorted[0].midiNote, pitch: sorted[0].pitch },
        high: { midi: sorted[sorted.length - 1].midiNote, pitch: sorted[sorted.length - 1].pitch },
      };
    }

    // Measure info: total count + array of beat boundaries for progress bar
    metadata.totalMeasures = 0;
    metadata.measureBeats = []; // [{ measureNum, startBeat, endBeat, beats, beatType }]

    // Re-derive from the part(s) - walk first part's measures to build boundaries
    if (partIds.length > 0) {
      const firstPartId = partIds[0];
      const firstPartRegex = new RegExp(
        `<part\\s+id="${firstPartId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([\\s\\S]*?)<\\/part>`,
        'i'
      );
      const firstPartMatch = xml.match(firstPartRegex);
      if (firstPartMatch) {
        const measures = this._extractMeasures(firstPartMatch[1]);
        let mDivisions = 1;
        let mTime = { beats: 4, beatType: 4 };
        let mBeatOffset = 0;

        for (let mi = 0; mi < measures.length; mi++) {
          const mXml = measures[mi];
          // Check for attributes in this measure
          for (const attrM of mXml.matchAll(/<attributes>([\s\S]*?)<\/attributes>/g)) {
            const attr = attrM[1];
            const divM = attr.match(/<divisions>(\d+)<\/divisions>/);
            if (divM) mDivisions = parseInt(divM[1]);
            const timeM = attr.match(/<time>([\s\S]*?)<\/time>/);
            if (timeM) {
              mTime = {
                beats: parseInt(timeM[1].match(/<beats>(\d+)<\/beats>/)?.[1] || '4'),
                beatType: parseInt(timeM[1].match(/<beat-type>(\d+)<\/beat-type>/)?.[1] || '4'),
              };
            }
          }
          const measureBeats = mTime.beats * (4 / mTime.beatType);
          const num = parseInt(mXml.match(/<measure[^>]*number="(\d+)"/)?.[1] || String(mi + 1));
          metadata.measureBeats.push({
            measureNum: num,
            startBeat: mBeatOffset,
            endBeat: mBeatOffset + measureBeats,
            beats: mTime.beats,
            beatType: mTime.beatType,
          });
          mBeatOffset += measureBeats;
        }
        metadata.totalMeasures = measures.length;
      }
    }

    // Extract tempo from <sound tempo="..."/> (LAST occurrence = most recent/correct tempo)
    // Skip the obvious wrong ones: if tempo is < 20 (unrealistic for playback), assume OMR miscalibration
    const tempoMatches = [...xml.matchAll(/<sound[^>]*\btempo="([\d.]+)"/g)];
    let selectedTempo = null;
    if (tempoMatches.length > 0) {
      // Use the last occurrence, but skip if it looks wrong (e.g., 8 BPM)
      selectedTempo = parseFloat(tempoMatches[tempoMatches.length - 1][1]);
      // If last is unrealistic, try second-to-last
      if (selectedTempo < 20 && tempoMatches.length > 1) {
        selectedTempo = parseFloat(tempoMatches[tempoMatches.length - 2][1]);
      }
      // If still unrealistic, reject it (OMR calibration error like Audiveris tempo=8)
      if (selectedTempo < 20) {
        selectedTempo = null;
      }
    }
    // Default to 120 BPM if no valid tempo found
    metadata.tempo = selectedTempo ? Math.round(selectedTempo) : 120;

    console.log(
      `✅ Parsed MusicXML: ${noteCount} notes, ${restCount} rests, ` +
      `${metadata.staves} staves, ${metadata.systems} systems, ` +
      `${metadata.totalMeasures} measures, ${globalBeatOffset} total beats\n` +
      `   Voice distribution: ${Object.entries(voiceCounts).map(([v,c]) => `${v}=${c}`).join(', ')}` +
      (metadata.noteRange ? `\n   Range: ${metadata.noteRange.low.pitch} – ${metadata.noteRange.high.pitch}` : '') +
      (metadata.tempo ? `\n   Tempo: ${metadata.tempo} BPM` : '')
    );

    return { notes, metadata };
  }

  /* ─── Internal Helpers ─── */

  static _extractMeasures(partXml) {
    const measures = [];
    const regex = /<measure[^>]*>([\s\S]*?)<\/measure>/g;
    let match;
    while ((match = regex.exec(partXml)) !== null) {
      measures.push(match[0]);
    }
    return measures;
  }

  static _pitchToMidi(step, octave, alter) {
    return 12 * (octave + 1) + (PITCH_SEMITONES[step] || 0) + alter;
  }

  static _beatsToType(beats) {
    if (beats >= 4) return 'whole';
    if (beats >= 2) return 'half';
    if (beats >= 1) return 'quarter';
    if (beats >= 0.5) return 'eighth';
    if (beats >= 0.25) return 'sixteenth';
    return '32nd';
  }

  static _fifthsToKey(fifths) {
    if (fifths === 0) return { type: 'None', count: 0, fifths: 0 };
    if (fifths > 0) return { type: 'Sharps', count: fifths, fifths };
    return { type: 'Flats', count: Math.abs(fifths), fifths };
  }

  /**
   * Resolve ties by merging consecutive tied notes of the same pitch.
   */
  static _resolveTies(notes) {
    const openTies = new Map();

    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      if (note.type !== 'note') continue;

      const key = `${note.staffIndex}_${note.voice}_${note.midiNote}`;

      if (note._tieStop && openTies.has(key)) {
        const startIdx = openTies.get(key);
        const starter = notes[startIdx];
        const startBeats = starter.tiedBeats || starter.durationBeats || DURATION_BEATS[starter.duration] || 1;
        const addBeats = note.durationBeats || DURATION_BEATS[note.duration] || 1;
        starter.tiedBeats = startBeats + addBeats;
        note._remove = true;

        if (note._tieStart) {
          openTies.set(key, startIdx);
        } else {
          openTies.delete(key);
        }
      }

      if (note._tieStart && !note._remove) {
        openTies.set(key, i);
      }
    }

    for (let i = notes.length - 1; i >= 0; i--) {
      if (notes[i]._remove) {
        notes.splice(i, 1);
      } else {
        delete notes[i]._tieStart;
        delete notes[i]._tieStop;
        delete notes[i]._remove;
      }
    }
  }
}
