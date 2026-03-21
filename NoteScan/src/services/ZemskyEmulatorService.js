/**
 * Zemsky Emulator OMR Service
 *
 * Talks to the separate Android harness app running in the same emulator.
 * The harness exposes:
 *   GET  /docs
 *   POST /process
 * on http://127.0.0.1:8084
 */
import { File } from 'expo-file-system';
import { MusicXMLParser } from './MusicXMLParser';
import { normalizeMusicXmlSoftwareTag } from './MusicXmlBranding';

class ZemskyEmulatorServiceClass {
  _serverUrl = 'http://127.0.0.1:8084';

  _candidateBaseUrls() {
    const base = this.getServerUrl().replace(/\/+$/, '');
    const out = [base];

    const fallbacks = [
      'http://127.0.0.1:8084',
      'http://localhost:8084',
    ];

    for (const f of fallbacks) {
      if (!out.includes(f)) out.push(f);
    }
    return out;
  }

  setServerUrl(url) {
    this._serverUrl = url.replace(/\/+$/, '');
  }

  getServerUrl() {
    return this._serverUrl;
  }

  _getProcessUrl(baseUrl = this.getServerUrl()) {
    return `${baseUrl.replace(/\/+$/, '')}/process`;
  }

  _getDocsUrl(baseUrl = this.getServerUrl()) {
    return `${baseUrl.replace(/\/+$/, '')}/docs`;
  }

  _getRootUrl(baseUrl = this.getServerUrl()) {
    return `${baseUrl.replace(/\/+$/, '')}/`;
  }

  async _fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async checkHealth() {
    const urls = this._candidateBaseUrls();
    let lastErr = null;
    for (const baseUrl of urls) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          // Primary health endpoint
          let response = await this._fetchWithTimeout(this._getDocsUrl(baseUrl), { method: 'GET' }, 7000);
          if (!response.ok) {
            // Fallback to root endpoint if /docs is unavailable
            response = await this._fetchWithTimeout(this._getRootUrl(baseUrl), { method: 'GET' }, 7000);
          }

          if (response.ok) {
            if (baseUrl !== this.getServerUrl()) this.setServerUrl(baseUrl);
            return { ok: true, message: `Zemsky emulator engine is reachable (${baseUrl})` };
          }
          lastErr = new Error(`HTTP ${response.status} on ${baseUrl}`);
        } catch (e) {
          lastErr = e;
        }

        // Small retry delay, useful when harness app just resumed.
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    }
    return {
      ok: false,
      message: `Cannot reach Zemsky emulator engine: ${lastErr?.message || 'Unknown error'}`,
    };
  }

  async _postToAvailableEndpoint({ imageUri, fileName, mimeType }) {
    const urls = this._candidateBaseUrls();
    let lastErr = null;

    for (const baseUrl of urls) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          // Rebuild multipart body for each attempt; some RN transports do not like reused FormData.
          const formData = new FormData();
          formData.append('file', {
            uri: imageUri,
            name: fileName,
            type: mimeType,
          });

          const response = await this._fetchWithTimeout(
            this._getProcessUrl(baseUrl),
            {
              method: 'POST',
              body: formData,
              headers: {
                Accept: 'application/json, application/xml, text/xml, */*',
              },
            },
            90000
          );

          if (baseUrl !== this.getServerUrl()) this.setServerUrl(baseUrl);
          return response;
        } catch (e) {
          lastErr = e;
        }

        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      }
    }

    throw lastErr || new Error('No reachable Zemsky endpoint');
  }

  async processImage(imageUri, onProgress) {
    const report = (msg) => {
      console.log(`🎼 Zemsky: ${msg}`);
      if (onProgress) onProgress(msg);
    };

    report('Preparing image for emulator upload...');

    const file = new File(imageUri);
    if (!file.exists) {
      throw new Error('Image file not found: ' + imageUri);
    }

    const fileName = imageUri.split('/').pop() || 'sheet_music.jpg';
    const ext = fileName.split('.').pop().toLowerCase();
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

    report('Sending image to Zemsky emulator engine...');

    let response;
    try {
      response = await this._postToAvailableEndpoint({
        imageUri,
        fileName,
        mimeType,
      });
    } catch (e) {
      throw new Error(
        `Failed to connect to Zemsky emulator engine: ${e.message}\n\n` +
        'Make sure the Zemsky Harness app is open on the same Android phone (or emulator) as NoteScan.'
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Zemsky emulator returned status ${response.status}. ${body.substring(0, 500)}`);
    }

    report('Parsing MusicXML...');
    const json = await response.json();
    
    const musicXml = normalizeMusicXmlSoftwareTag(json.musicxml);
    if (!musicXml || musicXml.length < 50) {
      throw new Error('Zemsky emulator returned an empty or invalid MusicXML payload');
    }

    const parsed = MusicXMLParser.parse(musicXml, { strictMusicXml: true });
    
    report('Processing complete!');

    return {
      musicXml,
      notes: parsed.notes,
      metadata: {
        ...parsed.metadata,
        source: 'zemsky-emulator',
      },
      notePositions: null,
      processedImageUri: null,
    };
  }

  async processSheet(imageUri, onProgress) {
    return this.processImage(imageUri, onProgress);
  }
}

export const ZemskyEmulatorService = new ZemskyEmulatorServiceClass();
