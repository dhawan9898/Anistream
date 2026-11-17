import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.anicli.stream',
  appName: 'AniStream',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: true
  },
  plugins: {
    // The app is always dark: light status / navigation bar icons whatever the phone's theme.
    SystemBars: {
      style: 'DARK',
    },
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
