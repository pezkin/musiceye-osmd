"""
Audiveris OMR Server — FastAPI wrapper around Audiveris CLI.
Accepts image uploads and returns MusicXML + note positions from .omr.
Uses preprocess.py for camera-photo cleanup (perspective, deskew, Sauvola binarisation).
"""

import os
import uuid
import glob
import shutil
import subprocess
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.responses import PlainTextResponse, JSONResponse, FileResponse

from preprocess import preprocess  # our advanced pipeline

# Directory for saving debug preprocessed images
DEBUG_DIR = "/tmp/audiveris-debug"
os.makedirs(DEBUG_DIR, exist_ok=True)

# Register HEIC/HEIF support with Pillow
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
    print("✅ HEIC/HEIF support registered")
except ImportError:
    print("⚠️  pillow-heif not installed — HEIC images will fail")

app = FastAPI(title="Audiveris OMR Server", version="1.0.0")

# Find audiveris binary / jar
AUDIVERIS_BIN = None
AUDIVERIS_JAR = None

# Check for system-installed binary or extracted .deb
for p in ["/opt/audiveris/bin/Audiveris", "/usr/bin/audiveris", "/usr/local/bin/audiveris"]:
    if os.path.isfile(p):
        AUDIVERIS_BIN = p
        break

# Check for extracted zip (jar-based)
if not AUDIVERIS_BIN:
    jar_candidates = glob.glob("/opt/audiveris/**/Audiveris*.jar", recursive=True)
    bin_candidates = glob.glob("/opt/audiveris/**/bin/Audiveris", recursive=True)
    if bin_candidates:
        AUDIVERIS_BIN = bin_candidates[0]
    elif jar_candidates:
        AUDIVERIS_JAR = jar_candidates[0]

# Minimum pixels for Audiveris (needs ~300 DPI; for A4 that's ~2480x3508)
MIN_LONG_EDGE = 2400

WORK_DIR = "/tmp/audiveris-work"
OUTPUT_DIR = "/tmp/audiveris-output"

os.makedirs(WORK_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)


@app.get("/")
def root():
    return {
        "service": "Audiveris OMR Server",
        "version": "1.0.0",
        "engine": "Audiveris 5.9.0",
        "status": "ready",
        "binary": AUDIVERIS_BIN,
        "jar": AUDIVERIS_JAR,
    }


@app.get("/docs")
def docs_redirect():
    """Health check endpoint matching HOMR's /docs pattern."""
    return {"status": "ok", "engine": "audiveris"}


@app.post("/debug")
async def debug_preprocess(file: UploadFile = File(...)):
    """Preprocess a photo and return the cleaned B&W image (no Audiveris).

    Use this to see exactly what Audiveris receives after preprocessing.
    Upload a camera photo → get back the preprocessed PNG.
    """
    job_id = str(uuid.uuid4())[:8]
    work_path = os.path.join(WORK_DIR, job_id)
    os.makedirs(work_path, exist_ok=True)

    try:
        ext = Path(file.filename or "image.png").suffix or ".png"
        input_file = os.path.join(work_path, f"input{ext}")
        content = await file.read()
        with open(input_file, "wb") as f:
            f.write(content)

        input_file = _convert_to_png_if_needed(input_file, work_path, job_id)
        processed_file = preprocess(input_file)

        # Copy to debug dir (persists after cleanup)
        debug_out = os.path.join(DEBUG_DIR, f"debug_{job_id}.png")
        shutil.copy2(processed_file, debug_out)
        print(f"[{job_id}] Debug image saved: {debug_out}")

        # Cleanup work dir before returning
        shutil.rmtree(work_path, ignore_errors=True)

        return FileResponse(
            debug_out,
            media_type="image/png",
            filename=f"preprocessed_{job_id}.png",
        )
    except Exception as e:
        shutil.rmtree(work_path, ignore_errors=True)
        raise HTTPException(500, f"Debug preprocessing failed: {e}")


