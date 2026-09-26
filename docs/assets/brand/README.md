# db2i/mcp logo and wordmark guide

## 1. Brand direction

The identity uses a restrained route metaphor:

**small origin → continuous route → destination**

The logo should feel technical, calm, precise, and contemporary rather than decorative or overtly "AI".

The primary mark is the **route mark**:
- a small circular origin node
- one continuous route
- controlled rounded bends
- a smaller blue terminal square
- charcoal as the primary ink color
- a single restrained blue accent

The visual personality is **Nordic technical minimalism**: quiet, functional, editorial and slightly industrial.

---

## 2. Primary logo

Primary horizontal lockup:

- route mark on the left
- lowercase `db2i/mcp` wordmark on the right
- monochrome wordmark
- blue used only in the mark's destination node

Asset:

`svg/lockup-primary.svg`

Use this version for:
- website header
- product pages
- documentation landing pages
- README mastheads
- presentations
- general brand use

---

## 3. Logo mark

Asset:

`svg/mark-primary.svg`

The mark is designed on a **24 × 24** coordinate system.

### Construction

- origin node: circle
- route: continuous stroked path
- destination: slightly smaller square terminal
- route corners: rounded
- route weight: visually lighter than the endpoint masses
- destination node: intentionally smaller than the start node

The purpose of the asymmetry is to create a natural visual hierarchy:

**origin → movement → destination**

Do not add extra arrows, sparkles, database cylinders, chat bubbles, or additional nodes.

---

## 4. Wordmark

Primary wordmark:

`db2i/mcp`

Asset:

`svg/wordmark-primary.svg`

### Case

The wordmark is intentionally **all lowercase**.

This is a visual brand decision. It gives the identity a calmer, more contemporary, open-source-oriented character.

Do not change the logo to:

- `Db2i/mcp`
- `DB2I/MCP`
- `Db2i MCP`

### Technical naming

Use the visual wordmark and technical names differently:

| Context | Form |
|---|---|
| Brand / logo | `db2i/mcp` |
| Website | `db2i-mcp.com` |
| Package / CLI / repo | `mcp-server-db2i` |
| Product prose | `Db2 for i` |
| IBM platform name | `IBM i` |

The lowercase logo does **not** replace the correct product terminology in prose.

---

## 5. Typography

### Brand sans

Preferred:

**Geist Medium**

Fallback stack:

`Geist, "Helvetica Neue", Helvetica, Arial, sans-serif`

Recommended use:
- wordmark
- headings
- interface typography
- marketing copy

### Technical mono

Preferred:

**IBM Plex Mono**

Recommended use:
- CLI examples
- technical metadata
- labels
- architecture diagrams
- version information
- code

Font files are not bundled with this brand kit.

---

## 6. Color palette

### Primary

| Role | Value |
|---|---|
| Ink | `#161716` |
| Accent blue | `#3159E8` |
| Warm background | `#F3F1EB` |
| White | `#FFFFFF` |

### Dark mode

| Role | Value |
|---|---|
| Background | `#121312` |
| Light ink | `#ECEBE4` |
| Dark-mode accent | `#7D97FF` |

### Color rule

The accent blue should be functional, not decorative.

Preferred uses:
- destination node
- current route
- active state
- selected item
- successful connection

Avoid introducing multiple unrelated accent colors.

---

## 7. Clear space

Use at least **one origin-node diameter** of clear space around the complete lockup.

For the standalone mark, keep at least **25% of the mark width** clear on every side.

Do not place the logo directly against:
- dense photography
- complex diagrams
- high-contrast textures
- other marks

---

## 8. Minimum sizes

Recommended minimums:

| Use | Minimum |
|---|---:|
| Favicon | 16 px |
| UI icon | 20 px |
| Docs navigation | 24 px |
| Avatar | 32 px |
| Horizontal lockup | ~120 px wide |

At 16 px, use the standalone mark rather than the full wordmark.

Raster exports are provided in common sizes when available.

---

## 9. Background use

### Preferred

Use:
- warm off-white
- white
- near-black / charcoal

### Light background

Use:
- `mark-primary.svg`
- `lockup-primary.svg`

### Dark background

Use:
- `mark-dark.svg` and `lockup-dark.svg` (transparent, for dark web pages and the docs dark logo)
- `mark-dark-bg.svg` and `lockup-dark-bg.svg` (with the dark background, for images and social cards)

### Monochrome

Use:
- `mark-monochrome.svg`
- `lockup-monochrome.svg`

Monochrome versions are preferred for:
- printing
- embossing
- one-color applications
- constrained technical environments

---

## 10. Shape language

The identity should remain precise.

Recommended:
- small corner radii
- restrained rounded bends
- 1 px rules
- structured spacing
- strong grid alignment

Avoid:
- large pill shapes
- soft blobs
- excessive border radius
- glassmorphism
- gradient logos
- glow effects
- AI sparkles

The route should remain the central visual idea.

---

## 11. Logo misuse

Do not:

- rotate the mark
- stretch or compress it
- change the relationship between nodes and route
- recolor individual sections arbitrarily
- add shadows or glows
- use gradient fills
- outline the terminal square
- make both endpoints equally dominant
- add arrows to the route
- put the logo inside a generic rounded capsule
- use the accent slash together with the blue terminal by default

---

## 12. Slash usage

The slash is a custom wordmark feature.

Primary:
- monochrome slash

Optional:
- accent slash only when the route mark is not present

Asset:

`svg/wordmark-accent-slash.svg`

Avoid using both a blue terminal node and a blue slash in the same primary lockup. One accent is enough.

---

## 13. Website usage

Recommended header structure:

`[mark]   db2i/mcp`

Keep generous space between mark and wordmark.

Use the warm-light identity as the primary website environment.

Dark mode is secondary and works especially well for:
- CLI demos
- code blocks
- technical documentation
- terminal examples

---

## 14. Asset inventory

### SVG

- `svg/mark-primary.svg`
- `svg/mark-monochrome.svg`
- `svg/mark-white.svg`
- `svg/mark-dark.svg`
- `svg/mark-dark-bg.svg`
- `svg/favicon.svg` (switches to the dark colors with the browser theme)
- `svg/icon-tile.svg` (the mark on a warm tile: MCP server icon, `/icon.svg`)
- `svg/wordmark-primary.svg`
- `svg/wordmark-accent-slash.svg`
- `svg/wordmark-white.svg`
- `svg/lockup-primary.svg`
- `svg/lockup-monochrome.svg`
- `svg/lockup-dark.svg`
- `svg/lockup-dark-bg.svg`

### PNG

Generated raster versions are in `png/`: the mark at 16 to 512 px, the lockup at 256, 512 and 1024 px wide, and the icon tile at 256 px.

The SVG files are the source of truth.

---

## 15. Implementation note

The wordmark and lockup SVGs are outlined from Geist Medium, so they render the same without the font installed (GitHub, the docs, MCP clients). The slash is placed from the measured glyph bounds, with equal gaps to the `i` and the `m`. Kerning is not applied; `db2i` and `mcp` have no kerned pairs that change the result visibly.

The mark and lockups are cropped tight to their artwork. Add clear space with layout (section 7), not inside the file.

Where the site sets the wordmark as live text, load Geist and use `font-weight: 500` with `letter-spacing: -0.025em`.

## 16. Brand principle

The logo should communicate:

**a clear route between systems**

It should not communicate:
- "AI magic"
- generic networking
- database storage
- security as a shield
- chatbot behavior

The strongest identity comes from repeating the route idea consistently across the complete product experience.
