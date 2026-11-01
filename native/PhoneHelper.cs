// inZOI AI Phone helper (inZOIPhone.exe), built by tools/build-installer.js with the .NET Framework
// compiler that ships with Windows. The build adds the version attributes and the icon.
//
//   inZOIPhone.exe                      start the guardian hidden (runtime\node.exe app\supervisor.js next to this file)
//   inZOIPhone.exe --open               the same, then tell the user it runs and where to set it up (Start menu)
//   inZOIPhone.exe --stop               ask the running guardian and reply service to stop, then wait for them
//   inZOIPhone.exe --protect            stdin: text      -> stdout: DPAPI blob (base64, current user)
//   inZOIPhone.exe --unprotect          stdin: blob      -> stdout: text
//   inZOIPhone.exe --clipboard-protect  clipboard key    -> stdout: {"ok":true,"blob":"...","hint":"sk-...abcd","length":n}
//   inZOIPhone.exe --documents          stdout: the user's Documents folder
//   inZOIPhone.exe --pick-wallpaper     stdin: output file -> picture chosen in an Open dialog, turned upright,
//                                       scaled down, veiled or shaded for its light or dark style and saved
//                                       there as JPEG; stdout: {"ok":true,"width":w,"tone":"light|dark",...}
//                                       or {"ok":false,"reason":"cancelled|unreadable|too_large|too_small"}
//   inZOIPhone.exe --pick-photo         the same desktop picker for a Texts attachment, without wallpaper
//                                       shading; stdout: {"ok":true,"width":w,"height":h,"bytes":n,...}
//
// The key never appears on the command line. --clipboard-protect never writes the key itself anywhere.
// --pick-wallpaper only reads the chosen picture and only creates a file that does not exist yet.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class PhoneHelper
{
    static readonly byte[] Entropy = Encoding.UTF8.GetBytes("inZOI-AI-Phone/llm-key/v1");
    const int MinKey = 16;
    const int MaxKey = 512;

    [STAThread]
    static int Main(string[] args)
    {
        string mode = args.Length > 0 ? args[0] : "";
        try
        {
            switch (mode)
            {
                case "": return Launch();
                case "--open": return Open();
                case "--stop": return Stop();
                case "--protect": return Protect();
                case "--unprotect": return Unprotect();
                case "--clipboard-protect": return ClipboardProtect();
                case "--documents":
                    Write(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments));
                    return 0;
                case "--pick-wallpaper": return PickWallpaper();
                case "--pick-photo": return PickPhoto();
                default:
                    return 64;
            }
        }
        catch (Exception e)
        {
            WriteError(e.GetType().Name);
            return 1;
        }
    }

    static string BaseDir()
    {
        return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    }

    static string NodePath() { return Path.Combine(BaseDir(), "runtime", "node.exe"); }

    static string HomeDir()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(local, "inZOI AI Phone");
    }

    static string DataDir() { return Path.Combine(HomeDir(), "data"); }

    static bool GuardianRunning()
    {
        Process p = OurNode(ReadPid(Path.Combine(DataDir(), "guardian.pid")));
        if (p == null) return false;
        p.Dispose();
        return true;
    }

    // 0 started or already running, 2 files missing.
    static int Launch()
    {
        string node = NodePath();
        string app = Path.Combine(BaseDir(), "app");
        string script = Path.Combine(app, "supervisor.js");
        if (!File.Exists(node) || !File.Exists(script)) return 2;
        if (GuardianRunning()) return 0;
        var psi = new ProcessStartInfo(node, Quote(script))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = app
        };
        psi.EnvironmentVariables["INZOI_PHONE_HOME"] = HomeDir();
        using (Process.Start(psi)) { }
        return 0;
    }

    static int Open()
    {
        bool was = GuardianRunning();
        int code = Launch();
        bool zh = System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh";
        string title = zh ? "inZOI AI 手机" : "inZOI AI Phone";
        if (code != 0)
        {
            MessageBox.Show(zh ? "程序文件不完整，请重新安装 inZOI AI 手机。" : "Program files are missing. Please reinstall inZOI AI Phone.",
                title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return code;
        }
        string text = zh
            ? (was ? "inZOI AI 手机服务已经在后台运行。" : "inZOI AI 手机服务已在后台启动。") +
              "\n\n进入游戏后，打开手机里的 AI 应用，选择模型服务商并粘贴 API Key 即可。\n以后每次登录 Windows 都会自动启动，无需再打开本程序。"
            : (was ? "inZOI AI Phone Service is already running in the background." : "inZOI AI Phone Service has started in the background.") +
              "\n\nIn the game, open the AI app on the phone, pick a provider and paste your API key.\nIt starts by itself whenever you sign in to Windows; you do not need to open this again.";
        MessageBox.Show(text, title, MessageBoxButtons.OK, MessageBoxIcon.Information);
        return 0;
    }

    // Stops the guardian, then any reply service still running from this installation's
    // runtime, so an uninstall or update can replace the files.
    static int Stop()
    {
        string data = DataDir();
        Process p = OurNode(ReadPid(Path.Combine(data, "guardian.pid")));
        if (p != null)
        {
            Directory.CreateDirectory(data);
            File.WriteAllText(Path.Combine(data, "guardian.stop"), DateTime.UtcNow.ToString("o"));
            if (!p.WaitForExit(25000))
            {
                try { p.Kill(); } catch (Exception) { }
                p.WaitForExit(5000);
            }
            p.Dispose();
        }
        Process[] left = OurNodes();
        if (left.Length > 0)
        {
            Directory.CreateDirectory(data);
            File.WriteAllText(Path.Combine(data, "stop.request"), DateTime.UtcNow.ToString("o"));
            DateTime until = DateTime.UtcNow.AddSeconds(15);
            foreach (Process q in left)
            {
                int ms = (int)Math.Max(0, (until - DateTime.UtcNow).TotalMilliseconds);
                if (!q.WaitForExit(ms))
                {
                    try { q.Kill(); } catch (Exception) { }
                    q.WaitForExit(5000);
                }
                q.Dispose();
            }
        }
        return 0;
    }

    static Process[] OurNodes()
    {
        var list = new System.Collections.Generic.List<Process>();
        foreach (Process p in Process.GetProcessesByName("node"))
        {
            bool ours = false;
            try { ours = string.Equals(Path.GetFullPath(p.MainModule.FileName), Path.GetFullPath(NodePath()), StringComparison.OrdinalIgnoreCase); }
            catch (Exception) { }
            if (ours) list.Add(p);
            else p.Dispose();
        }
        return list.ToArray();
    }

    static int ReadPid(string file)
    {
        try
        {
            int pid;
            return int.TryParse(File.ReadAllText(file).Trim(), out pid) ? pid : 0;
        }
        catch (Exception) { return 0; }
    }

    // Only a process started from this installation's runtime is ever stopped.
    static Process OurNode(int pid)
    {
        if (pid <= 0) return null;
        try
        {
            Process p = Process.GetProcessById(pid);
            string exe = p.MainModule.FileName;
            if (string.Equals(Path.GetFullPath(exe), Path.GetFullPath(NodePath()), StringComparison.OrdinalIgnoreCase)) return p;
        }
        catch (Exception) { }
        return null;
    }

    static int Protect()
    {
        string text = ReadInput();
        if (text.Length == 0) return 3;
        byte[] blob = ProtectedData.Protect(Encoding.UTF8.GetBytes(text), Entropy, DataProtectionScope.CurrentUser);
        Write(Convert.ToBase64String(blob));
        return 0;
    }

    static int Unprotect()
    {
        string b64 = ReadInput().Trim();
        byte[] plain = ProtectedData.Unprotect(Convert.FromBase64String(b64), Entropy, DataProtectionScope.CurrentUser);
        Write(Encoding.UTF8.GetString(plain));
        return 0;
    }

    static int ClipboardProtect()
    {
        string raw = null;
        for (int i = 0; i < 5 && raw == null; i++)
        {
            try { raw = Clipboard.ContainsText() ? Clipboard.GetText() : ""; }
            catch (System.Runtime.InteropServices.ExternalException) { Thread.Sleep(80); }
        }
        if (raw == null) { Write("{\"ok\":false,\"reason\":\"clipboard_busy\"}"); return 0; }
        string key = CleanKey(raw);
        if (key.Length == 0) { Write("{\"ok\":false,\"reason\":\"clipboard_empty\"}"); return 0; }
        if (!LooksLikeKey(key)) { Write("{\"ok\":false,\"reason\":\"clipboard_invalid\"}"); return 0; }
        byte[] blob = ProtectedData.Protect(Encoding.UTF8.GetBytes(key), Entropy, DataProtectionScope.CurrentUser);
        Write("{\"ok\":true,\"blob\":\"" + Convert.ToBase64String(blob) + "\",\"hint\":\"" + Hint(key) +
              "\",\"length\":" + key.Length + "}");
        return 0;
    }

    // Large enough for a sharp phone screen in either orientation; the phone crops to fill.
    const int WallLong = 2560;
    const int WallShort = 1440;
    const int WallMinSide = 320;
    const long WallMaxFileBytes = 64L * 1024 * 1024;
    const long WallMaxPixels = 120L * 1000 * 1000;
    const long WallQuality = 88L;
    const int WallNameChars = 40;

    static int PickWallpaper()
    {
        string dest = ReadInput().Trim();
        if (!ValidWallpaperTarget(dest)) return 3;
        bool zh = System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh";
        string source = AskForPicture(zh ? "选择手机壁纸" : "Choose a phone wallpaper");
        if (source == null) { Write("{\"ok\":false,\"reason\":\"cancelled\"}"); return 0; }
        Write(ConvertWallpaper(source, dest));
        return 0;
    }

    static int PickPhoto()
    {
        string dest = ReadInput().Trim();
        if (!ValidWallpaperTarget(dest)) return 3;
        bool zh = System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh";
        string source = AskForPicture(zh ? "选择要发送的图片" : "Choose a photo to send");
        if (source == null) { Write("{\"ok\":false,\"reason\":\"cancelled\"}"); return 0; }
        Write(ConvertPhoto(source, dest));
        return 0;
    }

    internal static bool ValidWallpaperTarget(string dest)
    {
        if (dest.Length == 0 || dest.IndexOfAny(Path.GetInvalidPathChars()) >= 0 || !Path.IsPathRooted(dest)) return false;
        if (!dest.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) return false;
        string dir = Path.GetDirectoryName(dest);
        return !string.IsNullOrEmpty(dir) && Directory.Exists(dir) && !File.Exists(dest);
    }

    // The game usually fills the screen, so the dialog hangs off an invisible topmost window.
    static string AskForPicture(string title)
    {
        bool zh = System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh";
        Rectangle screen = Screen.PrimaryScreen.WorkingArea;
        using (var owner = new Form())
        using (var dialog = new OpenFileDialog())
        {
            owner.FormBorderStyle = FormBorderStyle.None;
            owner.ShowInTaskbar = false;
            owner.StartPosition = FormStartPosition.Manual;
            owner.Size = new Size(1, 1);
            owner.Location = new Point(screen.Left + screen.Width / 2, screen.Top + screen.Height / 3);
            owner.Opacity = 0;
            owner.TopMost = true;
            owner.Text = zh ? "inZOI AI 手机" : "inZOI AI Phone";
            dialog.Title = title;
            dialog.Filter = (zh ? "图片" : "Pictures") + " (*.jpg;*.jpeg;*.png;*.bmp;*.gif)|*.jpg;*.jpeg;*.png;*.bmp;*.gif";
            dialog.Multiselect = false;
            dialog.CheckFileExists = true;
            dialog.DereferenceLinks = true;
            dialog.RestoreDirectory = true;
            dialog.InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
            owner.Show();
            owner.Activate();
            DialogResult result = dialog.ShowDialog(owner);
            return result == DialogResult.OK && File.Exists(dialog.FileName) ? dialog.FileName : null;
        }
    }

    // Chat photos keep their original colours. Re-encoding removes EXIF metadata and bounds
    // both download size and memory use; the source file is never changed.
    const int PhotoMaxSide = 1600;
    const long PhotoMaxFileBytes = 32L * 1024 * 1024;
    const long PhotoMaxPixels = 60L * 1000 * 1000;
    const long PhotoQuality = 86L;

    internal static string ConvertPhoto(string source, string dest)
    {
        long size = new FileInfo(source).Length;
        if (size > PhotoMaxFileBytes) return "{\"ok\":false,\"reason\":\"too_large\"}";
        byte[] data = File.ReadAllBytes(source);
        Image picture;
        try { picture = Image.FromStream(new MemoryStream(data), false, true); }
        catch (ArgumentException) { return "{\"ok\":false,\"reason\":\"unreadable\"}"; }
        catch (OutOfMemoryException) { return "{\"ok\":false,\"reason\":\"unreadable\"}"; }
        using (picture)
        {
            if ((long)picture.Width * picture.Height > PhotoMaxPixels) return "{\"ok\":false,\"reason\":\"too_large\"}";
            TurnUpright(picture);
            int w = picture.Width;
            int h = picture.Height;
            double scale = Math.Min(1.0, (double)PhotoMaxSide / Math.Max(w, h));
            int outW = Math.Max(1, (int)Math.Round(w * scale));
            int outH = Math.Max(1, (int)Math.Round(h * scale));
            using (var canvas = new Bitmap(outW, outH, PixelFormat.Format24bppRgb))
            {
                using (Graphics g = Graphics.FromImage(canvas))
                using (var attributes = new ImageAttributes())
                {
                    g.Clear(Color.White);
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.CompositingQuality = CompositingQuality.HighQuality;
                    g.SmoothingMode = SmoothingMode.HighQuality;
                    attributes.SetWrapMode(WrapMode.TileFlipXY);
                    g.DrawImage(picture, new Rectangle(0, 0, outW, outH), 0, 0, w, h, GraphicsUnit.Pixel, attributes);
                }
                long written;
                using (var output = new FileStream(dest, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (var parameters = new EncoderParameters(1))
                {
                    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, PhotoQuality);
                    canvas.Save(output, JpegCodec(), parameters);
                    output.Flush(true);
                    written = output.Length;
                }
                string name = Path.GetFileNameWithoutExtension(source);
                if (name.Length > WallNameChars) name = name.Substring(0, WallNameChars);
                return "{\"ok\":true,\"width\":" + outW + ",\"height\":" + outH + ",\"bytes\":" + written +
                       ",\"name\":\"" + JsonText(name) + "\"}";
            }
        }
    }

    internal static string ConvertWallpaper(string source, string dest)
    {
        long size = new FileInfo(source).Length;
        if (size > WallMaxFileBytes) return "{\"ok\":false,\"reason\":\"too_large\"}";
        byte[] data = File.ReadAllBytes(source);
        Image picture;
        try { picture = Image.FromStream(new MemoryStream(data), false, true); }
        catch (ArgumentException) { return "{\"ok\":false,\"reason\":\"unreadable\"}"; }
        catch (OutOfMemoryException) { return "{\"ok\":false,\"reason\":\"unreadable\"}"; }
        using (picture)
        {
            if ((long)picture.Width * picture.Height > WallMaxPixels) return "{\"ok\":false,\"reason\":\"too_large\"}";
            TurnUpright(picture);
            int w = picture.Width;
            int h = picture.Height;
            if (Math.Min(w, h) < WallMinSide) return "{\"ok\":false,\"reason\":\"too_small\"}";
            double scale = Math.Min(1.0, Math.Min((double)WallLong / Math.Max(w, h), (double)WallShort / Math.Min(w, h)));
            int outW = Math.Max(1, (int)Math.Round(w * scale));
            int outH = Math.Max(1, (int)Math.Round(h * scale));
            double luma;
            using (var canvas = new Bitmap(outW, outH, PixelFormat.Format24bppRgb))
            {
                using (Graphics g = Graphics.FromImage(canvas))
                using (var attributes = new ImageAttributes())
                {
                    g.Clear(Color.Black);
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.CompositingQuality = CompositingQuality.HighQuality;
                    g.SmoothingMode = SmoothingMode.HighQuality;
                    attributes.SetWrapMode(WrapMode.TileFlipXY);
                    g.DrawImage(picture, new Rectangle(0, 0, outW, outH), 0, 0, w, h, GraphicsUnit.Pixel, attributes);
                    luma = MeanLuma(canvas);
                    ShadeForText(g, outW, outH, luma);
                }
                long written;
                using (var output = new FileStream(dest, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (var parameters = new EncoderParameters(1))
                {
                    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, WallQuality);
                    canvas.Save(output, JpegCodec(), parameters);
                    output.Flush(true);
                    written = output.Length;
                }
                string name = Path.GetFileNameWithoutExtension(source);
                if (name.Length > WallNameChars) name = name.Substring(0, WallNameChars);
                return "{\"ok\":true,\"width\":" + outW + ",\"height\":" + outH + ",\"bytes\":" + written +
                       ",\"tone\":\"" + (IsLight(luma) ? "light" : "dark") + "\"" +
                       ",\"luma\":" + Math.Round(luma, 3).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) +
                       ",\"name\":\"" + JsonText(name) + "\"}";
            }
        }
    }

    // The phone draws text straight on the wallpaper: the status bar at the top, icon labels in
    // the middle, the dock at the bottom. A light picture switches the phone to its light style
    // (dark text) and gets a white veil; a dark one keeps the dark style (white text) and gets a
    // black shade. Either is part of the picture, so every layer that paints the wallpaper,
    // page transitions included, shows the same thing.
    // The closer a picture is to the line between the two, the stronger its veil or shade.
    const double LightFromLuma = 0.56;
    static readonly float[] ShadeAt = { 0f, 0.18f, 0.55f, 1f };
    static readonly int[] DarkShadeSoft = { 92, 46, 56, 128 };
    static readonly int[] DarkShadeStrong = { 150, 104, 112, 170 };
    const double DarkShadeFrom = 0.32;
    static readonly int[] LightVeilSoft = { 70, 26, 34, 90 };
    static readonly int[] LightVeilStrong = { 140, 84, 92, 150 };
    const double LightVeilFrom = 0.82;
    const int LumaGrid = 32;

    internal static bool IsLight(double luma) { return luma >= LightFromLuma; }

    static void ShadeForText(Graphics g, int w, int h, double luma)
    {
        bool light = IsLight(luma);
        double t = light
            ? (LightVeilFrom - luma) / (LightVeilFrom - LightFromLuma)
            : (luma - DarkShadeFrom) / (LightFromLuma - DarkShadeFrom);
        t = Math.Max(0, Math.Min(1, t));
        int[] soft = light ? LightVeilSoft : DarkShadeSoft;
        int[] strong = light ? LightVeilStrong : DarkShadeStrong;
        int ink = light ? 255 : 0;
        var area = new Rectangle(0, 0, w, h + 1);
        using (var brush = new LinearGradientBrush(area, Color.Black, Color.Black, LinearGradientMode.Vertical))
        {
            var blend = new ColorBlend(ShadeAt.Length);
            blend.Positions = ShadeAt;
            blend.Colors = new Color[ShadeAt.Length];
            for (int i = 0; i < ShadeAt.Length; i++)
            {
                int alpha = (int)Math.Round(soft[i] + (strong[i] - soft[i]) * t);
                blend.Colors[i] = Color.FromArgb(alpha, ink, ink, ink);
            }
            brush.InterpolationColors = blend;
            g.CompositingMode = CompositingMode.SourceOver;
            g.FillRectangle(brush, 0, 0, w, h);
        }
    }

    // Average brightness 0..1 on a grid of samples, Rec. 709 weights.
    static double MeanLuma(Bitmap canvas)
    {
        double sum = 0;
        int n = 0;
        for (int gy = 0; gy < LumaGrid; gy++)
        {
            int y = (int)((gy + 0.5) * canvas.Height / LumaGrid);
            for (int gx = 0; gx < LumaGrid; gx++)
            {
                int x = (int)((gx + 0.5) * canvas.Width / LumaGrid);
                Color c = canvas.GetPixel(x, y);
                sum += (0.2126 * c.R + 0.7152 * c.G + 0.0722 * c.B) / 255.0;
                n++;
            }
        }
        return n > 0 ? sum / n : 0;
    }

    // Phones store most photos sideways and record the turn in EXIF tag 0x0112.
    static void TurnUpright(Image picture)
    {
        const int OrientationTag = 0x0112;
        if (Array.IndexOf(picture.PropertyIdList, OrientationTag) < 0) return;
        PropertyItem item = picture.GetPropertyItem(OrientationTag);
        if (item.Value == null || item.Value.Length < 2) return;
        int value = BitConverter.ToUInt16(item.Value, 0);
        RotateFlipType turn;
        switch (value)
        {
            case 2: turn = RotateFlipType.RotateNoneFlipX; break;
            case 3: turn = RotateFlipType.Rotate180FlipNone; break;
            case 4: turn = RotateFlipType.Rotate180FlipX; break;
            case 5: turn = RotateFlipType.Rotate90FlipX; break;
            case 6: turn = RotateFlipType.Rotate90FlipNone; break;
            case 7: turn = RotateFlipType.Rotate270FlipX; break;
            case 8: turn = RotateFlipType.Rotate270FlipNone; break;
            default: return;
        }
        picture.RotateFlip(turn);
    }

    static ImageCodecInfo JpegCodec()
    {
        foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders())
        {
            if (codec.FormatID == ImageFormat.Jpeg.Guid) return codec;
        }
        throw new InvalidOperationException("no JPEG encoder");
    }

    static string JsonText(string s)
    {
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            if (c == '\\') sb.Append("\\\\");
            else if (c == '"') sb.Append("\\\"");
            else if (c < ' ' || c == '\u2028' || c == '\u2029') sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.ToString();
    }

    static string CleanKey(string raw)
    {
        string s = (raw ?? "").Trim();
        if (s.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) s = s.Substring(7).Trim();
        if (s.Length >= 2 && (s[0] == '"' || s[0] == '\'') && s[s.Length - 1] == s[0]) s = s.Substring(1, s.Length - 2).Trim();
        return s;
    }

    static bool LooksLikeKey(string s)
    {
        if (s.Length < MinKey || s.Length > MaxKey) return false;
        foreach (char c in s)
        {
            if (c <= ' ' || c > '~') return false;
        }
        return true;
    }

    // First three and last four characters, only printable ASCII, safe inside a JSON string.
    static string Hint(string key)
    {
        string head = key.Substring(0, Math.Min(3, key.Length));
        string tail = key.Length > 10 ? key.Substring(key.Length - 4) : "";
        return Escape(head) + "..." + Escape(tail);
    }

    static string Escape(string s)
    {
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    static string Quote(string s) { return "\"" + s + "\""; }

    static string ReadInput()
    {
        using (var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)))
        {
            return stdin.ReadToEnd();
        }
    }

    static void Write(string s)
    {
        using (var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)))
        {
            stdout.Write(s);
        }
    }

    static void WriteError(string s)
    {
        try
        {
            using (var stderr = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)))
            {
                stderr.Write(s);
            }
        }
        catch (Exception) { }
    }
}
