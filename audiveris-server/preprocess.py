"""
Advanced image preprocessing for OMR (Optical Music Recognition).

Pipeline for camera photos of sheet music (10 steps):
  Raw camera photo
    → Auto-crop             (remove desk/background around page)
    → Perspective correction (straighten tilted shots)
    → Dewarp                (flatten curved pages / book spines)
    → Deskew                (align staff lines horizontally)
    → Resize                (target 2400px long edge, min 1600 short)
    → Sharpen               (recover phone-camera blur via unsharp mask)
    → Smart binarize        (Sauvola first, Adobe-Scan fallback)
    → Close gaps            (reconnect broken staff lines)
    → Noise removal         (connected-component filtering)
    → Clean B&W image ready for Audiveris

Inspired by Leptonica's approach (as used by Zemsky's Sheet Music Scanner):
  - pixSauvolaBinarize  → our _sauvola()
  - dewarpBuildPageModel → our _dewarp()
  - pixDeskew            → our _deskew()
  - fixPerspective       → our _perspective_correct()

Uses OpenCV when available (best quality), falls back to PIL + numpy.
"""

import os
import sys
import numpy as np

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False

# Optimal range for Audiveris (~300 DPI on A4)
MIN_LONG_EDGE = 2400
MAX_LONG_EDGE = 3500


def log(msg):
    print(f"  [preprocess] {msg}", flush=True)


def preprocess(input_path: str, output_path: str = None, target: int = 2400) -> str:
    """
    Full preprocessing pipeline.  Returns path to cleaned image.
    Skips heavy processing if image is already clean (binary/b&w scan).
    Picks the best available backend automatically.
    """
    if output_path is None:
        base = input_path.rsplit(".", 1)[0]
        output_path = f"{base}_preprocessed.png"

    # Check whether the image is already a clean binary/b&w scan.
    # If so, just resize — don't re-binarize (would destroy thin lines).
    if _is_already_clean(input_path):
        log("Image is already clean binary — resize only")
        return _resize_only(input_path, output_path, target)

    if HAS_CV2:
        return _cv2_pipeline(input_path, output_path, target)
    return _pil_pipeline(input_path, output_path, target)


def _is_already_clean(path: str) -> bool:
    """
    Detect if the image is already a clean binary/b&w document
    (e.g., a scan, Adobe Scan output, or a rendered overlay).

    Heuristics:
      1. 1-bit images → always clean
      2. >90% pixels near-black/white → clean (perfect binary)
      3. >70% pixels near-black/white AND <10% in the gray
         midrange (80–180) → clean (Adobe Scan style, slightly noisy)
    """
    try:
        from PIL import Image as PILImage
        img = PILImage.open(path)
        mode = img.mode

        # 1-bit images are already binary by definition
        if mode == "1":
            log(f"Detected 1-bit image")
            return True

        gray = img.convert("L")
        arr = np.array(gray, dtype=np.uint8)
        total = arr.size
        near_black = np.sum(arr < 40)
        near_white = np.sum(arr > 215)
        midrange = np.sum((arr >= 80) & (arr <= 180))
        bw_ratio = (near_black + near_white) / total
        mid_ratio = midrange / total

        log(f"B&W ratio: {bw_ratio:.2%}  (black={near_black/total:.1%}, white={near_white/total:.1%}, midrange={mid_ratio:.1%})")

        # Pure binary
        if bw_ratio > 0.90:
            return True
        # Mostly clean (Adobe Scan etc.) — high B&W with very little gray
        if bw_ratio > 0.70 and mid_ratio < 0.10:
            log(f"Detected as mostly-clean document (Adobe Scan style)")
            return True
        return False
    except Exception as e:
        log(f"Clean-detection failed: {e}")
        return False


