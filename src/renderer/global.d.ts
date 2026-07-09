import type { PreloadApi } from '../preload/preload';

declare global {
  interface Window {
    api: PreloadApi;
  }
}

export {};
