#!/usr/bin/env python3
"""Select a tested Orders/reporting release without changing protected secrets."""
import os
from pathlib import Path
import re
import stat
import sys

if len(sys.argv) != 2 or not re.fullmatch(r'[0-9a-f]{7,40}', sys.argv[1]):
    raise SystemExit('Usage: production-select-feature-images.py <tested-source-sha>')
release = sys.argv[1][:7]
root = Path('/srv/docker/secrets/myfin-prod')
runtime = root / 'runtime.env'
previous = root / f'runtime-before-features-{release}.env'
selected = root / f'runtime-features-{release}.env'
expected = {
    'MYFIN_API_IMAGE': 'myfin-api:prod-operations-5145384',
    'MYFIN_WEB_IMAGE': 'myfin-web:prod-operations-5145384',
}
replacement = {
    'MYFIN_API_IMAGE': f'myfin-api:prod-features-{release}',
    'MYFIN_WEB_IMAGE': f'myfin-web:prod-features-{release}',
}
if stat.S_IMODE(runtime.stat().st_mode) != 0o600:
    raise SystemExit('Production runtime must have mode 0600')
original = runtime.read_text()
lines = original.splitlines(keepends=True)
for key, value in expected.items():
    if [line for line in lines if line.startswith(f'{key}=')] != [f'{key}={value}\n']:
        raise SystemExit(f'Unexpected or duplicate {key}; no change made')
if previous.exists() or selected.exists():
    raise SystemExit('Versioned runtime already exists; no change made')
updated = ''.join(
    f"{key}={replacement[key]}\n" if key in replacement else line
    for line in lines for key in [line.partition('=')[0]]
)

def create_protected(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(content)

create_protected(previous, original)
create_protected(selected, updated)
temporary = root / f'runtime.features.{release}.tmp'
create_protected(temporary, updated)
os.replace(temporary, runtime)
print('production_feature_images_selected; previous and versioned runtime retained')
