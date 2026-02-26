# Music Eye — Quantum Version

Sheet music scanner app powered by [HOMR](https://github.com/liebharc/homr) server-side Optical Music Recognition.

## Architecture

```
 ┌──────────────────────┐         ┌───────────────────────┐
 │   Music Eye App      │         │   HOMR Server         │
 │   (React Native)     │         │   (Python/Docker)     │
 │                      │  POST   │                       │
 │  Camera/Gallery ─────┼────────▶│  Image → OMR Pipeline │
 │                      │ image   │  → MusicXML           │
 │  MusicXML Parser  ◀──┼────────│                       │
 │  ↓                   │ xml     └───────────────────────┘
 │  AudioPlaybackService│
 │  ↓                   │
 │  SoundFont Player    │
 │  ↓                   │
 │  Score Viewer +      │
 │  Transport Bar       │
 └──────────────────────┘
```

**What was kept from the original Music Eye:**
- HomeScreen UI (scan from camera, photos, files)
- PlaybackScreen (score viewer, cursor, transport bar, tempo, voice toggles, instrument picker)
- PlaybackVisualization (orange cursor, progress bar, tap-to-seek, auto-scroll)
- AudioPlaybackService (WAV generation, SoundFont rendering)
- SoundFontService (SF2 parsing, multi-instrument support)
- Full theme/styling system

**What was replaced:**
- ~~MusicSheetProcessor~~ (4600-line on-device OMR) → **HOMRService** (server-side)
- ~~ModelService + TensorFlow.js~~ → **MusicXMLParser** (parses HOMR's MusicXML output)
- No more on-device ML models needed

## Getting Started

### 1. Start the HOMR Server

```bash
# Option A: Build from Dockerfile (included in ASSETS/homr-extracted/)
cd ASSETS/homr-extracted/homr-main
docker build -t homr .
docker run --rm -p 8080:8000 homr

# Option B: Quick test
curl -X POST -F "file=@your_sheet_music.jpg" http://localhost:8080/process --output result.musicxml
```

### 2. Run the App

```bash
cd NoteScan
npm install
npx expo start
```

### 3. Configure Server URL

Open the app → Settings → enter your HOMR server URL (default: `http://localhost:8080`).

If running on a physical device, use your machine's LAN IP instead of `localhost`.

## Project Structure

```
NoteScan/
├── App.js                          # App entry — screen navigation
├── package.json                    # Dependencies (no TF.js!)
├── assets/
│   └── SheetMusicScanner.sf2       # SoundFont for instrument playback
└── src/
    ├── screens/
    │   ├── HomeScreen.js           # Main menu + server status
    │   ├── PlaybackScreen.js       # Score viewer + audio playback
    │   └── SettingsScreen.js       # HOMR server configuration
    ├── services/
    │   ├── HOMRService.js          # ★ NEW: Uploads images to HOMR server
    │   ├── MusicXMLParser.js       # ★ NEW: Parses MusicXML → note objects
    │   ├── AudioPlaybackService.js # WAV synthesis + SoundFont playback
    │   └── SoundFontService.js     # SF2 file parser
    └── components/
        └── PlaybackVisualization.js # Score image + cursor overlay
```

## How It Works

1. **Capture**: User takes a photo or picks an image of sheet music
2. **Upload**: Image is sent to the HOMR server via `POST /process`
3. **OMR**: HOMR runs segmentation (UNet) + transformer (TrOMR) pipeline
4. **Parse**: Returned MusicXML is parsed into notes with pitch, duration, voice
5. **Position**: Notes get synthetic x/y positions for cursor tracking on the image
6. **Audio**: Notes are rendered to WAV using SoundFont samples
7. **Play**: Score viewer shows the image with a moving cursor and transport controls

## HOMR API

The server exposes a single endpoint:

```
POST /process
Content-Type: multipart/form-data
Field: file (image)

Response: MusicXML file (application/xml)
```