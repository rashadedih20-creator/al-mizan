// Excerpt from the Al-Mizan codebase (private repository).
// Original path: client/src/features/pos/nativeScanner.ts
// Shared for portfolio review. Copyright (c) 2026 Rashad Eideh. All rights reserved.

import { isNativeRuntime } from '../../platform/native';

/**
 * The ML Kit adapter — the ONLY file in the client that knows the barcode
 * plugin exists.
 *
 * The plugin is reached through a dynamic `import()` rather than a top-level
 * one. Vite then code-splits it into a chunk the web build never fetches, so
 * the browser bundle does not carry a bridge it can never call, and a plugin
 * that assumes an Android runtime cannot break `npm run build`.
 */

/**
 * How long the native event stream must stay quiet before the decode pipeline
 * re-arms.
 *
 * ⚠️ THIS IS THE STRUCTURAL EQUIVALENT OF THE WEB BRANCH'S EMPTY FRAME, AND
 * THE WHOLE REASON IT EXISTS.
 *
 * `BarcodeScannerOverlay`'s web pump re-arms when a decode cycle returns an
 * EMPTY RESULT ARRAY — the product left the reticle, so the next sighting of
 * the same barcode is a deliberate scan of a second unit. Native ML Kit has no
 * such signal: it fires an event on every frame that CONTAINS a barcode and
 * fires NOTHING on a clear frame.
 *
 * Without this timer `rearmedRef` never returns to `true` after a commit, and
 * the failure runs in the UNDER-counting direction: a cashier ringing up three
 * identical cans gets ONE on the receipt. The second and third are refused by
 * the re-arm guard, silently, with no toast and no beep to say so — the shop
 * undercharges and nothing anywhere reports it. (The duplicate direction is
 * already safe: while events keep arriving, `code === lastCodeRef` holds the
 * guard shut.)
 *
 * 300ms is roughly nine frames at 30fps: long enough that a run of dropped
 * frames on a barcode still in the reticle does not falsely re-arm, short
 * enough that lifting one unit and presenting the next re-arms before the
 * cashier gets there. A false re-arm is bounded by the 1.2s cooldown to at
 * most one extra scan, which is the cheaper direction to err in.
 */
export const REARM_SILENCE_MS = 300;

export type NativeStartFailure = 'unsupported' | 'denied';

export type NativeStartResult =
  | { ok: true; torchAvailable: boolean }
  | { ok: false; reason: NativeStartFailure };

export interface NativeScanOptions {
  /**
   * The symbologies to decode, in the web `BarcodeDetector` spelling. Passed
   * down from the overlay rather than redeclared here, so the two engines
   * cannot drift into accepting different barcode types — a divergence that
   * would show up as "this label scans on my desk but not on the handset".
   */
  formats: readonly string[];
  onBarcode: (code: string) => void;
  onSilence: () => void;
}

type ScannerModule = typeof import('@capacitor-mlkit/barcode-scanning');
type BarcodeFormatValue = import('@capacitor-mlkit/barcode-scanning').BarcodeFormat;
type ListenerHandle = { remove: () => Promise<void> };

let activeListener: ListenerHandle | null = null;
let silenceTimer: number | null = null;

const loadPlugin = (): Promise<ScannerModule> => import('@capacitor-mlkit/barcode-scanning');

/**
 * Bridge the W3C format strings the web engine uses onto ML Kit's enum.
 *
 * An unmapped name is DROPPED rather than throwing: adding a format to the web
 * branch's list must never be able to crash the native one, and ML Kit simply
 * decodes a slightly narrower set until the mapping is filled in.
 */
function mapFormats(mod: ScannerModule, names: readonly string[]): BarcodeFormatValue[] {
  const { BarcodeFormat } = mod;
  const table: Partial<Record<string, BarcodeFormatValue>> = {
    ean_13: BarcodeFormat.Ean13,
    ean_8: BarcodeFormat.Ean8,
    upc_a: BarcodeFormat.UpcA,
    upc_e: BarcodeFormat.UpcE,
    code_128: BarcodeFormat.Code128,
    code_39: BarcodeFormat.Code39,
    itf: BarcodeFormat.Itf,
    qr_code: BarcodeFormat.QrCode,
  };
  return names
    .map((name) => table[name])
    .filter((format): format is BarcodeFormatValue => format !== undefined);
}

