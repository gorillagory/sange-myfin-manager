#!/usr/bin/env python3
"""Create fresh file-only MyFin dev secrets outside source; prints no secret."""
import os,pathlib,secrets,sys
if len(sys.argv)!=2:raise SystemExit('Usage: create-secrets.py /absolute/private-directory')
p=pathlib.Path(sys.argv[1]).resolve();repo=pathlib.Path(__file__).resolve().parents[2]
if not p.is_absolute() or p.exists() or p.is_relative_to(repo):raise SystemExit('Use a new absolute directory outside Git')
p.mkdir(mode=0o700)
for name in ['runtime','migrator','auth','seed']:
 f=p/(name+'.secret')
 with f.open('x') as out:out.write(secrets.token_urlsafe(48)+'\n')
 f.chmod(0o600)
 if os.geteuid()==0:os.chown(f,1000,1000)
print('Created protected MyFin development secret files; no values displayed.')
