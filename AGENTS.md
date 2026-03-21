# Music Eye — Agent Handoff Document

> Last updated: March 21, 2026
> Purpose: Complete project context for any new agent/codespace picking up this work.

---

## 1. What Is This Project?

**Music Eye** is a React Native (Expo SDK 54) sheet music scanner app. The user takes a photo of sheet music, the app runs Optical Music Recognition (OMR) to detect notes, and plays them back with SoundFont audio.

The app has **two OMR engines**:
- **On-Device Engine** (default) — Pure JavaScript, Zemsky-inspired rule-based OMR. No server needed. Runs entirely on the phone.
- **Zemsky Emulator** — Uses the native Zemsky .so library via Android emulator harness. Requires the ZemskyHarness app running in the same emulator.

The user's goal is to **commercialize this app** and compete with David Zemsky's "Sheet Music Scanner" and PlayScore.

---

## 2. Repository Layout

```
/workspaces/music-eye-from-quantum/
├── README.md                         # ⚠️ OUTDATED — still references HOMR (old engine)
├── AGENTS.md                         # THIS FILE — project context for agents
├── ASSETS/
│   ├── SheetMusicScanner.sf2         # SoundFont for playback
│   └── zemsky-reverse-engineering.md # Full reverse-engineering of Zemsky's libsource-lib.so
│
└── NoteScan/                         # React Native app (Expo SDK 54)
    ├── App.js                        # Entry point — screen navigation + OMRSettings.load()
    ├── package.json                  # Expo 54, RN 0.81.5, expo-file-system 19
    ├── assets/
    │   └── SheetMusicScanner.sf2     # Copied SoundFont
    └── src/
        ├── screens/
        │   ├── HomeScreen.js         # Main menu, engine status indicator, tap to toggle engine
        │   ├── PlaybackScreen.js     # Score viewer + audio playback + transport controls
        │   └── SettingsScreen.js     # Engine picker (On-Device / Zemsky Emulator) + cache management
        ├── services/
        │   ├── OMRSettings.js        # Engine switcher — persists choice via AsyncStorage
        │   ├── OnDeviceOMRService.js # On-device engine wrapper (PNG+JPEG decode, processSheet)
        │   ├── ZemskyEmulatorService.js # Emulator harness (HTTP bridge to native .so)
        │   ├── MusicXMLParser.js     # Parses MusicXML string → note objects for playback
        │   ├── AudioPlaybackService.js # WAV synthesis using SoundFont samples
        │   ├── SoundFontService.js   # SF2 file parser
        │   ├── OMRCacheService.js    # Caches OMR results to avoid re-processing
        │   └── omr/                  # ★ ON-DEVICE OMR ENGINE (Zemsky-inspired)
        │       ├── index.js          # Module re-exports
        │       ├── OnDeviceOMR.js    # Main orchestrator — full pipeline
        │       ├── ImageUtils.js     # Binary image ops (binarize, RLE, CC, morphology)
        │       ├── StaffDetector.js  # Staff line detection via column-sliced projection
        │       ├── StaffRemover.js   # Staff erasure preserving intersecting symbols
        │       ├── SymbolDetector.js # CC classification → noteheads, stems, beams, rests
        │       ├── DurationAssigner.js # Beam count → duration, staff position → MIDI pitch
        │       └── MusicXMLExporter.js # Generate MusicXML 4.0 from detected notes
        └── components/
            ├── PlaybackVisualization.js # Score image + orange cursor overlay
            └── ScoreInfoPanel.js        # Score metadata display

```

---

## 3. On-Device OMR Engine (the core new work)

### Architecture

Inspired by David Zemsky's `libsource-lib.so` (reverse-engineered in `ASSETS/zemsky-reverse-engineering.md`). Pure JavaScript — no TensorFlow, no native modules, no server.

### Pipeline (OnDeviceOMR.processGrayImage)

```
Input: grayscale pixel array (Uint8Array) + width + height
  │
  ├─ 1. Sauvola adaptive binarization (window=15, k=0.2)
  ├─ 2. Staff detection — column-sliced horizontal projection → 5-line groups
  ├─ 3. Staff removal — scan-based erasure, preserves intersections
  ├─ 4. Connected component analysis on staff-removed image
  ├─ 5. Symbol classification by shape/size ratios:
  │     • Noteheads (filled/hollow/whole by fill ratio)
  │     • Stems (tall thin verticals)
  │     • Beams (wide short horizontals)
  │     • Rests (quarter/eighth/sixteenth by contour)
  │     • Dots (tiny circles near noteheads)
  │     • Accidentals (sharp/flat/natural by shape)
  │     • Barlines (full-height verticals)
  ├─ 6. Association: stem↔head, beam↔stem, dot↔note, accidental↔note
  ├─ 7. Duration: beam count → note duration (0=quarter, 1=eighth, 2=16th...)
  ├─ 8. Pitch: staff position → MIDI note (with clef + key + accidental)
  ├─ 9. Voice separation: stem up = voice 1, stem down = voice 2
  └─ 10. MusicXML 4.0 export
  │
Output: { musicxml: string, notes: Array, metadata: Object }
```

