import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  Platform,
  StatusBar,
  KeyboardAvoidingView,
  ScrollView,
  Image,
  Modal,
  Dimensions,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@expo/vector-icons';
import { ZemskyEmulatorService } from '../services/ZemskyEmulatorService';
import { OMRSettings } from '../services/OMRSettings';
import { OMRCacheService } from '../services/OMRCacheService';

const palette = {
  background: '#F9F7F1',
  surface: '#FBFAF5',
  surfaceStrong: '#F1EEE4',
  border: '#D6D0C4',
  ink: '#3E3C37',
  inkMuted: '#6E675E',
  accent: '#E05A2A',
  success: '#5CB85C',
  danger: '#D9534F',
};

export const SettingsScreen = ({ onNavigateBack }) => {
  const [engine, setEngine] = useState(OMRSettings.getEngine());
  const [fullscreenImage, setFullscreenImage] = useState(null);

  React.useEffect(() => {
    OMRSettings.load().then(() => setEngine(OMRSettings.getEngine()));
  }, []);

  const selectEngine = async (eng) => {
    await OMRSettings.setEngine(eng);
    setEngine(eng);
  };

  const handleClearCache = async () => {
    Alert.alert(
      'Clear OMR Cache?',
      'This will delete all cached OMR scan results. You\'ll need to rescan images, but it will use the latest fixes.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            try {
              await OMRCacheService.clearAll();
              Alert.alert('Success', 'OMR cache cleared. Next scan will use updated parser.');
            } catch (err) {
              Alert.alert('Error', 'Failed to clear cache: ' + (err.message || err));
            }
          }
        }
      ]
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <StatusBar barStyle="dark-content" backgroundColor={palette.background} />

      <View style={styles.header}>
        <TouchableOpacity onPress={onNavigateBack}>
          <Text style={styles.linkText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Settings</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView style={styles.scrollContent}>
        {/* OMR Engine Info */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Feather name="cpu" size={18} color={palette.ink} />
            <Text style={styles.sectionTitle}>OMR Engine</Text>
          </View>

          <View style={styles.engineRow}>
            <TouchableOpacity
              style={[styles.engineCard, engine === 'ondevice' && styles.engineCardActive]}
              onPress={() => selectEngine('ondevice')}
            >
              <View style={styles.engineHeader}>
                <View style={[styles.radioOuter, engine === 'ondevice' && styles.radioOuterActive]}>
                  {engine === 'ondevice' && <View style={styles.radioInner} />}
                </View>
                <Text style={[styles.engineName, engine === 'ondevice' && styles.engineNameActive]}>
                  On-Device
                </Text>
              </View>
              <Text style={styles.engineDesc}>
                Runs entirely on your phone. No server needed. Fast and private.
              </Text>
              <Text style={styles.engineVersion}>Rule-based • No internet required</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.engineCard, engine === 'zemsky' && styles.engineCardActive]}
              onPress={() => selectEngine('zemsky')}
            >
              <View style={styles.engineHeader}>
                <View style={[styles.radioOuter, engine === 'zemsky' && styles.radioOuterActive]}>
                  {engine === 'zemsky' && <View style={styles.radioInner} />}
                </View>
                <Text style={[styles.engineName, engine === 'zemsky' && styles.engineNameActive]}>
                  Zemsky Emulator
                </Text>
              </View>
              <Text style={styles.engineDesc}>
                Uses the separate Android harness app to run the native Zemsky .so OMR stack.
              </Text>
              <Text style={styles.engineVersion}>arm64 emulator • Native .so runtime</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Feather name="smartphone" size={18} color={palette.ink} />
            <Text style={styles.sectionTitle}>Zemsky Emulator</Text>
          </View>
          <Text style={styles.sectionDescription}>
            Default endpoint: {ZemskyEmulatorService.getServerUrl()}. Run the Zemsky Harness app in the same Android emulator, then select Zemsky Emulator here before scanning.
          </Text>
        </View>

        {/* Cache Management */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Feather name="trash-2" size={18} color={palette.ink} />
            <Text style={styles.sectionTitle}>Cache Management</Text>
          </View>
          <Text style={styles.sectionDescription}>
            OMR results are cached to avoid reprocessing. After parser updates, clear the cache to use new fixes.
          </Text>
          <TouchableOpacity style={[styles.button, styles.dangerButton]} onPress={handleClearCache}>
            <Feather name="trash-2" size={14} color="#fff" />
            <Text style={[styles.buttonText, { color: '#fff' }]}>Clear OMR Cache</Text>
          </TouchableOpacity>
        </View>

        {/* Docker Setup Help */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Feather name="terminal" size={18} color={palette.ink} />
            <Text style={styles.sectionTitle}>Quick Setup</Text>
          </View>

          <Text style={styles.sectionDescription}>
            Run the Zemsky emulator harness:
          </Text>
          <View style={styles.codeBlock}>
            <Text style={styles.codeText} selectable>
              cd ZemskyHarness{'\n'}
              ./gradlew installDebug{'\n'}
              adb shell am start -n com.musiceye.zemskyharness/.MainActivity
            </Text>
          </View>

          <Text style={styles.hint}>
            Zemsky Emulator uses a separate Android app running in the same emulator as NoteScan. On-Device engine runs entirely on your phone with no external dependencies.
          </Text>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Fullscreen image modal */}
      <Modal
        visible={!!fullscreenImage}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setFullscreenImage(null)}
      >
        <View style={styles.fullscreenOverlay}>
          <TouchableOpacity
            style={styles.fullscreenClose}
            onPress={() => setFullscreenImage(null)}
          >
            <Feather name="x" size={28} color="#fff" />
          </TouchableOpacity>
          {fullscreenImage && (
            <Image
              source={{ uri: fullscreenImage }}
              style={styles.fullscreenImage}
              resizeMode="contain"
            />
          )}
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: palette.background,
  },
  header: {
    paddingHorizontal: 24,
    paddingBottom: 12,
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 0) + 20 : 56,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: palette.background,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: palette.ink,
    letterSpacing: -0.4,
  },
  linkText: {
    fontSize: 14,
    color: palette.inkMuted,
    fontWeight: '600',
  },
  scrollContent: {
    flex: 1,
    paddingHorizontal: 24,
  },
  section: {
    marginBottom: 28,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: palette.ink,
  },
  sectionDescription: {
    fontSize: 13,
    color: palette.inkMuted,
    lineHeight: 18,
    marginBottom: 12,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: palette.ink,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  input: {
    backgroundColor: palette.surface,
    borderWidth: 2,
    borderColor: palette.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: palette.ink,
    fontWeight: '500',
    marginBottom: 12,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  button: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: palette.surface,
    borderWidth: 2,
    borderColor: palette.border,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  saveButton: {
    backgroundColor: palette.surfaceStrong,
  },
  dangerButton: {
    backgroundColor: palette.danger,
    borderColor: palette.danger,
  },
  buttonText: {
    fontSize: 12,
    fontWeight: '700',
    color: palette.ink,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  resultBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  resultOk: {
    backgroundColor: '#E8F5E9',
    borderColor: '#C8E6C9',
  },
  resultFail: {
    backgroundColor: '#FFEBEE',
    borderColor: '#FFCDD2',
  },
  resultText: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  codeBlock: {
    backgroundColor: '#2A2925',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
  codeText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    color: '#F3F1EA',
    lineHeight: 18,
  },
  hint: {
    fontSize: 12,
    color: palette.inkMuted,
    fontStyle: 'italic',
    marginTop: 4,
  },
  engineRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  engineCard: {
    flex: 1,
    backgroundColor: palette.surface,
    borderWidth: 2,
    borderColor: palette.border,
    borderRadius: 14,
    padding: 14,
  },
  engineCardActive: {
    borderColor: palette.accent,
    backgroundColor: '#FFF8F5',
  },
  engineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  radioOuter: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: palette.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOuterActive: {
    borderColor: palette.accent,
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: palette.accent,
  },
  engineName: {
    fontSize: 15,
    fontWeight: '800',
    color: palette.ink,
  },
  engineNameActive: {
    color: palette.accent,
  },
  engineDesc: {
    fontSize: 12,
    color: palette.inkMuted,
    lineHeight: 16,
    marginBottom: 4,
  },
  engineVersion: {
    fontSize: 10,
    color: palette.border,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  previewLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
    padding: 14,
    backgroundColor: '#FFF8F5',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FFE0D0',
  },
  previewLoadingText: {
    fontSize: 13,
    color: palette.accent,
    fontWeight: '600',
  },
  previewContainer: {
    marginTop: 14,
  },
  previewLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: palette.inkMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 6,
  },
  previewImage: {
    width: '100%',
    height: 260,
    backgroundColor: '#F0EDE5',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: palette.border,
  },
  fullscreenOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullscreenClose: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 56 : (StatusBar.currentHeight || 0) + 16,
    right: 20,
    zIndex: 10,
    padding: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 20,
  },
  fullscreenImage: {
    width: Dimensions.get('window').width,
    height: Dimensions.get('window').height * 0.85,
  },
});
