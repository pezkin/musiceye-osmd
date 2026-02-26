import React, { useState, useEffect } from 'react';
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
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { HOMRService } from '../services/HOMRService';

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
  const [serverUrl, setServerUrl] = useState(HOMRService.getServerUrl());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const handleSave = () => {
    const url = serverUrl.trim();
    if (!url) {
      Alert.alert('Invalid URL', 'Please enter a server URL');
      return;
    }
    HOMRService.setServerUrl(url);
    Alert.alert('Saved', 'HOMR server URL updated');
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    HOMRService.setServerUrl(serverUrl.trim());
    const result = await HOMRService.checkHealth();
    setTestResult(result);
    setTesting(false);
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
        {/* HOMR Server Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Feather name="server" size={18} color={palette.ink} />
            <Text style={styles.sectionTitle}>HOMR Server</Text>
          </View>
          <Text style={styles.sectionDescription}>
            Music Eye sends sheet music images to a HOMR server for recognition.
            The server processes the image and returns MusicXML data.
          </Text>

          <Text style={styles.label}>Server URL</Text>
          <TextInput
            style={styles.input}
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="http://localhost:8080"
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
            Run the HOMR server with Docker:
          </Text>
          <View style={styles.codeBlock}>
            <Text style={styles.codeText} selectable>
              docker build -t homr .{'\n'}
              docker run --rm -p 8080:8000 homr
            </Text>
          </View>
          <Text style={styles.sectionDescription}>
            Or use the pre-built image if available:
          </Text>
          <View style={styles.codeBlock}>
            <Text style={styles.codeText} selectable>
              docker run --rm -p 8080:8000 ghcr.io/liebharc/homr
            </Text>
          </View>
          <Text style={styles.hint}>
            If running on a physical device, replace "localhost" with your
            computer's IP address (e.g., 192.168.1.xxx).
          </Text>
        </View>
      </ScrollView>
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
});
