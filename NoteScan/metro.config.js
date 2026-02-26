const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add .sf2 to the list of asset extensions so Metro can bundle SoundFont files
config.resolver.assetExts.push('sf2');

module.exports = config;
