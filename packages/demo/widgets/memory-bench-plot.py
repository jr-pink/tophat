# Renders widgets/memory-bench.png (the opener answer's "Memory benchmarks" figure) from fallback/memory-bench-charts.json.
# Run: uv run --with matplotlib python packages/demo/widgets/memory-bench-plot.py
import json, pathlib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = pathlib.Path(__file__).resolve().parent
data = json.loads((HERE.parent / "fallback" / "memory-bench-charts.json").read_text())

ACCENT, INK, DIM, GRID, BAR, BASE, BG = "#b45c6e", "#1c1b19", "#77736a", "#e4e0d6", "#9d998f", "#cfcbc0", "#fbfaf6"
plt.rcParams.update({
    "font.family": ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"], "font.size": 11,
    "axes.edgecolor": DIM, "axes.labelcolor": INK, "xtick.color": INK, "ytick.color": DIM,
    "axes.spines.top": False, "axes.spines.right": False, "figure.facecolor": BG, "axes.facecolor": BG,
})

def pct(r): return 100 * r["correct"] / r["n"]

A = {r["system"]: r for r in data["setB_longmemeval_hard15"]["rows"]}
B = {r["system"]: r for r in data["personal_flooded_with_services"]["rows"]}
NAMES = {"Tophat core (Opus 5.5)": "Tophat\nOpus 5.5", "Mem0 OSS (Opus 5.5)": "Mem0 OSS\nOpus 5.5", "Wiki notes (Opus 5.5)": "Wiki notes\nOpus 5.5", "agentmemory (Opus 5.5)": "agentmemory\nOpus 5.5", "Zep/Graphiti (Opus 5.5)": "Zep/Graphiti\nOpus 5.5", "Supermemory (Opus 5.5)": "Supermemory\nOpus 5.5", "all in context (Opus 5.5)": "All in context (oracle)\nOpus 5.5", "tophat": "Tophat"}
ORACLE = "all in context"  # the oracle row: every event in the prompt, an upper bound rather than a system; drawn grayed out
SERVICES = {"Grok Bot", "Instinct", "Meta Muse", "ChatGPT dots", "Email agent"}
# research memory systems: every 2a row is answered by Opus 5.5 and named "<system> (Opus 5.5)" (the answering model; the memory-building
# model is in the caption), every one on both benchmarks; best first by the mean of the two scores
research = [s for s in A if s.endswith("(Opus 5.5)") and s in B]
research.sort(key=lambda s: (ORACLE not in s, -(pct(A[s]) + pct(B[s])) / 2))  # the oracle (upper bound) first, on the left; then systems best first
# chat assistants: the services plus tophat, on the real personal traces; best first
assist = sorted([s for s in B if s in SERVICES or s == "tophat"], key=lambda s: -pct(B[s]))  # 2b's own Tophat row; the 2a row is "Tophat core (Opus 5.5)"

def style(ax, title):
    ax.set_ylim(0, 116); ax.set_yticks(range(0, 101, 20)); ax.set_ylabel("correct (%)")
    ax.yaxis.grid(True, color=GRID, lw=0.8, zorder=0); ax.set_axisbelow(True); ax.tick_params(axis="x", length=0)
    ax.set_title(title, loc="left", fontsize=12.5, color=INK, pad=12, fontweight="bold")

def ticks(ax, xs, names):
    ax.set_xticks(list(xs), [NAMES.get(n, n) for n in names], fontsize=10.5, multialignment="center", linespacing=1.15, rotation=22, ha="center", va="center", rotation_mode="anchor")
    for t, n in zip(ax.get_xticklabels(), names):
        if B[n].get("ours"): t.set_color(ACCENT); t.set_fontweight("bold")
        if ORACLE in n: t.set_color(DIM)

def num(ax, x, r, ours, orc=False):
    ax.text(x, pct(r) + 1.2, f"{r['correct']}/{r['n']}", ha="center", va="bottom", fontsize=9.5, color=ACCENT if ours else (DIM if orc else INK), fontweight="bold" if ours else "normal")