### Module Details

| Module | Key Functions | Purpose |
|--------|--------------|---------|
| `ImageUtils.js` | `sauvolaBinarize`, `connectedComponents`, `horizontalProjection`, `horizontalRLE`, `verticalRLE`, `correlationScore`, `scaleImage` | Low-level image operations on `{data: Uint8Array, width, height}` |
| `StaffDetector.js` | `detectStaffs(bin)` → `Staff[]` | Finds staff lines, groups into 5-line staves, computes interline/lineHeight |
| `StaffRemover.js` | `removeStaffLines(bin, staves)` | Erases staff lines, keeps symbols at intersections |
| `SymbolDetector.js` | `detectSymbols(bin, staves)`, `associateStemsWithHeads`, `associateBeamsWithStems`, `associateDotsWithNotes`, `associateAccidentalsWithNotes` | CC → classified symbols → associated groups |
| `DurationAssigner.js` | `assignDurations(notes)`, `staffPositionToPitch(pos, clef, acc, key)`, `refineVoices(notes)` | Musical semantics from geometry |
| `MusicXMLExporter.js` | `exportToMusicXML(notes, metadata)` | MusicXML 4.0 with multi-voice `<backup>`, grand staff |
| `OnDeviceOMR.js` | `processGrayImage(data, w, h, onProgress)`, `processRGBAImage(data, w, h)` | Pipeline orchestrator |

---

## 4. Service Interface (both engines implement this)

```javascript
// Both OnDeviceOMRService and ZemskyEmulatorService implement:
service.checkHealth()      → { ok: boolean, message: string }
service.processImage(uri, onProgress) → { musicXml, notes, metadata, notePositions, processedImageUri }
service.processSheet(uri, onProgress) → { notes, staves, measures, processedImageUri, metadata }
```

`processSheet()` is what `PlaybackScreen` calls. It returns a `scoreData` object with notes that have `x`, `y` pixel positions for cursor tracking.

`OMRSettings.getService()` returns whichever engine is selected. PlaybackScreen uses it like:
```javascript
const service = OMRSettings.getService();
const result = await service.processSheet(imageUri, onProgress);
```

---

## 5. OnDeviceOMRService — Image Loading

The service reads image files using the **new expo-file-system v19 File API** (not the legacy `readAsStringAsync` which throws in SDK 54):

```javascript
import { File } from 'expo-file-system';
const file = new File(imageUri);
const bytes = await file.bytes();  // returns Uint8Array directly
```

It includes built-in decoders for both **PNG** and **JPEG**:
- PNG: Full decoder with zlib/DEFLATE decompression, scanline unfiltering (None/Sub/Up/Average/Paeth), RGB/RGBA/Gray/GrayAlpha support
- JPEG: Baseline DCT decoder with Huffman, IDCT, dequantization, YCbCr→Gray

This was necessary because camera images are JPEG but there's no Canvas API in React Native.

---

## 6. Key Dependencies (NoteScan/package.json)

| Package | Version | Purpose |
|---------|---------|---------|
| expo | ~54.0.0 | Framework |
| react-native | 0.81.5 | UI |
| expo-file-system | ~19.0.21 | File I/O (new File API, NOT legacy readAsStringAsync) |
| expo-image-picker | ~17.0.10 | Camera/gallery |
| expo-av | ~16.0.8 | Audio playback |
| react-native-audio-api | ^0.11.6 | Web Audio API polyfill |
| react-native-svg | 15.12.1 | SVG rendering |
| @react-native-async-storage/async-storage | ^2.2.0 | Settings persistence |
| @react-native-community/slider | 5.0.1 | Tempo slider |

---

## 7. Data Flow

```
User taps "Scan from Camera/Photos"
  → App.js: pickImageFromGallery/Camera → setPlaybackImageUri → navigate to PlaybackScreen
    → PlaybackScreen: processScore()
      → OMRSettings.getService() → OnDeviceOMRService or AudiverisService
      → service.processSheet(imageUri, onProgress)
        → [On-Device path]:
            File(imageUri).bytes() → PNG/JPEG decode → grayscale
            → OnDeviceOMR.processGrayImage() → full pipeline → {musicxml, notes, metadata}
            → Build synthetic x/y positions from beatOffset
            → Return scoreData
        → [Audiveris path]:
            Upload image via FormData to server
            → Server preprocesses + runs Audiveris → MusicXML + .omr positions
            → Parse response, match note positions
            → Return scoreData
      → setScoreData(result)
      → AudioPlaybackService renders notes to WAV
      → PlaybackVisualization shows score image + cursor
```

