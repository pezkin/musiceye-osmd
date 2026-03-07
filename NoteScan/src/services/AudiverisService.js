/**
 * Audiveris OMR Service
 *
 * Wraps the Audiveris OMR server (port 8082).
 * Audiveris produces higher-quality MusicXML with:
 *   - Proper <backup> elements for multi-voice/multi-staff
 *   - Dynamic markings, articulations, lyrics
 *   - Repeat/volta detection
 *   - Standard MusicXML 4.0.3 output
 */
import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system';
import Constants from 'expo-constants';
import { MusicXMLParser } from './MusicXMLParser';

// Auto-detect the Expo dev server URL — always use Metro proxy
// Metro proxies /audiveris/* → localhost:8082
function getDefaultServerUrl() {
  try {
    const debuggerHost =
      Constants.expoConfig?.hostUri ||
      Constants.manifest?.debuggerHost ||
      Constants.manifest2?.extra?.expoGo?.debuggerHost;
    if (debuggerHost) {
      const host = debuggerHost.split(':')[0];
      // For tunnel URLs, use HTTPS on default port
      if (debuggerHost.includes('.exp.direct') || debuggerHost.includes('ngrok') || debuggerHost.includes('tunnel')) {
        return `https://${host}`;
      }
      // LAN mode — use Metro port (proxy handles routing to Audiveris)
      const port = debuggerHost.split(':')[1] || '8081';
      return `http://${host}:${port}`;
    }
  } catch (e) {
    console.log('Could not auto-detect dev server URL:', e.message);
  }
  return 'http://localhost:8081';
}

class AudiverisServiceClass {
  _serverUrl = null;
  _timeout = 180000; // 3 minutes — Audiveris is more thorough

  setServerUrl(url) {
    this._serverUrl = url.replace(/\/+$/, '');
    console.log(`🌐 Audiveris server set to: ${this._serverUrl}`);
  }

  getServerUrl() {
    if (!this._serverUrl) {
      this._serverUrl = getDefaultServerUrl();
      console.log(`🌐 Audiveris server auto-detected: ${this._serverUrl}`);
    }
    return this._serverUrl;
  }

  /** Get the URL for the /process endpoint (always via Metro proxy) */
  _getProcessUrl() {
    return `${this.getServerUrl()}/audiveris/process`;
  }

  /** Get the URL for the health check (always via Metro proxy) */
  _getDocsUrl() {
    return `${this.getServerUrl()}/audiveris/docs`;
  }

  setTimeout(ms) {
    this._timeout = ms;
  }

  /**
   * Check if the Audiveris server is reachable.
   */
  async checkHealth() {
    const docsUrl = this._getDocsUrl();
    console.log(`🔍 Audiveris health check → ${docsUrl}`);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);

      const response = await fetch(docsUrl, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeout);

