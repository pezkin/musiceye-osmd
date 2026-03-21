/**
 * OnDeviceOMRService — Service wrapper for the on-device OMR engine.
 *
 * Matches the AudiverisService interface so it's a drop-in replacement.
 * No server needed — all processing happens on the phone.
 */
import { File } from 'expo-file-system';
import { OnDeviceOMR } from './omr/OnDeviceOMR';
import { scaleImage } from './omr/ImageUtils';
import { MusicXMLParser } from './MusicXMLParser';

class OnDeviceOMRServiceClass {
  /**
   * Health check — on-device engine is always available.
   */
  async checkHealth() {
    return {
      ok: true,
      message: 'On-device OMR engine ready (no server needed)',
    };
  }

  /**
   * Process an image using the on-device OMR engine.
   * @param {string} imageUri - local file URI
   * @param {Function} onProgress - progress callback
   */
  async processImage(imageUri, onProgress) {
    const report = (msg) => {
      console.log(`🎵 OnDevice: ${msg}`);
      if (onProgress) onProgress(msg);
    };

    report('Loading image...');

    // Read the raw bytes using the new expo-file-system File API
    const file = new File(imageUri);
    const bytes = await file.bytes();

    report('Decoding image pixels...');

    // Detect format and decode to grayscale
    let grayData, width, height;
    if (_isPNG(bytes)) {
      ({ grayData, width, height } = _decodePNGToGray(bytes));
    } else if (_isJPEG(bytes)) {
      ({ grayData, width, height } = _decodeJPEGToGray(bytes));
    } else {
      throw new Error('Unsupported image format. Please use PNG or JPEG.');
    }

    // Resize to a reasonable processing width if too large
    const MAX_WIDTH = 2400;
    if (width > MAX_WIDTH) {
      const scale = MAX_WIDTH / width;
      const newW = MAX_WIDTH;
      const newH = Math.round(height * scale);
      const scaled = scaleImage({ data: grayData, width, height }, newW, newH);
      grayData = scaled.data;
      width = scaled.width;
      height = scaled.height;
    }

    report(`Image: ${width}×${height}`);

    // Run the OMR pipeline
    const result = await OnDeviceOMR.processGrayImage(grayData, width, height, onProgress);

    report('Parsing MusicXML...');

    // Parse through our standard MusicXMLParser for consistent output
    let parsedNotes = result.notes;
    let metadata = result.metadata;

    try {
      const parsed = MusicXMLParser.parse(result.musicxml, { strictMusicXml: true });
      if (parsed.notes.length > 0) {
        parsedNotes = parsed.notes;
        metadata = { ...metadata, ...parsed.metadata };
      }
    } catch (e) {
      console.warn('MusicXMLParser failed, using direct notes:', e.message);
    }

    report(`Done — ${parsedNotes.length} notes detected`);

    return {
      musicXml: result.musicxml,
      notes: parsedNotes,
      metadata: {
        ...metadata,
        engine: 'on-device',
      },
      notePositions: null,
      processedImageUri: null,
    };
  }

  /**
   * Process an image and return a scoreData object compatible with PlaybackScreen.
   * This mirrors AudiverisService.processSheet().
   */
  async processSheet(imageUri, onProgress) {
    const { notes, metadata, musicXml } = await this.processImage(imageUri, onProgress);

    const imageWidth = metadata.imageWidth || 1400;
    const imageHeight = metadata.imageHeight || 1000;
    const systemCount = metadata.systems || 1;
    const systemHeight = imageHeight / systemCount;

    // Build synthetic positions from beatOffset (same as AudiverisService fallback)
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
        const staffOffset = (note.staffIndex || 0) % 2 === 0
          ? -systemHeight * 0.15
          : systemHeight * 0.15;
        note.y = systemMid + staffOffset;
      }
    }

    // Build staff groups and system bounds
    const systemBounds = [];
    const staffGroups = [];
    const stavesPerSystem = metadata.stavesPerSystem || 2;

    for (let s = 0; s < systemCount; s++) {
      const top = s * systemHeight + systemHeight * 0.1;
      const bottom = (s + 1) * systemHeight - systemHeight * 0.1;
      const staffIndices = Array.from({ length: stavesPerSystem }, (_, i) => s * stavesPerSystem + i);

      systemBounds.push({ top, bottom, staffIndices });
      for (const si of staffIndices) {
        const mid = (top + bottom) / 2;
        const offset = (si - staffIndices[0]) / Math.max(1, staffIndices.length - 1);
        const staffTop = top + offset * (bottom - top) * 0.6;
        const spacing = (bottom - top) * 0.08;
        staffGroups.push(Array.from({ length: 5 }, (_, i) => staffTop + i * spacing));
      }
    }

    const allEvents = [...notes].sort((a, b) => {
      const sa = Number.isFinite(a.staffIndex) ? a.staffIndex : 999;
      const sb = Number.isFinite(b.staffIndex) ? b.staffIndex : 999;
      if (sa !== sb) return sa - sb;
      return (a.x || 0) - (b.x || 0);
    });

    const totalNotes = notes.filter(n => n.type !== 'rest').length;
    const totalRests = notes.filter(n => n.type === 'rest').length;

    return {
      musicXml: musicXml || '',
      notes: allEvents,
      staves: metadata.staves || 2,
      measures: [],
      processedImageUri: null,
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
        source: 'OnDevice',
        title: metadata.title || '',
        hasRealPositions: false,
      },
    };
  }
}

