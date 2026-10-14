#!/usr/bin/env python3
"""Export the nickel treatment selected for product integration."""
from pathlib import Path
import subprocess, xml.etree.ElementTree as ET
from PIL import Image
ROOT=Path(__file__).resolve().parent
OUT=ROOT/'applied';OUT.mkdir(exist_ok=True)
NS={'s':'http://www.w3.org/2000/svg'}
parts=[p.attrib['points'] for p in ET.parse(ROOT/'split-k.svg').findall('.//s:polygon',NS)]
assert parts==['6,6 18,6 18,58 6,58','26,16 58,2 58,16 26,30','26,34 58,48 58,62 26,48']
def svg(color,bg=None):
    body=(f'<rect width="64" height="64" fill="{bg}"/>' if bg else '')
    body+=''.join(f'<polygon points="{p}" fill="{("#8B9096" if i==2 else color)}"/>' for i,p in enumerate(parts))
    return '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img"><title>kanban.cards</title>'+body+'</svg>\n'
for suffix,color in [('', '#0B0D0E'),('-dark','#F7F6F2')]:
    for prefix in ['brand-mark','favicon']:
        (OUT/f'{prefix}{suffix}.svg').write_text(svg(color))
(OUT/'favicon-tile.svg').write_text(svg('#F7F6F2','#0B0D0E'))
for s in [16,32,48]:
    subprocess.run(['magick','-background','none','-density','384',str(OUT/'favicon-tile.svg'),'-resize',f'{s}x{s}!','-strip','-alpha','off',f'PNG24:{OUT/f"favicon-{s}.png"}'],check=True)
frames=[Image.open(OUT/f'favicon-{s}.png').convert('RGBA') for s in [16,32,48]]
frames[-1].save(OUT/'favicon.ico',format='ICO',sizes=[(16,16),(32,32),(48,48)],append_images=frames[:-1])
subprocess.run(['magick','-background','none','-density','192',str(ROOT/'app-icons/app-icon-nickel.svg'),'-resize','180x180!','-strip','-alpha','off',f'PNG24:{OUT/"apple-touch-icon.png"}'],check=True)
print('Exported nickel product assets without changing canonical geometry.')
