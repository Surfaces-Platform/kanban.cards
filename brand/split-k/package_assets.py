#!/usr/bin/env python3
"""Create a deterministic ZIP of the selected asset system and verify its contents."""
from pathlib import Path
import hashlib, json, zipfile
ROOT=Path(__file__).resolve().parent
EXCLUDE={'SHA256SUMS','package.json','.DS_Store'}
files=sorted(p for p in ROOT.rglob('*') if p.is_file() and p.name not in EXCLUDE and '__pycache__' not in p.parts)
receipt=json.loads((ROOT/'validation.json').read_text())
assert receipt['status']=='asset checks passed'
assert all(x['result']=='pass' for x in receipt['checks']+receipt['manual_checks'])
sums=''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+str(p.relative_to(ROOT))+'\n' for p in files)
(ROOT/'SHA256SUMS').write_text(sums)
files=sorted([*files,ROOT/'SHA256SUMS'])
archive=ROOT.parent/'kanban-cards-split-k-assets.zip'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for p in files:
        info=zipfile.ZipInfo('split-k/'+str(p.relative_to(ROOT)),date_time=(2026,10,13,0,0,0))
        info.compress_type=zipfile.ZIP_DEFLATED
        info.external_attr=0o100644<<16
        z.writestr(info,p.read_bytes())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    assert len(z.namelist())==len(files)
    for p in files: assert z.read('split-k/'+str(p.relative_to(ROOT)))==p.read_bytes()
metadata={'archive':archive.name,'files':len(files),'bytes':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'verified':'CRC and exact content bytes match every packaged source file'}
(ROOT.parent/'kanban-cards-split-k-assets.json').write_text(json.dumps(metadata,indent=2)+'\n')
print(json.dumps(metadata,indent=2))
