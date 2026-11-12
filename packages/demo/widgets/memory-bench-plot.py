# Renders widgets/memory-bench-a.png and memory-bench-b.png (the two panels of the opener answer's "Memory benchmarks" figure, 2a and 2b)
# from fallback/memory-bench-charts.json, and embeds both in widgets/memory-bench.html. The two panels are separate images of one size, dpi and
# font size so the page can lay them side by side or stack them (flexbox) with identical text on screen.
# Run: uv run --with matplotlib python packages/demo/widgets/memory-bench-plot.py
import json, pathlib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = pathlib.Path(__file__).resolve().parent
data = json.loads((HERE.parent / "fallback" / "memory-bench-charts.json").read_text())

# one figure size, dpi and set of font sizes for both panels (the widget shows each at the same CSS width in either layout)
FIG, DPI, FONT = (4.2, 3.7), 300, 8
TITLE_PT, TICK_PT, NUM_PT, LEG_PT = 9.5, 7.6, 7, 7
ROT = 35  # x label slant: steep enough that neighbouring two-line labels clear each other at this panel width
ACCENT, INK, DIM, GRID, BAR, BASE, BG = "#b45c6e", "#1c1b19", "#77736a", "#e4e0d6", "#9d998f", "#cfcbc0", "#fbfaf6"
plt.rcParams.update({
    "font.family": ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"], "font.size": FONT,
    "axes.edgecolor": DIM, "axes.labelcolor": INK, "xtick.color": INK, "ytick.color": DIM,
    "axes.spines.top": False, "axes.spines.right": False, "figure.facecolor": BG, "axes.facecolor": BG,
})

def pct(r): return 100 * r["correct"] / r["n"]

A = {r["system"]: r for r in data["setB_longmemeval_hard15"]["rows"]}
B = {r["system"]: r for r in data["personal_flooded_with_services"]["rows"]}
NAMES = {"Tophat core (Opus 5.5)": "Tophat\nOpus 5.5", "Mem0 OSS (Opus 5.5)": "Mem0 OSS\nOpus 5.5", "Wiki notes (Opus 5.5)": "Wiki notes\nOpus 5.5", "agentmemory (Opus 5.5)": "agentmemory\nOpus 5.5", "Zep/Graphiti (Opus 5.5)": "Zep/Graphiti\nOpus 5.5", "Supermemory (Opus 5.5)": "Supermemory\nOpus 5.5", "all in context (Opus 5.5)": "All in context (oracle)\nOpus 5.5", "tophat": "Tophat"}
ORACLE = "all in context"  # the oracle row: every event in the prompt, an upper bound rather than a system; drawn grayed out
SERVICES = {"Grok Bot", "Instinct", "Meta Muse", "ChatGPT dots", "Kat"}
# research memory systems: every 2a row is answered by Opus 5.5 and named "<system> (Opus 5.5)" (the answering model; the memory-building
# model is in the caption), every one on both benchmarks; best first by the mean of the two scores
research = [s for s in A if s.endswith("(Opus 5.5)") and s in B]
research.sort(key=lambda s: (ORACLE not in s, -(pct(A[s]) + pct(B[s])) / 2))  # the oracle (upper bound) first, on the left; then systems best first
# chat assistants: the services plus tophat, on the real personal traces; best first
assist = sorted([s for s in B if s in SERVICES or s == "tophat"], key=lambda s: -pct(B[s]))  # 2b's own Tophat row; the 2a row is "Tophat core (Opus 5.5)"

def style(ax, title):
    ax.set_ylim(0, 116); ax.set_yticks(range(0, 101, 20)); ax.set_ylabel("correct (%)")
    ax.yaxis.grid(True, color=GRID, lw=0.8, zorder=0); ax.set_axisbelow(True); ax.tick_params(axis="x", length=0)
    ax.set_title(title, loc="left", fontsize=TITLE_PT, color=INK, pad=12, fontweight="bold")

def ticks(ax, xs, names):
    ax.set_xticks(list(xs), [NAMES.get(n, n) for n in names], fontsize=TICK_PT, multialignment="center", linespacing=1.15, rotation=ROT, ha="center", va="center", rotation_mode="anchor")
    for t, n in zip(ax.get_xticklabels(), names):
        if B[n].get("ours"): t.set_color(ACCENT); t.set_fontweight("bold")
        if ORACLE in n: t.set_color(DIM)

