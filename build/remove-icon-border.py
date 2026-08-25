from collections import deque
from pathlib import Path

from PIL import Image

source = Path(__file__).with_name("icon.svg.png")
output = Path(__file__).with_name("icon.png")
image = Image.open(source).convert("RGBA")
pixels = image.load()
width, height = image.size
queue = deque()
seen = set()


def is_white_background(x: int, y: int) -> bool:
    red, green, blue, _alpha = pixels[x, y]
    return red >= 245 and green >= 245 and blue >= 245


for x in range(width):
    queue.extend(((x, 0), (x, height - 1)))
for y in range(1, height - 1):
    queue.extend(((0, y), (width - 1, y)))

while queue:
    x, y = queue.popleft()
    if (x, y) in seen or not is_white_background(x, y):
        continue
    seen.add((x, y))
    red, green, blue, _alpha = pixels[x, y]
    pixels[x, y] = (red, green, blue, 0)
    for next_x, next_y in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
        if 0 <= next_x < width and 0 <= next_y < height:
            queue.append((next_x, next_y))

image.save(output)