fig, (a, b) = plt.subplots(1, 2, figsize=(14.02, 4.9), gridspec_kw={"width_ratios": [1.6, 1], "wspace": 0.16})
w = 0.36
for i, n in enumerate(research):
    ours = bool(B[n].get("ours"))
    for dx, r, light in ((-w / 2, A[n], True), (w / 2, B[n], False)):
        c = (ACCENT if not light else "#dba9b3") if ours else (BAR if not light else BASE)
        orc = ORACLE in n
        a.bar(i + dx, pct(r), width=w * 0.94, color=c, edgecolor=DIM if orc else "none", linewidth=0.6, alpha=0.35 if orc else 1, linestyle=(0, (2, 1.5)) if orc else "-", zorder=2)
        num(a, i + dx, r, ours, orc)
ticks(a, range(len(research)), research)
a.tick_params(axis="x", pad=14)
style(a, "2a. Research memory systems")
from matplotlib.patches import Patch
a.legend(handles=[Patch(color=BASE, label="LongMemEval-S, hardest 15"), Patch(color=BAR, label="real personal traces, 99 questions")],
         frameon=False, fontsize=9.5, loc="upper right", bbox_to_anchor=(1, 1.03), ncol=2, columnspacing=1.2, handlelength=1.2)
for i, n in enumerate(assist):
    ours = bool(B[n].get("ours"))
    b.bar(i, pct(B[n]), width=0.6, color=ACCENT if ours else BAR, edgecolor="none", zorder=2)
    num(b, i, B[n], ours)
ticks(b, range(len(assist)), assist)
# every chat assistant (Tophat included) carries its circular logo under the bar, above the name (icons from each product's site: widgets/logos/)
from matplotlib.offsetbox import OffsetImage, AnnotationBbox
LOGOS = {"Grok Bot": "grok-logo.png", "ChatGPT dots": "chatgpt-logo.png", "Instinct": "instinct-logo.png", "Meta Muse": "muse-logo.png", "Email agent": "email-agent-logo.png", "tophat": "tophat-logo.png"}
LOGO_PT = {"Grok Bot": 22, "ChatGPT dots": 27, "Instinct": 27, "Meta Muse": 27, "Email agent": 27, "tophat": 28}
b.tick_params(axis="x", pad=36)
for i, n in enumerate(assist):
    if n not in LOGOS: continue
    img = plt.imread(HERE / "logos" / LOGOS[n])
    b.add_artist(AnnotationBbox(OffsetImage(img, zoom=LOGO_PT[n] / img.shape[0] * 300 / 100 / 3), (i, 0), xybox=(0, -18), xycoords=("data", "axes fraction"),
                                boxcoords="offset points", frameon=False, box_alignment=(0.5, 0.5), annotation_clip=False))
style(b, "2b. Chat assistants, real personal traces")
fig.subplots_adjust(left=0.06, right=0.995, top=0.9, bottom=0.24)
import math
from matplotlib.transforms import ScaledTranslation
fig.canvas.draw(); rr = fig.canvas.get_renderer()
for ax in (a, b):
    for t in ax.get_xticklabels():
        t.set_rotation(0); w = t.get_window_extent(rr).width / fig.dpi; t.set_rotation(22)
        t.set_transform(t.get_transform() + ScaledTranslation(0, -(w / 2) * math.sin(math.radians(22)), fig.dpi_scale_trans))
out = HERE / "memory-bench.png"
fig.savefig(out, dpi=300, metadata={"Title": "Memory benchmarks: correct answers per system"}, pil_kwargs={"compress_level": 6})
print(out)

# the chat's figure: the plot in the widget frame with the shared caption underneath (the caption lives in HTML, never in the image)
import base64
CAPTION = ("<b>Fig. 1</b>a. benchmarked on the hardest 15 questions in LongMemEval-S, b. benchmarked against real traces comprising 99 questions in a haystack of ~300k tokens.")
head = (HERE / "memory-bench.html").read_text().split("/* this figure:")[0] if (HERE / "memory-bench.html").exists() else ""
assert "figcaption{" in head, "memory-bench.html lost the shared caption style"
b64 = base64.b64encode(out.read_bytes()).decode()
(HERE / "memory-bench.html").write_text(head + """/* this figure: a matplotlib plot (widgets/memory-bench-plot.py, 300 dpi) */
body{background:#fbfaf6}.art{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:6px 8px}
.art img{max-width:100%;max-height:100%;object-fit:contain;display:block}
</style></head><body>
<figure>
<div class="art"><img alt="Memory benchmarks: correct answers per system" src="data:image/png;base64,""" + b64 + """"></div>
<figcaption>""" + CAPTION + """</figcaption>
</figure>
</body></html>
""")
print(HERE / "memory-bench.html")