def num(ax, x, r, ours, orc=False, rot=0):
    ax.text(x, pct(r) + 1.2, f"{r['correct']}/{r['n']}", ha="center", va="bottom", rotation=rot, fontsize=NUM_PT, color=ACCENT if ours else (DIM if orc else INK), fontweight="bold" if ours else "normal")

import math
from matplotlib.patches import Patch
from matplotlib.offsetbox import OffsetImage, AnnotationBbox
from matplotlib.transforms import ScaledTranslation

def new_panel():
    fig, ax = plt.subplots(figsize=FIG)
    fig.subplots_adjust(left=0.135, right=0.99, top=0.9, bottom=0.29)
    return fig, ax

def finish(fig, ax, name, title):
    # rotated labels hang from their centre: shift each down by half its unrotated width so the text's right end sits under its bar
    fig.canvas.draw(); rr = fig.canvas.get_renderer()
    for t in ax.get_xticklabels():
        t.set_rotation(0); w = t.get_window_extent(rr).width / fig.dpi; t.set_rotation(ROT)
        t.set_transform(t.get_transform() + ScaledTranslation(0, -(w / 2) * math.sin(math.radians(ROT)), fig.dpi_scale_trans))
    # guard: nothing leaves the panel; bar numbers do not touch each other; neighbouring slanted labels are further apart (perpendicular to the text) than their line height
    fb = fig.bbox
    xl = ax.get_xticklabels()
    for t in xl + ax.texts:
        bb = t.get_window_extent(rr)
        assert fb.x0 <= bb.x0 and bb.x1 <= fb.x1 and fb.y0 <= bb.y0 and bb.y1 <= fb.y1, f"{name}: '{t.get_text()}' leaves the panel"
    nums = [t.get_window_extent(rr) for t in ax.texts]
    assert not any(n.overlaps(p.get_window_extent(rr)) for n in nums for p in ax.patches), f"{name}: a bar number sits on a bar"
    assert not any(p.overlaps(q) for k, p in enumerate(nums) for q in nums[k + 1:]), f"{name}: bar numbers overlap"
    if ax.get_legend():
        lb = ax.get_legend().get_window_extent(rr)
        assert not any(lb.overlaps(o.get_window_extent(rr)) for o in ax.texts + list(ax.patches)), f"{name}: the legend sits on a bar or number"
    for ab in ax.artists:
        ib = ab.get_window_extent(rr)
        assert not any(ib.overlaps(t.get_window_extent(rr)) for t in xl), f"{name}: a logo sits on an x label"
    xs = [t.get_position()[0] for t in xl]
    pitch_in = min(y - x for x, y in zip(xs, xs[1:])) * ax.get_window_extent(rr).width / (ax.get_xlim()[1] - ax.get_xlim()[0]) / fig.dpi
    need_in = max(t.get_text().count("\n") + 1 for t in xl) * TICK_PT * 1.25 / 72
    assert pitch_in * math.sin(math.radians(ROT)) >= need_in, f"{name}: slanted labels collide ({pitch_in * math.sin(math.radians(ROT)):.3f}in < {need_in:.3f}in)"
    out = HERE / name
    fig.savefig(out, dpi=DPI, metadata={"Title": title}, pil_kwargs={"compress_level": 6})
    plt.close(fig)
    print(out)
    return out

# 2a: research memory systems, both benchmarks side by side per system
fa, a = new_panel()
w = 0.36
for i, n in enumerate(research):
    ours = bool(B[n].get("ours"))
    for dx, r, light in ((-w / 2, A[n], True), (w / 2, B[n], False)):
        c = (ACCENT if not light else "#dba9b3") if ours else (BAR if not light else BASE)
        orc = ORACLE in n
        a.bar(i + dx, pct(r), width=w * 0.94, color=c, edgecolor=DIM if orc else "none", linewidth=0.6, alpha=0.35 if orc else 1, linestyle=(0, (2, 1.5)) if orc else "-", zorder=2)
        num(a, i + dx, r, ours, orc, rot=90)  # upright numbers are wider than 2a's bars; stood on end they clear the neighbouring bars
ticks(a, range(len(research)), research)
a.tick_params(axis="x", pad=10)
style(a, "2a. Research memory systems")
a.set_ylim(0, 132)
a.legend(handles=[Patch(color=BASE, label="LongMemEval-S, hardest 15"), Patch(color=BAR, label="real personal traces, 99 questions")],
         frameon=False, fontsize=LEG_PT, loc="upper right", bbox_to_anchor=(1, 1.02), ncol=1, handlelength=1.2, labelspacing=0.3)