/**
 * Minimal PNG decoder — extracts grayscale pixel data.
 * Handles uncompressed/deflated RGB/RGBA/Grayscale PNGs.
 */
function _decodePNGToGray(pngBytes) {
  // Validate PNG signature
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (pngBytes[i] !== sig[i]) throw new Error('Not a valid PNG file');
  }

  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const dataChunks = [];
  let pos = 8;

  while (pos < pngBytes.length) {
    const chunkLen = _readUint32BE(pngBytes, pos);
    const chunkType = String.fromCharCode(
      pngBytes[pos + 4], pngBytes[pos + 5], pngBytes[pos + 6], pngBytes[pos + 7]
    );

    if (chunkType === 'IHDR') {
      width = _readUint32BE(pngBytes, pos + 8);
      height = _readUint32BE(pngBytes, pos + 12);
      bitDepth = pngBytes[pos + 16];
      colorType = pngBytes[pos + 17];
    } else if (chunkType === 'IDAT') {
      dataChunks.push(pngBytes.slice(pos + 8, pos + 8 + chunkLen));
    } else if (chunkType === 'IEND') {
      break;
    }

    pos += 12 + chunkLen; // 4(len) + 4(type) + data + 4(crc)
  }

  if (width === 0 || height === 0) {
    throw new Error('Failed to parse PNG header');
  }

  // Concatenate IDAT chunks
  let totalLen = 0;
  for (const chunk of dataChunks) totalLen += chunk.length;
  const compressed = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of dataChunks) {
    compressed.set(chunk, offset);
    offset += chunk.length;
  }

  // Decompress using pako-like inflate (we need to use a simple zlib decompress)
  // In React Native we can use the built-in zlib or a JS implementation
  let raw;
  try {
    raw = _inflate(compressed);
  } catch (e) {
    throw new Error('Failed to decompress PNG data: ' + e.message);
  }

  // Bytes per pixel depends on color type
  let bpp;
  switch (colorType) {
    case 0: bpp = 1; break; // Grayscale
    case 2: bpp = 3; break; // RGB
    case 4: bpp = 2; break; // Grayscale + Alpha
    case 6: bpp = 4; break; // RGBA
    default: throw new Error(`Unsupported PNG color type: ${colorType}`);
  }

  // Unfilter scanlines
  const stride = width * bpp + 1; // +1 for filter byte
  const pixels = new Uint8Array(width * height * bpp);

  for (let y = 0; y < height; y++) {
    const filterType = raw[y * stride];
    const scanline = raw.subarray(y * stride + 1, y * stride + 1 + width * bpp);
    const prevLine = y > 0 ? pixels.subarray((y - 1) * width * bpp, y * width * bpp) : null;
    const destOffset = y * width * bpp;

    for (let x = 0; x < width * bpp; x++) {
      let val = scanline[x];
      const a = x >= bpp ? pixels[destOffset + x - bpp] : 0;
      const b = prevLine ? prevLine[x] : 0;
      const c = (x >= bpp && prevLine) ? prevLine[x - bpp] : 0;

      switch (filterType) {
        case 0: break; // None
        case 1: val = (val + a) & 0xFF; break; // Sub
        case 2: val = (val + b) & 0xFF; break; // Up
        case 3: val = (val + Math.floor((a + b) / 2)) & 0xFF; break; // Average
        case 4: val = (val + _paethPredictor(a, b, c)) & 0xFF; break; // Paeth
      }
      pixels[destOffset + x] = val;
    }
  }

  // Convert to grayscale
  const grayData = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    switch (colorType) {
      case 0: // Already grayscale
        grayData[i] = pixels[i];
        break;
      case 2: // RGB
        grayData[i] = Math.round(
          0.299 * pixels[i * 3] + 0.587 * pixels[i * 3 + 1] + 0.114 * pixels[i * 3 + 2]
        );
        break;
      case 4: // Grayscale + Alpha
        grayData[i] = pixels[i * 2];
        break;
      case 6: // RGBA
        grayData[i] = Math.round(
          0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2]
        );
        break;
    }
  }

  return { grayData, width, height };
}

