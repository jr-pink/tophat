# Re-embeds the Mac picture of item 3 into widgets/mac-desktop.html as a data URI and writes the notification as widgets/pushover.jpg (a plain image the chat shows in its image viewer):
#   uv run --with pillow python packages/demo/dev/embed-images.py [DIR]
# DIR (or $DEMO_SHOTS_DIR) holds mac-desktop.png and pushover.png.
# Rewrites only the image and its alt text's neighbours; the caption, layout and shared styles of each widget stay as committed.
# Commit the two widgets afterwards (explicit pathspec); the release publishes them.
import base64, io, os, re, sys
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__)); W = os.path.join(HERE, '..', 'widgets')
D = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('DEMO_SHOTS_DIR') or sys.exit('usage: embed-images.py DIR (or DEMO_SHOTS_DIR)')
DENY_FILE = os.path.join(HERE, '..', '..', '..', 'scripts', 'traceability-deny.txt')
DENY = [re.compile(l.strip(), re.I) for l in open(DENY_FILE) if l.strip() and not l.strip().startswith('#')] if os.path.exists(DENY_FILE) else []
def uri(name, width, q):
    im = Image.open(os.path.join(D, name)).convert('RGB')
    if im.width > width: im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    # base64 can spell a word the traceability scan denies by chance; step the quality down until it does not
    for qq in range(q, q - 10, -1):
        b = io.BytesIO(); im.save(b, 'JPEG', quality=qq, optimize=True)
        enc = base64.b64encode(b.getvalue()).decode()
        if not any(d.search(enc) for d in DENY): return 'data:image/jpeg;base64,' + enc
    raise SystemExit('every quality spelled a denied word')
im = Image.open(os.path.join(D, 'pushover.png')).convert('RGB'); im = im.resize((800, round(im.height * 800 / im.width)), Image.LANCZOS)
im.save(os.path.join(W, 'pushover.jpg'), 'JPEG', quality=82, optimize=True, progressive=True)
for widget, png, width, q in (('mac-desktop.html', 'mac-desktop.png', 1200, 72),):
    p = os.path.join(W, widget); h = open(p).read()
    h2, n = re.subn(r'(<img src=")data:image/jpeg;base64,[^"]*(")', lambda m: m.group(1) + uri(png, width, q) + m.group(2), h, count=1)
    assert n == 1, widget
    open(p, 'w').write(h2); print(widget, len(h2))
