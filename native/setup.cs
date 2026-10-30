// setup.exe — ตัวติดตั้งที่ลูกค้าดับเบิลคลิกครั้งแรกหลังแตก zip
//
// หน้าที่เดียวกับ ติดตั้งครั้งแรก.bat + native\bootstrap.ps1 แต่ไม่เรียก PowerShell เลย
// (exe ที่สั่ง powershell -ExecutionPolicy Bypass มักโดนโปรแกรมป้องกันไวรัสบล็อก):
//   1. ถ้ายังไม่ได้แตก zip (ไม่เจอ native\install.mjs) → บอกให้แตกก่อน
//   2. ปลดป้าย "ไฟล์จากอินเทอร์เน็ต" (Zone.Identifier) ของไฟล์ทั้งโฟลเดอร์
//   3. หา Node.js 20+: runtime\node\node.exe → node ในเครื่อง → ดาวน์โหลด zip จาก nodejs.org (ตรวจ SHA256)
//   4. ส่งต่อให้ node native\install.mjs ทำที่เหลือ (ffmpeg, เสียงพากย์, เชื่อม Chrome, shortcut, สรุป)
// ไม่ต้องใช้สิทธิ์ admin (setup.manifest บังคับ asInvoker) · รันซ้ำได้
//
// คอมไพล์: node scripts/build-setup.mjs (ใช้ csc.exe ที่มากับ Windows — C# 5 เท่านั้น ห้ามใช้ $"" หรือ ?.)
// ไฟล์นี้ต้องเป็น UTF-8 แบบมี BOM ไม่งั้น csc อ่านภาษาไทยเพี้ยน

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

