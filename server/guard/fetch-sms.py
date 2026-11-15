"""Fetch only the pinned public UCI dataset. Never reads application data."""
import hashlib
import io
from pathlib import Path
import urllib.request
import zipfile

URL = 'https://archive.ics.uci.edu/static/public/228/sms+spam+collection.zip'
CACHE = Path(__file__).parent / '.cache' / 'SMSSpamCollection'
SHA256 = '7d039a24a6083ed9ef0f806ebad56bbb976e3aeb8de05669173bfdc4996c239d'
if CACHE.exists():
    content = CACHE.read_bytes()
else:
    with urllib.request.urlopen(URL, timeout=25) as response:
        archive = response.read(1_000_001)
    if len(archive) > 1_000_000:
        raise SystemExit('Unexpected public corpus size.')
    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        info = source.getinfo('SMSSpamCollection')
        if info.file_size > 1_000_000:
            raise SystemExit('Unexpected expanded corpus size.')
        content = source.read(info)
if hashlib.sha256(content).hexdigest() != SHA256:
    raise SystemExit('Public corpus checksum changed. Review the source before retraining.')
CACHE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
CACHE.write_bytes(content)
CACHE.chmod(0o600)
print('Verified pinned public UCI corpus; no application data used.')
