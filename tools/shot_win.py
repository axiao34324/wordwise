import ctypes, struct, zlib, sys

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
PW_CLIENTONLY = 1

# 找 WordWise 设置 窗口
target_hwnd = None
def enum_cb(hwnd, lparam):
    global target_hwnd
    if not user32.IsWindowVisible(hwnd):
        return True
    length = user32.GetWindowTextLengthW(hwnd)
    if length > 0:
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        if 'WordWise' in buf.value:
            print('found window:', hwnd, repr(buf.value))
            if '设置' in buf.value or 'Settings' in buf.value:
                target_hwnd = hwnd
    return True

EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.POINTER(ctypes.c_int), ctypes.c_long)
user32.EnumWindows(EnumWindowsProc(enum_cb), 0)

if not target_hwnd:
    print('NOT_FOUND')
    sys.exit(1)

class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

rc = RECT()
user32.GetWindowRect(target_hwnd, ctypes.byref(rc))
W, H = rc.right - rc.left, rc.bottom - rc.top
print('rect:', rc.left, rc.top, W, H)

hwndDC = user32.GetWindowDC(target_hwnd)
mem = gdi32.CreateCompatibleDC(hwndDC)
bmp = gdi32.CreateCompatibleBitmap(hwndDC, W, H)
old = gdi32.SelectObject(mem, bmp)
ok = user32.PrintWindow(target_hwnd, mem, PW_CLIENTONLY)
print('PrintWindow:', ok)

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
user32.ReleaseDC(target_hwnd, hwndDC)

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
with open(sys.argv[1], 'wb') as f:
    f.write(png)
print('saved', sys.argv[1], W, 'x', H)
