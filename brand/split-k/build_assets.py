#!/usr/bin/env python3
"""Rebuild the Split K asset system from the canonical split-k.svg.
Requires Python 3, Pillow, and ImageMagick. Wordmark outline source is included.
"""
from pathlib import Path
from copy import deepcopy
import hashlib, html, json, math, shutil, subprocess, sys, xml.etree.ElementTree as ET
from PIL import Image

ROOT = Path(__file__).resolve().parent
INK, IVORY, NICKEL, RULE = '#0B0D0E', '#F7F6F2', '#8B9096', '#DAD7CF'
NS = {'s':'http://www.w3.org/2000/svg'}
MASTER = ROOT/'split-k.svg'
PARTS = [n.attrib['points'] for n in ET.parse(MASTER).findall('.//s:polygon',NS)]
LOCKED = ['6,6 18,6 18,58 6,58','26,16 58,2 58,16 26,30','26,34 58,48 58,62 26,48']
assert PARTS == LOCKED, 'Canonical geometry differs from selected direction lock'
SIZES = [16,24,32,48,96]
APP_SIZES = [16,24,32,48,64,96,128,180,192,256,512,1024]
GENERATED=[]

def mark(color=INK, nickel=False, x=0, y=0, size=64, extra=''):
    body=''.join(f'<polygon points="{p}"'+(f' fill="{NICKEL}"' if nickel and i==2 else '')+'/>' for i,p in enumerate(PARTS))
    transform='' if (x,y,size)==(0,0,64) else f' transform="translate({x} {y}) scale({size/64:g})"'
    return f'<g fill="{color}"{transform} {extra}>{body}</g>'

def doc(body,w=64,h=64,title='kanban.cards',extra=''):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" {extra}><title>{html.escape(title)}</title>{body}</svg>\n'

def write(name,content):
    p=ROOT/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(content);GENERATED.append(name);return p

def render(src,dest,size=None,opaque=False):
    dest=ROOT/dest;dest.parent.mkdir(parents=True,exist_ok=True)
    args=['magick','-font','/System/Library/Fonts/Supplemental/Arial.ttf','-background','none','-density','384' if not size or size<=256 else '192',str(src)]
    if size: args+=['-resize',f'{size}x{size}!']
    else: args+=['-resize','25%']
    args+=['-strip','-colorspace','sRGB']
    if opaque: args+=['-alpha','off',f'PNG24:{dest}']
    else: args+=[f'PNG32:{dest}']
    subprocess.run(args,check=True,capture_output=True)
    GENERATED.append(str(dest.relative_to(ROOT)))

def rect(x,y,w,h,fill,rx=0,stroke=None):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}"'+(f' stroke="{stroke}"' if stroke else '')+'/>'

def text(x,y,s,size=16,weight=400,color=INK,anchor=None):
    return f'<text x="{x}" y="{y}" font-family="Arial, sans-serif" font-size="{size}" font-weight="{weight}" fill="{color}"'+(f' text-anchor="{anchor}"' if anchor else '')+'>'+html.escape(s)+'</text>'

# Standalone marks are transparent. No variant changes the polygons.
for name,color,nickel in [('mark-reversed',IVORY,False),('mark-currentcolor','currentColor',False),('mark-nickel',INK,True)]:
    write(f'svg/{name}.svg',doc(mark(color,nickel)))
for scheme,color in [('ink',INK),('reversed',IVORY)]:
    src=MASTER if scheme=='ink' else ROOT/'svg/mark-reversed.svg'
    for s in SIZES:
        render(src,f'png/mark-{scheme}-{s}.png',s)
render(MASTER,'png/mark-ink-512.png',512)
render(ROOT/'svg/mark-reversed.svg','png/mark-reversed-512.png',512)

# Adaptive transparent SVG; fixed high-contrast PNG/ICO fallback.
style=f'<style>.planes{{fill:{INK}}}@media (prefers-color-scheme:dark){{.planes{{fill:{IVORY}}}}}</style>'
write('favicon/favicon.svg',doc(style+mark(extra='class="planes"')))
write('favicon/favicon-light.svg',doc(mark(INK)))
write('favicon/favicon-dark.svg',doc(mark(IVORY)))
write('favicon/safari-pinned-tab.svg',doc(mark('#000000')))
fallback=write('favicon/favicon-tile.svg',doc(rect(0,0,64,64,INK)+mark(IVORY)))
for s in [16,32,48,64]: render(fallback,f'favicon/favicon-{s}.png',s,True)
frames=[Image.open(ROOT/f'favicon/favicon-{s}.png').convert('RGBA') for s in [16,32,48]]
frames[-1].save(ROOT/'favicon/favicon.ico',format='ICO',sizes=[(16,16),(32,32),(48,48)],append_images=frames[:-1])
GENERATED.append('favicon/favicon.ico')

