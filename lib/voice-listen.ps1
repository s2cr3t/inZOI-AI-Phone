# Voice input's key and microphone (lib/voice.js starts this with Windows PowerShell):
#   powershell -File voice-listen.ps1 <virtual key> <folder> [process name start]
# While the key is held (and, when a name is given, the window in front belongs to a process whose
# name starts with it) the default microphone is recorded; let go, the recording is saved in the
# folder and named on stdout. Nothing is recorded at any other time, and no key but that one is
# looked at. The service can also ask for a recording on stdin, one line each: start | stop (the
# phone's microphone button). One JSON line per event: ready | down {by} | up {file, ms, by} |
# cancel (held too briefly) | error {what}; by is key or button. Ends when stdin closes (the
# service that started it is gone).
param([int]$Vk = 0, [string]$Dir = '', [string]$NameStart = '')

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class InzoiVoiceListen
{
    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    static extern int mciSendString(string command, StringBuilder ret, int retLength, IntPtr callback);

    const string Rec = "inzoivoice";
    const int MinHeldMs = 400;
    const int MaxHeldMs = 30000;
    // A recording asked for on stdin (start, until stop).
    static volatile bool Asked = false;

    static bool Mci(string command) { return mciSendString(command, null, 0, IntPtr.Zero) == 0; }

    static bool InFront(string nameStart)
    {
        if (nameStart.Length == 0) return true;
        try
        {
            uint pid;
            GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            if (pid == 0) return false;
            using (var p = Process.GetProcessById((int)pid))
            {
                return p.ProcessName.StartsWith(nameStart, StringComparison.OrdinalIgnoreCase);
            }
        }
        catch (Exception) { return false; }
    }

    static string JsonText(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\""); }

    public static int Run(int vk, string dir, string nameStart)
    {
        if (vk < 1 || vk > 254 || !Directory.Exists(dir)) return 64;
        var gone = new ManualResetEvent(false);
        var watcher = new Thread(delegate ()
        {
            try
            {
                var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                string line;
                while ((line = stdin.ReadLine()) != null)
                {
                    line = line.Trim();
                    if (line == "start") Asked = true;
                    else if (line == "stop") Asked = false;
                }
            }
            catch (Exception) { }
            gone.Set();
        });
        watcher.IsBackground = true;
        watcher.Start();
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        stdout.AutoFlush = true;
        stdout.WriteLine("{\"e\":\"ready\"}");
        bool recording = false;
        bool waitUp = false;
        DateTime since = DateTime.UtcNow;
        int n = 0;
        string by = "key";
        while (!gone.WaitOne(25))
        {
            bool key = (GetAsyncKeyState(vk) & 0x8000) != 0;
            bool down = key || Asked;
            if (waitUp)
            {
                if (!down) waitUp = false;
                continue;
            }
            if (!recording)
            {
                if (!down || (!Asked && !InFront(nameStart))) continue;
                by = key ? "key" : "button";
                Mci("close " + Rec);
                if (!Mci("open new type waveaudio alias " + Rec))
                {
                    stdout.WriteLine("{\"e\":\"error\",\"what\":\"no_microphone\"}");
                    waitUp = true;
                    continue;
                }
                // 16 kHz mono 16-bit when the driver takes it; whatever it records otherwise.
                Mci("set " + Rec + " alignment 2 bitspersample 16 samplespersec 16000 channels 1 bytespersec 32000");
                if (!Mci("record " + Rec))
                {
                    Mci("close " + Rec);
                    stdout.WriteLine("{\"e\":\"error\",\"what\":\"record_failed\"}");
                    waitUp = true;
                    continue;
                }
                recording = true;
                since = DateTime.UtcNow;
                stdout.WriteLine("{\"e\":\"down\",\"by\":\"" + by + "\"}");
                continue;
            }
            int ms = (int)(DateTime.UtcNow - since).TotalMilliseconds;
            if (down && ms < MaxHeldMs) continue;
            Mci("stop " + Rec);
            recording = false;
            waitUp = down;
            // A recording asked for that ran to its length ends there.
            if (by == "button") Asked = false;
            if (ms < MinHeldMs)
            {
                Mci("close " + Rec);
                stdout.WriteLine("{\"e\":\"cancel\"}");
                continue;
            }
            n = (n + 1) % 8;
            string file = Path.Combine(dir, "say-" + n + ".wav");
            try { File.Delete(file); } catch (Exception) { }
            bool saved = Mci("save " + Rec + " \"" + file + "\"");
            Mci("close " + Rec);
            stdout.WriteLine(saved && File.Exists(file)
                ? "{\"e\":\"up\",\"file\":\"" + JsonText(file) + "\",\"ms\":" + ms + ",\"by\":\"" + by + "\"}"
                : "{\"e\":\"error\",\"what\":\"save_failed\"}");
        }
        if (recording)
        {
            Mci("stop " + Rec);
            Mci("close " + Rec);
        }
        return 0;
    }
}
'@

exit [InzoiVoiceListen]::Run($Vk, $Dir, $NameStart)