def _extract_positions_from_omr(omr_path: str) -> dict:
    """
    Parse an Audiveris .omr project file (ZIP containing XML) and extract
    note-head pixel positions, system/staff layout, and measure boundaries.

    Returns a dict with:
      - imageWidth, imageHeight: dimensions of the processed image
      - systems[]: each with top/bottom/left/right, staff info, and measure ranges
      - heads[]: each with x, y, w, h, pitch, staff, systemIndex, measure
    """
    try:
        with zipfile.ZipFile(omr_path, "r") as zf:
            # Find the sheet XML (typically sheet#1/sheet#1.xml)
            sheet_files = [n for n in zf.namelist() if n.endswith(".xml") and "sheet" in n.lower() and "book" not in n.lower()]
            if not sheet_files:
                print(f"  ⚠️ No sheet XML found in .omr: {zf.namelist()}")
                return None

            sheet_xml = zf.read(sheet_files[0]).decode("utf-8")

        root = ET.fromstring(sheet_xml)

        # Image dimensions from <picture width="" height="">
        picture = root.find("picture")
        img_w = int(picture.get("width", "0")) if picture is not None else 0
        img_h = int(picture.get("height", "0")) if picture is not None else 0

        # Parse systems, stacks (measures), staves, and inters
        page = root.find("page")
        if page is None:
            print("  ⚠️ No <page> element in sheet XML")
            return None

        systems_data = []
        all_heads = []
        global_measure_idx = 0  # 1-based measure number, assigned sequentially

        for sys_elem in page.findall("system"):
            sys_id = sys_elem.get("id")
            sys_index = len(systems_data)

            # Collect stack (measure) boundaries
            stacks = []
            for stack in sys_elem.findall("stack"):
                stack_id = stack.get("id")
                left = int(stack.get("left", "0"))
                right = int(stack.get("right", "0"))
                global_measure_idx += 1
                stacks.append({
                    "stackId": stack_id,
                    "measureNum": global_measure_idx,
                    "left": left,
                    "right": right,
                })

            # Collect staff Y boundaries from staff lines
            staffs = []
            for part in sys_elem.findall("part"):
                for staff in part.findall("staff"):
                    staff_id = staff.get("id")
                    staff_left = int(staff.get("left", "0"))
                    staff_right = int(staff.get("right", "0"))
                    lines_y = []
                    lines_elem = staff.find("lines")
                    if lines_elem is not None:
                        for line in lines_elem.findall("line"):
                            for pt in line.findall("point"):
                                lines_y.append(float(pt.get("y", "0")))
                    staff_top = min(lines_y) if lines_y else 0
                    staff_bot = max(lines_y) if lines_y else 0
                    staffs.append({
                        "staffId": staff_id,
                        "top": staff_top,
                        "bottom": staff_bot,
                        "left": staff_left,
                        "right": staff_right,
                    })

            # System vertical bounds from staffs
            all_tops = [s["top"] for s in staffs]
            all_bots = [s["bottom"] for s in staffs]
            sys_top = min(all_tops) if all_tops else 0
            sys_bot = max(all_bots) if all_bots else 0
            sys_left = min(s["left"] for s in staffs) if staffs else 0
            sys_right = max(s["right"] for s in staffs) if staffs else 0

            systems_data.append({
                "systemIndex": sys_index,
                "top": sys_top,
                "bottom": sys_bot,
                "left": sys_left,
                "right": sys_right,
                "measures": stacks,
                "staffs": staffs,
            })

            # Parse <sig> → <inters> for note heads
            sig = sys_elem.find("sig")
            if sig is None:
                continue
            inters_elem = sig.find("inters")
            if inters_elem is None:
                continue

            for inter in inters_elem:
                if inter.tag != "head":
                    continue

                bounds_elem = inter.find("bounds")
                if bounds_elem is None:
                    continue

                hx = int(bounds_elem.get("x", "0"))
                hy = int(bounds_elem.get("y", "0"))
                hw = int(bounds_elem.get("w", "0"))
                hh = int(bounds_elem.get("h", "0"))
                pitch = int(inter.get("pitch", "0"))
                staff = inter.get("staff", "1")

                # Determine which measure this head falls in
                head_cx = hx + hw // 2
                measure_num = 0
                for stack in stacks:
                    if stack["left"] <= head_cx <= stack["right"]:
                        measure_num = stack["measureNum"]
                        break
                if measure_num == 0 and stacks:
                    # Fallback: assign to nearest stack
                    measure_num = min(stacks, key=lambda s: abs((s["left"] + s["right"]) / 2 - head_cx))["measureNum"]

                all_heads.append({
                    "x": hx,
                    "y": hy,
                    "w": hw,
                    "h": hh,
                    "pitch": pitch,
                    "staff": staff,
                    "systemIndex": sys_index,
                    "measure": measure_num,
                })

        # Sort heads by system, then measure, then x
        all_heads.sort(key=lambda h: (h["systemIndex"], h["measure"], h["x"]))

        result = {
            "imageWidth": img_w,
            "imageHeight": img_h,
            "systems": systems_data,
            "heads": all_heads,
        }
        print(f"  📍 Extracted {len(all_heads)} note heads across {len(systems_data)} systems, {global_measure_idx} measures")
        return result

    except Exception as e:
        print(f"  ⚠️ Failed to parse .omr file: {e}")
        import traceback
        traceback.print_exc()
        return None


