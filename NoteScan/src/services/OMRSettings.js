/**
 * OMRSettings — Shared settings for OMR engine.
 * Supports two engines:
 *   - 'ondevice'  — on-device rule-based engine (no server needed)
 *   - 'zemsky'    — Android emulator harness backed by native .so files
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@omr_engine';

class OMRSettingsClass {
  _engine = 'ondevice';

  /**
   * Get the current engine name.
   * @returns {'ondevice'|'zemsky'}
   */
  getEngine() {
    return this._engine;
  }

  /** Load saved engine preference. */
  async load() {
    try {
      const saved = await AsyncStorage.getItem(STORAGE_KEY);
      if (saved === 'ondevice' || saved === 'zemsky') {
        this._engine = saved;
      }
    } catch (e) {
      // ignore — use default
    }
  }

  /** Switch engine. */
  async setEngine(engine) {
    if (engine === 'ondevice' || engine === 'zemsky') {
      this._engine = engine;
      try {
        await AsyncStorage.setItem(STORAGE_KEY, engine);
      } catch (e) {
        // ignore
      }
    }
  }

  /**
   * Get the active service instance.
   */
  getService() {
    if (this._engine === 'zemsky') {
      const { ZemskyEmulatorService } = require('./ZemskyEmulatorService');
      return ZemskyEmulatorService;
    }
    // Default to on-device
    const { OnDeviceOMRService } = require('./OnDeviceOMRService');
    return OnDeviceOMRService;
  }
}

export const OMRSettings = new OMRSettingsClass();
