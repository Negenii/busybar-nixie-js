# raw2anim.py <dir> <slot>: s<slot>.raw + s<slot>.sections.json -> s<slot>.zip for seq2anim
import sys, zipfile, io, json, os
from PIL import Image
d, slot = sys.argv[1], sys.argv[2]
data = open(f'{d}/{slot if not slot.isdigit() else "s" + slot}.raw', 'rb').read(); AW = int(os.environ.get('AW', '11')); AH = int(os.environ.get('AH', '16')); fs = AW * AH * 3; n = len(data) // fs
secs = json.load(open(f'{d}/{slot if not slot.isdigit() else "s" + slot}.sections.json'))
stem = slot if not slot.isdigit() else f's{slot}'
with zipfile.ZipFile(f'{d}/{stem}.zip', 'w') as z:
    for i in range(n):
        b = io.BytesIO(); Image.frombytes('RGB', (AW, AH), data[i*fs:(i+1)*fs]).save(b, 'PNG'); z.writestr(f'{stem}/{i}.png', b.getvalue())
    z.writestr(f'{stem}/meta.json', json.dumps({'fps': int(os.environ.get('FPS', '25')), 'color_mode': 'rgb888', 'sections': secs}))
