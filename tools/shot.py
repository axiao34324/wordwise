import ctypes, struct, zlib, sys

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
user32.SetProcessDPIAware()

SW = user32.GetSystemMetrics(0)
SH = user32.GetSystemMetrics(1)
SRCCOPY = 0x00CC0020

hdc = user32.GetDC(0)
mem = gdi32.CreateCompatibleDC(hdc)
bmp = gdi32.CreateCompatibleBitmap(hdc, SW, SH)
old = gdi32.SelectObject(mem, bmp)
gdi32.BitBlt(mem, 0, 0, SW, SH, hdc, 0, 0, SRCCOPY)

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
bi.bmiHeader.biWidth = SW
bi.bmiHeader.biHeight = -SH  # top-down
bi.bmiHeader.biPlanes = 1
bi.bmiHeader.biBitCount = 32
bi.bmiHeader.biCompression = 0

buf = ctypes.create_string_buffer(SW * SH * 4)
gdi32.GetDIBits(mem, bmp, 0, SH, buf, ctypes.byref(bi), 0)
gdi32.SelectObject(mem, old)
gdi32.DeleteObject(bmp)
gdi32.DeleteDC(mem)
user32.ReleaseDC(0, hdc)

raw = bytearray()
data = buf.raw
for y in range(SH):
    raw.append(0)
    row = data[y * SW * 4:(y + 1) * SW * 4]
    for x in range(SW):
        b, g, r, a = row[x*4], row[x*4+1], row[x*4+2], row[x*4+3]
        raw += bytes((r, g, b, a))

def chunk(tag, payload):
    c = struct.pack('>I', len(payload)) + tag + payload
    return c + struct.pack('>I', zlib.crc32(tag + payload) & 0xffffffff)

png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', SW, SH, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(bytes(raw), 6))
png += chunk(b'IEND', b'')
with open(sys.argv[1], 'wb') as f:
    f.write(png)
print('saved', sys.argv[1], SW, 'x', SH)