# Opaque, square app sources. Rounding is applied only in preview masks.
for name,bg,fg,nickel in [('app-icon',INK,IVORY,False),('app-icon-light',IVORY,INK,False),('app-icon-nickel',INK,IVORY,True)]:
    src=write(f'app-icons/{name}.svg',doc(rect(0,0,1024,1024,bg)+mark(fg,nickel,192,192,640),1024,1024))
    sizes=APP_SIZES if name=='app-icon' else [512,1024]
    for s in sizes: render(src,f'app-icons/{name}-{s}.png',s,True)
for name,s in [('apple-touch-icon',180),('maskable-192',192),('maskable-512',512)]:
    shutil.copyfile(ROOT/f'app-icons/app-icon-{s}.png',ROOT/f'app-icons/{name}.png');GENERATED.append(f'app-icons/{name}.png')

# Flat foreground source for Apple's native Icon Composer, separate from backdrop.
write('app-icons/composer/foreground.svg',doc(mark(IVORY,x=192,y=192,size=640),1024,1024))
write('app-icons/composer/background.svg',doc(rect(0,0,1024,1024,INK),1024,1024))

# A conventional single-image iOS asset catalog. Keep it separate from the app checkout.
ios=ROOT/'app-icons/apple/AppIcon.appiconset';ios.mkdir(parents=True,exist_ok=True)
shutil.copyfile(ROOT/'app-icons/app-icon-1024.png',ios/'AppIcon-1024.png')
GENERATED.append('app-icons/apple/AppIcon.appiconset/AppIcon-1024.png')
write('app-icons/apple/AppIcon.appiconset/Contents.json',json.dumps({'images':[{'filename':'AppIcon-1024.png','idiom':'universal','platform':'ios','size':'1024x1024'}],'info':{'author':'xcode','version':1}},indent=2)+'\n')

# macOS icon family. Use the same SVG placement at every size.
iconset=ROOT/'app-icons/macos/kanban-cards.iconset';iconset.mkdir(parents=True,exist_ok=True)
for s in [16,32,128,256,512]:
    for mult,suffix in [(1,''),(2,'@2x')]:
        size=s*mult
        source=ROOT/f'app-icons/app-icon-{size}.png'
        if not source.exists(): render(ROOT/'app-icons/app-icon.svg',str(source.relative_to(ROOT)),size,True)
        target=iconset/f'icon_{s}x{s}{suffix}.png';shutil.copyfile(source,target);GENERATED.append(str(target.relative_to(ROOT)))
mac_frames=[Image.open(ROOT/f'app-icons/app-icon-{n}.png').convert('RGBA') for n in [32,64,128,256,512,1024]]
mac_frames[-1].save(ROOT/'app-icons/macos/kanban-cards.icns',format='ICNS',append_images=mac_frames)
GENERATED.append('app-icons/macos/kanban-cards.icns')

# Icons-only fragment does not change app name, navigation, launch behavior, or display mode.
write('web-manifest-icons.json',json.dumps({'icons':[
 {'src':'/brand/split-k/app-icons/app-icon-192.png','sizes':'192x192','type':'image/png','purpose':'any'},
 {'src':'/brand/split-k/app-icons/app-icon-512.png','sizes':'512x512','type':'image/png','purpose':'any'},
 {'src':'/brand/split-k/app-icons/maskable-192.png','sizes':'192x192','type':'image/png','purpose':'maskable'},
 {'src':'/brand/split-k/app-icons/maskable-512.png','sizes':'512x512','type':'image/png','purpose':'maskable'}]},indent=2)+'\n')
write('web-head.html','''<!-- Example asset paths: adjust to your static asset mount. -->
<link rel="icon" href="/brand/split-k/favicon/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="/brand/split-k/favicon/favicon.svg" type="image/svg+xml" sizes="any">
<link rel="apple-touch-icon" href="/brand/split-k/app-icons/apple-touch-icon.png" sizes="180x180">
<link rel="mask-icon" href="/brand/split-k/favicon/safari-pinned-tab.svg" color="#0B0D0E">
''')

# Animated concept: geometry is fixed; only opacity changes and reduced motion is respected.
# Canonical outlined lockups use pinned Inter 780 source paths and shared proportions.
subprocess.run([sys.executable, str(ROOT/'build_lockups.py')], check=True)
GENERATED.extend(json.loads((ROOT/'lockup-layout.json').read_text())['generated'])

style='<style>.stem{animation:reveal .45s ease-out both}.upper{animation:reveal .45s .12s ease-out both}.lower{animation:reveal .45s .24s ease-out both}@keyframes reveal{from{opacity:0}to{opacity:1}}@media(prefers-reduced-motion:reduce){.stem,.upper,.lower{animation:none}}</style>'
parts=''.join(f'<polygon class="{cl}" points="{pts}"/>' for cl,pts in zip(['stem','upper','lower'],PARTS))
write('svg/mark-motion.svg',doc(style+f'<g fill="{INK}">{parts}</g>'))

