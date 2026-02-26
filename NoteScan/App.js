import React, { useState } from 'react';
import { StatusBar, View, Text, TouchableOpacity, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { HomeScreen } from './src/screens/HomeScreen';
import { PlaybackScreen } from './src/screens/PlaybackScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';

export default function App() {
  const [currentScreen, setCurrentScreen] = useState('home');
  const [playbackImageUri, setPlaybackImageUri] = useState(null);

  const pickImageFromGallery = async () => {
    try {
      const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permissionResult.granted) {
        Alert.alert('Permission Required', 'Permission to access gallery is required!');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 1,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      setPlaybackImageUri(asset.uri);
      setCurrentScreen('playback');
    } catch (err) {
      console.error('Error picking image:', err?.message || err);
      Alert.alert('Error', 'Failed to pick image. Please try again.');
    }
  };

  const pickImageFromCamera = async () => {
    try {
      const permissionResult = await ImagePicker.requestCameraPermissionsAsync();

      if (!permissionResult.granted) {
        Alert.alert('Permission Required', 'Permission to access camera is required!');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 1,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      setPlaybackImageUri(asset.uri);
      setCurrentScreen('playback');
    } catch (err) {
      console.error('Error capturing image:', err?.message || err);
      Alert.alert('Error', 'Failed to capture image. Please try again.');
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9F7F1" />
      {currentScreen === 'home' ? (
        <HomeScreen
          onNavigate={setCurrentScreen}
          onPickFromGallery={pickImageFromGallery}
          onPickFromCamera={pickImageFromCamera}
        />
      ) : currentScreen === 'playback' ? (
        <PlaybackScreen
          imageUri={playbackImageUri}
          onNavigateBack={() => setCurrentScreen('home')}
        />
      ) : currentScreen === 'settings' ? (
        <SettingsScreen
          onNavigateBack={() => setCurrentScreen('home')}
        />
      ) : currentScreen === 'upload-file' ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9F7F1' }}>
          <Text style={{ fontSize: 18, color: '#3E3C37', marginBottom: 20 }}>📄 Upload Files</Text>
          <Text style={{ fontSize: 14, color: '#6E675E', marginBottom: 20 }}>Coming soon...</Text>
          <TouchableOpacity onPress={() => setCurrentScreen('home')}>
            <Text style={{ color: '#6E675E', fontSize: 16, fontWeight: '600' }}>← Back to Home</Text>
          </TouchableOpacity>
        </View>
      ) : currentScreen === 'help' ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9F7F1' }}>
          <Text style={{ fontSize: 18, color: '#3E3C37', marginBottom: 20 }}>❓ Help</Text>
          <Text style={{ fontSize: 14, color: '#6E675E', marginBottom: 20, paddingHorizontal: 24, textAlign: 'center' }}>
            Music Eye uses the HOMR (Homer's Optical Music Recognition) server to scan
            sheet music images and convert them to playable notes.{'\n\n'}
            1. Take a photo or pick an image of sheet music{'\n'}
            2. The image is sent to the HOMR server for analysis{'\n'}
            3. The returned MusicXML is converted to playable audio{'\n\n'}
            Configure the HOMR server URL in Settings.
          </Text>
          <TouchableOpacity onPress={() => setCurrentScreen('home')}>
            <Text style={{ color: '#6E675E', fontSize: 16, fontWeight: '600' }}>← Back to Home</Text>
          </TouchableOpacity>
        </View>
      ) : currentScreen === 'library' ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9F7F1' }}>
          <Text style={{ fontSize: 18, color: '#3E3C37', marginBottom: 20 }}>🎼 Scanned Music</Text>
          <Text style={{ fontSize: 14, color: '#6E675E', marginBottom: 20 }}>Coming soon...</Text>
          <TouchableOpacity onPress={() => setCurrentScreen('home')}>
            <Text style={{ color: '#6E675E', fontSize: 16, fontWeight: '600' }}>← Back to Home</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}
