import struct, zlib, os, math

def make_png(size, path):
    px = [[(0, 0, 0, 0)] * size for _ in range(size)]
    bg = (12, 68, 124)       # 深蓝 #0C447C
    fg = (230, 232, 238)     # 近白
    r = 7                     # 圆角半径
    cx = cy = (size - 1) / 2

    for y in range(size):
        for x in range(size):
            # 圆角矩形判定
            inside = True
            for (ox, oy) in ((r, r), (size - 1 - r, r), (r, size - 1 - r), (size - 1 - r, size - 1 - r)):
                if (x < r or x > size - 1 - r) and (y < r or y > size - 1 - r):
                    dx, dy = x - ox, y - oy
                    if dx * dx + dy * dy > r * r:
                        inside = False
            if not inside:
                continue
            # 图形: 三条横线 + 一个高亮选中块 (文本选择意象)
            color = bg
            if 9 <= x <= 22 and y in (10, 11):      # 第一行(未选中)
                color = (133, 183, 235, 255)
            if 9 <= x <= 27 and y in (15, 16):      # 第二行高亮
                color = fg
            if 9 <= x <= 19 and y in (20, 21):      # 第三行
                color = (133, 183, 235, 255)
            if isinstance(color, tuple) and len(color) == 4:
                px[y][x] = color
            else:
                px[y][x] = (color[0], color[1], color[2], 255)

    raw = b''
    for row in px:
        raw += b'\x00' + b''.join(struct.pack('4B', *p) for p in row)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(png)
    print('written', path, len(png), 'bytes')

make_png(32, os.path.join(os.path.dirname(__file__), '..', 'assets', 'icon.png'))
make_png(16, os.path.join(os.path.dirname(__file__), '..', 'assets', 'icon16.png'))
