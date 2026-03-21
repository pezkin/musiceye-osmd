/**
 * MusicXMLExporter — Generate MusicXML from detected notes and rests.
 *
 * Produces standard MusicXML 4.0 output compatible with MuseScore, Finale,
 * Sibelius, and our own MusicXMLParser.
 *
 * Zemsky's exportToMusicXml: builds XML string part-by-part, handling
 * multi-voice with <backup> elements, key/time/clef attributes, and
 * proper duration/type mapping.
 */

const DURATION_TO_TYPE = {
  'whole': 'whole',
  'half': 'half',
  'quarter': 'quarter',
  'eighth': 'eighth',
  'sixteenth': '16th',
  '32nd': '32nd',
  '64th': '64th',
};

const DURATION_TO_DIVS = {
  'whole': 16,
  'half': 8,
  'quarter': 4,
  'eighth': 2,
  'sixteenth': 1,
  '32nd': 0.5,
  '64th': 0.25,
};

/**
 * Export detected music to MusicXML string.
 *
 * @param {Object} params
 * @param {import('./DurationAssigner').MusicalNote[]} params.notes
 * @param {import('./DurationAssigner').MusicalRest[]} params.rests
 * @param {import('./StaffDetector').Staff[]} params.staves
 * @param {Object} params.timeSignature - {beats, beatType}
 * @param {Object} params.keySignature - {fifths}
 * @param {Object} params.clefs - {staffIndex → 'treble'|'bass'}
 * @param {string} params.title
 * @returns {string} MusicXML document
 */
export function exportToMusicXML({
  notes,
  rests,
  staves,
  timeSignature = { beats: 4, beatType: 4 },
  keySignature = { fifths: 0 },
  clefs = {},
  title = 'Untitled',
}) {
  const divisions = 4; // divisions per quarter note (allows 16th notes)

  // Group staves into parts (grand staff = 2 staves per part, else 1)
  const parts = _groupStavesIntoParts(staves);

  // Find total measures
  const maxMeasure = Math.max(
    ...notes.map(n => n.measureIndex),
    ...rests.map(r => r.measureIndex),
    0
  );

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN"\n`;
  xml += `  "http://www.musicxml.org/dtds/partwise.dtd">\n`;
  xml += `<score-partwise version="4.0">\n`;

  // Work title
  xml += `  <work>\n    <work-title>${_escapeXml(title)}</work-title>\n  </work>\n`;

  // Identification
  xml += `  <identification>\n`;
  xml += `    <encoding>\n`;
  xml += `      <software>Music-eye-zem</software>\n`;
  xml += `      <encoding-date>${new Date().toISOString().split('T')[0]}</encoding-date>\n`;
  xml += `    </encoding>\n`;
  xml += `  </identification>\n`;

  // Part list
  xml += `  <part-list>\n`;
  for (let pi = 0; pi < parts.length; pi++) {
    xml += `    <score-part id="P${pi + 1}">\n`;
    xml += `      <part-name>Part ${pi + 1}</part-name>\n`;
    xml += `    </score-part>\n`;
  }
  xml += `  </part-list>\n`;

  // Parts
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    xml += `  <part id="P${pi + 1}">\n`;

    for (let mi = 0; mi <= maxMeasure; mi++) {
      xml += `    <measure number="${mi + 1}">\n`;

      // Attributes in first measure
      if (mi === 0) {
        xml += `      <attributes>\n`;
        xml += `        <divisions>${divisions}</divisions>\n`;
        xml += `        <key>\n          <fifths>${keySignature.fifths}</fifths>\n        </key>\n`;
        xml += `        <time>\n          <beats>${timeSignature.beats}</beats>\n`;
        xml += `          <beat-type>${timeSignature.beatType}</beat-type>\n        </time>\n`;

        if (part.staveIndices.length > 1) {
          xml += `        <staves>${part.staveIndices.length}</staves>\n`;
        }

        for (let si = 0; si < part.staveIndices.length; si++) {
          const staffIdx = part.staveIndices[si];
          const clefType = clefs[staffIdx] || (si === 0 ? 'treble' : 'bass');
          const num = part.staveIndices.length > 1 ? ` number="${si + 1}"` : '';
          xml += `        <clef${num}>\n`;
          xml += `          <sign>${clefType === 'treble' ? 'G' : clefType === 'bass' ? 'F' : 'C'}</sign>\n`;
          xml += `          <line>${clefType === 'treble' ? '2' : clefType === 'bass' ? '4' : '3'}</line>\n`;
          xml += `        </clef>\n`;
        }

        xml += `      </attributes>\n`;
      }

      // Collect notes and rests for this measure across all staves in this part
      const measureNotes = notes.filter(n =>
        n.measureIndex === mi && part.staveIndices.includes(n.staffIndex)
      );
      const measureRests = rests.filter(r =>
        r.measureIndex === mi && part.staveIndices.includes(r.staffIndex)
      );

      // Group by voice, process each voice
      const voices = _groupByVoice(measureNotes, measureRests, part);

      let firstVoice = true;
      for (const [voiceKey, events] of voices) {
        if (!firstVoice && events.length > 0) {
          // Backup to start of measure for next voice
          const measureDuration = timeSignature.beats * (divisions * 4 / timeSignature.beatType);
          xml += `      <backup>\n        <duration>${measureDuration}</duration>\n      </backup>\n`;
        }

        for (const event of events) {
          if (event.isRest) {
            xml += _restToXml(event, divisions, voiceKey, part);
          } else {
            xml += _noteToXml(event, divisions, voiceKey, part);
          }
        }

        if (events.length > 0) firstVoice = false;
      }

      // If no events in this measure for any voice, add a whole rest
      if (voices.size === 0 || [...voices.values()].every(v => v.length === 0)) {
        const measureDuration = timeSignature.beats * (divisions * 4 / timeSignature.beatType);
        xml += `      <note>\n        <rest/>\n        <duration>${measureDuration}</duration>\n`;
        xml += `        <type>whole</type>\n      </note>\n`;
      }

      xml += `    </measure>\n`;
    }

    xml += `  </part>\n`;
  }

  xml += `</score-partwise>\n`;
  return xml;
}