      return {
        ok: response.ok || response.status === 200,
        message: response.ok
          ? `Audiveris server is reachable`
          : `Audiveris server responded with ${response.status}`,
      };
    } catch (e) {
      return {
        ok: false,
        message: e.name === 'AbortError'
          ? `Audiveris server timed out (20s)`
          : `Cannot reach Audiveris server: ${e.message}`,
      };
    }
  }

  /**
   * Send an image to the Audiveris server for OMR processing.
   */
  async processImage(imageUri, onProgress) {
    const report = (msg) => {
      console.log(`🎼 Audiveris: ${msg}`);
      if (onProgress) onProgress(msg);
    };

    report('Preparing image for upload...');

    const file = new File(imageUri);
    if (!file.exists) {
      throw new Error('Image file not found: ' + imageUri);
    }

    report('Uploading to Audiveris server...');

    const fileName = imageUri.split('/').pop() || 'sheet_music.jpg';
    const ext = fileName.split('.').pop().toLowerCase();
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

    let response;
    try {
      const formData = new FormData();
      formData.append('file', {
        uri: imageUri,
        name: fileName,
        type: mimeType,
      });

      response = await fetch(this._getProcessUrl(), {
        method: 'POST',
        body: formData,
        headers: {
          'Accept': 'application/json, application/xml, text/xml, */*',
        },
      });
    } catch (e) {
      throw new Error(
        `Failed to connect to Audiveris server: ${e.message}\n\n` +
        'Make sure the Audiveris server is running and accessible from this device.'
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`🎼 Audiveris error ${response.status}: ${body.substring(0, 800)}`);

      if (response.status === 422) {
        throw new Error(
          'Audiveris could not recognize music in this image.\n\n' +
          'Tips for better results:\n' +
          '• Use good lighting with no shadows\n' +
          '• Hold the camera directly above the page\n' +
          '• Make sure the full staff lines are visible\n' +
          '• Avoid blurry or skewed photos\n' +
          '• Try a higher-resolution photo'
        );
      }

      throw new Error(
        `Audiveris server returned status ${response.status}.\n` +
        `Response: ${body.substring(0, 500)}`
      );
    }

    report('Parsing response...');

    // Server now returns JSON with { musicxml, notePositions, processedImage }
    const contentType = response.headers.get('content-type') || '';
    let musicXml;
    let notePositions = null;
    let processedImageB64 = null;

    if (contentType.includes('application/json')) {
      const json = await response.json();
      musicXml = json.musicxml;
      notePositions = json.notePositions || null;
      processedImageB64 = json.processedImage || null;
      console.log(`🎼 Audiveris: received JSON — ${musicXml?.length || 0} chars XML, positions: ${notePositions ? `${notePositions.heads?.length || 0} heads` : 'none'}, processedImage: ${processedImageB64 ? `${Math.round(processedImageB64.length / 1024)}KB` : 'none'}`);
    } else {
      // Fallback for older server versions returning plain XML
      musicXml = await response.text();
      console.log(`🎼 Audiveris: received ${musicXml.length} chars of plain MusicXML (legacy)`);
    }

    if (!musicXml || musicXml.length < 50) {
      throw new Error('Audiveris server returned an empty or invalid response');
    }

    // Check if Audiveris flagged the sheet as invalid
    if (musicXml.includes('flagged as invalid') || musicXml.includes('did not complete successfully')) {
      throw new Error('Audiveris could not process this image. Try a clearer, higher-resolution photo (300+ DPI recommended).');
    }

    report('Converting to playback format...');
    const parsed = MusicXMLParser.parse(musicXml);
    console.log(`🎼 Audiveris: parsed ${parsed.notes.length} notes, ${parsed.metadata.totalMeasures || '?'} measures`);

    // Save preprocessed image to disk if available
    let processedImageUri = null;
    if (processedImageB64) {
      try {
        const dir = FileSystem.cacheDirectory + 'omr/';
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
        const path = dir + 'preprocessed_' + Date.now() + '.png';
        await FileSystem.writeAsStringAsync(path, processedImageB64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        processedImageUri = path;
        console.log(`🎼 Audiveris: saved preprocessed image → ${path}`);
      } catch (e) {
        console.warn('Could not save preprocessed image:', e.message);
      }
    }

    report('Processing complete!');

    return {
      musicXml,
      notes: parsed.notes,
      metadata: parsed.metadata,
      notePositions,
      processedImageUri,
    };
  }

  /**
   * Send an image to the /debug endpoint and get back
   * the preprocessed PNG as a base64 data URI.
   * This lets the user see exactly what Audiveris receives.
   */
  async debugPreprocess(imageUri) {
    const fileName = imageUri.split('/').pop() || 'sheet_music.jpg';
    const ext = fileName.split('.').pop().toLowerCase();
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

    const formData = new FormData();
    formData.append('file', {
      uri: imageUri,
      name: fileName,
      type: mimeType,
    });

    const debugUrl = `${this.getServerUrl()}/audiveris/debug`;
    console.log(`🔍 Debug preprocess → ${debugUrl}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    let response;
    try {
      response = await fetch(debugUrl, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch (e) {
      clearTimeout(timeout);
      throw new Error(`Failed to connect to server: ${e.message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Server error ${response.status}: ${body.substring(0, 200)}`);
    }

    // Read the PNG response as a blob and convert to base64 data URI
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to read preprocessed image'));
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Process an image and return a scoreData object compatible with PlaybackScreen.
   * Returns a scoreData object compatible with PlaybackScreen.
   */
  async processSheet(imageUri, onProgress) {
    const { notes, metadata, notePositions, processedImageUri } = await this.processImage(imageUri, onProgress);

    // Determine displayed image dimensions and whether we have real .omr positions.
    const hasRealPositions = notePositions && notePositions.heads && notePositions.heads.length > 0
      && notePositions.systems && notePositions.systems.length > 0;

    let imageWidth = 1400;
    let imageHeight = 1000;

    // Always measure the ACTUAL image the viewer will display.
    // This is the preprocessed image if available, otherwise the original photo.
    const displayUri = processedImageUri || imageUri;
    try {
      const { Image } = require('react-native');
      const dims = await new Promise((resolve) => {
        Image.getSize(
          displayUri,
          (w, h) => resolve({ w, h }),
          () => resolve(null)
        );
      });
      if (dims) {
        imageWidth = dims.w;
        imageHeight = dims.h;
      }
    } catch (e) {
      console.warn('Could not get image dimensions:', e.message);
    }

    // If .omr dimensions differ from the actual image, pre-scale all .omr data
    // to match. This handles any Audiveris internal rescaling.
    if (hasRealPositions) {
      const omrW = notePositions.imageWidth || 0;
      const omrH = notePositions.imageHeight || 0;
      console.log(`📐 Display image: ${imageWidth}×${imageHeight}, .omr reports: ${omrW}×${omrH}`);

      if (omrW > 0 && omrH > 0 && (Math.abs(omrW - imageWidth) > 2 || Math.abs(omrH - imageHeight) > 2)) {
        const sx = imageWidth / omrW;
        const sy = imageHeight / omrH;
        console.warn(`⚠️ Dimension mismatch — rescaling .omr coords by ${sx.toFixed(3)}×${sy.toFixed(3)}`);
        for (const head of notePositions.heads) {
          head.x = Math.round(head.x * sx);
          head.y = Math.round(head.y * sy);
          head.w = Math.round(head.w * sx);
          head.h = Math.round(head.h * sy);
        }
        for (const sys of notePositions.systems) {
          sys.top *= sy; sys.bottom *= sy;
          sys.left *= sx; sys.right *= sx;
          if (sys.measures) {
            for (const m of sys.measures) { m.left *= sx; m.right *= sx; }
          }
          if (sys.staffs) {
            for (const s of sys.staffs) {
              s.top *= sy; s.bottom *= sy;
              s.left = (s.left || 0) * sx; s.right = (s.right || 0) * sx;
            }
          }
        }
        notePositions.imageWidth = imageWidth;
        notePositions.imageHeight = imageHeight;
      }
    }

    let systemBounds = [];
    let staffGroups = [];

    if (hasRealPositions) {
      console.log(`📍 Using real positions: ${notePositions.heads.length} heads, ${notePositions.systems.length} systems`);

      // ── Build measure → system mapping and measure x-ranges from .omr ──
      const measureToSystem = {};   // measureNum → systemIndex
      const measureRanges = {};     // measureNum → { left, right }

      for (const sys of notePositions.systems) {
        for (const m of sys.measures) {
          measureToSystem[m.measureNum] = sys.systemIndex;
          measureRanges[m.measureNum] = { left: m.left, right: m.right };
        }
      }

      const systemCount = notePositions.systems.length;

      // ── Build .omr heads index: measure → sorted heads ──
      const headsByMeasure = {};
      for (const head of notePositions.heads) {
        const mkey = head.measure;
        if (!headsByMeasure[mkey]) headsByMeasure[mkey] = [];
        headsByMeasure[mkey].push(head);
      }
      for (const mkey of Object.keys(headsByMeasure)) {
        headsByMeasure[mkey].sort((a, b) => a.x - b.x);
      }

      // ── Assign positions to MusicXML notes ──
      // Group notes by measure (measureIndex is 0-based, .omr measureNum is 1-based)
      const notesByMeasure = {};
      for (const note of notes) {
        const mNum = (note.measureIndex != null ? note.measureIndex + 1 : 1);
        if (!notesByMeasure[mNum]) notesByMeasure[mNum] = [];
        notesByMeasure[mNum].push(note);
      }

      let matchedDirect = 0;
      let matchedInterp = 0;

      for (const [mNumStr, mNotes] of Object.entries(notesByMeasure)) {
        const mNum = parseInt(mNumStr);
        const sysIdx = measureToSystem[mNum] ?? 0;
        const range = measureRanges[mNum];
        const heads = headsByMeasure[mNum] || [];

        // Sort notes by beatOffset
        const nonRests = mNotes.filter(n => n.type !== 'rest');
        nonRests.sort((a, b) => (a.beatOffset || 0) - (b.beatOffset || 0));

        // Assign systemIndex to ALL notes in this measure
        for (const note of mNotes) {
          note.systemIndex = sysIdx;
        }

        if (heads.length > 0 && nonRests.length > 0) {
          // Match notes to heads by sequential order within the measure
          // Handle chords: multiple notes at same beat share similar x
          const uniqueBeats = [...new Set(nonRests.map(n => n.beatOffset))].sort((a, b) => a - b);
          const uniqueXClusters = _clusterByX(heads, imageWidth * 0.02);

          if (uniqueBeats.length === uniqueXClusters.length) {
            // Perfect 1:1 beat→cluster match — use .omr head positions directly
            matchedDirect += nonRests.length;
            for (let bi = 0; bi < uniqueBeats.length; bi++) {
              const beatNotes = nonRests.filter(n => n.beatOffset === uniqueBeats[bi]);
              const cluster = uniqueXClusters[bi];
              // Use absolute pixel coordinates directly (already scaled to display image)
              const clusterCenterX = cluster.reduce((s, h) => s + h.x + h.w / 2, 0) / cluster.length;

              for (const note of beatNotes) {
                note.x = clusterCenterX;
                // Set Y from closest matching .omr head in this cluster
                const headForNote = cluster.length === 1 ? cluster[0]
                  : cluster.reduce((best, h) => (!best || Math.abs(h.pitch - (note.omrPitch || 0)) < Math.abs(best.pitch - (note.omrPitch || 0))) ? h : best, null);
                if (headForNote) {
                  note.y = headForNote.y + headForNote.h / 2;
                  note._hasRealY = true;
                }
              }
            }
          } else {
            // Fallback: distribute using measure x-range + beatOffset interpolation
            matchedInterp += nonRests.length;
            _assignXByBeatInterpolation(nonRests, range);
          }

          // Assign rest positions using beatOffset interpolation within measure range
          const rests = mNotes.filter(n => n.type === 'rest');
          if (rests.length > 0 && range) {
            _assignXByBeatInterpolation(rests, range);
          }
        } else if (range) {
          // No heads matched — use measure-range interpolation (still better than global)
          matchedInterp += mNotes.filter(n => n.type !== 'rest').length;
          _assignXByBeatInterpolation(mNotes, range);
        }
      }

      console.log(`📊 Position matching: ${matchedDirect} notes from .omr heads, ${matchedInterp} notes interpolated`);

      // ── Assign y positions using real .omr data ──
      for (const note of notes) {
        if (!note._hasRealY) {
          // Fallback: use real staff center from .omr system data
          const sysIdx = note.systemIndex || 0;
          const sysData = notePositions.systems[sysIdx];
          if (sysData && sysData.staffs && sysData.staffs.length > 0) {
            const staffLocal = (note.staffIndex || 0) % sysData.staffs.length;
            const staff = sysData.staffs[staffLocal];
            note.y = staff ? (staff.top + staff.bottom) / 2
                          : (sysData.top + sysData.bottom) / 2;
          } else {
            note.y = imageHeight * ((sysIdx + 0.5) / systemCount);
          }
        }
        // Ensure x is set (fallback for any unmapped notes)
        if (typeof note.x !== 'number' || !Number.isFinite(note.x)) {
          note.x = imageWidth * 0.1;
        }
      }

      // ── Build system bounds using REAL .omr system positions ──
      for (let s = 0; s < systemCount; s++) {
        const sysData = notePositions.systems[s];
        const top = sysData ? sysData.top : (s / systemCount) * imageHeight;
        const bottom = sysData ? sysData.bottom : ((s + 1) / systemCount) * imageHeight;
        const numStaffs = sysData?.staffs?.length || 1;
        const staffIndices = Array.from({ length: numStaffs }, (_, i) => s * numStaffs + i);

        systemBounds.push({ top, bottom, staffIndices });
        if (sysData?.staffs) {
          for (const staff of sysData.staffs) {
            const staffTop = staff.top;
            const spacing = (staff.bottom - staff.top) / 4;
            staffGroups.push(Array.from({ length: 5 }, (_, i) => staffTop + i * spacing));
          }
        } else {
          staffGroups.push(Array.from({ length: 5 }, (_, i) => top + i * ((bottom - top) / 4)));
        }
      }
    } else {
      // ── FALLBACK: Synthetic positions from beatOffset (legacy behavior) ──
      console.log('📍 No .omr positions — using synthetic beatOffset positions');
      const systemCount = metadata.systems || 1;
      const systemHeight = imageHeight / systemCount;
      const MARGIN_X = imageWidth * 0.08;
      const usableWidth = imageWidth - 2 * MARGIN_X;

      const notesBySystem = {};
      for (const note of notes) {
        const sys = note.systemIndex || 0;
        if (!notesBySystem[sys]) notesBySystem[sys] = [];
        notesBySystem[sys].push(note);
      }

      for (const [sysIdx, sysNotes] of Object.entries(notesBySystem)) {
        const idx = parseInt(sysIdx);
        const systemTop = idx * systemHeight;
        const systemMid = systemTop + systemHeight / 2;

        const beats = sysNotes
          .map(n => n.beatOffset)
          .filter(b => typeof b === 'number' && Number.isFinite(b));
        const minBeat = beats.length > 0 ? Math.min(...beats) : 0;
        const maxBeat = beats.length > 0 ? Math.max(...beats) : 1;
        const beatRange = maxBeat - minBeat;

        for (const note of sysNotes) {
          if (typeof note.beatOffset === 'number' && Number.isFinite(note.beatOffset) && beatRange > 0) {
            const fraction = (note.beatOffset - minBeat) / beatRange;
            note.x = MARGIN_X + fraction * usableWidth;
          } else {
            note.x = MARGIN_X;
          }
          const staffOffset = note.staffIndex % 2 === 0 ? -systemHeight * 0.15 : systemHeight * 0.15;
          note.y = systemMid + staffOffset;
        }
      }

      // Build staff groups and system bounds
      for (let s = 0; s < systemCount; s++) {
        const top = s * systemHeight + systemHeight * 0.1;
        const bottom = (s + 1) * systemHeight - systemHeight * 0.1;
        const staffIndices = metadata.stavesPerSystem
          ? Array.from({ length: metadata.stavesPerSystem }, (_, i) => s * metadata.stavesPerSystem + i)
          : [s * 2, s * 2 + 1];

        systemBounds.push({ top, bottom, staffIndices });
        for (const si of staffIndices) {
          const mid = (top + bottom) / 2;
          const offset = (si - staffIndices[0]) / Math.max(1, staffIndices.length - 1);
          const staffTop = top + offset * (bottom - top) * 0.6;
          const spacing = (bottom - top) * 0.08;
          staffGroups.push(Array.from({ length: 5 }, (_, i) => staffTop + i * spacing));
        }
      }
    }

    const allEvents = [...notes].sort((a, b) => {
      const sa = Number.isFinite(a.staffIndex) ? a.staffIndex : 999;
      const sb = Number.isFinite(b.staffIndex) ? b.staffIndex : 999;
      if (sa !== sb) return sa - sb;
      return (a.x || 0) - (b.x || 0);
    });

    const totalNotes = notes.filter((n) => n.type !== 'rest').length;
    const totalRests = notes.filter((n) => n.type === 'rest').length;

    return {
      notes: allEvents,
      staves: metadata.staves || 2,
      measures: [],
      processedImageUri: processedImageUri || null,
      metadata: {
        imageWidth,
        imageHeight,
        staffGroups,
        keySignature: metadata.keySignature || { type: 'None', count: 0 },
        timeSignature: metadata.timeSignature || { beats: 4, beatType: 4 },
        clefs: metadata.clefs || ['treble', 'bass'],
        barLines: [],
        ledgerLines: 0,
        systems: systemBounds,
        timestamp: new Date().toISOString(),
        totalNotes,
        totalRests,
        source: 'Audiveris',
        title: metadata.title || '',
        hasRealPositions: !!hasRealPositions,
      },
    };
  }
}

/**
 * Cluster heads by x-proximity. Heads within `threshold` pixels are grouped together.
 */
function _clusterByX(heads, threshold) {
  if (heads.length === 0) return [];
  const sorted = [...heads].sort((a, b) => a.x - b.x);
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const lastCluster = clusters[clusters.length - 1];
    const lastX = lastCluster[lastCluster.length - 1].x;
    if (sorted[i].x - lastX <= threshold) {
      lastCluster.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }
  return clusters;
}

/**
 * Assign x positions to notes using measure x-range + beatOffset interpolation.
 */
function _assignXByBeatInterpolation(notesInMeasure, measureRange) {
  if (!measureRange) return;

  const beats = notesInMeasure
    .map(n => n.beatOffset)
    .filter(b => typeof b === 'number' && Number.isFinite(b));
  const minBeat = beats.length > 0 ? Math.min(...beats) : 0;
  const maxBeat = beats.length > 0 ? Math.max(...beats) : 1;
  const beatRange = maxBeat - minBeat || 1;

  // measureRange.left/right are already in display-image pixel coordinates
  // (pre-scaled if .omr dims differed from actual image)
  const mLeft = measureRange.left;
  const mRight = measureRange.right;
  const mWidth = mRight - mLeft;
  const margin = mWidth * 0.1; // Small margin within measure

  for (const note of notesInMeasure) {
    if (typeof note.beatOffset === 'number' && Number.isFinite(note.beatOffset)) {
      const fraction = (note.beatOffset - minBeat) / beatRange;
      note.x = mLeft + margin + fraction * (mWidth - 2 * margin);
    } else {
      note.x = mLeft + margin;
    }
  }
}

export const AudiverisService = new AudiverisServiceClass();
