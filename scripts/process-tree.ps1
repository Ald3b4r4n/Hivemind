$ErrorActionPreference = 'Stop'
try {
    $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())) | ConvertFrom-Json
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class HivemindProcess {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Startup {
        public int size;
        public string reserved, desktop, title;
        public int x, y, width, height, charsX, charsY, fill, flags;
        public short show, reservedSize;
        public IntPtr reservedPtr, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Child {
        public IntPtr process, thread;
        public uint pid, tid;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long processTime, jobTime;
        public uint flags;
        public UIntPtr minWorkingSet, maxWorkingSet;
        public uint activeProcesses;
        public UIntPtr affinity;
        public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Limits {
        public BasicLimits basic;
        public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
        public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
    }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int type, ref Limits info, int length);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string file, StringBuilder command, IntPtr ps, IntPtr ts,
        bool inherit, uint flags, IntPtr environment, string directory, ref Startup startup, out Child child);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes + 1);
            result.Append('\\', slashes).Append(c);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    public static int Run(string file, string[] args, uint parentPid) {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var parent = OpenProcess(0x100000, false, parentPid); // SYNCHRONIZE
        if (parent == IntPtr.Zero) { CloseHandle(job); throw new Win32Exception(); }
        try {
            var limits = new Limits { basic = new BasicLimits { flags = 0x2000 } }; // KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Limits)))) throw new Win32Exception();
            var startup = new Startup {
                size = Marshal.SizeOf(typeof(Startup)), flags = 0x100,
                input = GetStdHandle(-10), output = GetStdHandle(-11), error = GetStdHandle(-12)
            };
            foreach (var handle in new[] { startup.input, startup.output, startup.error }) {
                if (!SetHandleInformation(handle, 1, 1)) throw new Win32Exception();
            }
            var command = new StringBuilder(Quote(file));
            foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            Child child;
            if (!CreateProcess(file, command, IntPtr.Zero, IntPtr.Zero, true, 0x4, IntPtr.Zero,
                null, ref startup, out child)) throw new Win32Exception(); // CREATE_SUSPENDED
            try {
                if (!AssignProcessToJobObject(job, child.process)) throw new Win32Exception();
                if (ResumeThread(child.thread) == UInt32.MaxValue) throw new Win32Exception();
                uint finished = WaitForMultipleObjects(2, new[] { child.process, parent }, false, UInt32.MaxValue);
                if (finished == 1) return 124;
                if (finished != 0) throw new Win32Exception();
                uint code;
                if (!GetExitCodeProcess(child.process, out code)) throw new Win32Exception();
                return unchecked((int)code);
            } catch {
                TerminateProcess(child.process, 1);
                throw;
            } finally {
                CloseHandle(child.thread);
                CloseHandle(child.process);
            }
        } finally {
            CloseHandle(parent);
            CloseHandle(job);
        }
    }
}
"@
    exit [HivemindProcess]::Run($request.file, [string[]]$request.args, [uint32]$request.parent)
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 125
}