function _isPNG(bytes) {
  return bytes.length > 8 &&
    bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
}

function _isJPEG(bytes) {
  return bytes.length > 2 && bytes[0] === 0xFF && bytes[1] === 0xD8;
}

/**
 * Baseline JPEG decoder — extracts grayscale pixel data.
 * Supports baseline (SOF0) and progressive (SOF2) markers for dimension reading,
 * with full Huffman + IDCT decoding for baseline JPEGs.
 */
function _decodeJPEGToGray(data) {
  let pos = 0;
  let width = 0, height = 0, numComponents = 0;
  const components = [];
  const huffDC = {};
  const huffAC = {};
  const quantTables = {};

  function readU16() {
    const v = (data[pos] << 8) | data[pos + 1];
    pos += 2;
    return v;
  }

  // Skip SOI
  if (data[0] !== 0xFF || data[1] !== 0xD8) throw new Error('Not a valid JPEG');
  pos = 2;

  while (pos < data.length) {
    if (data[pos] !== 0xFF) { pos++; continue; }
    while (data[pos] === 0xFF) pos++;
    const marker = data[pos++];

    if (marker === 0xD9) break; // EOI
    if (marker === 0x00 || marker === 0xD0 || (marker >= 0xD1 && marker <= 0xD7)) continue;

    const segLen = readU16();
    const segEnd = pos + segLen - 2;

    if (marker === 0xDB) {
      // DQT — Quantization table
      let p = pos;
      while (p < segEnd) {
        const info = data[p++];
        const tableId = info & 0x0F;
        const is16bit = (info >> 4) & 1;
        const table = new Uint16Array(64);
        for (let i = 0; i < 64; i++) {
          table[i] = is16bit ? ((data[p] << 8) | data[p + 1]) : data[p];
          p += is16bit ? 2 : 1;
        }
        quantTables[tableId] = table;
      }
    } else if (marker === 0xC4) {
      // DHT — Huffman table
      let p = pos;
      while (p < segEnd) {
        const info = data[p++];
        const tableClass = (info >> 4) & 1; // 0=DC, 1=AC
        const tableId = info & 0x0F;
        const counts = new Uint8Array(16);
        let total = 0;
        for (let i = 0; i < 16; i++) { counts[i] = data[p++]; total += counts[i]; }
        const symbols = new Uint8Array(total);
        for (let i = 0; i < total; i++) symbols[i] = data[p++];

        // Build lookup
        const ht = _buildJPEGHuffTable(counts, symbols);
        if (tableClass === 0) huffDC[tableId] = ht;
        else huffAC[tableId] = ht;
      }
    } else if (marker === 0xC0) {
      // SOF0 — Baseline DCT
      const precision = data[pos];
      height = (data[pos + 1] << 8) | data[pos + 2];
      width = (data[pos + 3] << 8) | data[pos + 4];
      numComponents = data[pos + 5];
      let p = pos + 6;
      for (let i = 0; i < numComponents; i++) {
        const id = data[p];
        const sampling = data[p + 1];
        const hSamp = (sampling >> 4) & 0xF;
        const vSamp = sampling & 0xF;
        const qtId = data[p + 2];
        components.push({ id, hSamp, vSamp, qtId, dcPred: 0 });
        p += 3;
      }
    } else if (marker === 0xDA) {
      // SOS — Start of scan
      const numScanComponents = data[pos];
      let p = pos + 1;
      const scanComponents = [];
      for (let i = 0; i < numScanComponents; i++) {
        const compId = data[p];
        const tableSpec = data[p + 1];
        scanComponents.push({
          compId,
          dcTableId: (tableSpec >> 4) & 0xF,
          acTableId: tableSpec & 0xF,
        });
        p += 2;
      }
      // Skip Ss, Se, Ah/Al
      p += 3;

      // Decode the entropy-coded segment
      return _decodeJPEGScan(data, p, width, height, components, scanComponents, huffDC, huffAC, quantTables);
    }

    pos = segEnd;
  }

  throw new Error('JPEG: no image data found');
}

