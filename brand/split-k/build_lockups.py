#!/usr/bin/env python3
"""Build canonical Inter 780 nickel lockups from the included vector outlines."""
from pathlib import Path
from copy import deepcopy
import hashlib, json, math, subprocess, xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
NS = {'s': 'http://www.w3.org/2000/svg'}
ET.register_namespace('', NS['s'])
EXPECTED = ['6,6 18,6 18,58 6,58', '26,16 58,2 58,16 26,30', '26,34 58,48 58,62 26,48']
rules = json.loads((ROOT/'wordmark-source/lockup-rules.json').read_text())
metrics = json.loads((ROOT/'wordmark-source/metrics.json').read_text())
assert metrics['fontFamily'] == rules['fontFamily'] == 'Inter'
assert metrics['weightAxis'] == rules['weightAxis'] == 780
assert metrics['opticalSizeAxis'] == rules['opticalSizeAxis'] == 32
assert metrics['fallbackRuns'] == 0
assert metrics['fontFileSha256'] == rules['fontFileSha256']
assert metrics['fontSize'] == rules['sourceFontSize'] == 64
assert metrics['capHeight'] == rules['sourceCapHeight'] == 46.5625
source = ET.parse(ROOT/'wordmark-source/kanban-cards-wordmark.svg').getroot()
paths = source.findall('s:path', NS)
assert len(paths) == metrics['glyphCount'] == 12
assert not source.findall('.//s:text', NS)
path_digest = hashlib.sha256('\n'.join(p.attrib['d'] for p in paths).encode()).hexdigest()
assert path_digest == rules['wordmarkGlyphPathDigest'], 'Wordmark differs from approved Inter outlines'
polygons = ET.parse(ROOT/'split-k.svg').findall('.//s:polygon', NS)
assert [p.attrib['points'] for p in polygons] == EXPECTED

scale = rules['capHeight']/metrics['capHeight']
ib = metrics['inkBounds']
word_width = ib['width']*scale
generated = []
records = []

def render(svg, target, density=384):
    # Vector outlines need no installed fonts. Strip time metadata for repeatable PNGs.
    subprocess.run(['magick', '-background', 'none', '-density', str(density), str(svg), '-strip', str(target)], check=True)

for layout in ['horizontal', 'stacked']:
    if layout == 'horizontal':
        width = 24+52+20+word_width+24
        height = rules['canvasHeight']
        mark_x, mark_y = 18., 22.
        word_x, baseline = 96-ib['x']*scale, float(rules['baseline'])
    else:
        # Same type scale and mark height; the 20px gap is measured vertically.
        width = math.ceil(max(52, word_width)+48)
        mark_x, mark_y = (width-52)/2-6, 22.
        baseline = 84+20-ib['y']*scale
        word_x = (width-word_width)/2-ib['x']*scale
        height = math.ceil(baseline+(ib['y']+ib['height'])*scale+24)
    for theme, color, suffix in [('light', '#0B0D0E', ''), ('dark', '#F7F6F2', '-reversed')]:
        name = layout+suffix
        svg = ET.Element('{'+NS['s']+'}svg', {
            'width': f'{width:.9f}', 'height': str(height),
            'viewBox': f'0 0 {width:.9f} {height}', 'role': 'img', 'aria-labelledby': 'title',
            'data-font-family': 'Inter', 'data-font-weight': '780', 'data-font-optical-size': '32',
            'data-mark-height': '60', 'data-cap-height': '38', 'data-ink-gap': '20'})
        ET.SubElement(svg, '{'+NS['s']+'}title', {'id': 'title'}).text = f'kanban.cards consistent {layout} lockup, Inter 780, {theme}'
        mark = ET.SubElement(svg, '{'+NS['s']+'}g', {'data-role': 'mark', 'transform': f'translate({mark_x:.12f} {mark_y:.12f}) scale(1.000000000000)'})
        for i, original in enumerate(polygons):
            polygon = deepcopy(original)
            polygon.attrib.pop('class', None)
            polygon.tail = None
            polygon.attrib['fill'] = '#8B9096' if i == 2 else color
            mark.append(polygon)
        word = ET.SubElement(svg, '{'+NS['s']+'}g', {'data-role': 'wordmark', 'fill': color, 'transform': f'translate({word_x:.12f} {baseline:.12f}) scale({scale:.12f})'})
        for path in paths:
            word.append(deepcopy(path))
        target = ROOT/'lockups'/(name+'.svg')
        ET.ElementTree(svg).write(target, encoding='unicode', xml_declaration=False)
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        if layout == 'horizontal':
            assert digest == rules['approvedHorizontalSha256'][target.name], 'Horizontal lockup differs from the approved source'
        render(target, target.with_suffix('.png'))
        generated += ['lockups/'+name+'.svg', 'lockups/'+name+'.png']
        records.append({'layout': layout, 'theme': theme, 'svg': 'lockups/'+name+'.svg',
                        'sha256': digest, 'width': width, 'height': height,
                        'markTransform': mark.attrib['transform'], 'wordTransform': word.attrib['transform']})

