"""Generate architecture-sequence.png: a readable sequence diagram for the DSH adapter."""

from PIL import Image, ImageDraw, ImageFont

FONT_PATH = r"C:\Windows\Fonts\msyh.ttc"
TITLE_FONT = ImageFont.truetype(FONT_PATH, 16)
LABEL_FONT = ImageFont.truetype(FONT_PATH, 13)
SMALL_FONT = ImageFont.truetype(FONT_PATH, 11)

BG = (255, 255, 255)
INK = (40, 44, 52)
BLUE = (59, 130, 246)
GREEN = (34, 197, 94)
GRAY = (148, 163, 184)
LIFELINE = (203, 213, 225)
PHASE_BLUE = (239, 246, 255)
PHASE_GREEN = (240, 253, 244)

# (label, x)
participants = [
    ("调用方", 70),
    ("Adapter", 205),
    ("记忆召回", 340),
    ("凭证服务", 475),
    ("Launcher", 610),
    ("DSH 子进程", 745),
]
pos = {name: x for name, x in participants}

# (from, to, text, color)
run_messages = [
    ("调用方", "Adapter", "1  调用 (prompt, sessionId, eventId, attempt)", BLUE),
    ("Adapter", "记忆召回", "2  召回记忆/知识库 (300ms 超时降级)", GREEN),
    ("记忆召回", "Adapter", "3  RecallBundle", GREEN),
    ("Adapter", "凭证服务", "4  换 api_key (credential_provider_name)", BLUE),
    ("凭证服务", "Adapter", "5  api_key", BLUE),
    ("Adapter", "Launcher", "6  run (同 sessionId 串行)", BLUE),
    ("Launcher", "DSH 子进程", "7  spawn + stdin 写入任务", GREEN),
    ("DSH 子进程", "Launcher", "8  stdout NDJSON 帧", GREEN),
    ("Launcher", "Adapter", "9  ChildRunResult", BLUE),
    ("Adapter", "调用方", "10  result + sessionId", BLUE),
]

prepare_messages = [
    ("Adapter", "Launcher", "prepare: 渲染 profile + dsh --dump-config 体检", GREEN),
]

WIDTH = 860
HEADER = 80
GAP = 62
PREPARE_GAP = 64
FINAL = 60
run_top = HEADER + 30
run_bottom = run_top + GAP * len(run_messages)
prepare_top = run_bottom + 40
prepare_bottom = prepare_top + PREPARE_GAP * len(prepare_messages)
HEIGHT = prepare_bottom + FINAL

img = Image.new("RGB", (WIDTH, HEIGHT), BG)
d = ImageDraw.Draw(img)

# Phase backgrounds
d.rectangle([0, run_top - 12, WIDTH, run_bottom + 20], fill=PHASE_GREEN)
d.rectangle([0, prepare_top - 12, WIDTH, prepare_bottom + 20], fill=PHASE_BLUE)

d.text((16, run_top - 30), "阶段二：一次 invocation（每个任务一轮）", font=TITLE_FONT, fill=(15, 118, 72))
d.text((16, prepare_top - 30), "阶段一：启动装配 prepare（容器启动时一次）", font=TITLE_FONT, fill=(29, 78, 216))

# Participant boxes and lifelines
for name, x in participants:
    w = d.textlength(name, font=LABEL_FONT)
    d.rectangle([x - w / 2 - 8, HEADER - 26, x + w / 2 + 8, HEADER], outline=INK, width=1, fill=(250, 250, 250))
    d.text((x - w / 2, HEADER - 24), name, font=LABEL_FONT, fill=INK)
    d.line([x, HEADER, x, HEIGHT - 24], fill=LIFELINE, width=1)


def arrow(draw, x1, x2, y, text, color):
    draw.line([x1, y, x2, y], fill=color, width=2)
    if x2 > x1:
        draw.polygon([(x2, y), (x2 - 7, y - 5), (x2 - 7, y + 5)], fill=color)
    else:
        draw.polygon([(x2, y), (x2 + 7, y - 5), (x2 + 7, y + 5)], fill=color)
    tw = draw.textlength(text, font=SMALL_FONT)
    tx = min(x1, x2) + abs(x2 - x1) / 2 - tw / 2
    draw.text((tx, y - 18), text, font=SMALL_FONT, fill=(55, 65, 81))


for i, (a, b, label, color) in enumerate(run_messages):
    arrow(d, pos[a], pos[b], run_top + i * GAP, label, color)

for i, (a, b, label, color) in enumerate(prepare_messages):
    arrow(d, pos[a], pos[b], prepare_top + i * PREPARE_GAP, label, color)

out = r"D:\DSH_DEV\agentarts-adapter-js\deepseek-harness-adapter\docs\architecture-sequence.png"
img.save(out, "PNG")
print(out)
