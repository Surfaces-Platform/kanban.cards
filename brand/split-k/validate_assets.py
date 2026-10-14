#!/usr/bin/env python3
"""Validate asset geometry, pixel formats, packaging and integration references."""
from pathlib import Path
import hashlib, json, math, re, struct, xml.etree.ElementTree as ET
from PIL import Image, ImageChops

ROOT=Path(__file__).resolve().parent
NS={'s':'http://www.w3.org/2000/svg'}
EXPECTED=['6,6 18,6 18,58 6,58','26,16 58,2 58,16 26,30','26,34 58,48 58,62 26,48']
checks=[]
def passed(name,**details): checks.append({'check':name,'result':'pass',**details})
master=ET.parse(ROOT/'split-k.svg').getroot()
assert master.attrib['viewBox']=='0 0 64 64'
assert [p.attrib['points'] for p in master.findall('.//s:polygon',NS)]==EXPECTED
for p in ROOT.rglob('*.svg'):
    tree=ET.parse(p)
    for node in tree.findall('.//s:polygon',NS):
        assert node.attrib['points'] in EXPECTED,(str(p),'foreign polygon')
    assert not tree.findall('.//s:script',NS),p
    for node in tree.iter():
        for key,val in node.attrib.items():
            if key.endswith('href'): assert val.startswith('#'),(p,val)
passed('SVG syntax, locked canonical geometry, and no foreign mark polygons',count=len(list(ROOT.rglob('*.svg'))))
for p in [ROOT/'split-k.svg',*list((ROOT/'svg').glob('*.svg')),*list((ROOT/'favicon').glob('*.svg')),*list((ROOT/'lockups').glob('*.svg'))]:
    tree=ET.parse(p)
    assert not tree.findall('.//s:text',NS),p
passed('Portable master and lockups without font dependencies')
for scheme in ['ink','reversed']:
    for s in [16,24,32,48,96,512]:
        with Image.open(ROOT/f'png/mark-{scheme}-{s}.png') as im:
            assert im.size==(s,s)
            assert im.mode=='RGBA'
            assert im.getchannel('A').getextrema()==(0,255)
            assert im.getbbox()
passed('Transparent mark PNG dimensions and alpha',sizes=[16,24,32,48,96,512])
for p in (ROOT/'app-icons').rglob('*.png'):
    with Image.open(p) as im:
        assert im.width==im.height,p
        assert im.mode=='RGB',(p,im.mode)
        assert im.getpixel((0,0))==im.getpixel((im.width-1,im.height-1)),p
passed('All flat app icon PNGs square, opaque RGB and unrounded',count=len(list((ROOT/'app-icons').rglob('*.png'))))
for name in ['app-icon','app-icon-light','app-icon-nickel']:
    sizes=[16,24,32,48,64,96,128,180,192,256,512,1024] if name=='app-icon' else [512,1024]
    for size in sizes:
        with Image.open(ROOT/f'app-icons/{name}-{size}.png') as im: assert im.size==(size,size)
with Image.open(ROOT/'app-icons/apple-touch-icon.png') as im: assert im.size==(180,180)
passed('App icon dimensions through 1024px and Apple touch 180px')
ico=Image.open(ROOT/'favicon/favicon.ico')
assert ico.ico.sizes()=={(16,16),(32,32),(48,48)},ico.ico.sizes()
for s in [16,32,48]:
    frame=ico.ico.getimage((s,s)).convert('RGBA')
    expected=Image.open(ROOT/f'favicon/favicon-{s}.png').convert('RGBA')
    assert frame.tobytes()==expected.tobytes(),s
passed('ICO frames match exported PNGs exactly',sizes=[16,32,48])
with Image.open(ROOT/'app-icons/macos/kanban-cards.icns') as icns:
    assert icns.format=='ICNS'
    for points_w,points_h,scale in icns.info['sizes']:
        s=points_w*scale
        frame=icns.icns.getimage((points_w,points_h,scale)).convert('RGBA')
        expected=Image.open(ROOT/f'app-icons/app-icon-{s}.png').convert('RGBA')
        assert frame.size==(s,s) and frame.tobytes()==expected.tobytes(),s
passed('macOS ICNS readable and frames match rendered PNGs',sizes=[32,64,128,256,512,1024])
placement=json.loads((ROOT/'placement.json').read_text())
assert placement['maximum_mark_vertex_radius']<placement['safe_zone_radius']
for s in [192,512]:
    im=Image.open(ROOT/f'app-icons/maskable-{s}.png').convert('RGB')
    pix=im.load();cx=cy=s/2
    # Include all painted antialias pixels and their outer pixel corners, not just vertices.
    for y in range(s):
        for x in range(s):
            if pix[x,y]!=(11,13,14):
                assert max(math.hypot(px-cx,py-cy) for px in [x,x+1] for py in [y,y+1])<=s*.4,(s,x,y)
passed('Maskable artwork and antialias pixels fully inside circular safe zone',maximum_vertex_radius=placement['maximum_mark_vertex_radius'],safe_zone_radius=placement['safe_zone_radius'])
frag=json.loads((ROOT/'web-manifest-icons.json').read_text())
assert set(frag)=={'icons'}
for icon in frag['icons']:
    target=ROOT/icon['src'].removeprefix('/brand/split-k/')
    assert target.exists(),target
    s=int(icon['sizes'].split('x')[0])
    with Image.open(target) as im: assert im.size==(s,s)
assert '@media (prefers-color-scheme:dark)' in (ROOT/'favicon/favicon.svg').read_text()
assert 'prefers-reduced-motion:reduce' in (ROOT/'svg/mark-motion.svg').read_text()
passed('Manifest references, adaptive favicon declarations and reduced-motion support')
contents=json.loads((ROOT/'app-icons/apple/AppIcon.appiconset/Contents.json').read_text())
for entry in contents['images']:
    path=ROOT/'app-icons/apple/AppIcon.appiconset'/entry['filename']
    with Image.open(path) as im: assert im.size==(1024,1024) and im.mode=='RGB'
