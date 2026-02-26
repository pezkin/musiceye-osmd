/**
 * HOMR (Homer's Optical Music Recognition) Server Integration Service
 *
 * Replaces the on-device MusicSheetProcessor with server-side OMR.
 * Sends sheet music images to a HOMR server and receives MusicXML back.
 *
 * HOMR API:  POST /process  (multipart/form-data with file field)
 *            Returns: MusicXML file
 */
import * as FileSystem from 'expo-file-system';
import { MusicXMLParser } from './MusicXMLParser';

// Default HOMR server URL — user can change in settings
const DEFAULT_SERVER_URL = 'http://localhost:8080';

class HOMRServiceClass {
  _serverUrl = DEFAULT_SERVER_URL;
  _timeout = 120000; // 2 minutes — OMR can be slow on large scores

  /**
   * Set the HOMR server URL.
   * @param {string} url - e.g. 'http://192.168.1.100:8080' or 'https://homr.example.com'
   */
  setServerUrl(url) {
    // Remove trailing slash
    this._serverUrl = url.replace(/\/+$/, '');
    console.log(`🌐 HOMR server set to: ${this._serverUrl}`);
  }

  getServerUrl() {
    return this._serverUrl;
  }

  /**
   * Set the request timeout in milliseconds.
   * @param {number} ms
   */
  setTimeout(ms) {
    this._timeout = ms;
  }

  /**
   * Check if the HOMR server is reachable.
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async checkHealth() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${this._serverUrl}/docs`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeout);

      return {
        ok: response.ok || response.status === 200,
        message: response.ok ? 'Server is reachable' : `Server responded with ${response.status}`,
      };
    } catch (e) {
      return {
        ok: false,
        message: e.name === 'AbortError'
          ? 'Server timed out (10s)'
          : `Cannot reach server: ${e.message}`,
      };
    }
  }

  /**
   * Send an image to the HOMR server for OMR processing.
   *
   * @param {string} imageUri - local file URI (from camera or gallery)
   * @param {function} [onProgress] - optional callback: (stage: string) => void
   * @returns {Promise<{musicXml: string, notes: Array, metadata: Object}>}
   */
  async processImage(imageUri, onProgress) {
    const report = (msg) => {
      console.log(`🎼 HOMR: ${msg}`);
      if (onProgress) onProgress(msg);
    };

    report('Preparing image for upload...');

    // Read the image file info
    const fileInfo = await FileSystem.getInfoAsync(imageUri);
    if (!fileInfo.exists) {
      throw new Error('Image file not found: ' + imageUri);
    }

    report('Uploading to HOMR server...');

    // Determine filename and mime type
    const fileName = imageUri.split('/').pop() || 'sheet_music.jpg';
    const ext = fileName.split('.').pop().toLowerCase();
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

    // Upload using FileSystem.uploadAsync for reliable multipart upload
    let uploadResult;
    try {
      uploadResult = await FileSystem.uploadAsync(
        `${this._serverUrl}/process`,
        imageUri,
        {
          httpMethod: 'POST',
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: 'file',
          mimeType: mimeType,
          parameters: {},
          headers: {
            'Accept': 'application/xml, text/xml, */*',
          },
        }
      );
    } catch (e) {
      throw new Error(
        `Failed to connect to HOMR server at ${this._serverUrl}: ${e.message}\n\n` +
        'Make sure the HOMR server is running and accessible from this device.'
      );
    }

    if (uploadResult.status !== 200) {
      throw new Error(
        `HOMR server returned status ${uploadResult.status}.\n` +
        `Response: ${(uploadResult.body || '').substring(0, 500)}`
      );
    }

    report('Parsing MusicXML response...');

    const musicXml = uploadResult.body;
    if (!musicXml || musicXml.length < 50) {
      throw new Error('HOMR server returned an empty or invalid response');
    }

    // Parse MusicXML into the note format expected by PlaybackScreen
    report('Converting to playback format...');
    const parsed = MusicXMLParser.parse(musicXml);

    report('Processing complete!');

    return {
      musicXml,
      notes: parsed.notes,
      metadata: parsed.metadata,
    };
  }

  /**
   * Process an image and return a scoreData object compatible with PlaybackScreen.
   * This is the main entry point that matches the old MusicSheetProcessor.processSheet API.
   *
   * @param {string} imageUri
   * @param {function} [onProgress]
   * @returns {Promise<Object>} scoreData compatible with PlaybackScreen
   */
  async processSheet(imageUri, onProgress) {
    const { notes, metadata } = await this.processImage(imageUri, onProgress);

    // Get image dimensions for cursor positioning
    let imageWidth = 1400;
    let imageHeight = 1000;
    try {
      const { Image } = require('react-native');
      await new Promise((resolve) => {
        Image.getSize(
          imageUri,
          (w, h) => {
            imageWidth = w;
            imageHeight = h;
            resolve();
          },
          () => resolve()
        );
      });
    } catch (e) {
      console.warn('Could not get image dimensions:', e.message);
    }

    // Assign synthetic x/y positions for cursor tracking.
    // Since HOMR returns MusicXML (no pixel coords), we distribute
    // notes evenly across the image width per staff system.
    const systemCount = metadata.systems || 1;
    const systemHeight = imageHeight / systemCount;
    const MARGIN_X = imageWidth * 0.08;
    const usableWidth = imageWidth - 2 * MARGIN_X;

    // Group notes by system
    const notesBySystem = {};
    for (const note of notes) {
      const sys = note.systemIndex || 0;
      if (!notesBySystem[sys]) notesBySystem[sys] = [];
      notesBySystem[sys].push(note);
    }

    // Assign x/y positions
    for (const [sysIdx, sysNotes] of Object.entries(notesBySystem)) {
      const idx = parseInt(sysIdx);
      const noteCount = sysNotes.length;
      const systemTop = idx * systemHeight;
      const systemMid = systemTop + systemHeight / 2;

      for (let i = 0; i < noteCount; i++) {
        const note = sysNotes[i];
        note.x = MARGIN_X + (i / Math.max(1, noteCount - 1)) * usableWidth;
        // Treble staff notes above center, bass below
        const staffOffset = note.staffIndex % 2 === 0 ? -systemHeight * 0.15 : systemHeight * 0.15;
        note.y = systemMid + staffOffset;
      }
    }

    // Build staff groups and system bounds for PlaybackVisualization
    const staffGroups = [];
    const systemBounds = [];
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
        // Generate 5 staff lines per staff
        const staffTop = top + offset * (bottom - top) * 0.6;
        const spacing = (bottom - top) * 0.08;
        staffGroups.push(Array.from({ length: 5 }, (_, i) => staffTop + i * spacing));
      }
    }

    // Merge notes + rests and sort
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
        source: 'HOMR',
        title: metadata.title || '',
      },
    };
  }
}

export const HOMRService = new HOMRServiceClass();