# Proofs use source geometry rather than screenshots of enlarged raster assets.
W,H=1440,1030
b=rect(0,0,W,H,IVORY)+text(56,66,'Split K asset system',38,600)+text(56,100,'Split K / selected asset system',18)
b+=text(1384,65,'A · LOCKED',12,600,anchor='end')+f'<path d="M56 125H1384" stroke="{RULE}"/>'
b+=mark(INK,x=138,y=165,size=224)
b+=text(56,440,'Canonical mark',18,600)+text(56,469,'Three planes. Exact selected geometry.',13)
b+=rect(504,155,390,270,INK,8)+mark(IVORY,x=615,y=205,size=168)
b+=text(504,461,'Reversed',18,600)+text(504,489,'One color for small-size contrast.',13)
b+=rect(988,155,270,270,INK,58)+mark(IVORY,True,x=1038.625,y=205.625,size=168.75)
b+=text(988,461,'Primary app icon',18,600)+text(988,489,'Centered. Opaque square source.',13)
b+=f'<path d="M56 518H1384" stroke="{RULE}"/>'
b+=text(56,554,'Actual mark sizes',18,600)
x=62
for s in SIZES:
    b+=mark(INK,x=x,y=590+(96-s)/2,size=s)
    b+=text(x+s/2,713,f'{s}px',12,anchor='middle');x+=s+38
b+=text(565,554,'Browser fallback',18,600)
for j,s in enumerate([16,32,48]):
    x=565+j*100
    b+=rect(x,605,s,s,INK)+mark(IVORY,x=x,y=605,size=s)
    b+=text(x+s/2,691,f'{s}px',12,anchor='middle')
b+=text(988,554,'App treatments',18,600)
b+=rect(988,584,108,108,IVORY,23,RULE)+mark(INK,x=1008.25,y=604.25,size=67.5)
b+=rect(1144,584,108,108,INK,23)+mark(IVORY,True,x=1164.25,y=604.25,size=67.5)
b+=text(988,720,'Light tile',12)+text(1144,720,'Nickel lower plane',12)
b+=f'<path d="M56 748H1384" stroke="{RULE}"/>'
b+=text(56,784,'Mask behavior',18,600)
for i,(name,clip) in enumerate([
 ('Square',rect(0,0,136,136,'#fff')),
 ('Rounded square',rect(0,0,136,136,'#fff',29)),
 ('Circle','<circle cx="68" cy="68" r="68"/>'),
 ('Safe-zone crop','<circle cx="68" cy="68" r="54.4"/>')]):
    x=56+i*235;y=808
    b+=f'<g transform="translate({x} {y})">'+clip.replace('#fff',INK).replace('<circle ',f'<circle fill="{INK}" ')+mark(IVORY,x=25.5,y=25.5,size=85)+'</g>'
    b+=text(x,974,name,12)
b+=text(1040,848,'Source SVG + ICO',15,600)+text(1040,879,'PNG app icons through 1024px',13)+text(1040,910,'Apple catalog + macOS ICNS',13)+text(1040,941,'Maskable web icons',13)
b+=text(56,1010,'All mark variants share one canonical geometry. Rounded corners appear only in previews; app sources are square.',12,color='#666C70')
src=write('proofs/asset-overview.svg',doc(b,W,H,'Split K selected asset system'))
render(src,'proofs/asset-overview.png')

W,H=920,380
b=rect(0,0,W,H,IVORY)+text(28,40,'Split K at actual pixel sizes',26,600)
b+=text(28,69,'The master and favicon share the same 64 × 64 geometry.',14)
for row,(name,color,bg) in enumerate([('Ink',INK,IVORY),('Reversed',IVORY,INK)]):
    y=105+row*127
    b+=rect(28,y,864,116,bg,5)+text(44,y+28,name,14,600,color)
    x=192
    for s in SIZES:
        b+=mark(color,x=x,y=y+6+(96-s)/2,size=s)
        b+=text(x+s/2,y+109,f'{s}px',11,400,color,'middle');x+=s+48
b+=text(28,372,'Inspect at 100% scale. No independent snapping, rescaling, or geometry change was applied at 16px.',12)
src=write('proofs/pixel-proof.svg',doc(b,W,H));render(src,'proofs/pixel-proof.png')

# Safe-zone verification uses all polygon vertices; convex planes remain entirely inside.
radius=max(math.hypot(192+float(p.split(',')[0])*10-512,192+float(p.split(',')[1])*10-512) for points in PARTS for p in points.split())
assert radius<409.6
write('placement.json',json.dumps({'canonical_viewBox':[0,0,64,64],'app_canvas':1024,'mark_viewport':640,'translation':[192,192],'scale':10,'visible_bounds':[252,212,772,812],'safe_zone_radius':409.6,'maximum_mark_vertex_radius':radius,'safe_zone_margin':409.6-radius,'geometry_changes':'none'},indent=2)+'\n')
write('generated-files.json',json.dumps(sorted(set(GENERATED)),indent=2)+'\n')
print(f'Built {len(set(GENERATED))} outputs from {MASTER}')