@app.post("/process")
async def process_image(file: UploadFile = File(...)):
    """
    Accept an image file and run Audiveris OMR.
    Returns MusicXML as plain text.
    """
    if not AUDIVERIS_BIN and not AUDIVERIS_JAR:
        raise HTTPException(500, "Audiveris binary not found")

    # Save uploaded file
    job_id = str(uuid.uuid4())[:8]
    work_path = os.path.join(WORK_DIR, job_id)
    out_path = os.path.join(OUTPUT_DIR, job_id)
    os.makedirs(work_path, exist_ok=True)
    os.makedirs(out_path, exist_ok=True)

    ext = Path(file.filename or "image.png").suffix or ".png"
    input_file = os.path.join(work_path, f"input{ext}")

    try:
        content = await file.read()
        with open(input_file, "wb") as f:
            f.write(content)

        # Convert HEIC/HEIF/WEBP to PNG (iPhone camera, etc.)
        input_file = _convert_to_png_if_needed(input_file, work_path, job_id)

        # Preprocess: auto-crop → perspective → dewarp → deskew → sharpen → binarise
        processed_file = preprocess(input_file)

        # Save preprocessed image for debugging (last 5 kept)
        debug_out = os.path.join(DEBUG_DIR, f"last_{job_id}.png")
        try:
            shutil.copy2(processed_file, debug_out)
            # Cleanup old debug images (keep last 5)
            debug_files = sorted(glob.glob(os.path.join(DEBUG_DIR, "last_*.png")))
            for old in debug_files[:-5]:
                os.remove(old)
        except Exception:
            pass

        # Build Audiveris command with quality tuning for camera photos
        # These options make Audiveris more tolerant of imperfect input:
        #   - Scale.minInterline: accept narrower staff spacing (phone photos)
        #   - Sheet.Scale.maxInterline: allow wider spacing too
        quality_options = [
            "-option", "org.audiveris.omr.sheet.Scale.minInterline=10",
            "-option", "org.audiveris.omr.sheet.Scale.maxInterline=30",
        ]

        if AUDIVERIS_BIN:
            cmd = [
                "xvfb-run", "-a",
                AUDIVERIS_BIN,
                "-batch",
                "-export",
                "-output", out_path,
                *quality_options,
                processed_file,
            ]
        else:
            cmd = [
                "xvfb-run", "-a",
                "java", "-jar", AUDIVERIS_JAR,
                "-batch",
                "-export",
                "-output", out_path,
                *quality_options,
                processed_file,
            ]

        print(f"[{job_id}] Running: {' '.join(cmd)}")

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=180,  # 3 min timeout
            env={**os.environ, "DISPLAY": ":99"},
        )

        print(f"[{job_id}] Return code: {result.returncode}")
        if result.stdout:
            print(f"[{job_id}] stdout ({len(result.stdout)} chars):")
            # Print full stdout for debugging (split long output)
            for line in result.stdout.splitlines():
                print(f"  | {line}")
        if result.stderr:
            print(f"[{job_id}] stderr ({len(result.stderr)} chars):")
            for line in result.stderr.splitlines()[:50]:
                print(f"  ! {line}")

        # Find output MusicXML — Audiveris outputs .mxl (compressed) or .xml
        mxl_files = glob.glob(os.path.join(out_path, "**", "*.mxl"), recursive=True)
        xml_files = glob.glob(os.path.join(out_path, "**", "*.xml"), recursive=True)
        musicxml_files = glob.glob(os.path.join(out_path, "**", "*.musicxml"), recursive=True)

        output_file = None
        is_mxl = False

        if mxl_files:
            output_file = mxl_files[0]
            is_mxl = True
        elif xml_files:
            output_file = xml_files[0]
        elif musicxml_files:
            output_file = musicxml_files[0]

        if not output_file:
            # Check if files were created in a subdirectory
            all_files = []
            for root_dir, dirs, files in os.walk(out_path):
                for fname in files:
                    all_files.append(os.path.join(root_dir, fname))

            # Log the failure details server-side
            error_msg = (
                f"Audiveris did not produce MusicXML output. "
                f"Files found: {all_files}. "
                f"RC: {result.returncode}. "
                f"stderr: {result.stderr[:500] if result.stderr else 'none'}"
            )
            print(f"[{job_id}] ERROR: {error_msg}")

            raise HTTPException(422, error_msg)

        if is_mxl:
            # .mxl is a ZIP containing .xml — extract it
            with zipfile.ZipFile(output_file, "r") as zf:
                xml_names = [n for n in zf.namelist() if n.endswith(".xml") and not n.startswith("META-INF")]
                if not xml_names:
                    raise HTTPException(422, "MXL archive contains no XML file")
                musicxml_content = zf.read(xml_names[0]).decode("utf-8")
        else:
            with open(output_file, "r") as f:
                musicxml_content = f.read()

        # Extract note positions from .omr project file
        note_positions = None
        omr_files = glob.glob(os.path.join(out_path, "**", "*.omr"), recursive=True)
        if omr_files:
            print(f"[{job_id}] Found .omr file: {omr_files[0]}")
            note_positions = _extract_positions_from_omr(omr_files[0])
        else:
            print(f"[{job_id}] No .omr file found in output")

        # Return JSON with both MusicXML and positions
        return JSONResponse(content={
            "musicxml": musicxml_content,
            "notePositions": note_positions,
        })

    except subprocess.TimeoutExpired:
        raise HTTPException(504, "Audiveris processing timed out (180s)")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Processing error: {str(e)}")
    finally:
        # Cleanup
        shutil.rmtree(work_path, ignore_errors=True)
        shutil.rmtree(out_path, ignore_errors=True)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)


def _convert_to_png_if_needed(input_file: str, work_path: str, job_id: str) -> str:
    """Convert HEIC/HEIF/WEBP/TIFF to PNG so OpenCV and Audiveris can read them."""
    ext = os.path.splitext(input_file)[1].lower()
    needs_convert = ext in (".heic", ".heif", ".webp", ".tiff", ".tif", ".bmp")

    if not needs_convert:
        return input_file

    try:
        from PIL import Image as PILImage
        png_path = os.path.join(work_path, "input.png")
        img = PILImage.open(input_file)
        img = img.convert("RGB")
        img.save(png_path, "PNG")
        print(f"[{job_id}] Converted {ext} → PNG ({img.size[0]}×{img.size[1]})")
        return png_path
    except Exception as e:
        print(f"[{job_id}] ⚠️ Conversion from {ext} failed: {e}")
        return input_file