function _buildJPEGHuffTable(counts, symbols) {
  // Build a code→symbol lookup using canonical Huffman
  const maxCode = new Int32Array(17);
  const valPtr = new Int32Array(17);
  const minCode = new Int32Array(17);

  let code = 0;
  let si = 0;
  for (let len = 1; len <= 16; len++) {
    minCode[len] = code;
    valPtr[len] = si;
    for (let i = 0; i < counts[len - 1]; i++) { si++; code++; }
    maxCode[len] = code - 1;
    code <<= 1;
  }

  return { maxCode, minCode, valPtr, symbols };
}

function _decodeJPEGScan(data, startPos, width, height, components, scanComponents, huffDC, huffAC, quantTables) {
  // Extract entropy-coded data (remove byte stuffing)
  const ecData = [];
  let p = startPos;
  while (p < data.length) {
    if (data[p] === 0xFF) {
      if (data[p + 1] === 0x00) {
        ecData.push(0xFF);
        p += 2;
      } else if (data[p + 1] === 0xD9) {
        break; // EOI
      } else if (data[p + 1] >= 0xD0 && data[p + 1] <= 0xD7) {
        p += 2; // RST marker — skip
        // Reset DC predictors
        for (const comp of components) comp.dcPred = 0;
      } else {
        break;
      }
    } else {
      ecData.push(data[p++]);
    }
  }

  const bits = new Uint8Array(ecData);
  let bitPos = 0;
  let bitBuf = 0;
  let bitCount = 0;

  function readBit() {
    if (bitCount === 0) {
      if (bitPos >= bits.length) return 0;
      bitBuf = bits[bitPos++];
      bitCount = 8;
    }
    bitCount--;
    return (bitBuf >> bitCount) & 1;
  }

  function readBits(n) {
    let val = 0;
    for (let i = 0; i < n; i++) val = (val << 1) | readBit();
    return val;
  }

  function decodeHuff(ht) {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | readBit();
      if (code <= ht.maxCode[len]) {
        return ht.symbols[ht.valPtr[len] + code - ht.minCode[len]];
      }
    }
    return 0;
  }

  function receive(n) {
    if (n === 0) return 0;
    const val = readBits(n);
    if (val < (1 << (n - 1))) return val - (1 << n) + 1;
    return val;
  }

  // Zigzag order
  const ZZ = [
    0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,
    35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63
  ];

  // IDCT constants
  const C = new Float64Array(8);
  for (let i = 0; i < 8; i++) C[i] = Math.cos(Math.PI * i / 16);

  function idct8x8(block) {
    const out = new Float64Array(64);
    // Row pass
    const tmp = new Float64Array(64);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        let sum = 0;
        for (let u = 0; u < 8; u++) {
          const cu = u === 0 ? 1 / Math.SQRT2 : 1;
          sum += cu * block[y * 8 + u] * Math.cos((2 * x + 1) * u * Math.PI / 16);
        }
        tmp[y * 8 + x] = sum;
      }
    }
    // Column pass
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        let sum = 0;
        for (let v = 0; v < 8; v++) {
          const cv = v === 0 ? 1 / Math.SQRT2 : 1;
          sum += cv * tmp[v * 8 + x] * Math.cos((2 * y + 1) * v * Math.PI / 16);
        }
        out[y * 8 + x] = sum / 4;
      }
    }
    return out;
  }

  // Determine max sampling factors
  let maxH = 1, maxV = 1;
  for (const comp of components) {
    if (comp.hSamp > maxH) maxH = comp.hSamp;
    if (comp.vSamp > maxV) maxV = comp.vSamp;
  }

  const mcuWidth = maxH * 8;
  const mcuHeight = maxV * 8;
  const mcuCols = Math.ceil(width / mcuWidth);
  const mcuRows = Math.ceil(height / mcuHeight);

  // Allocate per-component buffers
  const compBuffers = components.map(comp => {
    const w = mcuCols * comp.hSamp * 8;
    const h = mcuRows * comp.vSamp * 8;
    return { data: new Float64Array(w * h), w, h };
  });

  // Decode MCUs
  for (let mcuY = 0; mcuY < mcuRows; mcuY++) {
    for (let mcuX = 0; mcuX < mcuCols; mcuX++) {
      for (let ci = 0; ci < scanComponents.length; ci++) {
        const sc = scanComponents[ci];
        const comp = components.find(c => c.id === sc.compId) || components[ci];
        const qt = quantTables[comp.qtId] || quantTables[0];
        const dcHt = huffDC[sc.dcTableId];
        const acHt = huffAC[sc.acTableId];
        const buf = compBuffers[ci];

        for (let v = 0; v < comp.vSamp; v++) {
          for (let h = 0; h < comp.hSamp; h++) {
            // Decode one 8x8 block
            const block = new Float64Array(64);

            // DC coefficient
            const dcLen = decodeHuff(dcHt);
            const dcDiff = receive(dcLen);
            comp.dcPred += dcDiff;
            block[0] = comp.dcPred * (qt ? qt[0] : 1);

            // AC coefficients
            let k = 1;
            while (k < 64) {
              const rs = decodeHuff(acHt);
              const r = (rs >> 4) & 0xF; // run of zeros
              const s = rs & 0xF;        // size of coefficient
              if (s === 0) {
                if (r === 0) break;    // EOB
                if (r === 15) { k += 16; continue; } // ZRL
                break;
              }
              k += r;
              if (k >= 64) break;
              block[ZZ[k]] = receive(s) * (qt ? qt[k] : 1);
              k++;
            }

            // IDCT
            const pixels = idct8x8(block);

            // Write to component buffer
            const bx = (mcuX * comp.hSamp + h) * 8;
            const by = (mcuY * comp.vSamp + v) * 8;
            for (let yy = 0; yy < 8; yy++) {
              for (let xx = 0; xx < 8; xx++) {
                const px = bx + xx;
                const py = by + yy;
                if (px < buf.w && py < buf.h) {
                  buf.data[py * buf.w + px] = pixels[yy * 8 + xx] + 128;
                }
              }
            }
          }
        }
      }
    }
  }

  // Convert to grayscale output
  const grayData = new Uint8Array(width * height);

  if (components.length === 1) {
    // Grayscale JPEG
    const buf = compBuffers[0];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        grayData[y * width + x] = Math.max(0, Math.min(255, Math.round(buf.data[y * buf.w + x])));
      }
    }
  } else {
    // YCbCr → Grayscale (just use Y channel)
    const yBuf = compBuffers[0];
    const yComp = components[0];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Map pixel to Y component buffer (account for subsampling)
        const sy = Math.floor(y * yComp.vSamp / maxV);
        const sx = Math.floor(x * yComp.hSamp / maxH);
        const val = yBuf.data[sy * yBuf.w + sx];
        grayData[y * width + x] = Math.max(0, Math.min(255, Math.round(val)));
      }
    }
  }

  return { grayData, width, height };
}