out_a = finish(fa, a, "memory-bench-a.png", "Memory benchmarks 2a: research memory systems, correct answers")

# 2b: chat assistants on the real personal traces; each carries its circular logo under the bar, above the name (icons from each product's site: widgets/logos/)
fb, b = new_panel()
for i, n in enumerate(assist):
    ours = bool(B[n].get("ours"))
    b.bar(i, pct(B[n]), width=0.6, color=ACCENT if ours else BAR, edgecolor="none", zorder=2)
    num(b, i, B[n], ours)
ticks(b, range(len(assist)), assist)
LOGOS = {"Grok Bot": "grok-logo.png", "ChatGPT dots": "chatgpt-logo.png", "Instinct": "instinct-logo.png", "Meta Muse": "muse-logo.png", "Kat": "kat-logo.png", "tophat": "tophat-logo.png"}
LOGO_PT = {"Grok Bot": 22, "ChatGPT dots": 27, "Instinct": 27, "Meta Muse": 27, "Kat": 27, "tophat": 28}
LOGO_K = 0.72  # logos scale with the smaller panel text
b.tick_params(axis="x", pad=36)
for i, n in enumerate(assist):
    if n not in LOGOS: continue
    img = plt.imread(HERE / "logos" / LOGOS[n])
    b.add_artist(AnnotationBbox(OffsetImage(img, zoom=LOGO_K * LOGO_PT[n] / img.shape[0] * 300 / 100 / 3), (i, 0), xybox=(0, -15), xycoords=("data", "axes fraction"),
                                boxcoords="offset points", frameon=False, box_alignment=(0.5, 0.5), annotation_clip=False))
style(b, "2b. Chat assistants, real personal traces")
out_b = finish(fb, b, "memory-bench-b.png", "Memory benchmarks 2b: chat assistants on real personal traces, correct answers")

# the chat's figure: the two plots in the widget frame with the shared caption underneath (the caption lives in HTML, never in the image).
# Layout (flexbox): side by side when the frame is wide, stacked when narrow; each image has one fixed CSS width in both, so the text is the same size on screen.
import base64
CAPTION = ("<b>Fig. 1</b>a. benchmarked on the hardest 15 questions in LongMemEval-S, b. benchmarked against real traces comprising 99 questions in a haystack of ~300k tokens.")
src = (HERE / "memory-bench.html").read_text() if (HERE / "memory-bench.html").exists() else ""
head = src.split("/* this figure:")[0]
assert "figcaption{" in head, "memory-bench.html lost the shared caption style"
uri = lambda p: "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()
(HERE / "memory-bench.html").write_text(head + """/* this figure: two matplotlib plots of one size and dpi (widgets/memory-bench-plot.py, 300 dpi), flexbox: side by side when the frame has room, stacked when not.
   Each image is 312 CSS px wide in both layouts and in the figure viewer (never scaled up), so the text on screen is the same size everywhere. The page is as tall as its
   content and tells the chat so ({tophatFigure:'height'}, below); the chat sizes the frame to it, so nothing scrolls inside. */
html,body{height:auto}body{overflow:visible;background:#fbfaf6}figure{flex:none}.art{flex:none;display:flex;justify-content:center;padding:4px}
.pair{display:flex;flex-wrap:wrap;justify-content:center;gap:6px}
.pair img{flex:none;width:312px;max-width:100%;height:auto;display:block}
</style></head><body>
<figure>
<div class="art"><div class="pair"><img alt="2a. Research memory systems: correct answers on LongMemEval-S (hardest 15) and on real personal traces (99 questions)" src=\"""" + uri(out_a) + """\"><img alt="2b. Chat assistants: correct answers on real personal traces (99 questions)" src=\"""" + uri(out_b) + """\"></div></div>
<figcaption>""" + CAPTION + """</figcaption>
</figure>
<script>(function(){function tell(){parent.postMessage({tophatFigure:'height',px:Math.ceil(document.body.getBoundingClientRect().height)},'*')}addEventListener('load',tell);if(window.ResizeObserver)new ResizeObserver(tell).observe(document.body);tell()})()</script>
</body></html>
""")
print(HERE / "memory-bench.html")
