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
import { AudiverisService } from '../services/AudiverisService';

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
  const [audiverisUrl, setAudiverisUrl] = useState(AudiverisService.getServerUrl());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // Preprocessing preview state
  const [previewOriginal, setPreviewOriginal] = useState(null);
  const [previewProcessed, setPreviewProcessed] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [fullscreenImage, setFullscreenImage] = useState(null);

  const handleSave = () => {
    const url = audiverisUrl.trim();
    if (!url) { Alert.alert('Invalid URL', 'Please enter a server URL'); return; }
    AudiverisService.setServerUrl(url);
    Alert.alert('Saved', 'Server URL updated');
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    AudiverisService.setServerUrl(audiverisUrl.trim());
    const result = await AudiverisService.checkHealth();
    setTestResult(result);
    setTesting(false);
  };

  const handlePreviewPreprocess = async () => {
    try {
      const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permissionResult.granted) {
        Alert.alert('Permission Required', 'Permission to access photos is required');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 1,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) return;

      const asset = result.assets[0];
      setPreviewOriginal(asset.uri);
      setPreviewProcessed(null);
      setPreviewError(null);
      setPreviewing(true);

      try {
        const processedDataUri = await AudiverisService.debugPreprocess(asset.uri);
        setPreviewProcessed(processedDataUri);
      } catch (e) {
        setPreviewError(e.message);
      } finally {
        setPreviewing(false);
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to pick image: ' + (err.message || err));
    }
  };

  const handlePreviewFromCamera = async () => {
    try {
      const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
      if (!permissionResult.granted) {
        Alert.alert('Permission Required', 'Permission to access camera is required');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 1,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) return;

      const asset = result.assets[0];
      setPreviewOriginal(asset.uri);
      setPreviewProcessed(null);
      setPreviewError(null);
      setPreviewing(true);

      try {
        const processedDataUri = await AudiverisService.debugPreprocess(asset.uri);
        setPreviewProcessed(processedDataUri);
      } catch (e) {
        setPreviewError(e.message);
      } finally {
        setPreviewing(false);
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to take photo: ' + (err.message || err));
    }
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

          <View style={[styles.engineCard, styles.engineCardActive]}>
            <View style={styles.engineHeader}>
              <View style={[styles.radioOuter, styles.radioOuterActive]}>
                <View style={styles.radioInner} />
              </View>
              <Text style={[styles.engineName, styles.engineNameActive]}>
                Audiveris
              </Text>
            </View>
            <Text style={styles.engineDesc}>
              Full-featured OMR. Detects notes, dynamics, articulations, repeats, and lyrics.
            </Text>
            <Text style={styles.engineVersion}>v5.9.0 • Advanced preprocessing</Text>
          </View>
        </View>

        {/* Server Configuration */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Feather name="server" size={18} color={palette.ink} />
            <Text style={styles.sectionTitle}>Audiveris Server</Text>
          </View>
          <Text style={styles.sectionDescription}>
            Audiveris is a full-featured OMR engine with advanced image preprocessing
            (perspective correction, deskew, adaptive binarization, noise removal).
          </Text>

          <Text style={styles.label}>Server URL</Text>
          <TextInput
            style={styles.input}
            value={audiverisUrl}
            onChangeText={setAudiverisUrl}
            placeholder="http://localhost:8082"
            placeholderTextColor="#B5B0A5"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <View style={styles.buttonRow}>
            <TouchableOpacity style={styles.button} onPress={handleTest} disabled={testing}>
              {testing ? (
                <ActivityIndicator size="small" color={palette.ink} />
              ) : (
                <Feather name="wifi" size={14} color={palette.ink} />
              )}
              <Text style={styles.buttonText}>
                {testing ? 'Testing...' : 'Test Connection'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.button, styles.saveButton]} onPress={handleSave}>
              <Feather name="save" size={14} color={palette.ink} />
              <Text style={styles.buttonText}>Save</Text>
            </TouchableOpacity>
          </View>

          {testResult && (
            <View style={[
              styles.resultBox,
              testResult.ok ? styles.resultOk : styles.resultFail,
            ]}>
              <Feather
                name={testResult.ok ? 'check-circle' : 'alert-circle'}
                size={16}
                color={testResult.ok ? palette.success : palette.danger}
              />
              <Text style={[
                styles.resultText,
                { color: testResult.ok ? palette.success : palette.danger },
              ]}>
                {testResult.message}
              </Text>
            </View>
          )}
        </View>

        {/* Docker Setup Help */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Feather name="terminal" size={18} color={palette.ink} />
            <Text style={styles.sectionTitle}>Quick Setup</Text>
          </View>

          <Text style={styles.sectionDescription}>
            Run the Audiveris server with Docker:
          </Text>
          <View style={styles.codeBlock}>
            <Text style={styles.codeText} selectable>
              cd audiveris-server{'\n'}
              docker build -t audiveris-server .{'\n'}
              docker run --rm -p 8082:8000 audiveris-server
            </Text>
          </View>

          <Text style={styles.hint}>
            If running on a physical device, replace "localhost" with your
            computer's IP address (e.g., 192.168.1.xxx).
          </Text>
        </View>

        {/* Preprocessing Preview */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Feather name="eye" size={18} color={palette.ink} />
            <Text style={styles.sectionTitle}>Preview Preprocessing</Text>
          </View>

          <Text style={styles.sectionDescription}>
            See how your photo looks after the server preprocesses it.
            This is exactly what Audiveris receives for recognition.
          </Text>

          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={styles.button}
              onPress={handlePreviewPreprocess}
              disabled={previewing}
            >
              <Feather name="image" size={14} color={palette.ink} />
              <Text style={styles.buttonText}>From Photos</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.button}
              onPress={handlePreviewFromCamera}
              disabled={previewing}
            >
              <Feather name="camera" size={14} color={palette.ink} />
              <Text style={styles.buttonText}>From Camera</Text>
            </TouchableOpacity>
          </View>

          {previewing && (
            <View style={styles.previewLoading}>
              <ActivityIndicator size="small" color={palette.accent} />
              <Text style={styles.previewLoadingText}>Preprocessing image...</Text>
            </View>
          )}

          {previewError && (
            <View style={[styles.resultBox, styles.resultFail, { marginTop: 12 }]}>
              <Feather name="alert-circle" size={16} color={palette.danger} />
              <Text style={[styles.resultText, { color: palette.danger }]}>
                {previewError}
              </Text>
            </View>
          )}

          {previewOriginal && (
            <View style={styles.previewContainer}>
              <Text style={styles.previewLabel}>ORIGINAL</Text>
              <TouchableOpacity onPress={() => setFullscreenImage(previewOriginal)}>
                <Image
                  source={{ uri: previewOriginal }}
                  style={styles.previewImage}
                  resizeMode="contain"
                />
              </TouchableOpacity>

              {previewProcessed && (
                <>
                  <Text style={[styles.previewLabel, { marginTop: 12 }]}>AFTER PREPROCESSING</Text>
                  <TouchableOpacity onPress={() => setFullscreenImage(previewProcessed)}>
                    <Image
                      source={{ uri: previewProcessed }}
                      style={styles.previewImage}
                      resizeMode="contain"
                    />
                  </TouchableOpacity>
                  <Text style={styles.hint}>
                    Tap either image to view fullscreen
                  </Text>
                </>
              )}
            </View>
          )}
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
