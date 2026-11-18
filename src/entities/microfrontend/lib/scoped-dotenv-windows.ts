import { spawnSync } from "node:child_process";
import path from "node:path";
import type { ConfigDirectory } from "../models/config.ts";

// Windows PowerShell ships with Windows. The script is fixed; the path is passed as JSON data.
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
$request = ConvertFrom-Json ([Console]::In.ReadToEnd())
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class MfDashboardDotenv {
    [StructLayout(LayoutKind.Sequential)]
    struct FileInformation {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct UnicodeString {
        public ushort Length, MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ObjectAttributes {
        public int Length;
        public IntPtr RootDirectory, ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor, SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoStatus {
        public IntPtr Status, Information;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFile(
        string name, uint access, uint sharing, IntPtr security, uint disposition, uint flags,
        IntPtr template
    );
    [DllImport("kernel32.dll")]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern uint GetFinalPathNameByHandle(
        SafeFileHandle handle, StringBuilder name, uint length, uint flags
    );
    [DllImport("kernel32.dll")]
    static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("ntdll.dll")]
    static extern int NtOpenFile(
        out IntPtr handle, uint access, ref ObjectAttributes attrs, out IoStatus status,
        uint sharing, uint options
    );

    const uint ReadAttributes = 0x80, ShareAll = 7, OpenExisting = 3;
    const uint BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;
    const uint Directory = 0x10, ReparsePoint = 0x400, Disk = 1;
    const uint CaseInsensitive = 0x40, DontReparse = 0x1000;
    const uint ReadData = 1, Synchronize = 0x100000;
    const uint NonDirectoryFile = 0x40, SynchronousNonAlert = 0x20;

    public static byte[] Read(string directory, string id, string name, int limit) {
        using (var root = CreateFile(directory, ReadAttributes, ShareAll, IntPtr.Zero,
            OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero)) {
            FileInformation info;
            if (root.IsInvalid || !GetFileInformationByHandle(root, out info) ||
                (info.Attributes & (Directory | ReparsePoint)) != Directory ||
                id != info.VolumeSerial + ":" + ((ulong)info.IndexHigh << 32 | info.IndexLow)) return null;

            var canonical = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(root, canonical, (uint)canonical.Capacity, 0);
            if (length == 0 || length >= canonical.Capacity ||
                !String.Equals(canonical.ToString(), directory, StringComparison.OrdinalIgnoreCase)) return null;

            var leaf = new UnicodeString {
                Length = checked((ushort)(name.Length * 2)),
                MaximumLength = checked((ushort)(name.Length * 2 + 2)),
                Buffer = Marshal.StringToHGlobalUni(name)
            };
            var leafPointer = IntPtr.Zero;
            try {
                leafPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
                Marshal.StructureToPtr(leaf, leafPointer, false);
                var attrs = new ObjectAttributes {
                    Length = Marshal.SizeOf(typeof(ObjectAttributes)),
                    RootDirectory = root.DangerousGetHandle(),
                    ObjectName = leafPointer,
                    Attributes = CaseInsensitive | DontReparse
                };
                IoStatus status;
                IntPtr handle;
                if (NtOpenFile(out handle, ReadData | ReadAttributes | Synchronize, ref attrs,
                    out status, ShareAll, NonDirectoryFile | SynchronousNonAlert | OpenReparsePoint) < 0) return null;
                using (var file = new SafeFileHandle(handle, true)) {
                    if (GetFileType(file) != Disk || !GetFileInformationByHandle(file, out info) ||
                        (info.Attributes & (Directory | ReparsePoint)) != 0 ||
                        ((ulong)info.SizeHigh << 32 | info.SizeLow) > (ulong)limit) return null;
                    using (var stream = new FileStream(file, FileAccess.Read)) {
                        var bytes = new byte[limit + 1];
                        int offset = 0;
                        while (offset < bytes.Length) {
                            int count = stream.Read(bytes, offset, bytes.Length - offset);
                            if (count == 0) {
                                Array.Resize(ref bytes, offset);
                                return bytes;
                            }
                            offset += count;
                        }
                        return null;
                    }
                }
            } finally {
                Marshal.FreeHGlobal(leafPointer);
                Marshal.FreeHGlobal(leaf.Buffer);
            }
        }
    }
}
'@
[byte[]] $bytes = [MfDashboardDotenv]::Read($request.directory, $request.id, $request.name, $request.limit)
if ($null -eq $bytes) { exit 1 }
[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
`;

const encodedScript = Buffer.from(script, "utf16le").toString("base64");

export function readWindowsDotenv(
  name: string,
  directory: ConfigDirectory,
  limit: number,
): Buffer | null {
  const SystemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!SystemRoot || !path.isAbsolute(SystemRoot)) return null;
  const result = spawnSync(
    path.join(SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
    {
      cwd: SystemRoot,
      env: { SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
      input: JSON.stringify({
        name,
        directory: path.toNamespacedPath(directory.path),
        id: directory.id,
        limit,
      }),
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: limit + 1,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  return result.status === 0 && !result.error ? result.stdout : null;
}