---

## 8. Current Status & Known Issues

### What Works
- [x] Dual engine architecture (on-device + Audiveris)
- [x] Engine switching in HomeScreen (tap status) and SettingsScreen (radio cards)
- [x] Engine preference persisted via AsyncStorage
- [x] On-device OMR pipeline: all 7 modules built
- [x] PNG + JPEG image decoding (no native deps)
- [x] MusicXML 4.0 export
- [x] PlaybackScreen calls `service.processSheet()` via OMRSettings
- [x] Audiveris server with improved preprocessing

### Not Yet Tested / Known Gaps
- [ ] **On-device engine has NOT been tested on real sheet music images yet** — the pipeline is architecturally complete but may have bugs in staff detection, symbol classification, or pitch assignment when processing actual photos
- [ ] The pure-JS JPEG decoder may be slow on large images — may need optimization or a native module for production
- [ ] The pure-JS DEFLATE decompressor may have edge cases with certain PNG compression
- [ ] No test suite exists for the OMR modules
- [ ] `README.md` is outdated (still references HOMR, the old engine before Audiveris)
- [ ] Help screen text still mentions "OMR server" — should mention on-device option
- [ ] "Upload from Files" and "Browse Scanned Music" screens are placeholder stubs
- [ ] `expo start --tunnel` had exit code 1 (never debugged — may be an ngrok issue)

### What Needs Work Next
1. **Test the on-device engine** on real sheet music images and fix detection issues
2. **Optimize performance** — the JS image decoders and OMR pipeline may be slow on phone
3. **Update README.md** to reflect current architecture
4. **Add error handling** in the OMR pipeline (graceful failures for bad images)
5. **Build the Library screen** to save/browse previously scanned scores
6. **Polish the UI** for commercial release

---

## 9. Gap Analysis: Our Engine vs Zemsky's Sheet Music Scanner (~50% parity)

### What We Match Zemsky On
| Pipeline Stage | Zemsky (C++) | Our Engine (JS) | Status |
|---------------|-------------|-----------------|--------|
| Sauvola adaptive binarization | `pixSauvolaBinarize` | `sauvolaBinarize()` in ImageUtils.js | ✅ Implemented (window size needs tuning) |
| Staff detection | Column-sliced horizontal projection → 5-line groups | `detectStaffs()` in StaffDetector.js | ✅ Matches approach |
| Staff removal | Scan-based erasure, preserves intersections | `removeStaffLines()` in StaffRemover.js | ✅ Matches approach |
| Connected component analysis | `pixConnComp` → classify by shape | `connectedComponents()` + `detectSymbols()` | ✅ Matches approach |
| Notehead classification | Filled/hollow/whole by fill ratio + correlation | `_classifyHeadType()` in SymbolDetector.js | ⚠️ Heuristic only, no template confirmation |
| Stem/beam/dot detection | Shape-based size ratios | SymbolDetector.js classification | ✅ Matches approach |
| Stem↔head, beam↔stem association | Geometric proximity rules | `associateStemsWithHeads()`, etc. | ✅ Matches approach |
| Beam count → duration | 0=quarter, 1=eighth, 2=16th, 3=32nd | `assignDurations()` in DurationAssigner.js | ✅ Matches |
| Staff position → MIDI pitch | Line/space mapping with clef offset | `staffPositionToPitch()` | ✅ Matches (but clef is hardcoded) |
| Voice separation | Stem up = voice 1, stem down = voice 2 | `refineVoices()` | ✅ Matches |
| MusicXML export | Multi-voice with `<backup>`, grand staff | `exportToMusicXML()` | ✅ Matches |