def _resize_only(src: str, dst: str, target: int) -> str:
    """Just resize + convert to grayscale PNG. No binarization."""
    from PIL import Image as PILImage

    img = PILImage.open(src).convert("L")
    w, h = img.size
    long = max(w, h)

    if long < target * 0.8:
        s = target / long
        img = img.resize((int(w * s), int(h * s)), PILImage.LANCZOS)
        log(f"Upscaled {w}×{h} → {img.size[0]}×{img.size[1]}")
    elif long > MAX_LONG_EDGE:
        s = MAX_LONG_EDGE / long
        img = img.resize((int(w * s), int(h * s)), PILImage.LANCZOS)
        log(f"Downscaled {w}×{h} → {img.size[0]}×{img.size[1]}")

    img.save(dst, "PNG")
    log(f"Output {img.size[0]}×{img.size[1]} → {dst}")
    return dst


# ──────────────────────────────────────────────────────────
#  OpenCV pipeline  (perspective + dewarp + deskew + Sauvola + CC cleanup)
# ──────────────────────────────────────────────────────────

def _cv2_pipeline(src: str, dst: str, target: int) -> str:
    """Camera-photo → clean B&W pipeline optimised for music notation.

    Inspired by Leptonica's approach (as used by Zemsky's Sheet Music Scanner):
    - Sauvola binarization (gold standard for thin lines + uneven lighting)
    - Sharpening to recover phone-camera blur
    - Conservative morphology to preserve delicate music symbols
    """
    img = cv2.imread(src)
    if img is None:
        log(f"Cannot read {src}, returning as-is")
        return src

    h, w = img.shape[:2]
    log(f"Input {w}×{h}  mode={'color' if len(img.shape)==3 else 'gray'}")

    # 1. Auto-crop — remove non-page border (table, desk, background)
    img = _auto_crop(img)

    # 2. Perspective correction (straighten tilted shots)
    img = _perspective_correct(img)

    # 3. Grayscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img

    # 4. Dewarp — straighten curved/bent pages (book spines, curled paper)
    gray = _dewarp(gray)

    # 5. Deskew via staff-line angle
    gray = _deskew(gray)

    # 6. Resize to target range (Audiveris needs interline ≥ 16px)
    gray = _resize(gray, target)

    # 7. Sharpen — phone photos are always slightly soft; unsharp mask
    #    recovers thin staff lines that would otherwise vanish in binarization
    gray = _sharpen(gray)

    # 8. Binarize — Sauvola first (like Zemsky/Leptonica), Adobe-Scan fallback
    binary = _smart_binarize(gray)

    # 9. Morphological close to reconnect broken staff lines
    binary = _close_gaps(binary)

    # 10. Remove small noise specks
    binary = _remove_noise(binary)

    cv2.imwrite(dst, binary)
    fh, fw = binary.shape[:2]
    log(f"Output {fw}×{fh} → {dst}")
    return dst


# ──────────────────────────────────────────────────────────
#  Dewarping — straighten curved / bent pages
# ──────────────────────────────────────────────────────────