function clearSilenceTimer(): void {
  if (silenceTimer !== null) {
    window.clearTimeout(silenceTimer);
    silenceTimer = null;
  }
}

function armSilenceTimer(onSilence: () => void): void {
  clearSilenceTimer();
  silenceTimer = window.setTimeout(() => {
    silenceTimer = null;
    onSilence();
  }, REARM_SILENCE_MS);
}

/**
 * Open the native camera and begin streaming decoded barcodes.
 *
 * Torch availability is reported in the START RESULT rather than through a
 * separate exported probe: it can only be answered once the camera session is
 * open, and the overlay needs it exactly once, so folding it in here keeps the
 * call ordering impossible to get wrong from outside.
 */
export async function startNativeScan(options: NativeScanOptions): Promise<NativeStartResult> {
  if (!isNativeRuntime()) return { ok: false, reason: 'unsupported' };

  const mod = await loadPlugin();
  const { BarcodeScanner, LensFacing } = mod;

  // A handset without Google Play services, or one where the bundled scanner
  // module failed to load. Distinct from a refusal: there is nothing to grant.
  const { supported } = await BarcodeScanner.isSupported();
  if (!supported) return { ok: false, reason: 'unsupported' };

  let { camera } = await BarcodeScanner.checkPermissions();
  if (camera !== 'granted') {
    ({ camera } = await BarcodeScanner.requestPermissions());
  }
  if (camera !== 'granted') return { ok: false, reason: 'denied' };

  // The listener is attached BEFORE `startScan`, not after. ML Kit begins
  // emitting as soon as the analyzer has a frame, so a listener registered
  // afterwards drops whatever was decoded during camera warm-up — which is
  // precisely the barcode a cashier already had in front of the lens when they
  // opened the scanner.
  activeListener = await BarcodeScanner.addListener('barcodesScanned', (event) => {
    // Every event is proof a barcode is in frame, so it postpones the re-arm.
    armSilenceTimer(options.onSilence);

    // First non-empty value, mirroring the web pump's `results.find(...)`.
    for (const barcode of event.barcodes) {
      const code = barcode.rawValue?.trim();
      if (code) {
        options.onBarcode(code);
        return;
      }
    }
  });

  await BarcodeScanner.startScan({
    formats: mapFormats(mod, options.formats),
    lensFacing: LensFacing.Back,
  });

  let torchAvailable = false;
  try {
    ({ available: torchAvailable } = await BarcodeScanner.isTorchAvailable());
  } catch {
    // A device that will not answer the question has no torch to offer.
    torchAvailable = false;
  }

  return { ok: true, torchAvailable };
}

/**
 * Tear the native scan down. Safe to call when nothing was ever started, which
 * is the ordinary case after a permission refusal.
 */
export async function stopNativeScan(): Promise<void> {
  clearSilenceTimer();

  const listener = activeListener;
  activeListener = null;

  if (!isNativeRuntime()) return;

  const { BarcodeScanner } = await loadPlugin();

  // ⚠️ TORCH OFF FIRST, BEFORE `stopScan`. `disableTorch` needs the camera
  // session still open; called afterwards it throws or silently no-ops and the
  // LED stays lit after the overlay closes — a flashlight burning in the
  // merchant's pocket until they notice.
  try {
    await BarcodeScanner.disableTorch();
  } catch {
    // No torch on this device, or it was never on. Nothing to undo.
  }

  await listener?.remove();

  try {
    await BarcodeScanner.stopScan();
  } catch {
    // Already stopped — a double teardown must not surface as an error.
  }
}

export async function setTorch(on: boolean): Promise<void> {
  if (!isNativeRuntime()) return;
  const { BarcodeScanner } = await loadPlugin();
  if (on) await BarcodeScanner.enableTorch();
  else await BarcodeScanner.disableTorch();
}
