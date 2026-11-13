// Adds Firebase (FCM push) only when google-services.json is present, and lets EXPO_PUBLIC_API_URL override the API URL.
const fs = require('fs');
module.exports = ({ config }) => ({
  ...config,
  android: { ...config.android, ...(fs.existsSync('./google-services.json') ? { googleServicesFile: './google-services.json' } : {}) },
  extra: { ...config.extra, apiUrl: process.env.EXPO_PUBLIC_API_URL ?? config.extra.apiUrl },
});
