#!/usr/bin/env python3
"""Select the already-tested operations image IDs for protected production."""
import os
from pathlib import Path
import stat
import sys

root = Path('/srv/docker/secrets/myfin-prod')
runtime = root / 'runtime.env'
previous = root / 'runtime-before-operations-5145384.env'
selected = root / 'runtime-operations-5145384.env'
expected = {
    'MYFIN_API_IMAGE': 'myfin-api:phase07-ad37cbd',
    'MYFIN_WEB_IMAGE': 'myfin-web:phase06-0de74b2',
}
replacement = {
    'MYFIN_API_IMAGE': 'myfin-api:prod-operations-5145384',
    'MYFIN_WEB_IMAGE': 'myfin-web:prod-operations-5145384',
}

if stat.S_IMODE(runtime.stat().st_mode) != 0o600:
    raise SystemExit('Production runtime must have mode 0600')
original = runtime.read_text()
lines = original.splitlines(keepends=True)
for key, value in expected.items():
    matches = [line for line in lines if line.startswith(f'{key}=')]
    if matches != [f'{key}={value}\n']:
        raise SystemExit(f'Unexpected or duplicate {key}; no change made')
updated = ''.join(
    f'{key}={replacement[key]}\n' if key in replacement else line
    for line in lines
    for key in [line.partition('=')[0]]
)
if sys.argv[1:] == ['--dry-run']:
    print('production_image_selection_preflight_passed')
    raise SystemExit(0)
if sys.argv[1:]:
    raise SystemExit('Only --dry-run is supported')
if previous.exists() or selected.exists():
    raise SystemExit('Versioned runtime already exists; no change made')

def create_protected(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(content)

create_protected(previous, original)
create_protected(selected, updated)
temporary = root / 'runtime.operations.tmp'
create_protected(temporary, updated)
os.replace(temporary, runtime)
print('production_images_selected; previous and versioned runtime retained')
