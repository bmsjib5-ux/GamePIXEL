# Makes sprite alpha binary: pixels below the threshold become fully transparent,
# everything else fully opaque. Removes glow haze and gives hard pixel edges.
param([Parameter(Mandatory)][string[]]$Path, [int]$Threshold = 128)

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class AlphaFix {
    public static string Run(string src, string dst, int thr) {
        int cleared = 0, solid = 0;
        using (var b0 = new Bitmap(src))
        using (var b = new Bitmap(b0.Width, b0.Height, PixelFormat.Format32bppArgb)) {
            var rect = new Rectangle(0, 0, b0.Width, b0.Height);
            var s = b0.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            byte[] buf = new byte[s.Stride * s.Height];
            Marshal.Copy(s.Scan0, buf, 0, buf.Length);
            b0.UnlockBits(s);
            for (int i = 0; i < buf.Length; i += 4) {
                if (buf[i + 3] < thr) { buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 0; cleared++; }
                else { buf[i + 3] = 255; solid++; }
            }
            var d = b.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            Marshal.Copy(buf, 0, d.Scan0, buf.Length);
            b.UnlockBits(d);
            b.Save(dst, ImageFormat.Png);
        }
        return String.Format("transparent={0} opaque={1}", cleared, solid);
    }
}
'@

foreach ($p in $Path) {
    $tmp = "$p.tmp.png"
    $r = [AlphaFix]::Run($p, $tmp, $Threshold)
    Move-Item -LiteralPath $tmp -Destination $p -Force
    "{0} : {1}" -f (Split-Path $p -Leaf), $r
}