# Both canonical horizontal lockups use the same scale in this rendered proof.
proof = ET.Element('{'+NS['s']+'}svg', {'width': '1000', 'height': '330', 'viewBox': '0 0 1000 330'})
for row, suffix, background in [(0, '', '#F7F6F2'), (1, '-reversed', '#0B0D0E')]:
    ET.SubElement(proof, '{'+NS['s']+'}rect', {'x': '0', 'y': str(row*165), 'width': '1000', 'height': '165', 'fill': background})
    lockup = ET.parse(ROOT/'lockups'/('horizontal'+suffix+'.svg')).getroot()
    width = float(lockup.attrib['width'])
    group = ET.SubElement(proof, '{'+NS['s']+'}g', {'transform': f'translate({(1000-width*1.4)/2:.12f} {row*165+(165-109*1.4)/2:.12f}) scale(1.4)'})
    for child in lockup.findall('s:g', NS):
        group.append(deepcopy(child))
proof_path = ROOT/'proofs/lockup-proof.svg'
ET.ElementTree(proof).write(proof_path, encoding='unicode', xml_declaration=False)
render(proof_path, proof_path.with_suffix('.png'), density=96)
generated += ['proofs/lockup-proof.svg', 'proofs/lockup-proof.png', 'lockup-layout.json']
stacked_proof = ET.Element('{'+NS['s']+'}svg', {'width': '1000', 'height': '240', 'viewBox': '0 0 1000 240'})
for column, suffix, background in [(0, '', '#F7F6F2'), (1, '-reversed', '#0B0D0E')]:
    ET.SubElement(stacked_proof, '{'+NS['s']+'}rect', {'x': str(column*500), 'y': '0', 'width': '500', 'height': '240', 'fill': background})
    lockup = ET.parse(ROOT/'lockups'/('stacked'+suffix+'.svg')).getroot()
    group = ET.SubElement(stacked_proof, '{'+NS['s']+'}g', {'transform': f'translate({column*500+60} 36.5)'})
    for child in lockup.findall('s:g', NS):
        group.append(deepcopy(child))
stacked_proof_path = ROOT/'proofs/stacked-proof.svg'
ET.ElementTree(stacked_proof).write(stacked_proof_path, encoding='unicode', xml_declaration=False)
render(stacked_proof_path, stacked_proof_path.with_suffix('.png'), density=96)
generated += ['proofs/stacked-proof.svg', 'proofs/stacked-proof.png']
(ROOT/'lockup-layout.json').write_text(json.dumps({'font': 'Inter', 'weight': 780, 'opticalSize': 32,
    'visibleMarkHeight': 60, 'capHeight': 38, 'inkGap': 20, 'minimumOuterPadding': 24,
    'horizontalBaseline': 73, 'horizontalCanvasHeight': 109, 'wordmarkGlyphPathDigest': path_digest,
    'assets': records, 'generated': generated}, indent=2)+'\n')
print(f'Built {len(records)} outlined Inter 780 lockups with canonical nickel geometry.')