function _noteToXml(note, divisions, voiceNum, part) {
  const dur = Math.round((note.durationBeats || 1) * divisions);
  const type = DURATION_TO_TYPE[note.duration] || 'quarter';

  // Parse pitch name
  const pitchMatch = note.pitchName.match(/^([A-G])(#|b)?(\d+)$/);
  if (!pitchMatch) return '';

  const step = pitchMatch[1];
  const alter = pitchMatch[2] === '#' ? 1 : pitchMatch[2] === 'b' ? -1 : 0;
  const octave = parseInt(pitchMatch[3]);

  let xml = `      <note>\n`;
  xml += `        <pitch>\n`;
  xml += `          <step>${step}</step>\n`;
  if (alter !== 0) xml += `          <alter>${alter}</alter>\n`;
  xml += `          <octave>${octave}</octave>\n`;
  xml += `        </pitch>\n`;
  xml += `        <duration>${dur}</duration>\n`;
  xml += `        <voice>${voiceNum}</voice>\n`;
  xml += `        <type>${type}</type>\n`;

  if (note.dotted) {
    xml += `        <dot/>\n`;
  }

  if (note.accidental) {
    const accName = note.accidental === 'sharp' ? 'sharp' :
                    note.accidental === 'flat' ? 'flat' : 'natural';
    xml += `        <accidental>${accName}</accidental>\n`;
  }

  // Staff number (for grand staff parts)
  if (part.staveIndices.length > 1) {
    const localStaff = part.staveIndices.indexOf(note.staffIndex) + 1;
    xml += `        <staff>${localStaff}</staff>\n`;
  }

  xml += `      </note>\n`;
  return xml;
}

function _restToXml(rest, divisions, voiceNum, part) {
  const dur = Math.round((rest.durationBeats || 1) * divisions);
  const type = DURATION_TO_TYPE[rest.duration] || 'quarter';

  let xml = `      <note>\n`;
  xml += `        <rest/>\n`;
  xml += `        <duration>${dur}</duration>\n`;
  xml += `        <voice>${voiceNum}</voice>\n`;
  xml += `        <type>${type}</type>\n`;

  if (part.staveIndices.length > 1) {
    const localStaff = part.staveIndices.indexOf(rest.staffIndex) + 1;
    xml += `        <staff>${localStaff}</staff>\n`;
  }

  xml += `      </note>\n`;
  return xml;
}

function _groupStavesIntoParts(staves) {
  // Heuristic: if staves are close together (within 3× interline gap),
  // they're a grand staff (one part). Otherwise separate parts.
  const parts = [];

  if (staves.length <= 1) {
    parts.push({ staveIndices: [0] });
    return parts;
  }

  let currentPart = { staveIndices: [0] };
  for (let i = 1; i < staves.length; i++) {
    const gap = staves[i].top - staves[i - 1].bottom;
    const avgInterline = (staves[i].interline + staves[i - 1].interline) / 2;

    // Grand staff gap is typically 2-4× interline; separate systems are much larger
    if (gap < avgInterline * 5) {
      currentPart.staveIndices.push(i);
    } else {
      parts.push(currentPart);
      currentPart = { staveIndices: [i] };
    }
  }
  parts.push(currentPart);

  return parts;
}

function _groupByVoice(notes, rests, part) {
  const voices = new Map(); // voiceNum → [{note/rest with isRest flag}]

  // Combine and sort by x position
  const events = [
    ...notes.map(n => ({ ...n, isRest: false })),
    ...rests.map(r => ({ ...r, isRest: true, voice: 1 })),
  ].sort((a, b) => a.x - b.x);

  for (const event of events) {
    const v = event.voice || 1;
    if (!voices.has(v)) voices.set(v, []);
    voices.get(v).push(event);
  }

  return voices;
}

function _escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
