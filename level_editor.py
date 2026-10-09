import pygame
import json
import sys

# Inicializácia pygame
pygame.init()

# Konštanty
GRID_WIDTH = 20
GRID_HEIGHT = 20
CELL_SIZE = 30
MARGIN = 50
BUTTON_HEIGHT = 40

WIDTH = GRID_WIDTH * CELL_SIZE + 2 * MARGIN
HEIGHT = GRID_HEIGHT * CELL_SIZE + 2 * MARGIN + BUTTON_HEIGHT + 20

# Farby
WHITE = (255, 255, 255)
BLACK = (0, 0, 0)
GRAY = (200, 200, 200)
BLUE = (100, 150, 255)
GREEN = (100, 255, 100)
RED = (255, 100, 100)

# Vytvorenie okna
screen = pygame.display.set_mode((WIDTH, HEIGHT))
pygame.display.set_caption("Pentomino Level Editor")

# Grid (20x20)
grid = [[False for _ in range(GRID_WIDTH)] for _ in range(GRID_HEIGHT)]

# Font
font = pygame.font.Font(None, 24)

def draw_grid():
    """Vykreslí grid"""
    for row in range(GRID_HEIGHT):
        for col in range(GRID_WIDTH):
            x = MARGIN + col * CELL_SIZE
            y = MARGIN + row * CELL_SIZE
            
            # Vyplň bunku ak je True
            if grid[row][col]:
                pygame.draw.rect(screen, BLUE, (x, y, CELL_SIZE, CELL_SIZE))
            
            # Obrys bunky
            pygame.draw.rect(screen, GRAY, (x, y, CELL_SIZE, CELL_SIZE), 1)


