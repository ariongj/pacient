"""Create new VPS-only secrets. Refuse to overwrite an existing configuration."""
import argparse
import os
from pathlib import Path
import secrets
from urllib.parse import urlsplit

parser = argparse.ArgumentParser()
parser.add_argument('--web-url', required=True)
args = parser.parse_args()
url = urlsplit(args.web_url)
if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
    parser.error('--web-url must be a plain public HTTPS URL')
origin = f'{url.scheme}://{url.netloc}'
values = {
    'POSTGRES_PASSWORD': secrets.token_hex(32),
    'JWT_ACCESS_SECRET': secrets.token_hex(48),
    'MFA_ENCRYPTION_KEY': secrets.token_hex(48),
    'WEB_ORIGIN': origin,
    'WEB_APP_URL': args.web_url.rstrip('/'),
    'PACIENTI_BIND_ADDRESS': '127.0.0.1',
    'PACIENTI_PORT': '18840',
    'PACIENTI_IMAGE': 'pacienti-api:local',
}
target = Path(__file__).resolve().parent.parent / '.env.vps'
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as stream:
    stream.write(''.join(f'{key}={value}\n' for key, value in values.items()))
print('Private VPS configuration created; no credentials printed.')