def _dewarp(gray):
    """
    Detect and correct page curvature (e.g. book spines, curled paper).

    Approach inspired by Leptonica's dewarpBuildPageModel:
      1. Binary threshold to isolate ink
      2. Find long horizontal runs (staff lines / text baselines)
      3. For each row-band, fit the horizontal center-of-mass to a polynomial
      4. Build a pixel displacement map from the curvature model
      5. Remap the grayscale image to flatten the curves

    If the page is already flat (<2px curvature), skip dewarping to avoid
    introducing artifacts on clean scans.
    """
    h, w = gray.shape[:2]

    # Need a reasonable image size for reliable detection
    if h < 400 or w < 400:
        return gray

    try:
        # --- Step 1: Rough binarization for line detection ---
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        _, bw = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

        # --- Step 2: Find approximate staff-line y-positions via row sums ---
        # We use the raw binarized image (not morph-filtered) because curved
        # lines don't survive horizontal morphological opening — which is
        # exactly when dewarping is needed.  Curved lines create broad but
        # distinct peaks in the horizontal projection.
        num_bands = 40
        band_w = w // num_bands

        row_sums = np.sum(bw, axis=1).astype(np.float64)
        if row_sums.max() == 0:
            log("Dewarp: no ink found — skipping")
            return gray

        # Smooth to merge nearby staff-line peaks into one broad peak per line
        kernel_h = max(h // 80, 5)
        if kernel_h % 2 == 0:
            kernel_h += 1
        smooth = cv2.GaussianBlur(row_sums.reshape(-1, 1), (1, kernel_h), 0).flatten()

        # Adaptive threshold: peaks above 20% of max
        threshold = smooth.max() * 0.20
        peak_rows = []
        in_peak = False
        peak_start = 0
        for y in range(len(smooth)):
            if smooth[y] > threshold and not in_peak:
                in_peak = True
                peak_start = y
            elif (smooth[y] <= threshold or y == len(smooth) - 1) and in_peak:
                in_peak = False
                # Use weighted centroid within the peak for more accuracy
                seg = smooth[peak_start:y]
                if seg.sum() > 0:
                    yy = np.arange(len(seg), dtype=np.float64)
                    center = int(np.dot(yy, seg) / seg.sum()) + peak_start
                else:
                    center = (peak_start + y) // 2
                peak_rows.append(center)

        if len(peak_rows) < 3:
            log(f"Dewarp: only {len(peak_rows)} line rows found — skipping")
            return gray

        # --- Step 3: Trace curvature for each peak ---
        # In each vertical band, find the y-centroid of ink in a window
        # around the approximate peak position.  This tracks the actual
        # curve of each staff line even when it deviates 30+ px.
        win_h = max(h // 20, 20)  # generous search window
        curves = []
        for py in peak_rows:
            y_lo = max(0, py - win_h)
            y_hi = min(h, py + win_h)
            strip = bw[y_lo:y_hi, :]

            xs = []
            ys = []
            for bx in range(num_bands):
                x0 = bx * band_w
                x1 = min(x0 + band_w, w)
                col_sum = np.sum(strip[:, x0:x1], axis=1).astype(np.float64)
                if col_sum.max() < 255 * 2:
                    continue
                yy = np.arange(strip.shape[0], dtype=np.float64)
                total = col_sum.sum()
                if total < 1:
                    continue
                cy = np.dot(yy, col_sum) / total + y_lo
                cx = (x0 + x1) / 2.0
                xs.append(cx)
                ys.append(cy)

            if len(xs) >= num_bands // 3:  # need at least 1/3 of bands
                curves.append((np.array(xs), np.array(ys)))

        if len(curves) < 2:
            log(f"Dewarp: only {len(curves)} traceable curves — skipping")
            return gray

        # --- Step 4: Measure curvature (deviation from straight line) ---
        # Don't assume any polynomial shape — measure raw residuals from the
        # linear best-fit, which works for parabolic, sinusoidal, or any shape.
        max_deviation = 0.0
        residual_curves = []  # (xs, residuals) for building displacement map
        for xs, ys in curves:
            if len(xs) < 4:
                continue
            lin_coeffs = np.polyfit(xs, ys, 1)
            lin_ys = np.polyval(lin_coeffs, xs)
            residuals = ys - lin_ys  # positive = below baseline
            deviation = np.max(np.abs(residuals))
            max_deviation = max(max_deviation, deviation)
            residual_curves.append((xs, residuals))

        log(f"Dewarp: {len(curves)} curves traced, max curvature = {max_deviation:.1f}px")

        if max_deviation < 2.0:
            log("Dewarp: page is flat enough — skipping")
            return gray

        if not residual_curves:
            return gray

        # --- Step 5: Build displacement map from traced residuals ---
        # Average the residual curves to get a single curvature profile.
        # Interpolate to get a smooth displacement value for every x pixel.
        x_coords = np.arange(w, dtype=np.float64)

        # Resample each residual curve onto a common grid, then average
        resampled = []
        for xs, res in residual_curves:
            # Interpolate this curve's residuals to every pixel column
            interp = np.interp(x_coords, xs, res, left=res[0], right=res[-1])
            resampled.append(interp)

        # Average across all curves — curvature shape should be consistent
        avg_displacement = np.mean(resampled, axis=0)

        # Smooth the displacement to avoid pixel-level noise
        kernel_sm = max(w // 50, 5)
        if kernel_sm % 2 == 0:
            kernel_sm += 1
        avg_displacement = cv2.GaussianBlur(
            avg_displacement.reshape(1, -1).astype(np.float32),
            (kernel_sm, 1), 0
        ).flatten()

        # Build full remap arrays
        map_x = np.zeros((h, w), dtype=np.float32)
        map_y = np.zeros((h, w), dtype=np.float32)

        for y in range(h):
            map_x[y, :] = x_coords.astype(np.float32)
            map_y[y, :] = (y - avg_displacement).astype(np.float32)

        # --- Step 6: Remap ---
        dewarped = cv2.remap(gray, map_x, map_y,
                             interpolation=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_CONSTANT,
                             borderValue=255)

        log(f"Dewarp: applied correction (max shift = {max_deviation:.1f}px)")
        return dewarped

    except Exception as e:
        log(f"Dewarp: failed ({e}) — skipping")
        return gray


# ──────────────────────────────────────────────────────────
#  PIL / numpy fallback pipeline
# ──────────────────────────────────────────────────────────

def _pil_pipeline(src: str, dst: str, target: int) -> str:
    from PIL import Image, ImageFilter, ImageOps

    img = Image.open(src)
    w, h = img.size
    log(f"Input {w}×{h}  mode={img.mode}  (PIL pipeline)")

    # Grayscale
    gray = img.convert("L")

    # Resize — ensure short edge ≥ 1600 for adequate interline spacing
    long = max(w, h)
    short = min(w, h)
    MIN_SHORT = 1600
    if short < MIN_SHORT:
        s = MIN_SHORT / short
        gray = gray.resize((int(w * s), int(h * s)), Image.LANCZOS)
        log(f"Upscaled (short edge) → {gray.size[0]}×{gray.size[1]}")
    elif long < target * 0.8:
        s = target / long
        gray = gray.resize((int(w * s), int(h * s)), Image.LANCZOS)
        log(f"Upscaled → {gray.size[0]}×{gray.size[1]}")
    elif long > MAX_LONG_EDGE:
        s = MAX_LONG_EDGE / long
        if short * s < MIN_SHORT:
            s = MIN_SHORT / short
        gray = gray.resize((int(w * s), int(h * s)), Image.LANCZOS)
        log(f"Downscaled → {gray.size[0]}×{gray.size[1]}")

    # Auto-contrast
    gray = ImageOps.autocontrast(gray, cutoff=1)

    # Sauvola via numpy (same maths as CV2 version, just slower)
    arr = np.array(gray, dtype=np.float64)
    bw, bh = gray.size
    win = max(bw, bh) // 40          # window ≈ 1/40th of image
    if win % 2 == 0:
        win += 1
    win = max(win, 11)

    # local mean via box blur
    blurred = gray.filter(ImageFilter.BoxBlur(win // 2))
    mean = np.array(blurred, dtype=np.float64)

    # local std approximation  (|pixel − mean|  blurred)
    diff_img = Image.fromarray(np.abs(arr - mean).astype(np.uint8))
    std_approx = np.array(diff_img.filter(ImageFilter.BoxBlur(win // 2)),
                          dtype=np.float64) + 1e-6

    R = 128.0
    k = 0.2
    thresh = mean * (1.0 + k * (std_approx / R - 1.0))
    binary = np.where(arr > thresh, 255, 0).astype(np.uint8)
    log(f"Sauvola binarised (PIL)  win={win}  k={k}")

    result = Image.fromarray(binary, mode="L")
    result.save(dst, "PNG")
    log(f"Output {result.size[0]}×{result.size[1]} → {dst}")
    return dst


# ──────────────────────────────────────────────────────────
#  Shared helpers (OpenCV)
# ──────────────────────────────────────────────────────────

def _auto_crop(img):
    """Remove non-page border (table, desk, dark background).

    Uses edge detection + largest-contour bounding rect to find the
    sheet music page, even without a perfect 4-corner quad.  More
    lenient than perspective_correct — works on partial page edges.
    """
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img.copy()

    # Detect page area using Otsu on the grayscale
    blurred = cv2.GaussianBlur(gray, (11, 11), 0)
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Find the largest bright region (= the page)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return img

    largest = max(contours, key=cv2.contourArea)
    area_ratio = cv2.contourArea(largest) / (w * h)

    # Only crop if the page fills 20–90% of the frame (if ~100%, no background to remove)
    if area_ratio < 0.20 or area_ratio > 0.92:
        return img

    x, y, rw, rh = cv2.boundingRect(largest)
    # Add small margin (2%)
    margin_x = int(rw * 0.02)
    margin_y = int(rh * 0.02)
    x1 = max(0, x - margin_x)
    y1 = max(0, y - margin_y)
    x2 = min(w, x + rw + margin_x)
    y2 = min(h, y + rh + margin_y)

    if (x2 - x1) < w * 0.5 or (y2 - y1) < h * 0.5:
        return img  # crop too aggressive, skip

    cropped = img[y1:y2, x1:x2]
    log(f"Auto-cropped {w}×{h} → {x2-x1}×{y2-y1}  (page fills {area_ratio:.0%})")
    return cropped


def _perspective_correct(img):
    """Detect page quad and warp to a flat rectangle."""
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img.copy()
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    edges = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)),
                       iterations=2)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return img

    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4 and cv2.contourArea(approx) > w * h * 0.25:
            pts = _order_quad(approx.reshape(4, 2).astype(np.float32))
            wA = np.linalg.norm(pts[2] - pts[3])
            wB = np.linalg.norm(pts[1] - pts[0])
            hA = np.linalg.norm(pts[1] - pts[2])
            hB = np.linalg.norm(pts[0] - pts[3])
            maxW, maxH = int(max(wA, wB)), int(max(hA, hB))
            if maxW < 200 or maxH < 200:
                continue
            dst = np.array([[0, 0], [maxW - 1, 0],
                            [maxW - 1, maxH - 1], [0, maxH - 1]], dtype=np.float32)
            M = cv2.getPerspectiveTransform(pts, dst)
            warped = cv2.warpPerspective(img, M, (maxW, maxH))
            log(f"Perspective corrected {w}×{h} → {maxW}×{maxH}")
            return warped

    return img


def _order_quad(pts):
    """Order 4 points: TL, TR, BR, BL."""
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    rect[1] = pts[np.argmin(d)]
    rect[3] = pts[np.argmax(d)]
    return rect


def _deskew(gray):
    """Rotate so staff lines are perfectly horizontal."""
    h, w = gray.shape[:2]
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=100,
                            minLineLength=int(w * 0.3), maxLineGap=20)
    if lines is None or len(lines) < 3:
        return gray

    angles = []
    for l in lines:
        x1, y1, x2, y2 = l[0]
        a = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        if abs(a) < 10:
            angles.append(a)

    if not angles:
        return gray
    med = float(np.median(angles))
    if abs(med) < 0.1:
        return gray

    M = cv2.getRotationMatrix2D((w // 2, h // 2), med, 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    nW, nH = int(h * sin + w * cos), int(h * cos + w * sin)
    M[0, 2] += (nW - w) / 2
    M[1, 2] += (nH - h) / 2
    rotated = cv2.warpAffine(gray, M, (nW, nH),
                             borderMode=cv2.BORDER_CONSTANT, borderValue=255)
    log(f"Deskewed {med:+.2f}°")
    return rotated


def _resize(gray, target):
    """
    Scale so both edges are large enough for Audiveris.
    Audiveris needs interline ≥ 16px, which requires the short edge
    (where staves run) to be at least ~1600px for typical sheet music.
    """
    h, w = gray.shape[:2]
    long_edge = max(w, h)
    short_edge = min(w, h)
    MIN_SHORT_EDGE = 1600  # guarantee enough interline pixels

    if short_edge < MIN_SHORT_EDGE:
        # Short edge is too small — scale based on short edge
        s = MIN_SHORT_EDGE / short_edge
        gray = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
        log(f"Upscaled (short edge) {w}×{h} → {gray.shape[1]}×{gray.shape[0]}")
    elif long_edge < target * 0.8:
        # Long edge is too small
        s = target / long_edge
        gray = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
        log(f"Upscaled (long edge) {w} → {gray.shape[1]}px")
    elif long_edge > MAX_LONG_EDGE:
        # Too large — but don't shrink short edge below minimum
        s = MAX_LONG_EDGE / long_edge
        if short_edge * s < MIN_SHORT_EDGE:
            s = MIN_SHORT_EDGE / short_edge
        gray = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        log(f"Downscaled {w}×{h} → {gray.shape[1]}×{gray.shape[0]}")
    return gray


def _sharpen(gray):
    """Unsharp-mask sharpening to recover phone-camera softness.

    Phone photos are always slightly soft due to small sensor, thin lens,
    and possible slight motion blur.  Without sharpening, 1-2px staff lines
    become gray blobs that Sauvola binarization turns into broken dashes.

    Uses a mild unsharp mask:  sharpened = gray + alpha * (gray - blurred)
    Alpha is adaptive — computed from the image's own blur level.
    """
    h, w = gray.shape[:2]

    # Measure blur level via Laplacian variance
    lap_var = cv2.Laplacian(gray, cv2.CV_64F).var()
    if lap_var > 800:
        # Image is already sharp (scanned document) — skip
        log(f"Sharpen: skipped (Laplacian variance = {lap_var:.0f}, already sharp)")
        return gray

    # Adaptive strength: blurrier images get more sharpening
    if lap_var < 100:
        alpha = 1.5  # very blurry
    elif lap_var < 300:
        alpha = 1.0  # moderately soft
    else:
        alpha = 0.5  # mildly soft

    # Gaussian blur radius scales with image size (~1/400 of long edge)
    sigma = max(w, h) / 400.0
    sigma = max(1.0, min(sigma, 3.0))

    blurred = cv2.GaussianBlur(gray, (0, 0), sigma)
    sharpened = cv2.addWeighted(gray, 1.0 + alpha, blurred, -alpha, 0)
    sharpened = np.clip(sharpened, 0, 255).astype(np.uint8)

    log(f"Sharpened: alpha={alpha:.1f}  sigma={sigma:.1f}  (blur score={lap_var:.0f})")
    return sharpened


def _smart_binarize(gray):
    """Intelligent binarization: Sauvola first (like Zemsky/Leptonica),
    with Adobe-Scan fallback for difficult lighting conditions.

    Sauvola is the gold standard for document binarization — it preserves
    thin lines (staff lines, stems) far better than global approaches.
    But it can struggle with extreme lighting gradients (shadow across page).
    In that case, fall back to the multi-pass Adobe-Scan approach.
    """
    h, w = gray.shape[:2]

    # Try Sauvola first
    binary = _sauvola(gray, k=0.15)  # k=0.15 slightly less aggressive than default

    # Validate result: check ink coverage
    total = binary.size
    black = np.sum(binary < 128)
    ink_pct = black / total

    if 0.02 <= ink_pct <= 0.35:
        # Looks reasonable for sheet music (2-35% ink)
        log(f"Smart binarize: Sauvola succeeded (ink={ink_pct:.1%})")
        return binary

    # Sauvola failed — too little or too much ink.
    # The image likely has extreme lighting issues.  Fall back to Adobe-Scan.
    log(f"Smart binarize: Sauvola ink={ink_pct:.1%} (bad) — trying Adobe-Scan fallback")
    fallback = _adobe_scan_binarize(gray)

    fb_ink = np.sum(fallback < 128) / total
    if 0.02 <= fb_ink <= 0.35:
        log(f"Smart binarize: Adobe-Scan fallback succeeded (ink={fb_ink:.1%})")
        return fallback

    # Both failed — return whichever has more plausible coverage
    if abs(ink_pct - 0.10) < abs(fb_ink - 0.10):
        log(f"Smart binarize: both marginal, keeping Sauvola (ink={ink_pct:.1%})")
        return binary
    else:
        log(f"Smart binarize: both marginal, keeping Adobe-Scan (ink={fb_ink:.1%})")
        return fallback


def _sauvola(gray, win=0, k=0.2, R=128.0):
    """
    Sauvola adaptive binarisation — gold standard for documents.
    T(x,y) = mean(x,y) * (1 + k * (std(x,y)/R − 1))
    Uses integral images so it's fast even on large images.
    """
    h, w = gray.shape[:2]
    if win == 0:
        win = max(w, h) // 40
        if win % 2 == 0:
            win += 1
        win = max(win, 11)

    gf = gray.astype(np.float64)
    pad = win // 2

    integral   = cv2.integral(gf)          # shape (h+1, w+1)
    integral_sq = cv2.integral(gf * gf)

    # vectorised local-sum via integral images
    y1 = np.clip(np.arange(h) - pad, 0, h).astype(int)
    y2 = np.clip(np.arange(h) + pad + 1, 0, h).astype(int)
    x1 = np.clip(np.arange(w) - pad, 0, w).astype(int)
    x2 = np.clip(np.arange(w) + pad + 1, 0, w).astype(int)

    Y1, X1 = np.meshgrid(y1, x1, indexing="ij")
    Y2, X2 = np.meshgrid(y2, x2, indexing="ij")
    cnt = np.maximum((Y2 - Y1) * (X2 - X1), 1)

    sm  = integral[Y2, X2] - integral[Y1, X2] - integral[Y2, X1] + integral[Y1, X1]
    ssq = integral_sq[Y2, X2] - integral_sq[Y1, X2] - integral_sq[Y2, X1] + integral_sq[Y1, X1]

    mean = sm / cnt
    std  = np.sqrt(np.maximum(ssq / cnt - mean * mean, 0))

    thresh = mean * (1.0 + k * (std / R - 1.0))
    out = np.where(gf > thresh, 255, 0).astype(np.uint8)
    log(f"Sauvola binarised  win={win}  k={k}")
    return out


def _adobe_scan_binarize(gray):
    """Adobe-Scan-style aggressive binarization.

    Multi-pass approach that forces a clean pure-black-on-white result
    from any camera photo, regardless of lighting conditions:

    1. Strong bilateral filter — smooths texture/noise but keeps edges (ink)
    2. Background estimation via large morphological open — models the page
    3. Divide gray by background — eliminates all lighting gradients
    4. CLAHE on the flattened image — maximize local contrast
    5. Aggressive adaptive threshold — pure B&W output
    6. Otsu validation fallback
    """
    h, w = gray.shape[:2]
    log(f"Adobe-Scan binarization on {w}×{h}")

    # --- Step 1: Bilateral filter (denoise while preserving edges) ---
    smooth = cv2.bilateralFilter(gray, d=9, sigmaColor=75, sigmaSpace=75)

    # --- Step 2: Estimate background via large morphological opening ---
    # Kernel large enough to "erase" staff lines and notes, leaving only
    # the page background + lighting gradient
    bg_kernel_size = max(w, h) // 15
    if bg_kernel_size % 2 == 0:
        bg_kernel_size += 1
    bg_kernel_size = max(bg_kernel_size, 51)
    bg_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                          (bg_kernel_size, bg_kernel_size))
    background = cv2.morphologyEx(smooth, cv2.MORPH_OPEN, bg_kernel)
    log(f"Background estimated  kernel={bg_kernel_size}")

    # --- Step 3: Divide — cancel lighting gradients ---
    # result = (gray / background) * 255  — makes page uniformly white
    bg_float = background.astype(np.float64)
    bg_float[bg_float < 1] = 1  # avoid division by zero
    flat = (smooth.astype(np.float64) / bg_float * 255.0)
    flat = np.clip(flat, 0, 255).astype(np.uint8)
    log(f"Background divided — lighting flattened")

    # --- Step 4: CLAHE on the flattened image ---
    tile = max(4, min(w, h) // 20)
    clahe = cv2.createCLAHE(clipLimit=4.0, tileGridSize=(tile, tile))
    enhanced = clahe.apply(flat)
    log(f"CLAHE enhanced  tile={tile}  clip=4.0")

    # --- Step 5: Aggressive adaptive threshold ---
    # Block size ~1/30th of image — responds to local detail
    block = max(w, h) // 30
    if block % 2 == 0:
        block += 1
    block = max(block, 15)
    # C=12 is aggressive — biases toward black, ensuring staff lines survive
    binary = cv2.adaptiveThreshold(enhanced, 255,
                                   cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY, block, 12)
    log(f"Adaptive threshold  block={block}  C=12")

    # --- Step 6: Validate ink coverage ---
    total = binary.size
    black = np.sum(binary < 128)
    ink_pct = black / total
    log(f"Ink coverage: {ink_pct:.1%}")

    if ink_pct < 0.02:
        # Threshold was too conservative — try Otsu on the enhanced image
        log(f"Too little ink — Otsu fallback")
        _, binary = cv2.threshold(enhanced, 0, 255,
                                  cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        ink_pct2 = np.sum(binary < 128) / total
        log(f"Otsu ink coverage: {ink_pct2:.1%}")
    elif ink_pct > 0.40:
        # Too much ink (image was very dark) — lighten the threshold
        log(f"Too much ink — retrying with C=20")
        binary = cv2.adaptiveThreshold(enhanced, 255,
                                       cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                       cv2.THRESH_BINARY, block, 20)
        ink_pct2 = np.sum(binary < 128) / total
        log(f"Adjusted ink coverage: {ink_pct2:.1%}")

    return binary


def _close_gaps(binary):
    """Morphological close to reconnect small gaps in staff lines,
    then open to thin bloated lines back to a consistent width."""
    # Close: bridge tiny horizontal gaps
    close_k = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 1))
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, close_k)
    # Open: thin any bloated vertical strokes (prevents line(1,11,13) issue)
    open_k = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 2))
    thinned = cv2.morphologyEx(closed, cv2.MORPH_OPEN, open_k)
    return thinned
    return closed


def _remove_noise(binary, min_area=10):
    """Remove small connected-component specks (salt/pepper, dust)."""
    inv = cv2.bitwise_not(binary)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=8)
    clean = np.full_like(binary, 255)
    removed = 0
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        cw   = stats[i, cv2.CC_STAT_WIDTH]
        ch   = stats[i, cv2.CC_STAT_HEIGHT]
        if area >= min_area and (cw > 2 or ch > 2):
            clean[labels == i] = 0
        else:
            removed += 1
    if removed:
        log(f"Noise removal: dropped {removed} tiny components")
    return clean


# ──────────────────────────────────────────────────────────
#  CLI for standalone testing
# ──────────────────────────────────────────────────────────
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: python {sys.argv[0]} <input> [output]")
        sys.exit(1)
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else None
    out = preprocess(src, dst)
    print(f"Done → {out}")
