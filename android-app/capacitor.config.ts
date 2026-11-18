import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ke.co.etech.swass',
  appName: 'AURORA E-RECEIPT',
  webDir: '../frontend',
  server: {
    url: 'https://swass-web.onrender.com',
    cleartext: false
  },
  android: {
    allowMixedContent: false
  }
};

export default config;