def draw_axes():
    """Vykreslí osy X a Y so stupnicou a vyznačeným stredom"""
    # Draw scales outside the grid: X axis under the grid (1..GRID_WIDTH left->right),
    # Y axis left of the grid (1..GRID_HEIGHT bottom->top).
    grid_left = MARGIN
    grid_top = MARGIN
    grid_right = MARGIN + GRID_WIDTH * CELL_SIZE
    grid_bottom = MARGIN + GRID_HEIGHT * CELL_SIZE

    AXIS_COLOR = (30, 30, 30)
    TICK_COLOR = (80, 80, 80)
    LABEL_COLOR = (40, 40, 40)

    # Positions for axes outside grid
    x_axis_y = grid_bottom + 18
    # Place Y axis closer to grid so labels fit on screen
    y_axis_x = grid_left - 25

    # Horizontal axis (X) below grid
    pygame.draw.line(screen, AXIS_COLOR, (grid_left, x_axis_y), (grid_right, x_axis_y), 2)
    # Vertical axis (Y) to the left of grid
    pygame.draw.line(screen, AXIS_COLOR, (y_axis_x, grid_top), (y_axis_x, grid_bottom), 2)

    tick_len = 6

    # X-axis ticks and labels (below grid): label 1..GRID_WIDTH left->right
    for col in range(GRID_WIDTH):
        x = grid_left + col * CELL_SIZE + CELL_SIZE // 2
        pygame.draw.line(screen, TICK_COLOR, (x, x_axis_y - tick_len), (x, x_axis_y + tick_len), 1)
        val = col + 1
        label = font.render(str(val), True, LABEL_COLOR)
        screen.blit(label, (x - label.get_width() // 2, x_axis_y + tick_len + 2))

    # Y-axis ticks and labels (left of grid): label 1..GRID_HEIGHT bottom->top
    for row in range(GRID_HEIGHT):
        y = grid_top + row * CELL_SIZE + CELL_SIZE // 2
        pygame.draw.line(screen, TICK_COLOR, (y_axis_x - tick_len, y), (y_axis_x + tick_len, y), 1)
        # bottom row should be 1
        val = GRID_HEIGHT - row
        label = font.render(str(val), True, LABEL_COLOR)
        label_x = y_axis_x - tick_len - 8 - label.get_width()
        # ensure labels don't go off-screen
        if label_x < 4:
            label_x = 4
        screen.blit(label, (label_x, y - label.get_height() // 2))

    # Mark center: since grid is even (20x20), center is between 4 cells - draw 4 small dots
    center_cols = (GRID_WIDTH // 2 - 1, GRID_WIDTH // 2)
    center_rows = (GRID_HEIGHT // 2 - 1, GRID_HEIGHT // 2)
    CENTER_COLOR = (220, 20, 60)
    for r in center_rows:
        for c in center_cols:
            cx = grid_left + c * CELL_SIZE + CELL_SIZE // 2
            cy = grid_top + r * CELL_SIZE + CELL_SIZE // 2
            pygame.draw.circle(screen, CENTER_COLOR, (cx, cy), 4)

def draw_ui():
    """Vykreslí UI prvky"""
    # Počet buniek
    count = sum(sum(row) for row in grid)
    pentominos = count // 5
    remainder = count % 5
    
    text = font.render(f"Bunky: {count} | Pentomín: {pentominos} | Zvyšok: {remainder}", True, BLACK)
    screen.blit(text, (10, 10))
    
    if remainder == 0 and count > 0:
        status = font.render("✓ SPRÁVNE - deliteľné 5", True, GREEN)
    else:
        status = font.render("✗ NESPRÁVNE - nie je deliteľné 5", True, RED)
    screen.blit(status, (10, HEIGHT - BUTTON_HEIGHT - 25))
    
    # Tlačidlá
    clear_btn = pygame.Rect(MARGIN, HEIGHT - BUTTON_HEIGHT - 10, 100, BUTTON_HEIGHT)
    save_btn = pygame.Rect(MARGIN + 110, HEIGHT - BUTTON_HEIGHT - 10, 100, BUTTON_HEIGHT)
    
    pygame.draw.rect(screen, RED if clear_btn.collidepoint(pygame.mouse.get_pos()) else GRAY, clear_btn)
    pygame.draw.rect(screen, GREEN if save_btn.collidepoint(pygame.mouse.get_pos()) else GRAY, save_btn)
    
    clear_text = font.render("CLEAR", True, BLACK)
    save_text = font.render("SAVE", True, BLACK)
    
    screen.blit(clear_text, (clear_btn.x + 20, clear_btn.y + 10))
    screen.blit(save_text, (save_btn.x + 20, save_btn.y + 10))
    
    # Návod
    help_text = font.render("LMB: Pridaj | RMB: Odstráň | SPACE: Clear", True, BLACK)
    screen.blit(help_text, (MARGIN + 220, HEIGHT - BUTTON_HEIGHT))
    
    return clear_btn, save_btn

def get_cell_from_mouse(pos):
    """Zistí ktorá bunka je pod myšou"""
    x, y = pos
    col = (x - MARGIN) // CELL_SIZE
    row = (y - MARGIN) // CELL_SIZE
    
    if 0 <= row < GRID_HEIGHT and 0 <= col < GRID_WIDTH:
        return row, col
    return None, None

def clear_grid():
    """Vymaže celý grid"""
    global grid
    grid = [[False for _ in range(GRID_WIDTH)] for _ in range(GRID_HEIGHT)]

def save_to_json():
    """Uloží level do JSON"""
    count = sum(sum(row) for row in grid)
    if count % 5 != 0:
        print("CHYBA: Počet buniek nie je deliteľný 5!")
        return False
    
    pentomino_count = count // 5
    
    # Vytvor level s automatickým názvom
    level = {
        "id": 1,
        "name": f"Level {len(grid)}",
        "description": f"Level s {pentomino_count} pentomínami",
        "gridWidth": 20,
        "gridHeight": 20,
        "targetShape": grid,
        "availablePieces": ["I"] * pentomino_count,  # môžeš zmeniť
        "startingPositions": []
    }
    
    # Pridaj štartovacie pozície (rozmiestni ich po okrajoch, ale nie úplne na kraji)
    # aby sa pentomína určite zmestili
    positions = []
    for i in range(pentomino_count):
        if i < 2:
            # Horné rohy (trochu od okraja)
            positions.append({"row": 1, "col": 2 if i == 0 else 16})
        elif i < 4:
            # Dolné rohy (trochu od okraja, max row 15 aby sa zmestila 5-bunková figura)
            positions.append({"row": 15, "col": 2 if i == 2 else 16})
        elif i < 6:
            # Ľavá a pravá strana (v strede)
            positions.append({"row": 9, "col": 1 if i % 2 == 0 else 17})
        else:
            # Ďalšie pozície rozmiestnené bezpečne
            row = 3 + ((i - 6) % 3) * 5
            col = 5 + ((i - 6) // 3) * 5
            positions.append({"row": min(row, 15), "col": min(col, 15)})
    
    level["startingPositions"] = positions[:pentomino_count]
    
    # Načítaj existujúce levely
    try:
        with open("src/data/pentominoLevels.json", "r", encoding="utf-8") as f:
            levels = json.load(f)
    except FileNotFoundError:
        levels = []
    
    # Pridaj nový level
    level["id"] = len(levels) + 1
    level["name"] = f"Level {level['id']}"
    levels.append(level)
    
    # Ulož
    with open("src/data/pentominoLevels.json", "w", encoding="utf-8") as f:
        # Vlastný formát pre pekný JSON
        f.write("[\n")
        for i, level in enumerate(levels):
            f.write("  {\n")
            f.write(f'    "id": {level["id"]},\n')
            f.write(f'    "name": "{level["name"]}",\n')
            f.write(f'    "description": "{level["description"]}",\n')
            f.write(f'    "gridWidth": {level["gridWidth"]},\n')
            f.write(f'    "gridHeight": {level["gridHeight"]},\n')
            f.write('    "targetShape": [\n')
            for row_idx, row in enumerate(level["targetShape"]):
                row_str = "[" + ",".join("true" if cell else "false" for cell in row) + "]"
                f.write(f'      {row_str}{"," if row_idx < len(level["targetShape"])-1 else ""}\n')
            f.write('    ],\n')
            f.write(f'    "availablePieces": {json.dumps(level["availablePieces"])},\n')
            f.write('    "startingPositions": [\n')
            for pos_idx, pos in enumerate(level["startingPositions"]):
                f.write(f'      {json.dumps(pos)}{"," if pos_idx < len(level["startingPositions"])-1 else ""}\n')
            f.write('    ]\n')
            f.write(f'  }}{"," if i < len(levels)-1 else ""}\n')
        f.write("]\n")
    
    print(f"✓ Level uložený! ID: {level['id']}, Bunky: {count}, Pentomín: {pentomino_count}")
    return True

# Hlavná slučka
running = True
drawing = False
erasing = False
saved_message = None
saved_message_time = 0

while running:
    screen.fill(WHITE)
    
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False
        
        elif event.type == pygame.MOUSEBUTTONDOWN:
            clear_btn, save_btn = draw_ui()
            
            # Kliknutie na tlačidlá
            if clear_btn.collidepoint(event.pos):
                clear_grid()
            elif save_btn.collidepoint(event.pos):
                if save_to_json():
                    saved_message = "✓ ULOŽENÉ!"
                    saved_message_time = pygame.time.get_ticks()
                else:
                    saved_message = "✗ CHYBA - počet buniek nie je deliteľný 5"
                    saved_message_time = pygame.time.get_ticks()
            else:
                row, col = get_cell_from_mouse(event.pos)
                if row is not None:
                    if event.button == 1:  # Ľavé tlačidlo
                        grid[row][col] = True
                        drawing = True
                    elif event.button == 3:  # Pravé tlačidlo
                        grid[row][col] = False
                        erasing = True
        
        elif event.type == pygame.MOUSEBUTTONUP:
            drawing = False
            erasing = False
        
        elif event.type == pygame.MOUSEMOTION:
            if drawing:
                row, col = get_cell_from_mouse(event.pos)
                if row is not None:
                    grid[row][col] = True
            elif erasing:
                row, col = get_cell_from_mouse(event.pos)
                if row is not None:
                    grid[row][col] = False
        
        elif event.type == pygame.KEYDOWN:
            if event.key == pygame.K_SPACE:
                clear_grid()
            elif event.key == pygame.K_s:
                save_to_json()
    
    draw_grid()
    draw_axes()
    draw_ui()
    
    # Zobraz správu o uložení
    if saved_message and pygame.time.get_ticks() - saved_message_time < 2000:
        msg = font.render(saved_message, True, GREEN if "✓" in saved_message else RED)
        screen.blit(msg, (WIDTH // 2 - 100, HEIGHT // 2))
    
    pygame.display.flip()

pygame.quit()
sys.exit()