function _paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function _readUint32BE(buf, pos) {
  return (buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
}

/**
 * Simple zlib/deflate decompressor.
 * Handles the 2-byte zlib header + raw deflate stream.
 */
function _inflate(data) {
  // Skip 2-byte zlib header (CMF + FLG)
  if (data.length < 2) throw new Error('Data too short for zlib');
  const cmf = data[0];
  const flg = data[1];
  if ((cmf * 256 + flg) % 31 !== 0) throw new Error('Invalid zlib header');

  // Use a pure-JS inflate implementation
  return _rawInflate(data, 2);
}

/**
 * Raw DEFLATE decompressor (RFC 1951).
 * Minimal implementation sufficient for PNG IDAT streams.
 */
function _rawInflate(data, startPos) {
  const output = [];
  let pos = startPos;
  let bitBuf = 0;
  let bitCount = 0;

  function readBits(n) {
    while (bitCount < n) {
      if (pos >= data.length) throw new Error('Unexpected end of deflate data');
      bitBuf |= data[pos++] << bitCount;
      bitCount += 8;
    }
    const val = bitBuf & ((1 << n) - 1);
    bitBuf >>= n;
    bitCount -= n;
    return val;
  }

  function readByte() {
    return readBits(8);
  }

  // Fixed Huffman code lengths
  const FIXED_LIT_CODES = new Uint8Array(288);
  for (let i = 0; i <= 143; i++) FIXED_LIT_CODES[i] = 8;
  for (let i = 144; i <= 255; i++) FIXED_LIT_CODES[i] = 9;
  for (let i = 256; i <= 279; i++) FIXED_LIT_CODES[i] = 7;
  for (let i = 280; i <= 287; i++) FIXED_LIT_CODES[i] = 8;

  const FIXED_DIST_CODES = new Uint8Array(32);
  FIXED_DIST_CODES.fill(5);

  function buildHuffmanTable(codeLengths) {
    const maxLen = Math.max(...codeLengths);
    const counts = new Uint16Array(maxLen + 1);
    for (const len of codeLengths) if (len > 0) counts[len]++;

    const offsets = new Uint16Array(maxLen + 1);
    for (let i = 1; i <= maxLen; i++) offsets[i] = offsets[i - 1] + counts[i - 1];

    const table = new Uint16Array(codeLengths.length);
    for (let i = 0; i < codeLengths.length; i++) {
      if (codeLengths[i] > 0) table[offsets[codeLengths[i]]++] = i;
    }

    return { counts, table, maxLen };
  }

  function decodeSymbol(ht) {
    let code = 0;
    let first = 0;
    let idx = 0;
    for (let len = 1; len <= ht.maxLen; len++) {
      code |= readBits(1);
      const count = ht.counts[len];
      if (code - first < count) {
        return ht.table[idx + code - first];
      }
      idx += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('Invalid Huffman code');
  }

  const LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];

  let bfinal = 0;
  while (!bfinal) {
    bfinal = readBits(1);
    const btype = readBits(2);

    if (btype === 0) {
      // Stored (uncompressed)
      bitBuf = 0;
      bitCount = 0;
      const len = data[pos] | (data[pos + 1] << 8);
      pos += 4; // skip len + nlen
      for (let i = 0; i < len; i++) output.push(data[pos++]);
    } else {
      let litHt, distHt;

      if (btype === 1) {
        // Fixed Huffman
        litHt = buildHuffmanTable(FIXED_LIT_CODES);
        distHt = buildHuffmanTable(FIXED_DIST_CODES);
      } else if (btype === 2) {
        // Dynamic Huffman
        const hlit = readBits(5) + 257;
        const hdist = readBits(5) + 1;
        const hclen = readBits(4) + 4;

        const codeLenOrder = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
        const codeLenLengths = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) {
          codeLenLengths[codeLenOrder[i]] = readBits(3);
        }

        const codeLenHt = buildHuffmanTable(codeLenLengths);
        const allLengths = new Uint8Array(hlit + hdist);
        let ai = 0;

        while (ai < hlit + hdist) {
          const sym = decodeSymbol(codeLenHt);
          if (sym < 16) {
            allLengths[ai++] = sym;
          } else if (sym === 16) {
            const rep = readBits(2) + 3;
            const val = ai > 0 ? allLengths[ai - 1] : 0;
            for (let j = 0; j < rep; j++) allLengths[ai++] = val;
          } else if (sym === 17) {
            const rep = readBits(3) + 3;
            for (let j = 0; j < rep; j++) allLengths[ai++] = 0;
          } else if (sym === 18) {
            const rep = readBits(7) + 11;
            for (let j = 0; j < rep; j++) allLengths[ai++] = 0;
          }
        }

        litHt = buildHuffmanTable(allLengths.subarray(0, hlit));
        distHt = buildHuffmanTable(allLengths.subarray(hlit));
      } else {
        throw new Error(`Invalid block type: ${btype}`);
      }

      // Decode literals/lengths
      while (true) {
        const sym = decodeSymbol(litHt);
        if (sym === 256) break; // end of block
        if (sym < 256) {
          output.push(sym);
        } else {
          // Length/distance pair
          const lenIdx = sym - 257;
          const length = LEN_BASE[lenIdx] + readBits(LEN_EXTRA[lenIdx]);
          const distSym = decodeSymbol(distHt);
          const distance = DIST_BASE[distSym] + readBits(DIST_EXTRA[distSym]);

          for (let i = 0; i < length; i++) {
            output.push(output[output.length - distance]);
          }
        }
      }
    }
  }

  return new Uint8Array(output);
}

export const OnDeviceOMRService = new OnDeviceOMRServiceClass();
