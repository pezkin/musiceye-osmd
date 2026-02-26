/**
 * MusicXML Parser
 *
 * Parses MusicXML returned by the HOMR server into the note/rest format
 * expected by AudioPlaybackService and PlaybackScreen.
 *
 * Output note format:
 *   { type, pitch, midiNote, duration, dotted, voice, staffIndex,
 *     systemIndex, measureIndex, accidental, tiedBeats }
 *
 * This is a lightweight XML parser that works in React Native without
 * any native XML dependencies — uses regex-based extraction.
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
  'breve': 'whole', // treat breve as whole
};

// Voice number → voice name
const VOICE_NAMES = {
  1: 'Soprano',
  2: 'Alto',
  3: 'Tenor',
  4: 'Bass',
};

export class MusicXMLParser {
  /**
   * Parse a MusicXML string into notes and metadata.
   * @param {string} xml - raw MusicXML string
   * @returns {{ notes: Array, metadata: Object }}
   */
  static parse(xml) {
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
    const titleMatch = xml.match(/<movement-title>([^<]*)<\/movement-title>/);
    if (titleMatch) metadata.title = titleMatch[1].trim();

    // Extract all parts
    const partIds = [];
    const partListMatches = xml.matchAll(/<score-part\s+id="([^"]+)"/g);
    for (const m of partListMatches) {
      partIds.push(m[1]);
    }

    if (partIds.length === 0) {
      // Fallback: find parts by <part id="..."> tag
      const partMatches = xml.matchAll(/<part\s+id="([^"]+)"/g);
      for (const m of partMatches) {
        if (!partIds.includes(m[1])) partIds.push(m[1]);
      }
    }

    // Parse each part
    let globalStaffIndex = 0;
    let systemIndex = 0;
    let highestStavesSeen = 0;

    for (let partIdx = 0; partIdx < partIds.length; partIdx++) {
      const partId = partIds[partIdx];
      const partRegex = new RegExp(
        `<part\\s+id="${this._escapeRegex(partId)}"[^>]*>([\\s\\S]*?)<\\/part>`,
        'i'
      );
      const partMatch = xml.match(partRegex);
      if (!partMatch) continue;
      const partContent = partMatch[1];

      // Extract measures
      const measures = this._extractMeasures(partContent);

      // Track state
      let divisions = 1; // divisions per quarter note
      let currentKey = { fifths: 0, mode: 'major' };
      let currentTime = { beats: 4, beatType: 4 };
      let currentClefs = {};
      let stavesInPart = 1;
      let measureIndex = -1;

      for (const measureXml of measures) {
        measureIndex++;

        // Check for new system (heuristic: every N measures or via print tag)
        const newSystem = measureXml.match(/<print[^>]*new-system="yes"/);
        const newPage = measureXml.match(/<print[^>]*new-page="yes"/);
        if (measureIndex > 0 && (newSystem || newPage)) {
          systemIndex++;
        }

        // Parse attributes (divisions, key, time, staves, clefs)
        const attrMatch = measureXml.match(/<attributes>([\s\S]*?)<\/attributes>/);
        if (attrMatch) {
          const attr = attrMatch[1];

          const divMatch = attr.match(/<divisions>(\d+)<\/divisions>/);
          if (divMatch) divisions = parseInt(divMatch[1]);

          const keyMatch = attr.match(/<key>([\s\S]*?)<\/key>/);
          if (keyMatch) {
            const fifths = parseInt(keyMatch[1].match(/<fifths>(-?\d+)<\/fifths>/)?.[1] || '0');
            const mode = keyMatch[1].match(/<mode>(\w+)<\/mode>/)?.[1] || 'major';
            currentKey = { fifths, mode };
          }

          const timeMatch = attr.match(/<time>([\s\S]*?)<\/time>/);
          if (timeMatch) {
            const beats = parseInt(timeMatch[1].match(/<beats>(\d+)<\/beats>/)?.[1] || '4');
            const beatType = parseInt(timeMatch[1].match(/<beat-type>(\d+)<\/beat-type>/)?.[1] || '4');
            currentTime = { beats, beatType };
          }

          const stavesMatch = attr.match(/<staves>(\d+)<\/staves>/);
          if (stavesMatch) {
            stavesInPart = parseInt(stavesMatch[1]);
            highestStavesSeen = Math.max(highestStavesSeen, stavesInPart);
          }

          // Parse clefs
          const clefMatches = [...attr.matchAll(/<clef[^>]*(?:number="(\d+)")?[^>]*>([\s\S]*?)<\/clef>/g)];
          for (const cm of clefMatches) {
            const clefNum = cm[1] ? parseInt(cm[1]) : 1;
            const sign = cm[2].match(/<sign>(\w)<\/sign>/)?.[1] || 'G';
            const line = parseInt(cm[2].match(/<line>(\d)<\/line>/)?.[1] || '2');
            const clefName = sign === 'G' ? 'treble' : sign === 'F' ? 'bass' : sign === 'C' ? 'alto' : 'treble';
            currentClefs[clefNum] = clefName;
          }
        }

        // Parse notes and rests in this measure
        const noteMatches = [...measureXml.matchAll(/<note[^>]*>([\s\S]*?)<\/note>/g)];
        let isChord = false;

        for (const nm of noteMatches) {
          const noteXml = nm[1];

          // Check if this is a chord member (don't advance position)
          isChord = /<chord\s*\/>/.test(noteXml);

          // Get staff number (default 1)
          const staffNum = parseInt(noteXml.match(/<staff>(\d+)<\/staff>/)?.[1] || '1');
          const staffIdx = globalStaffIndex + staffNum - 1;

          // Get voice
          const voiceNum = parseInt(noteXml.match(/<voice>(\d+)<\/voice>/)?.[1] || '1');
          const voiceName = VOICE_NAMES[voiceNum] || VOICE_NAMES[((voiceNum - 1) % 4) + 1];

          // Get duration in divisions
          const durationDivs = parseInt(noteXml.match(/<duration>(\d+)<\/duration>/)?.[1] || String(divisions));

          // Get type (quarter, half, etc.)
          const typeStr = noteXml.match(/<type>([^<]+)<\/type>/)?.[1] || '';
          const duration = DURATION_TYPE_MAP[typeStr] || this._divisionsToType(durationDivs, divisions);

          // Dotted?
          const dotted = /<dot\s*\/>/.test(noteXml);

          // Tied?
          const tieStart = /<tie\s+type="start"\s*\/>/.test(noteXml);
          const tieStop = /<tie\s+type="stop"\s*\/>/.test(noteXml);

          // Is it a rest?
          const isRest = /<rest\s*\/>/.test(noteXml) || /<rest>/.test(noteXml);

          if (isRest) {
            notes.push({
              type: 'rest',
              pitch: null,
              midiNote: null,
              duration: dotted ? `dotted_${duration}` : duration,
              dotted,
              voice: voiceName,
              staffIndex: staffIdx,
              systemIndex,
              measureIndex,
              accidental: null,
              tiedBeats: null,
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
                const accType = accMatch[1];
                accidental = accType === 'sharp' ? 'sharp'
                  : accType === 'flat' ? 'flat'
                  : accType === 'natural' ? 'natural'
                  : null;
              }

              notes.push({
                type: 'note',
                pitch: pitchName,
                midiNote,
                duration: dotted ? `dotted_${duration}` : duration,
                dotted,
                voice: voiceName,
                staffIndex: staffIdx,
                systemIndex,
                measureIndex,
                accidental,
                tiedBeats: null,
                _tieStart: tieStart,
                _tieStop: tieStop,
              });
            }
          }
        }
      }

      // Update global staff index for next part
      globalStaffIndex += stavesInPart;

      // Update metadata from this part
      if (metadata.clefs.length === 0) {
        for (const [, clef] of Object.entries(currentClefs)) {
          metadata.clefs.push(clef);
        }
      }
      metadata.timeSignature = currentTime;
      metadata.keySignature = this._fifthsToKey(currentKey.fifths);
    }

    // Resolve ties: merge tied notes into single notes with extended duration
    this._resolveTies(notes);

    // Calculate systems (minimum 1)
    metadata.systems = Math.max(1, systemIndex + 1);
    metadata.staves = globalStaffIndex;
    metadata.stavesPerSystem = highestStavesSeen || (globalStaffIndex > 0 ? globalStaffIndex / metadata.systems : 2);

    console.log(
      `✅ Parsed MusicXML: ${notes.filter(n => n.type === 'note').length} notes, ` +
      `${notes.filter(n => n.type === 'rest').length} rests, ` +
      `${metadata.staves} staves, ${metadata.systems} systems`
    );

    return { notes, metadata };
  }

  /* ─── Internal Helpers ─── */

  static _extractMeasures(partXml) {
    const measures = [];
    const regex = /<measure[^>]*>([\s\S]*?)<\/measure>/g;
    let match;
    while ((match = regex.exec(partXml)) !== null) {
      measures.push(match[0]); // include the <measure> tags
    }
    return measures;
  }

  static _pitchToMidi(step, octave, alter) {
    const semitone = PITCH_SEMITONES[step] || 0;
    return 12 * (octave + 1) + semitone + alter;
  }

  static _divisionsToType(durationDivs, divisions) {
    // divisions = divisions per quarter note
    const ratio = durationDivs / divisions;
    if (ratio >= 4) return 'whole';
    if (ratio >= 2) return 'half';
    if (ratio >= 1) return 'quarter';
    if (ratio >= 0.5) return 'eighth';
    if (ratio >= 0.25) return 'sixteenth';
    return '32nd';
  }

  static _fifthsToKey(fifths) {
    if (fifths === 0) return { type: 'None', count: 0 };
    if (fifths > 0) return { type: 'Sharps', count: fifths };
    return { type: 'Flats', count: Math.abs(fifths) };
  }

  static _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Resolve ties by merging consecutive tied notes of the same pitch.
   * Modifies the notes array in place.
   */
  static _resolveTies(notes) {
    const DURATION_BEATS = {
      'whole': 4, 'half': 2, 'quarter': 1, 'eighth': 0.5, 'sixteenth': 0.25,
      '32nd': 0.125,
      'dotted_whole': 6, 'dotted_half': 3, 'dotted_quarter': 1.5,
      'dotted_eighth': 0.75, 'dotted_sixteenth': 0.375, 'dotted_32nd': 0.1875,
    };

    // Track open ties: key = `${staffIndex}_${voice}_${midiNote}` → index in notes array
    const openTies = new Map();

    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      if (note.type !== 'note') continue;

      const key = `${note.staffIndex}_${note.voice}_${note.midiNote}`;

      if (note._tieStop && openTies.has(key)) {
        // This note is the continuation of a tie — merge into the starter
        const startIdx = openTies.get(key);
        const starter = notes[startIdx];
        const startBeats = starter.tiedBeats || DURATION_BEATS[starter.duration] || 1;
        const addBeats = DURATION_BEATS[note.duration] || 1;
        starter.tiedBeats = startBeats + addBeats;

        // Mark this continuation note for removal
        note._remove = true;

        // If the continuation also starts a new tie, keep tracking
        if (note._tieStart) {
          openTies.set(key, startIdx); // keep pointing to original
        } else {
          openTies.delete(key);
        }
      }

      if (note._tieStart && !note._remove) {
        openTies.set(key, i);
      }
    }

    // Remove merged continuation notes and clean up internal fields
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