passed('iOS single-image catalog references valid 1024px opaque source')
for name,expected in [('asset-overview.png',(1440,1030)),('pixel-proof.png',(920,380))]:
    with Image.open(ROOT/'proofs'/name) as im: assert im.size==expected,(name,im.size)
passed('Proof image dimensions')
# Canonical wordmarks and proportions are portable, pinned source contracts.
rules=json.loads((ROOT/'wordmark-source/lockup-rules.json').read_text())
metrics=json.loads((ROOT/'wordmark-source/metrics.json').read_text())
assert metrics['fontFamily']=='Inter' and metrics['weightAxis']==780 and metrics['opticalSizeAxis']==32
assert metrics['fallbackRuns']==0 and metrics['fontFilesIncluded'] is False
assert metrics['fontFileSha256']==rules['fontFileSha256']
assert metrics['fontSize']==64 and metrics['capHeight']==46.5625
source_paths=[p.attrib['d'] for p in ET.parse(ROOT/'wordmark-source/kanban-cards-wordmark.svg').findall('s:path',NS)]
assert len(source_paths)==12
assert hashlib.sha256('\n'.join(source_paths).encode()).hexdigest()==rules['wordmarkGlyphPathDigest']
def parts(transform):
    values=list(map(float,re.findall(r'-?\d+(?:\.\d+)?',transform)))
    assert len(values)==3,transform
    return values
def close(a,b): assert abs(a-b)<1e-6,(a,b)
ib=metrics['inkBounds']; variants={}
for layout in ['horizontal','stacked']:
    for suffix,color in [('', '#0B0D0E'),('-reversed','#F7F6F2')]:
        path=ROOT/'lockups'/(layout+suffix+'.svg');doc=ET.parse(path).getroot()
        mark=doc.find("s:g[@data-role='mark']",NS);word=doc.find("s:g[@data-role='wordmark']",NS)
        polygons=mark.findall('s:polygon',NS)
        assert [p.attrib['points'] for p in polygons]==EXPECTED
        assert [p.attrib['fill'] for p in polygons]==[color,color,'#8B9096']
        assert word.attrib['fill']==color
        glyphs=[p.attrib['d'] for p in word.findall('s:path',NS)];assert glyphs==source_paths
        assert not doc.findall('.//s:text',NS)
        tx,ty,ms=parts(mark.attrib['transform']);wx,baseline,ws=parts(word.attrib['transform'])
        close(ms,1);close(60*ms,60);close(metrics['capHeight']*ws,38)
        mark_left,mark_top,mark_right,mark_bottom=tx+6*ms,ty+2*ms,tx+58*ms,ty+62*ms
        word_left,word_top=wx+ib['x']*ws,baseline+ib['y']*ws
        word_right,word_bottom=wx+(ib['x']+ib['width'])*ws,baseline+(ib['y']+ib['height'])*ws
        width,height=float(doc.attrib['width']),float(doc.attrib['height'])
        assert min(mark_left,word_left)>=24-1e-6 and min(mark_top,word_top)>=24-1e-6
        assert width-max(mark_right,word_right)>=24-1e-6 and height-max(mark_bottom,word_bottom)>=24-1e-6
        if layout=='horizontal':
            close(word_left-mark_right,20);close(baseline,73);close(height,109)
            close(baseline-38/2,(mark_top+mark_bottom)/2)
            assert hashlib.sha256(path.read_bytes()).hexdigest()==rules['approvedHorizontalSha256'][path.name]
        else:
            close(word_top-mark_bottom,20);close((mark_left+mark_right)/2,(word_left+word_right)/2)
        with Image.open(path.with_suffix('.png')) as image:
            assert image.size==(round(width*4),round(height*4)),(path,image.size)
            assert image.mode=='RGBA'
            alpha=image.getchannel('A').getbbox();assert alpha[0]>0 and alpha[1]>0 and alpha[2]<image.width and alpha[3]<image.height
            colors={pixel[:3] for pixel in image.get_flattened_data() if pixel[3]==255}
            assert tuple(bytes.fromhex(color[1:])) in colors and (139,144,150) in colors
        variant=(glyphs,mark.attrib['transform'],word.attrib['transform'],doc.attrib['viewBox'])
        if not suffix: variants[layout]=variant
        else: assert variants[layout]==variant
passed('Inter 780 optical-size 32 outlines, no fallback, and exact approved horizontal SVG fingerprints')
passed('Canonical lockup 60px marks, 38px cap height, 20px ink gaps, shared horizontal baseline, and minimum 24px padding')
passed('Nickel primary lockups, identical light/dark geometry, and unclipped four-times PNG exports')
with Image.open(ROOT/'proofs/lockup-proof.png') as image: assert image.size==(1000,330)
with Image.open(ROOT/'proofs/stacked-proof.png') as image: assert image.size==(1000,240)
passed('Light and dark canonical lockup proof dimensions')

receipt=ROOT/'validation.json'
old=json.loads(receipt.read_text()) if receipt.exists() else {}
manual=old.get('manual_checks',[])
receipt.write_text(json.dumps({'status':'asset checks passed','canonical_source':'split-k.svg','canonical_sha256':hashlib.sha256((ROOT/'split-k.svg').read_bytes()).hexdigest(),'geometry_changes':'none','checks':checks,'manual_checks':manual},indent=2)+'\n')
print(json.dumps({'status':'pass','checks':len(checks),'receipt':str(receipt)},indent=2))
