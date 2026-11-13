/// <reference types="vite/client" />

import type { DiskOrganizerApi } from '@shared/api';

declare global {
  interface Window {
    api: DiskOrganizerApi;
  }
}

export {};