### Critical Gaps vs Zemsky
| Feature | Zemsky Does | We Do | Impact | Effort to Fix |
|---------|------------|-------|--------|---------------|
| **Clef detection** | Template-matches treble, bass, alto, tenor clefs | Hardcoded alternating treble/bass | **All pitches wrong if clef differs** | Medium — need template matching or CC shape analysis near staff start |
| **Key signature detection** | Counts sharps/flats near clef, determines key | Hardcoded C major | **Wrong accidentals on every note** | Medium — detect small CCs between clef and first note |
| **Time signature detection** | Template-matches stacked numbers (4/4, 3/4, 6/8) | Hardcoded 4/4 | **Measure grouping breaks on non-4/4 music** | Medium — template match or OCR two digits |
| **Perspective correction** | Quad-corner dewarp for tilted photos | None | **Skewed phone photos fail** | Hard — need contour detection + homography transform |
| **Image deskew** | Staff angle → affine rotation | None (StaffDetector computes angle but doesn't use it) | **Slightly rotated images misdetect** | Easy — rotate image by detected staff angle before processing |
| **Ties & slurs** | Curve fitting on arcs between notes | Not implemented | **Tied notes play twice instead of sustaining** | Hard — arc detection + note linkage |
| **Tuplets** | Bracket + "3" text detection | Not implemented | **Triplets play wrong rhythm** | Medium — detect brackets + adjust durations |
| **Repeat signs** | Dot pairs + thick barlines + volta brackets | Not implemented | **Repeats ignored, plays once** | Medium — detect double barlines + dot pairs |
| **Dynamics (p, f, mf)** | Text template matching | Not implemented | No expression in playback | Low priority |
| **Articulations** | Staccato dots, accents, fermatas | Not implemented | Subtle playback differences | Low priority |

### Known Bugs to Fix
| Bug | Location | Fix |
|-----|----------|-----|
| Sauvola window ~75px, should be ~15px | `ImageUtils.js` — `sauvolaBinarize()` windowRatio | Change `windowRatio` from ~40 → 15 |
| Double-dot only applies 1.5× instead of 1.75× | `DurationAssigner.js` line ~96-101 | Use `durationBeats *= 1.5 ** dotCount` |
| Rest classification by size only, not shape | `SymbolDetector.js` — `_classifyRest()` | Add RLE contour analysis per Zemsky |
| No template matching confirmation | `SymbolDetector.js` — noteheads | Add `correlationScore()` check (function exists in ImageUtils but unused) |

### Priority Roadmap to Close Gap
1. **Fix bugs** (Sauvola window, double-dot) — quick wins, 30 minutes
2. **Add deskew** — use already-computed staff angle to rotate image — 1 session
3. **Clef detection** — template match treble/bass/alto near staff start — 1-2 sessions
4. **Key signature detection** — count sharp/flat CCs near clef — 1 session
5. **Time signature detection** — template match or digit OCR — 1 session
6. **Template matching refinement** — use existing `correlationScore()` to confirm noteheads — 1 session
7. **Perspective correction** — contour-based quad detection — 2-3 sessions
8. **Ties/slurs** — arc detection + note linkage — 2-3 sessions
9. **Repeats** — double barline + dot pair detection — 1-2 sessions
10. **Tuplets** — bracket detection + duration adjustment — 1-2 sessions

**Estimated total to reach ~90% Zemsky parity: 12-15 more sessions.**

---

## 10. Reference: Zemsky Reverse Engineering

`ASSETS/zemsky-reverse-engineering.md` contains a complete analysis of David Zemsky's `libsource-lib.so` (3.3MB arm64 binary from Sheet Music Scanner app). This was the blueprint for our on-device engine. Key sections:

- **Preprocessing**: Sauvola binarization, morphological cleanup
- **Staff Detection**: Column-sliced horizontal projection, 5-line grouping
- **Staff Removal**: Scan-based with intersection preservation
- **Symbol Recognition**: Connected components + shape classification (not ML)
- **Duration Assignment**: Beam counting, stem analysis
- **Voice Separation**: Stem direction → voice index
- **MusicXML Export**: Part grouping, multi-voice with `<backup>`

Our implementation follows this pipeline closely but is written in JavaScript instead of C++.

---

## 11. File-by-File Quick Reference

| File | Lines (approx) | What It Does |
|------|----------------|-------------|
| `App.js` | 120 | Screen router, image picker, OMRSettings.load() |
| `HomeScreen.js` | 220 | Main menu, engine status dot, tap-to-toggle engine |
| `PlaybackScreen.js` | 600+ | Score viewer, audio playback, transport, tempo slider |
| `SettingsScreen.js` | 600+ | Engine radio cards, Audiveris URL config, preview preprocessing |
| `OMRSettings.js` | 60 | Engine switcher singleton, AsyncStorage persistence |
| `OnDeviceOMRService.js` | 650+ | Service wrapper: File.bytes(), PNG/JPEG decode, processSheet() |
| `MusicXMLParser.js` | ~400 | Parse MusicXML → {notes, metadata} |
| `AudioPlaybackService.js` | ~500 | WAV synthesis from SoundFont samples |
| `SoundFontService.js` | ~300 | SF2 binary parser |
| `OMRCacheService.js` | ~100 | Hash-based OMR result caching |
| `ZemskyEmulatorService.js` | ~400 | Emulator HTTP bridge to native .so |
| `omr/ImageUtils.js` | ~500 | Binarize, RLE, CC, morphology, scale |
| `omr/StaffDetector.js` | ~300 | Staff line detection + grouping |
| `omr/StaffRemover.js` | ~100 | Staff erasure preserving symbols |
| `omr/SymbolDetector.js` | ~500 | CC classification + association |
| `omr/DurationAssigner.js` | ~250 | Duration, pitch, voice assignment |
| `omr/MusicXMLExporter.js` | ~300 | MusicXML 4.0 generation |
| `omr/OnDeviceOMR.js` | ~250 | Pipeline orchestrator |
