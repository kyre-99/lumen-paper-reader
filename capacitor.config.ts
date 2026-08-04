import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'online.wenshupaper.app',
  appName: '文枢',
  // App 直接加载线上站点：网页端更新即 App 更新，无需发版。
  // webDir 仅占位（cap add/sync 要求存在），实际页面来自 server.url。
  webDir: 'public',
  backgroundColor: '#F7FBF8',
  server: {
    url: 'https://wenshupaper.online',
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
