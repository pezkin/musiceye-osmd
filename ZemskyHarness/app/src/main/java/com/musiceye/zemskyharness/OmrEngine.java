package com.musiceye.zemskyharness;

import android.content.Context;
import android.util.Log;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Matrix;

import androidx.exifinterface.media.ExifInterface;

import com.xemsoft.sheetmusicscanner2.analysis.Scanner;
import com.xemsoft.sheetmusicscanner2.leptonica.JniLeptonicaJNI;
import com.xemsoft.sheetmusicscanner2.sources.JniSourceJNI;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public class OmrEngine {
    private static final String TAG = "ZemskyHarness";
    private static final long NATIVE_ANALYZE_TIMEOUT_MS = 30000; // 30 second timeout
    private static final int MAX_NATIVE_IMAGE_SIDE = 3200;
    private static final int MIN_NATIVE_IMAGE_SIDE = 2400;
    private static final float NATIVE_ANALYZE_SCALE = 2.0f;
    
    private final File templatesDir;
    private final File ocrModelPath;
    private final File keySigCModelPath;
    private final File keySigDigitModelPath;
    private final File tmpDir;

    private static final class RetryableAnalyzeException extends Exception {
        final int resultCode;

        RetryableAnalyzeException(String message, int resultCode) {
            super(message);
            this.resultCode = resultCode;
        }
    }

    public OmrEngine(Context context) throws Exception {
        File templatesRoot = AssetExtractor.ensureAssetDir(context, "templates");
        File modelsRoot = AssetExtractor.ensureAssetDir(context, "nnModels");
        this.templatesDir = templatesRoot;
        this.ocrModelPath = new File(modelsRoot, "ocr_model.json");
        this.keySigCModelPath = new File(modelsRoot, "keySignatures_c_model.json");
        this.keySigDigitModelPath = new File(modelsRoot, "keySignatures_digit_model.json");
        this.tmpDir = new File(context.getCacheDir(), "zemsky-tmp");
        if (!tmpDir.exists() && !tmpDir.mkdirs()) {
            throw new Exception("Could not create tmp dir: " + tmpDir);
        }
    }

    public String processImage(String imagePath) throws Exception {
        Exception lastError = null;

        // Strategy 1: normalized grayscale + default scale
        try {
            return processImageAttempt(imagePath, true, NATIVE_ANALYZE_SCALE, 0);
        } catch (RetryableAnalyzeException e) {
            lastError = e;
            Log.w(TAG, "Retrying OMR after result code=" + e.resultCode + " using original image");
        } catch (Exception e) {
            lastError = e;
            Log.w(TAG, "First OMR attempt failed: " + e.getMessage());
        }

        // Strategy 2: original image + default scale
        try {
            return processImageAttempt(imagePath, false, NATIVE_ANALYZE_SCALE, 0);
        } catch (RetryableAnalyzeException e) {
            lastError = e;
            Log.w(TAG, "Retrying OMR after result code=" + e.resultCode + " with alternate scale");
        } catch (Exception e) {
            lastError = e;
            Log.w(TAG, "Second OMR attempt failed: " + e.getMessage());
        }

        // Strategy 3: original image + alternate scale (legacy server behavior)
        try {
            return processImageAttempt(imagePath, false, 1.0f, 0);
        } catch (Exception e) {
            lastError = e;
            Log.w(TAG, "Third OMR attempt failed: " + e.getMessage());
        }

        // Strategy 4: normalized grayscale + forced 90deg rotation
        try {
            return processImageAttempt(imagePath, true, NATIVE_ANALYZE_SCALE, 90);
        } catch (Exception e) {
            lastError = e;
            Log.w(TAG, "Fourth OMR attempt failed: " + e.getMessage());
        }

        // Strategy 5: normalized grayscale + forced 270deg rotation
        try {
            return processImageAttempt(imagePath, true, NATIVE_ANALYZE_SCALE, 270);
        } catch (Exception e) {
            lastError = e;
            Log.w(TAG, "Fifth OMR attempt failed: " + e.getMessage());
        }

        throw lastError != null ? lastError : new Exception("OMR failed for all strategies");
    }

    private String processImageAttempt(String imagePath, boolean usePreparedImage, float analyzeScale, int forcedRotationDeg) throws Exception {
        File preparedImage = usePreparedImage ? prepareInputImage(imagePath) : null;
        String nativeImagePath = preparedImage != null ? preparedImage.getAbsolutePath() : imagePath;
        File rotatedImage = null;

        if (forcedRotationDeg != 0) {
            rotatedImage = createRotatedCopy(nativeImagePath, forcedRotationDeg);
            if (rotatedImage != null) {
                nativeImagePath = rotatedImage.getAbsolutePath();
                Log.i(TAG, "Applied forced rotation " + forcedRotationDeg + "deg for retry: " + nativeImagePath);
            }
        }

        long sessionPtr = JniSourceJNI.sessionCreate();
        if (sessionPtr == 0) {
            if (preparedImage != null) preparedImage.delete();
            if (rotatedImage != null) rotatedImage.delete();
            throw new Exception("sessionCreate failed");
        }

        long pixPtr = JniLeptonicaJNI.pixRead(nativeImagePath);
        if (pixPtr == 0) {
            JniSourceJNI.sessionDestroy(sessionPtr);
            if (preparedImage != null) preparedImage.delete();
            if (rotatedImage != null) rotatedImage.delete();
            throw new Exception("pixRead failed for " + nativeImagePath);
        }

        long resultPtr = 0;
        try {
            // Validate templates and models before native call
            validateAssets();
            
            int width = JniLeptonicaJNI.pixGetWidth(pixPtr);
            Scanner scanner = new Scanner();

            // The native analyzer polls scanner.isScanCanceled(); trigger that instead of thread interrupts.
            AtomicBoolean timedOut = new AtomicBoolean(false);
            ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor();
            ScheduledFuture<?> cancelTask = watchdog.schedule(() -> {
                timedOut.set(true);
                scanner.cancel();
                Log.e(TAG, "nativeAnalyze watchdog requested cancel after " + NATIVE_ANALYZE_TIMEOUT_MS + "ms");
            }, NATIVE_ANALYZE_TIMEOUT_MS, TimeUnit.MILLISECONDS);

            try {
                Log.d(TAG, "nativeAnalyze: starting... width=" + width + ", scale=" + analyzeScale + ", prepared=" + (preparedImage != null) + ", forcedRotation=" + forcedRotationDeg);
                Log.d(TAG, "  templates=" + templatesDir.getAbsolutePath() + " (" + (templatesDir.exists() ? "exists" : "MISSING") + ")");
                Log.d(TAG, "  ocr_model=" + ocrModelPath.getAbsolutePath() + " (" + (ocrModelPath.exists() ? "exists" : "MISSING") + ")");
                Log.d(TAG, "  keySigC_model=" + keySigCModelPath.getAbsolutePath() + " (" + (keySigCModelPath.exists() ? "exists" : "MISSING") + ")");
                Log.d(TAG, "  keySigDigit_model=" + keySigDigitModelPath.getAbsolutePath() + " (" + (keySigDigitModelPath.exists() ? "exists" : "MISSING") + ")");
                
                resultPtr = JniSourceJNI.nativeAnalyze(
                    (float) width,
                    analyzeScale,
                    scanner,
                    pixPtr,
                    templatesDir.getAbsolutePath(),
                    ocrModelPath.getAbsolutePath(),
                    keySigCModelPath.getAbsolutePath(),
                    keySigDigitModelPath.getAbsolutePath(),
                    sessionPtr,
                    0,
                    ""
                );
                Log.d(TAG, "nativeAnalyze: returned " + resultPtr);
            } finally {
                cancelTask.cancel(true);
                watchdog.shutdownNow();
            }

            if (timedOut.get()) {
                throw new Exception("Native OMR analysis timed out");
            }
        } finally {
            JniLeptonicaJNI.pixDestroy(pixPtr);
        }

        if (resultPtr == 0) {
            JniSourceJNI.sessionDestroy(sessionPtr);
            throw new Exception("nativeAnalyze returned null");
        }

        try {
            int code = JniSourceJNI.analysisResult_resultCode_get(resultPtr, new Object());
            long scorePtr = JniSourceJNI.analysisResult_score_get(resultPtr, new Object());
            int sessionCountBefore = JniSourceJNI.session_n_get(sessionPtr);
            Log.d(TAG, "analysisResult: code=" + code + ", scorePtr=" + scorePtr + ", sessionPtr=" + sessionPtr + ", sessionCount=" + sessionCountBefore);

            if (scorePtr == 0) {
                if (sessionCountBefore > 0) {
                    // Some native builds populate session directly and leave analysisResult.score null.
                    Log.w(TAG, "score pointer is null but session already has " + sessionCountBefore + " score(s); continuing with export");
                } else if (code == 2) {
                    throw new Exception("No music content detected in image");
                } else if (code == 203 || code == 205) {
                    throw new RetryableAnalyzeException("No score produced (result code=" + code + ")", code);
                } else {
                    throw new Exception("No score produced (result code=" + code + ")");
                }
            } else {
                JniSourceJNI.sessionAdd(sessionPtr, null, scorePtr, null);
                Log.d(TAG, "sessionAdd: done");

                int sessionCountAfterAdd = JniSourceJNI.session_n_get(sessionPtr);
                Log.d(TAG, "session count after add=" + sessionCountAfterAdd);

                if (sessionCountAfterAdd <= sessionCountBefore) {
                    JniSourceJNI.sessionInsert(sessionPtr, null, scorePtr, null, 0);
                    Log.d(TAG, "sessionInsert fallback: done");
                }
            }

            int sessionCountAfterInsert = JniSourceJNI.session_n_get(sessionPtr);
            Log.d(TAG, "session count before export=" + sessionCountAfterInsert);

            if (sessionCountAfterInsert <= 0) {
                throw new Exception("No score available in session for export");
            }

            File outFile = File.createTempFile("zemsky_", ".xml", tmpDir);
            try {
                Log.d(TAG, "exportToMusicXml: outFile=" + outFile.getAbsolutePath());
                int exportOk = 0;
                int[] voiceFilters = new int[] { -1, 0, 1 };
                int[] divisionsCandidates = new int[] { 2, 4, 1 };

                for (int divisions : divisionsCandidates) {
                    if (exportOk != 0) break;
                    for (int voiceFilter : voiceFilters) {
                        exportOk = JniSourceJNI.exportToMusicXml(
                            outFile.getAbsolutePath(),
                            sessionPtr,
                            null,
                            "Scanned Score",
                            "Piano",
                            1,
                            0,
                            4,
                            divisions,
                            voiceFilter
                        );
                        Log.d(TAG, "exportToMusicXml attempt: divisions=" + divisions + ", voiceFilter=" + voiceFilter + ", returned=" + exportOk);
                        if (exportOk != 0) {
                            break;
                        }
                    }
                }

                long outSize = 0;
                try {
                    outSize = Files.size(outFile.toPath());
                } catch (Exception ignored) {
                    // Keep outSize as 0 and fail below if file is empty.
                }

                // In this binary, exportToMusicXml may return 0 even when XML output is written.
                if (exportOk == 0 && outSize > 0) {
                    Log.w(TAG, "exportToMusicXml returned 0 but output file has " + outSize + " bytes; accepting output");
                }

                byte[] bytes = Files.readAllBytes(outFile.toPath());
                if (bytes.length == 0) {
                    throw new Exception("exportToMusicXml failed (empty output)");
                }
                String xml = new String(bytes, StandardCharsets.UTF_8);
                if (!xml.contains("<score-partwise")) {
                    throw new Exception("exportToMusicXml failed (invalid XML output)");
                }
                return xml;
            } finally {
                //noinspection ResultOfMethodCallIgnored
                outFile.delete();
            }
        } finally {
            JniSourceJNI.delete_analysisResult(resultPtr);
            JniSourceJNI.sessionDestroy(sessionPtr);
            if (rotatedImage != null) {
                //noinspection ResultOfMethodCallIgnored
                rotatedImage.delete();
            }
            if (preparedImage != null) {
                //noinspection ResultOfMethodCallIgnored
                preparedImage.delete();
            }
        }
    }

    private File prepareInputImage(String imagePath) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(imagePath, bounds);

            int width = bounds.outWidth;
            int height = bounds.outHeight;
            if (width <= 0 || height <= 0) {
                return null;
            }

            int maxSide = Math.max(width, height);
            int sampleSize = 1;
            while ((maxSide / sampleSize) > MAX_NATIVE_IMAGE_SIDE) {
                sampleSize <<= 1;
            }

            BitmapFactory.Options decode = new BitmapFactory.Options();
            decode.inSampleSize = sampleSize;
            decode.inPreferredConfig = Bitmap.Config.ARGB_8888;
            Bitmap bitmap = BitmapFactory.decodeFile(imagePath, decode);
            if (bitmap == null) {
                return null;
            }

            bitmap = applyExifOrientation(imagePath, bitmap);

            Bitmap gray = Bitmap.createBitmap(bitmap.getWidth(), bitmap.getHeight(), Bitmap.Config.ARGB_8888);
            try {
                Canvas canvas = new Canvas(gray);
                Paint paint = new Paint();
                ColorMatrix matrix = new ColorMatrix();
                matrix.setSaturation(0f);
                paint.setColorFilter(new ColorMatrixColorFilter(matrix));
                canvas.drawBitmap(bitmap, 0f, 0f, paint);
            } finally {
                bitmap.recycle();
            }

            int grayW = gray.getWidth();
            int grayH = gray.getHeight();
            int grayMaxSide = Math.max(grayW, grayH);
            if (grayMaxSide < MIN_NATIVE_IMAGE_SIDE) {
                float upscale = (float) MIN_NATIVE_IMAGE_SIDE / (float) grayMaxSide;
                int upW = Math.max(1, Math.round(grayW * upscale));
                int upH = Math.max(1, Math.round(grayH * upscale));
                Bitmap upscaled = Bitmap.createScaledBitmap(gray, upW, upH, true);
                gray.recycle();
                gray = upscaled;
                Log.i(TAG, "Upscaled input for native OMR: " + grayW + "x" + grayH + " -> " + upW + "x" + upH);
            }

            File out = File.createTempFile("zemsky_input_", ".jpg", tmpDir);
            int preparedW = gray.getWidth();
            int preparedH = gray.getHeight();
            try (FileOutputStream fos = new FileOutputStream(out)) {
                gray.compress(Bitmap.CompressFormat.JPEG, 92, fos);
            } finally {
                gray.recycle();
            }

            Log.i(TAG, "Normalized input " + width + "x" + height + " -> " + out.getAbsolutePath() +
                " (sample=" + sampleSize + ", grayscale=" + true + ", prepared=" + preparedW + "x" + preparedH + ")");
            return out;
        } catch (Exception e) {
            Log.w(TAG, "Input normalization skipped: " + e.getMessage());
            return null;
        }
    }

    private File createRotatedCopy(String imagePath, int rotationDeg) {
        try {
            Bitmap bitmap = BitmapFactory.decodeFile(imagePath);
            if (bitmap == null) {
                return null;
            }

            Matrix matrix = new Matrix();
            matrix.postRotate(rotationDeg);
            Bitmap rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
            if (rotated != bitmap) {
                bitmap.recycle();
            }

            File out = File.createTempFile("zemsky_rot_", ".jpg", tmpDir);
            try (FileOutputStream fos = new FileOutputStream(out)) {
                rotated.compress(Bitmap.CompressFormat.JPEG, 94, fos);
            } finally {
                rotated.recycle();
            }
            return out;
        } catch (Exception e) {
            Log.w(TAG, "Forced-rotation retry skipped: " + e.getMessage());
            return null;
        }
    }

    private Bitmap applyExifOrientation(String imagePath, Bitmap bitmap) {
        try {
            ExifInterface exif = new ExifInterface(imagePath);
            int orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);

            Matrix matrix = new Matrix();
            switch (orientation) {
                case ExifInterface.ORIENTATION_ROTATE_90:
                    matrix.postRotate(90f);
                    break;
                case ExifInterface.ORIENTATION_ROTATE_180:
                    matrix.postRotate(180f);
                    break;
                case ExifInterface.ORIENTATION_ROTATE_270:
                    matrix.postRotate(270f);
                    break;
                case ExifInterface.ORIENTATION_FLIP_HORIZONTAL:
                    matrix.postScale(-1f, 1f);
                    break;
                case ExifInterface.ORIENTATION_FLIP_VERTICAL:
                    matrix.postScale(1f, -1f);
                    break;
                case ExifInterface.ORIENTATION_TRANSPOSE:
                    matrix.postRotate(90f);
                    matrix.postScale(-1f, 1f);
                    break;
                case ExifInterface.ORIENTATION_TRANSVERSE:
                    matrix.postRotate(270f);
                    matrix.postScale(-1f, 1f);
                    break;
                default:
                    return bitmap;
            }

            Bitmap rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
            if (rotated != bitmap) {
                bitmap.recycle();
            }
            Log.i(TAG, "Applied EXIF orientation " + orientation + " -> " + rotated.getWidth() + "x" + rotated.getHeight());
            return rotated;
        } catch (Exception e) {
            Log.w(TAG, "EXIF orientation normalization skipped: " + e.getMessage());
            return bitmap;
        }
    }

    private void validateAssets() throws Exception {
        if (!templatesDir.exists()) {
            throw new Exception("Templates directory not found: " + templatesDir.getAbsolutePath());
        }
        File[] templates = templatesDir.listFiles();
        if (templates == null || templates.length == 0) {
            throw new Exception("Templates directory is empty: " + templatesDir.getAbsolutePath());
        }
        Log.d(TAG, "  Templates: " + templates.length + " files");

        if (!ocrModelPath.exists()) {
            throw new Exception("OCR model not found: " + ocrModelPath.getAbsolutePath());
        }
        if (!keySigCModelPath.exists()) {
            throw new Exception("KeySig C model not found: " + keySigCModelPath.getAbsolutePath());
        }
        if (!keySigDigitModelPath.exists()) {
            throw new Exception("KeySig Digit model not found: " + keySigDigitModelPath.getAbsolutePath());
        }
        Log.d(TAG, "  Models: all present");
    }

}
