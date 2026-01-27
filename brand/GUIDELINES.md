# siteio Brand Design Guidelines

This document provides specifications for using siteio brand assets correctly and consistently.

---

## Logo Assets

| File | Description | Use Case |
|------|-------------|----------|
| `logo-full.svg` | Mark + wordmark | Primary logo, website header, docs |
| `logo-full-dark.svg` | Dark mode variant | Dark backgrounds |
| `logo-mark.svg` | Square "S" mark only | App icons, favicons, social avatars |
| `logo-mark-dark.svg` | Dark mode mark | Dark UI contexts |
| `wordmark.svg` | Text only | When space is limited horizontally |
| `wordmark-dark.svg` | Dark mode text | Dark backgrounds |
| `favicon.svg` | 32x32 favicon | Browser tabs |
| `icon-mono.svg` | Monochrome mark | Single-color contexts (print, embroidery) |

---

## Color Palette

### Primary Colors

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Blue** | `#0969da` | `rgb(9, 105, 218)` | Primary brand, links, CTAs |
| **Green** | `#2da44e` | `rgb(45, 164, 78)` | Success states, deploy confirmation |

### Dark Mode Colors

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Blue (Dark)** | `#58a6ff` | `rgb(88, 166, 255)` | Links on dark backgrounds |
| **Green (Dark)** | `#3fb950` | `rgb(63, 185, 80)` | Success on dark backgrounds |

### Neutrals

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Text** | `#1f2328` | `rgb(31, 35, 40)` | Primary text (light mode) |
| **Text (Dark)** | `#e6edf3` | `rgb(230, 237, 243)` | Primary text (dark mode) |
| **Muted** | `#656d76` | `rgb(101, 109, 118)` | Secondary text, descriptions |
| **Background** | `#ffffff` | `rgb(255, 255, 255)` | Page background (light) |
| **Background (Dark)** | `#0d1117` | `rgb(13, 17, 23)` | Page background (dark) |
| **Surface** | `#f6f8fa` | `rgb(246, 248, 250)` | Cards, code blocks (light) |
| **Surface (Dark)** | `#161b22` | `rgb(22, 27, 34)` | Cards, code blocks (dark) |
| **Border** | `#d0d7de` | `rgb(208, 215, 222)` | Borders (light) |
| **Border (Dark)** | `#30363d` | `rgb(48, 54, 61)` | Borders (dark) |

### Gradient

The brand gradient flows from Blue to Green (left-to-right or top-left to bottom-right):

```css
/* Light mode */
background: linear-gradient(135deg, #0969da 0%, #2da44e 100%);

/* Dark mode */
background: linear-gradient(135deg, #58a6ff 0%, #3fb950 100%);
```

---

## Typography

### Font Stack

```css
/* Headings & UI */
font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;

/* Code & CLI output */
font-family: 'IBM Plex Mono', 'SF Mono', 'Consolas', 'Liberation Mono', monospace;
```

### Font Weights

| Weight | Name | Usage |
|--------|------|-------|
| 400 | Regular | Body text |
| 500 | Medium | Subheadings, emphasis |
| 600 | SemiBold | Headings, buttons |
| 700 | Bold | Strong emphasis (sparingly) |

### Type Scale

| Name | Size | Line Height | Usage |
|------|------|-------------|-------|
| Display | 48px | 1.1 | Hero headlines |
| H1 | 32px | 1.2 | Page titles |
| H2 | 24px | 1.3 | Section headings |
| H3 | 20px | 1.4 | Subsection headings |
| Body | 16px | 1.5 | Paragraph text |
| Small | 14px | 1.5 | Captions, metadata |
| Code | 14px | 1.6 | Code blocks, CLI |

---

## Logo Usage

### Clear Space

Maintain clear space around the logo equal to the height of the "S" mark on all sides.

```
┌─────────────────────────────────┐
│                                 │
│   ┌───┐                         │
│   │ S │  siteio                 │
│   └───┘                         │
│     ▲                           │
│     │ minimum clear space       │
└─────────────────────────────────┘
```

### Minimum Sizes

| Asset | Minimum Width | Context |
|-------|---------------|---------|
| Full logo | 120px | General use |
| Logo mark | 24px | Icons, favicons |
| Wordmark | 80px | Tight horizontal spaces |

### Do's

- Use the provided SVG files
- Maintain aspect ratio
- Use dark variants on dark backgrounds
- Use monochrome version for single-color contexts

### Don'ts

- Don't rotate or skew the logo
- Don't change the gradient colors
- Don't add effects (shadows, outlines, glows)
- Don't place on busy backgrounds
- Don't recreate—use the provided assets

---

## Code Block Styling

Code blocks should feel native to the terminal experience:

```css
.code-block {
  background: #f6f8fa;      /* Surface color */
  border: 1px solid #d0d7de; /* Border color */
  border-radius: 6px;
  padding: 16px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 14px;
  line-height: 1.6;
  overflow-x: auto;
}

/* Dark mode */
.dark .code-block {
  background: #161b22;
  border-color: #30363d;
}
```

### Terminal Prompt Style

```
$ siteio sites deploy ./my-site
Zipping 42 files (128.5 KB)
Uploading (100%)
Site deployed successfully!

  URL: https://my-site.axel.siteio.me
  Size: 128.5 KB
```

- Use `$` for user commands
- Show realistic output
- Green checkmarks for success
- Muted text for progress

---

## Button Styles

### Primary Button

```css
.btn-primary {
  background: linear-gradient(135deg, #0969da 0%, #2da44e 100%);
  color: white;
  font-weight: 600;
  padding: 12px 24px;
  border-radius: 6px;
  border: none;
}

.btn-primary:hover {
  filter: brightness(1.1);
}
```

### Secondary Button

```css
.btn-secondary {
  background: transparent;
  color: #0969da;
  font-weight: 600;
  padding: 12px 24px;
  border-radius: 6px;
  border: 1px solid #d0d7de;
}
```

---

## Iconography

Use simple, geometric icons that match the technical aesthetic:

- **Style:** Outline, 2px stroke weight
- **Size:** 24x24 default, scale proportionally
- **Color:** Inherit from text or use brand blue

Recommended icon sets:
- [Lucide](https://lucide.dev/) (open source)
- [Heroicons](https://heroicons.com/) (MIT license)

---

## Voice & Tone Checklist

When creating content, verify it matches the brand voice:

- [ ] Is it direct? (No fluff, no jargon)
- [ ] Is it confident? (Not apologetic)
- [ ] Is it technical? (Speaking to developers)
- [ ] Is it honest? (Under-promise, over-deliver)
- [ ] Does it show, not tell? (Real examples over claims)

---

## File Naming Convention

Brand assets follow this pattern:

```
{type}-{variant}.svg

Examples:
logo-full.svg       # Default full logo
logo-full-dark.svg  # Dark mode variant
logo-mark.svg       # Just the mark
wordmark.svg        # Just the text
favicon.svg         # Browser favicon
icon-mono.svg       # Monochrome version
```

---

## Asset Checklist

| Asset | Light | Dark | Mono |
|-------|-------|------|------|
| Full Logo | `logo-full.svg` | `logo-full-dark.svg` | - |
| Logo Mark | `logo-mark.svg` | `logo-mark-dark.svg` | `icon-mono.svg` |
| Wordmark | `wordmark.svg` | `wordmark-dark.svg` | - |
| Favicon | `favicon.svg` | - | - |

---

*See [BRAND_BRIEFING.md](./BRAND_BRIEFING.md) for brand strategy and messaging.*
