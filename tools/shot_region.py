import ctypes, struct, zlib, sys
from ctypes import wintypes

# 截取指定 WordWise 窗口在屏幕上的实际区域（GDI BitBlt 桌面 DC）
# PrintWindow 抓不到 Chromium 的 GPU 合成内容，只能走屏幕复制。
# 用法：python shot_region.py out.png [标题关键字]

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
user32.SetProcessDPIAware()

keyword = sys.argv[2] if len(sys.argv) > 2 else '设置'

target = []
def enum_cb(hwnd, lparam):
    if not user32.IsWindowVisible(hwnd):
        return True
    n = user32.GetWindowTextLengthW(hwnd)
    if n > 0:
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if 'WordWise' in buf.value and keyword in buf.value:
            target.append((hwnd, buf.value))
    return True

EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.POINTER(ctypes.c_int), ctypes.c_long)
user32.EnumWindows(EnumWindowsProc(enum_cb), 0)
if not target:
    print('NOT_FOUND')
    sys.exit(1)

hwnd, title = target[0]
print('target:', repr(title))
user32.SetForegroundWindow(hwnd)
ctypes.windll.user32.keybd_event(0, 0, 0, 0)

class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

rc = RECT()
user32.GetWindowRect(hwnd, ctypes.byref(rc))
W, H = rc.right - rc.left, rc.bottom - rc.top
print('rect:', rc.left, rc.top, W, H)

hdc = user32.GetDC(0)
mem = gdi32.CreateCompatibleDC(hdc)
bmp = gdi32.CreateCompatibleBitmap(hdc, W, H)
old = gdi32.SelectObject(mem, bmp)
gdi32.BitBlt(mem, 0, 0, W, H, hdc, rc.left, rc.top, 0x00CC0020)

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", ctypes.c_ulong), ("biWidth", ctypes.c_long),
                ("biHeight", ctypes.c_long), ("biPlanes", ctypes.c_ushort),
                ("biBitCount", ctypes.c_ushort), ("biCompression", ctypes.c_ulong),
                ("biSizeImage", ctypes.c_ulong), ("biXPelsPerMeter", ctypes.c_long),
                ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", ctypes.c_ulong),
                ("biClrImportant", ctypes.c_ulong)]

class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", ctypes.c_ulong * 3)]

bi = BITMAPINFO()
bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
bi.bmiHeader.biWidth = W
bi.bmiHeader.biHeight = -H
bi.bmiHeader.biPlanes = 1
bi.bmiHeader.biBitCount = 32

buf = ctypes.create_string_buffer(W * H * 4)
gdi32.GetDIBits(mem, bmp, 0, H, buf, ctypes.byref(bi), 0)
gdi32.SelectObject(mem, old)
gdi32.DeleteObject(bmp)
gdi32.DeleteDC(mem)
user32.ReleaseDC(0, hdc)

raw = bytearray()
data = buf.raw
for y in range(H):
    raw.append(0)
    row = data[y*W*4:(y+1)*W*4]
    for x in range(W):
        raw += bytes((row[x*4+2], row[x*4+1], row[x*4], 255))

def chunk(tag, payload):
    c = struct.pack('>I', len(payload)) + tag + payload
    return c + struct.pack('>I', zlib.crc32(tag + payload) & 0xffffffff)

png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(bytes(raw), 6))
png += chunk(b'IEND', b'')
open(sys.argv[1], 'wb').write(png)
print('saved', sys.argv[1], W, 'x', H)