[assembly: AssemblyTitle("Cartoon Auto Setup")]
[assembly: AssemblyProduct("Cartoon Auto")]
[assembly: AssemblyDescription("Cartoon Auto installer")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class Setup
{
    const string NODE_BASE = "https://nodejs.org/dist/latest-v24.x/";
    static string Root;
    static bool Quiet;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool DeleteFileW(string path);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFileAttributesW(string path);
    const uint INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;

    [STAThread]
    static int Main(string[] args)
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
        try { Console.Title = "Cartoon Auto — ติดตั้ง"; } catch { }
        Quiet = Array.IndexOf(args, "--quiet") >= 0;
        Root = Path.GetDirectoryName(Path.GetFullPath(Assembly.GetExecutingAssembly().Location));

        if (!File.Exists(Path.Combine(Root, "native", "install.mjs")))
        {
            Popup("ยังไม่ได้แตกไฟล์ zip\n\n" +
                  "คลิกขวาที่ไฟล์ .zip → Extract All (แตกไฟล์ทั้งหมด)\n" +
                  "แล้วเปิดโฟลเดอร์ที่ได้ ดับเบิลคลิก setup.exe อีกครั้ง", MessageBoxIcon.Warning);
            return 1;
        }

        try
        {
            Directory.SetCurrentDirectory(Root);
            Console.WriteLine("Cartoon Auto — กำลังติดตั้ง ไม่ต้องกดอะไร รอจนขึ้นหน้าต่างสรุป");
            Console.WriteLine();

            Unblock();
            string node = FindOrDownloadNode();

            var psi = new ProcessStartInfo(node, Quote(Path.Combine(Root, "native", "install.mjs")) + JoinArgs(args));
            psi.UseShellExecute = false;
            psi.WorkingDirectory = Root;
            using (var p = Process.Start(psi))
            {
                p.WaitForExit();
                if (p.ExitCode != 0) Pause();
                return p.ExitCode;
            }
        }
        catch (Exception e)
        {
            string msg = e.Message;
            Console.WriteLine();
            Console.WriteLine("✗ ติดตั้งไม่สำเร็จ: " + msg);
            Popup("ติดตั้งไม่สำเร็จ\n\n" + msg + "\n\nตรวจว่าต่ออินเทอร์เน็ตอยู่ แล้วดับเบิลคลิก setup.exe อีกครั้ง", MessageBoxIcon.Error);
            Pause();
            return 1;
        }
    }

    // ไฟล์ที่แตกจาก zip ที่ดาวน์โหลดมามีป้าย "มาจากอินเทอร์เน็ต" — Windows จะถามยืนยันทุกครั้งที่เปิดโปรแกรมในแพ็กเกจ
    static void Unblock()
    {
        string self = Assembly.GetExecutingAssembly().Location;
        if (!HasZone(self)) return;
        Console.WriteLine("▸ ปลดป้าย \"ไฟล์จากอินเทอร์เน็ต\" ของไฟล์ในโฟลเดอร์นี้");
        var stack = new Stack<string>();
        stack.Push(Root);
        while (stack.Count > 0)
        {
            string dir = stack.Pop();
            try
            {
                foreach (string sub in Directory.GetDirectories(dir))
                {
                    // ไม่ไล่เข้า junction/symlink (กันวนซ้ำหรือไปแตะโฟลเดอร์อื่น)
                    if ((File.GetAttributes(sub) & FileAttributes.ReparsePoint) == 0) stack.Push(sub);
                }
                foreach (string f in Directory.GetFiles(dir)) DeleteFileW(f + ":Zone.Identifier");
            }
            catch { }
        }
    }

    static bool HasZone(string file)
    {
        // .NET Framework ไม่รับชื่อไฟล์ที่มี ":" (alternate data stream) — ถาม Windows ตรง ๆ
        return GetFileAttributesW(file + ":Zone.Identifier") != INVALID_FILE_ATTRIBUTES;
    }

    static string FindOrDownloadNode()
    {
        string node = Path.Combine(Root, "runtime", "node", "node.exe");
        if (NodeOk(node)) { Console.WriteLine("✓ Node.js (ในโฟลเดอร์ runtime)"); return node; }

        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in path.Split(';'))
        {
            if (dir.Trim().Length == 0) continue;
            string candidate;
            try { candidate = Path.Combine(dir.Trim().Trim('"'), "node.exe"); } catch { continue; }
            if (NodeOk(candidate)) { Console.WriteLine("✓ Node.js ในเครื่อง (" + candidate + ")"); return candidate; }
        }

        Console.WriteLine("▸ ดาวน์โหลด Node.js (~35 MB) — ครั้งแรกครั้งเดียว");
        ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; // TLS 1.2
        string sums;
        using (var wc = new WebClient()) { wc.Encoding = Encoding.UTF8; sums = wc.DownloadString(NODE_BASE + "SHASUMS256.txt"); }
        Match m = Regex.Match(sums, @"^([0-9a-f]{64})\s+(node-v[\d.]+-win-x64\.zip)\s*$", RegexOptions.Multiline);
        if (!m.Success) throw new Exception("หาไฟล์ Node.js สำหรับ Windows ใน nodejs.org ไม่เจอ");
        string hash = m.Groups[1].Value, file = m.Groups[2].Value;

        string tmp = Path.Combine(Path.GetTempPath(), "cartoon-node-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tmp);
        try
        {
            string zip = Path.Combine(tmp, file);
            Download(NODE_BASE + file, zip);
            if (!string.Equals(Sha256(zip), hash, StringComparison.OrdinalIgnoreCase))
                throw new Exception("ไฟล์ Node.js ที่ดาวน์โหลดเสีย (SHA256 ไม่ตรง) — ลองใหม่อีกครั้ง");

            Directory.CreateDirectory(Path.GetDirectoryName(node));
            string part = node + ".part";
            bool found = false;
            using (ZipArchive archive = ZipFile.OpenRead(zip))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    // node-vX-win-x64/node.exe (ชั้นเดียว)
                    string[] parts = entry.FullName.Split('/');
                    if (parts.Length == 2 && parts[1].Equals("node.exe", StringComparison.OrdinalIgnoreCase))
                    {
                        entry.ExtractToFile(part, true);
                        found = true;
                        break;
                    }
                }
            }
            if (!found) throw new Exception("แตกไฟล์ Node.js แล้วไม่พบ node.exe");
            if (File.Exists(node)) File.Delete(node);
            File.Move(part, node);
        }
        finally
        {
            try { Directory.Delete(tmp, true); } catch { }
        }
        if (!NodeOk(node)) throw new Exception("ลง Node.js แล้วแต่รันไม่ได้ (โปรแกรมป้องกันไวรัสอาจบล็อก runtime\\node\\node.exe)");
        Console.WriteLine("✓ Node.js " + file);
        return node;
    }

    static bool NodeOk(string exe)
    {
        if (!File.Exists(exe)) return false;
        try
        {
            var psi = new ProcessStartInfo(exe, "-p \"process.versions.node.split('.')[0]\"");
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            using (var p = Process.Start(psi))
            {
                string output = p.StandardOutput.ReadToEnd();
                p.StandardError.ReadToEnd();
                if (!p.WaitForExit(30000)) { try { p.Kill(); } catch { } return false; }
                int major;
                return p.ExitCode == 0 && int.TryParse(output.Trim(), out major) && major >= 20;
            }
        }
        catch { return false; }
    }

    static void Download(string url, string dest)
    {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.UserAgent = "CartoonAuto-Setup";
        using (var res = (HttpWebResponse)req.GetResponse())
        using (Stream src = res.GetResponseStream())
        using (var dst = File.Create(dest))
        {
            long total = res.ContentLength, done = 0;
            var buf = new byte[1 << 16];
            int n, lastPct = -1;
            while ((n = src.Read(buf, 0, buf.Length)) > 0)
            {
                dst.Write(buf, 0, n);
                done += n;
                if (total > 0)
                {
                    int pct = (int)(done * 100 / total);
                    if (pct != lastPct) { Console.Write("\r    " + pct + "%  "); lastPct = pct; }
                }
            }
            if (total > 0) Console.WriteLine();
        }
    }

    static string Sha256(string file)
    {
        using (var sha = SHA256.Create())
        using (var fs = File.OpenRead(file))
        {
            var sb = new StringBuilder();
            foreach (byte b in sha.ComputeHash(fs)) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }

    static string JoinArgs(string[] args)
    {
        var sb = new StringBuilder();
        foreach (string a in args) sb.Append(' ').Append(Quote(a));
        return sb.ToString();
    }

    // quoting ตามกฎ CommandLineToArgvW (ที่ node ใช้แยก argument)
    static string Quote(string s)
    {
        if (s.Length > 0 && s.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return s;
        var sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in s)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') sb.Append('\\', slashes * 2 + 1);
            else sb.Append('\\', slashes);
            slashes = 0;
            sb.Append(c);
        }
        sb.Append('\\', slashes * 2).Append('"');
        return sb.ToString();
    }

    static void Popup(string text, MessageBoxIcon icon)
    {
        if (Quiet) return;
        try
        {
            using (var owner = new Form { TopMost = true })
                MessageBox.Show(owner, text, "Cartoon Auto", MessageBoxButtons.OK, icon);
        }
        catch { }
    }

    static void Pause()
    {
        if (Quiet) return;
        try
        {
            Console.WriteLine();
            Console.Write("กด Enter เพื่อปิดหน้าต่างนี้");
            Console.ReadLine();
        }
        catch { }
    }
}
