// Resolve the microphone Windows is set to use (Settings > Sound > Input).
//
// FFmpeg's dshow input never consults the Windows default; it only opens the
// device name it is given. Without this, recordings used whichever microphone
// FFmpeg happened to list first, which can be the laptop array instead of the
// microphone the owner selected.

import { spawn } from 'child_process';

// Core Audio: IMMDeviceEnumerator.GetDefaultAudioEndpoint(eCapture, eConsole),
// then PKEY_Device_FriendlyName, which matches the dshow audio device name.
const DEFAULT_MIC_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct PK { public Guid f; public int p; }
[StructLayout(LayoutKind.Explicit)] public struct PV { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPS { int GetCount(out int c); int GetAt(int i, out PK k); int GetValue(ref PK k, out PV v); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMD { int Activate(ref Guid i, int c, IntPtr p, out IntPtr o); int OpenPropertyStore(int a, out IPS s); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMDE { int EnumAudioEndpoints(int f, int m, out IntPtr d); int GetDefaultAudioEndpoint(int f, int r, out IMD d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MDE {}
public static class DefaultMic {
  public static string Name() {
    var e = (IMDE)(new MDE()); IMD d;
    if (e.GetDefaultAudioEndpoint(1, 0, out d) != 0) return "";
    IPS s; d.OpenPropertyStore(0, out s);
    var k = new PK { f = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), p = 14 }; PV v;
    s.GetValue(ref k, out v);
    return Marshal.PtrToStringUni(v.p);
  }
}
'@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[DefaultMic]::Name()
`;

const LOOKUP_TIMEOUT_MS = 8000;

/** Friendly name of the Windows default recording device, or null if unavailable. */
export function readWindowsDefaultMicName(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    let stdout = '';
    let done = false;
    const finish = (name: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(name);
    };
    const encoded = Buffer.from(DEFAULT_MIC_SCRIPT, 'utf16le').toString('base64');
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true },
    );
    const timer = setTimeout(() => {
      try {
        ps.kill();
      } catch {
        /* already dead */
      }
      finish(null);
    }, LOOKUP_TIMEOUT_MS);
    ps.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf8');
    });
    ps.on('close', () => finish(stdout.trim() || null));
    ps.on('error', () => finish(null));
  });
}

/**
 * Choose the dshow audio device matching the Windows default. Falls back to
 * the first listed device when Windows gives no name or it is not in the list.
 */
export function pickPreferredMic(
  audioNames: string[],
  windowsDefault: string | null,
): string | undefined {
  if (windowsDefault) {
    const wanted = windowsDefault.trim().toLowerCase();
    const exact = audioNames.find((n) => n.trim().toLowerCase() === wanted);
    if (exact) return exact;
    // Legacy waveIn names are truncated to 31 characters.
    const truncated = audioNames.find(
      (n) => n.length >= 31 && wanted.startsWith(n.trim().toLowerCase()),
    );
    if (truncated) return truncated;
  }
  return audioNames[0];
}
