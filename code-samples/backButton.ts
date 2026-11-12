// Excerpt from the Al-Mizan codebase (private repository).
// Original path: client/src/platform/backButton.ts
// Shared for portfolio review. Copyright (c) 2026 Rashad Eideh. All rights reserved.

import { getNativePlatform } from './native';

/**
 * NAV-01 — the Android Back adapter.
 *
 * WHY A PLUGIN IS NEEDED AT ALL. `@capacitor/android` 7.x registers no
 * `OnBackPressedCallback`, so without one the activity's default Back runs and
 * FINISHES the app on every press — the owner's report. The official
 * `@capacitor/app` 7.x plugin registers an always-enabled callback: while a JS
 * `backButton` listener exists it only notifies JS; with none it calls
 * `webView.goBack()` when it can and otherwise does nothing. It never finishes
 * the activity on its own. `exitApp()` is the only exit, and only the explicit
 * confirmation calls it.
 *
 * KEYBOARD. The soft keyboard is an IME window: Android hands Back to the IME
 * first, which hides itself and consumes the event, so no `backButton` reaches
 * JS for that press. Nothing here infers keyboard state (phone check K1).
 *
 * Android-only and reached by dynamic `import()` — the plugin stays out of the
 * web bundle, and a browser session never attempts to exit anything.
 */

type Release = () => void;

export function nativeBackAvailable(): boolean {
  return getNativePlatform() === 'android';
}

/**
 * Subscribe to hardware / gesture Back. Returns a synchronous release that is
 * safe to call before the asynchronous registration has resolved: a handle that
 * arrives after release is removed at once, so StrictMode's mount → unmount →
 * mount cannot strand a listener.
 */
export function subscribeNativeBack(onBack: () => void): Release {
  if (!nativeBackAvailable()) return () => {};
  let released = false;
  let remove: (() => Promise<void>) | null = null;

  void import('@capacitor/app')
    .then(({ App }) => App.addListener('backButton', () => onBack()))
    .then((handle) => {
      if (released) void handle.remove();
      else remove = () => handle.remove();
    })
    .catch(() => {
      // Plugin missing or bridge not ready: the native callback then does
      // nothing on Back (see above), which is safe; there is nothing to undo.
    });

  return () => {
    released = true;
    if (remove) {
      const pending = remove;
      remove = null;
      void pending().catch(() => {});
    }
  };
}

/** Close the Android app. Called ONLY from the explicit exit confirmation. */
export async function exitNativeApp(): Promise<void> {
  if (!nativeBackAvailable()) return;
  const { App } = await import('@capacitor/app');
  await App.exitApp();
}
