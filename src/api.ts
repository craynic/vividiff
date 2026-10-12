import { invoke } from '@tauri-apps/api/core';
export async function rpc<T>(method: string, params: unknown = {}): Promise<T> {
  if ('__TAURI_INTERNALS__' in window) return invoke<T>('rpc', { method, params });
  // Browser transport is a test/development adapter only. Production has no HTTP token in the webview.
  if ((import.meta.env.DEV || import.meta.env.MODE === 'e2e') && import.meta.env.VITE_TEST_RPC) {
    const response = await fetch(import.meta.env.VITE_TEST_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
    const value = await response.json();
    if (value.error) throw new Error(value.error.message);
    return value.result;
  }
  throw new Error('DESKTOP_REQUIRED: run npm run desktop:dev');
}
