import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { SvgXml } from 'react-native-svg';
import { HOMRService } from '../services/HOMRService';

const logoXml = `
<svg width="160" height="120" viewBox="0 0 160 120" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 60C30 32 58 20 88 20C118 20 146 32 164 60C146 88 118 100 88 100C58 100 30 88 12 60Z" fill="#F1EEE4" stroke="#3E3C37" stroke-width="3"/>
  <circle cx="78" cy="60" r="9" fill="#3E3C37"/>
  <path d="M108 40V76C108 80.9 104 84.9 99.1 84.9C94.2 84.9 90.2 80.9 90.2 76C90.2 71.1 94.2 67.1 99.1 67.1C100.8 67.1 102.4 67.5 103.8 68.2V40H108Z" fill="#3E3C37"/>
</svg>
`;

export const HomeScreen = ({ onNavigate, onPickFromGallery, onPickFromCamera }) => {
  const [serverStatus, setServerStatus] = useState(null); // null = checking, true = ok, false = down

  useEffect(() => {
    checkServer();
  }, []);

  const checkServer = async () => {
    setServerStatus(null);
    const result = await HOMRService.checkHealth();
    setServerStatus(result.ok);
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9F7F1" />

      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.title}>Music Eye</Text>
          <SvgXml xml={logoXml} width={72} height={48} />
        </View>
        <Text style={styles.subtitle}>Scan and play sheet music in seconds</Text>

        {/* Server status indicator */}
        <TouchableOpacity style={styles.statusRow} onPress={checkServer}>
          <View style={[
            styles.statusDot,
            serverStatus === null ? styles.statusChecking :
            serverStatus ? styles.statusOk : styles.statusDown,
          ]} />
          <Text style={styles.statusText}>
            {serverStatus === null ? 'Checking HOMR server...' :
             serverStatus ? 'HOMR server connected' : 'HOMR server unreachable'}
          </Text>
          <Feather name="refresh-cw" size={12} color="#6E675E" style={{ marginLeft: 4 }} />
        </TouchableOpacity>
      </View>

      <View style={styles.content}>
        <View style={styles.buttonContainer}>
          {/* Scan from Camera */}
          <TouchableOpacity
            style={styles.actionButton}
            onPress={onPickFromCamera}
          >
            <View style={styles.buttonIconWrap}>
              <Feather name="camera" size={20} color="#3E3C37" />
            </View>
            <Text style={styles.buttonTitle}>Scan from Camera</Text>
          </TouchableOpacity>

          {/* Upload Image */}
          <TouchableOpacity
            style={styles.actionButton}
            onPress={onPickFromGallery}
          >
            <View style={styles.buttonIconWrap}>
              <Feather name="image" size={20} color="#3E3C37" />
            </View>
            <Text style={styles.buttonTitle}>Scan from Photos</Text>
          </TouchableOpacity>

          {/* Upload PDF/Files */}
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => onNavigate('upload-file')}
          >
            <View style={styles.buttonIconWrap}>
              <Feather name="download" size={20} color="#3E3C37" />
            </View>
            <Text style={styles.buttonTitle}>Scan from Files</Text>
          </TouchableOpacity>

          {/* Browse Scanned Music */}
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => onNavigate('library')}
          >
            <View style={styles.buttonIconWrap}>
              <Feather name="music" size={20} color="#3E3C37" />
            </View>
            <Text style={styles.buttonTitle}>Browse Scanned Music</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Footer Actions */}
      <View style={styles.footerContainer}>
        <View style={styles.footer}>
          <TouchableOpacity
            style={styles.footerAction}
            onPress={() => onNavigate('settings')}
          >
            <Feather name="settings" size={20} color="#3E3C37" />
            <Text style={styles.footerText}>Settings</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.footerAction}
            onPress={() => onNavigate('help')}
          >
            <Feather name="help-circle" size={20} color="#3E3C37" />
            <Text style={styles.footerText}>Help</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9F7F1',
  },
  header: {
    paddingTop: 72,
    paddingBottom: 28,
    paddingHorizontal: 24,
    gap: 8,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    fontSize: 36,
    lineHeight: 40,
    fontWeight: '800',
    color: '#3E3C37',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 14,
    color: '#6E675E',
    letterSpacing: 0.2,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusChecking: {
    backgroundColor: '#F0AD4E',
  },
  statusOk: {
    backgroundColor: '#5CB85C',
  },
  statusDown: {
    backgroundColor: '#D9534F',
  },
  statusText: {
    fontSize: 12,
    color: '#6E675E',
    fontWeight: '600',
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    paddingBottom: 20,
  },
  buttonContainer: {
    marginTop: 8,
    marginBottom: 28,
    gap: 12,
  },
  actionButton: {
    backgroundColor: '#FBFAF5',
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#D6D0C4',
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  buttonIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#D6D0C4',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F1EEE4',
  },
  buttonTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#3E3C37',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  footerContainer: {
    paddingHorizontal: 24,
    paddingBottom: 24,
    paddingTop: 8,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  footerText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#5C574E',
  },
});
