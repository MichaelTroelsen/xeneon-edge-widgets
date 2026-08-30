/* 8x8 pixel font + weather sprites rendered as inline SVG.
   No external font dependency: the widget must look identical on a device
   that has never seen a C64 typeface. Glyph pixels live in bits 6..2 of each
   row byte, so a glyph is 5 wide inside an 8-tall cell; advance is 6 px. */
(function (global) {
  'use strict';

  var CELL_H = 8;
  var GLYPH_W = 5;
  var ADVANCE = 6;

  var FONT = {
    ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    '0': [0x38, 0x44, 0x4c, 0x54, 0x64, 0x44, 0x38, 0x00],
    '1': [0x10, 0x30, 0x10, 0x10, 0x10, 0x10, 0x38, 0x00],
    '2': [0x38, 0x44, 0x04, 0x08, 0x10, 0x20, 0x7c, 0x00],
    '3': [0x7c, 0x08, 0x10, 0x08, 0x04, 0x44, 0x38, 0x00],
    '4': [0x08, 0x18, 0x28, 0x48, 0x7c, 0x08, 0x08, 0x00],
    '5': [0x7c, 0x40, 0x78, 0x04, 0x04, 0x44, 0x38, 0x00],
    '6': [0x18, 0x20, 0x40, 0x78, 0x44, 0x44, 0x38, 0x00],
    '7': [0x7c, 0x04, 0x08, 0x10, 0x20, 0x20, 0x20, 0x00],
    '8': [0x38, 0x44, 0x44, 0x38, 0x44, 0x44, 0x38, 0x00],
    '9': [0x38, 0x44, 0x44, 0x3c, 0x04, 0x08, 0x30, 0x00],
    'A': [0x38, 0x44, 0x44, 0x7c, 0x44, 0x44, 0x44, 0x00],
    'B': [0x78, 0x44, 0x44, 0x78, 0x44, 0x44, 0x78, 0x00],
    'C': [0x38, 0x44, 0x40, 0x40, 0x40, 0x44, 0x38, 0x00],
    'D': [0x70, 0x48, 0x44, 0x44, 0x44, 0x48, 0x70, 0x00],
    'E': [0x7c, 0x40, 0x40, 0x78, 0x40, 0x40, 0x7c, 0x00],
    'F': [0x7c, 0x40, 0x40, 0x78, 0x40, 0x40, 0x40, 0x00],
    'G': [0x38, 0x44, 0x40, 0x5c, 0x44, 0x44, 0x3c, 0x00],
    'H': [0x44, 0x44, 0x44, 0x7c, 0x44, 0x44, 0x44, 0x00],
    'I': [0x38, 0x10, 0x10, 0x10, 0x10, 0x10, 0x38, 0x00],
    'J': [0x1c, 0x08, 0x08, 0x08, 0x08, 0x48, 0x30, 0x00],
    'K': [0x44, 0x48, 0x50, 0x60, 0x50, 0x48, 0x44, 0x00],
    'L': [0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x7c, 0x00],
    'M': [0x44, 0x6c, 0x54, 0x54, 0x44, 0x44, 0x44, 0x00],
    'N': [0x44, 0x64, 0x54, 0x4c, 0x44, 0x44, 0x44, 0x00],
    'O': [0x38, 0x44, 0x44, 0x44, 0x44, 0x44, 0x38, 0x00],
    'P': [0x78, 0x44, 0x44, 0x78, 0x40, 0x40, 0x40, 0x00],
    'Q': [0x38, 0x44, 0x44, 0x44, 0x54, 0x48, 0x34, 0x00],
    'R': [0x78, 0x44, 0x44, 0x78, 0x50, 0x48, 0x44, 0x00],
    'S': [0x3c, 0x40, 0x40, 0x38, 0x04, 0x04, 0x78, 0x00],
    'T': [0x7c, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x00],
    'U': [0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x38, 0x00],
    'V': [0x44, 0x44, 0x44, 0x44, 0x44, 0x28, 0x10, 0x00],
    'W': [0x44, 0x44, 0x44, 0x54, 0x54, 0x6c, 0x44, 0x00],
    'X': [0x44, 0x44, 0x28, 0x10, 0x28, 0x44, 0x44, 0x00],
    'Y': [0x44, 0x44, 0x28, 0x10, 0x10, 0x10, 0x10, 0x00],
    'Z': [0x7c, 0x04, 0x08, 0x10, 0x20, 0x40, 0x7c, 0x00],
    '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x30, 0x30, 0x00],
    ',': [0x00, 0x00, 0x00, 0x00, 0x00, 0x18, 0x18, 0x30],
    ':': [0x00, 0x30, 0x30, 0x00, 0x30, 0x30, 0x00, 0x00],
    ';': [0x00, 0x18, 0x18, 0x00, 0x18, 0x18, 0x30, 0x00],
    '-': [0x00, 0x00, 0x00, 0x7c, 0x00, 0x00, 0x00, 0x00],
    '+': [0x00, 0x10, 0x10, 0x7c, 0x10, 0x10, 0x00, 0x00],
    '/': [0x04, 0x08, 0x08, 0x10, 0x20, 0x20, 0x40, 0x00],
    '*': [0x00, 0x54, 0x38, 0x7c, 0x38, 0x54, 0x00, 0x00],
    '%': [0x64, 0x64, 0x08, 0x10, 0x20, 0x4c, 0x4c, 0x00],
    '#': [0x28, 0x7c, 0x28, 0x28, 0x7c, 0x28, 0x00, 0x00],
    '!': [0x10, 0x10, 0x10, 0x10, 0x10, 0x00, 0x10, 0x00],
    '?': [0x38, 0x44, 0x04, 0x08, 0x10, 0x00, 0x10, 0x00],
    '(': [0x08, 0x10, 0x20, 0x20, 0x20, 0x10, 0x08, 0x00],
    ')': [0x20, 0x10, 0x08, 0x08, 0x08, 0x10, 0x20, 0x00],
    '=': [0x00, 0x00, 0x7c, 0x00, 0x7c, 0x00, 0x00, 0x00],
    '|': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x00],
    '<': [0x08, 0x10, 0x20, 0x40, 0x20, 0x10, 0x08, 0x00],
    '>': [0x40, 0x20, 0x10, 0x08, 0x10, 0x20, 0x40, 0x00],
    '"': [0x28, 0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    "'": [0x10, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    '°': [0x38, 0x28, 0x38, 0x00, 0x00, 0x00, 0x00, 0x00],
    '©': [0x38, 0x44, 0x58, 0x50, 0x58, 0x44, 0x38, 0x00],

    /* Lowercase. The C64 and the PET boot in their uppercase/graphics set and
       never needed these, but the BBC, the CPC and the Amiga all boot in mixed
       case - "BBC Computer 32K", not "BBC COMPUTER 32K" - so rendering their
       screens in capitals was a plain inaccuracy. Caps occupy rows 0-6;
       x-height sits in rows 2-6, ascenders reach row 0 and descenders row 7,
       which is why the comma already used row 7. */
    'a': [0x00, 0x00, 0x38, 0x04, 0x3c, 0x44, 0x3c, 0x00],
    'b': [0x40, 0x40, 0x78, 0x44, 0x44, 0x44, 0x78, 0x00],
    'c': [0x00, 0x00, 0x38, 0x44, 0x40, 0x44, 0x38, 0x00],
    'd': [0x04, 0x04, 0x3c, 0x44, 0x44, 0x44, 0x3c, 0x00],
    'e': [0x00, 0x00, 0x38, 0x44, 0x7c, 0x40, 0x38, 0x00],
    'f': [0x18, 0x20, 0x78, 0x20, 0x20, 0x20, 0x20, 0x00],
    'g': [0x00, 0x00, 0x3c, 0x44, 0x44, 0x3c, 0x04, 0x78],
    'h': [0x40, 0x40, 0x78, 0x44, 0x44, 0x44, 0x44, 0x00],
    'i': [0x10, 0x00, 0x30, 0x10, 0x10, 0x10, 0x38, 0x00],
    'j': [0x08, 0x00, 0x18, 0x08, 0x08, 0x08, 0x48, 0x30],
    'k': [0x40, 0x40, 0x48, 0x50, 0x60, 0x50, 0x48, 0x00],
    'l': [0x30, 0x10, 0x10, 0x10, 0x10, 0x10, 0x38, 0x00],
    'm': [0x00, 0x00, 0x68, 0x54, 0x54, 0x54, 0x54, 0x00],
    'n': [0x00, 0x00, 0x78, 0x44, 0x44, 0x44, 0x44, 0x00],
    'o': [0x00, 0x00, 0x38, 0x44, 0x44, 0x44, 0x38, 0x00],
    'p': [0x00, 0x00, 0x78, 0x44, 0x44, 0x78, 0x40, 0x40],
    'q': [0x00, 0x00, 0x3c, 0x44, 0x44, 0x3c, 0x04, 0x04],
    'r': [0x00, 0x00, 0x58, 0x60, 0x40, 0x40, 0x40, 0x00],
    's': [0x00, 0x00, 0x3c, 0x40, 0x38, 0x04, 0x78, 0x00],
    't': [0x20, 0x20, 0x78, 0x20, 0x20, 0x24, 0x18, 0x00],
    'u': [0x00, 0x00, 0x44, 0x44, 0x44, 0x44, 0x3c, 0x00],
    'v': [0x00, 0x00, 0x44, 0x44, 0x44, 0x28, 0x10, 0x00],
    'w': [0x00, 0x00, 0x44, 0x44, 0x54, 0x54, 0x28, 0x00],
    'x': [0x00, 0x00, 0x44, 0x28, 0x10, 0x28, 0x44, 0x00],
    'y': [0x00, 0x00, 0x44, 0x44, 0x44, 0x3c, 0x04, 0x78],
    'z': [0x00, 0x00, 0x7c, 0x08, 0x10, 0x20, 0x7c, 0x00]
  };

  var MISSING = [0x7c, 0x44, 0x44, 0x44, 0x44, 0x44, 0x7c, 0x00];

  /* Merge horizontally adjacent lit pixels into one rect. Keeps the DOM small:
     a 40-column boot banner becomes ~60 rects instead of ~250. */
  function bitmapRects(rows, originX, cellWidth, out) {
    for (var y = 0; y < rows.length; y++) {
      var row = rows[y];
      var run = -1;
      for (var x = 0; x <= cellWidth; x++) {
        var lit = x < cellWidth && row[x] === 1;
        if (lit && run < 0) {
          run = x;
        } else if (!lit && run >= 0) {
          out.push('<rect x="' + (originX + run) + '" y="' + y + '" width="' + (x - run) + '" height="1"/>');
          run = -1;
        }
      }
    }
  }

  /* A theme may replace individual letterforms rather than the whole set: the
     characters that carry a machine's identity are a handful, and inventing a
     complete ROM font we cannot check against a dump would look authentic
     while being fiction. Overrides are consulted first, the base set second. */
  var overrides = {};

  /* 'pixel' draws every character from the 8x8 set; 'system' hands the string
     to the browser as real text, which is what the Modern theme wants - there
     is no pixel font to be faithful to there. */
  var fontMode = 'pixel';

  /* Whether the machine had lowercase on screen at all. The C64 and the PET
     boot in their uppercase/graphics character set, so folding to capitals is
     the accurate rendering there, not a limitation; every other theme shows
     text as written. */
  var letterCase = 'upper';

  function setFont(mode, glyphs, mixedCase) {
    fontMode = (mode === 'system') ? 'system' : 'pixel';
    overrides = glyphs || {};
    letterCase = mixedCase ? 'mixed' : 'upper';
  }

  function cased(str) {
    return (letterCase === 'upper') ? str.toUpperCase() : str;
  }

  function glyphRows(ch) {
    var bytes = overrides[ch] || FONT[ch] || MISSING;
    var rows = [];
    for (var y = 0; y < CELL_H; y++) {
      var row = [];
      for (var x = 0; x < GLYPH_W; x++) {
        row.push((bytes[y] >> (6 - x)) & 1);
      }
      rows.push(row);
    }
    return rows;
  }

  function svg(viewW, viewH, rects, extraClass) {
    return '<svg class="px' + (extraClass ? ' ' + extraClass : '') +
      '" viewBox="0 0 ' + viewW + ' ' + viewH + '" preserveAspectRatio="xMinYMid meet"' +
      ' shape-rendering="crispEdges" fill="currentColor" xmlns="http://www.w3.org/2000/svg"' +
      ' focusable="false" aria-hidden="true">' + rects.join('') + '</svg>';
  }

  /* Render a string as inline SVG markup. The viewBox is 8 user units tall, so
     CSS sizes it with `height: 1em` and scale is driven purely by font tokens. */
  function textSVG(text) {
    var str = cased(String(text == null ? '' : text));
    var rects = [];
    for (var i = 0; i < str.length; i++) {
      bitmapRects(glyphRows(str.charAt(i)), i * ADVANCE, GLYPH_W, rects);
    }
    var width = str.length ? str.length * ADVANCE - 1 : 1;
    return svg(width, CELL_H, rects);
  }

  function setText(el, text) {
    if (!el) return;
    var str = String(text == null ? '' : text);
    if (fontMode === 'system') {
      el.textContent = cased(str);
    } else {
      el.innerHTML = textSVG(str);
    }
    el.setAttribute('aria-label', str);
  }

  /* 16x16 weather sprites, authored as strings so they stay editable. */
  var SPRITES = {
    sun: [
      '.......##.......',
      '.......##.......',
      '..#..........#..',
      '...#........#...',
      '......####......',
      '.....######.....',
      '....########....',
      '##..########..##',
      '##..########..##',
      '....########....',
      '.....######.....',
      '......####......',
      '...#........#...',
      '..#..........#..',
      '.......##.......',
      '.......##.......'
    ],
    moon: [
      '.....######.....',
      '...####....##...',
      '..####......##..',
      '.#####.......##.',
      '.#####.......##.',
      '#####.........##',
      '#####.........##',
      '#####..........#',
      '#####..........#',
      '#####.........##',
      '#####.........##',
      '.#####.......##.',
      '.######......##.',
      '..#######...##..',
      '...###########..',
      '.....######.....'
    ],
    cloud: [
      '................',
      '................',
      '.......####.....',
      '.....########...',
      '....##########..',
      '..#############.',
      '.##############.',
      '################',
      '################',
      '.##############.',
      '..############..',
      '................',
      '................',
      '................',
      '................',
      '................'
    ],
    partly: [
      '..#...#.........',
      '...####.........',
      '..######........',
      '#.######...#....',
      '..######.#####..',
      '...####.#######.',
      '..#...##########',
      '....############',
      '...#############',
      '...#############',
      '....###########.',
      '.....#########..',
      '................',
      '................',
      '................',
      '................'
    ],
    rain: [
      '.....#####......',
      '...#########....',
      '..###########...',
      '.#############..',
      '###############.',
      '###############.',
      '.#############..',
      '................',
      '...#...#...#....',
      '..#...#...#.....',
      '................',
      '....#...#...#...',
      '...#...#...#....',
      '................',
      '...#...#...#....',
      '..#...#...#.....'
    ],
    drizzle: [
      '.....#####......',
      '...#########....',
      '..###########...',
      '.#############..',
      '###############.',
      '###############.',
      '.#############..',
      '................',
      '...#...#...#....',
      '................',
      '................',
      '.....#...#......',
      '................',
      '................',
      '...#...#...#....',
      '................'
    ],
    snow: [
      '.....#####......',
      '...#########....',
      '..###########...',
      '.#############..',
      '###############.',
      '###############.',
      '.#############..',
      '................',
      '..#.#.....#.#...',
      '...#.......#....',
      '..#.#.....#.#...',
      '................',
      '.......#.#......',
      '........#.......',
      '.......#.#......',
      '................'
    ],
    storm: [
      '.....#####......',
      '...#########....',
      '..###########...',
      '.#############..',
      '###############.',
      '###############.',
      '.#############..',
      '................',
      '.........###....',
      '........###.....',
      '.......###......',
      '......######....',
      '.......####.....',
      '......###.......',
      '.....###........',
      '....##..........'
    ],
    fog: [
      '................',
      '................',
      '..###########...',
      '................',
      '.#############..',
      '................',
      '..###########...',
      '................',
      '###############.',
      '................',
      '..###########...',
      '................',
      '.#############..',
      '................',
      '..###########...',
      '................'
    ]
  };

  /* Small glyphs for the stat rows, in the same 8x8 cell as the font so they
     sit on the same rhythm as the text beside them. */
  var GLYPHS = {
    sunrise: [
      '...##...',
      '..####..',
      '.######.',
      '...##...',
      '...##...',
      '........',
      '########',
      '........'
    ],
    sunset: [
      '...##...',
      '...##...',
      '.######.',
      '..####..',
      '...##...',
      '........',
      '########',
      '........'
    ],
    wind: [
      '........',
      '..####.#',
      '......#.',
      '........',
      '.######.',
      '.......#',
      '........',
      '..####..'
    ],
    thermo: [
      '...##...',
      '..#..#..',
      '..#..#..',
      '..####..',
      '..####..',
      '.######.',
      '.######.',
      '..####..'
    ],
    drop: [
      '...##...',
      '...##...',
      '..####..',
      '.######.',
      '########',
      '########',
      '.######.',
      '..####..'
    ]
  };

  /* Dimensions come from the art itself, so 8x8 glyphs and 16x16 weather
     sprites go through the same renderer. */
  function artSVG(art, extraClass) {
    var w = art[0].length;
    var rects = [];
    var rows = art.map(function (line) {
      var row = [];
      for (var x = 0; x < w; x++) row.push(line.charAt(x) === '#' ? 1 : 0);
      return row;
    });
    bitmapRects(rows, 0, w, rects);
    return svg(w, art.length, rects, extraClass);
  }

  /* Stroked condition art for the Modern theme.
     The pixel sprites are the point of every retro theme, and a smooth icon
     beside a 16x16 cloud would look like a mistake in them. Modern is the one
     theme with no machine to be faithful to - it renders system text, so it
     gets drawn art on the same 24x24 grid rather than a scaled-up bitmap.
     Stroke-only, currentColor, round joins: it inherits the theme colour the
     same way the bitmaps do. */
  var STROKE_ART = {
    cloud: 'M7 17.5h9.5a3.8 3.8 0 0 0 .4-7.6 5.6 5.6 0 0 0-10.7-1.3A3.9 3.9 0 0 0 7 17.5z',
    sun: 'M12 15.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2z|M12 3.2v2.1|M12 18.7v2.1|M3.2 12h2.1|M18.7 12h2.1|M5.8 5.8l1.5 1.5|M16.7 16.7l1.5 1.5|M18.2 5.8l-1.5 1.5|M7.3 16.7l-1.5 1.5',
    moon: 'M19.5 14.8A8 8 0 0 1 9.2 4.5a8 8 0 1 0 10.3 10.3z',
    partly: 'M9 18h8a3.4 3.4 0 0 0 .3-6.8A5 5 0 0 0 8 10.2 3.5 3.5 0 0 0 9 18z|M6.6 11.2a4 4 0 0 1 5.6-5.4|M15.6 5.2V3.4|M20 8.4h1.7|M19.1 4.6l1.2-1.2',
    fog: 'M7 14h9.5a3.8 3.8 0 0 0 .4-7.6A5.6 5.6 0 0 0 6.2 5.1 3.9 3.9 0 0 0 7 14z|M4.5 17.6h15|M6.8 20.6h10.4',
    drizzle: 'M7 15h9.5a3.8 3.8 0 0 0 .4-7.6A5.6 5.6 0 0 0 6.2 6.1 3.9 3.9 0 0 0 7 15z|M9.4 18.2l-.8 2|M14.6 18.2l-.8 2',
    rain: 'M7 14.6h9.5a3.8 3.8 0 0 0 .4-7.6A5.6 5.6 0 0 0 6.2 5.7 3.9 3.9 0 0 0 7 14.6z|M8.8 17.6l-1.3 3.2|M12.6 17.6l-1.3 3.2|M16.4 17.6l-1.3 3.2',
    snow: 'M7 14.6h9.5a3.8 3.8 0 0 0 .4-7.6A5.6 5.6 0 0 0 6.2 5.7 3.9 3.9 0 0 0 7 14.6z|M7.8 19L10.2 19|M8.4 18L9.6 20|M9.6 18L8.4 20|M10.8 20.3L13.2 20.3|M11.4 19.3L12.6 21.3|M12.6 19.3L11.4 21.3|M13.8 19L16.2 19|M14.4 18L15.6 20|M15.6 18L14.4 20',
    storm: 'M7 14.2h9.5a3.8 3.8 0 0 0 .4-7.6A5.6 5.6 0 0 0 6.2 5.3 3.9 3.9 0 0 0 7 14.2z|M13.2 16.6l-3.4 3.1h3l-1.4 2.5'
  };

  /* ---------- machine art ----------
     One drawing per machine, shown beside its startup screen while it boots.
     Drawn from reference photographs, never from memory: the CPC 464, ZX
     Spectrum and CBM 8032 from photographs supplied for this project, and the
     BBC Micro, Commodore 64 and Amiga 1200 from public-domain photographs on
     Wikimedia Commons (Commodore-64-Computer-FL.jpg, BBC Micro left.jpeg,
     Commodore Amiga 1200 Tietokonemuseo.JPG).

     These render in one colour like every other sprite, so a machine has to be
     told apart by its SILHOUETTE and its internal structure rather than by its
     case colour - which is why each carries the one feature that identifies it:
     the PET's monitor sitting on its body, the CPC's cassette deck, the BBC's
     solid function-key strip, the Spectrum's corner flash, the C64's stacked
     function keys, the Amiga's numeric keypad. */
  var MACHINES = {
    c64: [
      '############################################',
      '#.........................#######..........#',
      '############################################',
      '#..........................................#',
      '#..........................................#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.##.##.....#',
      '#................................##.##.....#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.##.##.....#',
      '#................................##.##.....#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.##.##.....#',
      '#................................##.##.....#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.##.##.....#',
      '#................................##.##.....#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.##.##.....#',
      '#..........................................#',
      '#..........................................#',
      '############################################'
    ],
    pet: [
      '......############################......',
      '......#..........................#......',
      '......#..######################..#......',
      '......#..#....................#..#......',
      '......#..#.#########..........#..#......',
      '......#..#....................#..#......',
      '......#..#.#############......#..#......',
      '......#..#....................#..#......',
      '......#..#.######.............#..#......',
      '......#..#....................#..#......',
      '......#..#....................#..#......',
      '......#..######################..#......',
      '......#..........................#......',
      '......#..........................#......',
      '......############################......',
      '########################################',
      '#......................................#',
      '#......................................#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#.#...#.#.#.#.#',
      '#......................................#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#.#...#.#.#.#.#',
      '#......................................#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#.#...#.#.#.#.#',
      '#......................................#',
      '#......................................#',
      '########################################'
    ],
    bbc: [
      '############################################',
      '#..........................................#',
      '#..........................................#',
      '#...#############################....#####.#',
      '#..........................................#',
      '#..........................................#',
      '#...#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#........#',
      '#..........................................#',
      '#...#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#........#',
      '#..........................................#',
      '#...#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#........#',
      '#..........................................#',
      '#...#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#........#',
      '#..........................................#',
      '#...#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#........#',
      '#..........................................#',
      '#..........................................#',
      '############################################'
    ],
    cpc: [
      '############################################',
      '#..........................................#',
      '#..........................................#',
      '#...............................##########.#',
      '#..#.#.#.#.#.#.#.#.#.#.#........#........#.#',
      '#...............................#.##..##.#.#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#.#.#..#.##..##.#.#',
      '#...............................#........#.#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#.#.#..#........#.#',
      '#...............................##########.#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#.#.#..#........#.#',
      '#...............................##########.#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#.#.#.............#',
      '#..........................................#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#.#.#.............#',
      '#..........................................#',
      '#..........................................#',
      '############################################'
    ],
    spectrum: [
      '################################',
      '#..............................#',
      '#..............................#',
      '#..#.#.#.#.#.#.#.#.#.#.#.......#',
      '#..............................#',
      '#..#.#.#.#.#.#.#.#.#.#.#.......#',
      '#..............................#',
      '#..#.#.#.#.#.#.#.#.#.#.#.......#',
      '#..............................#',
      '#..#.#.#.#.#.#.#.#.#.#.#.......#',
      '#..............................#',
      '#........................####..#',
      '#........................####..#',
      '#........................####..#',
      '################################'
    ],
    amiga: [
      '##############################################',
      '#................................########....#',
      '#............................................#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#.......#.#.#.#.#...#',
      '#............................................#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#.......#.#.#.#.#...#',
      '#............................................#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#..#.#..#.#.#.#.#...#',
      '#............................................#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#..#.#..#.#.#.#.#...#',
      '#............................................#',
      '#..#.#.#.#.#.#.#.#.#.#.#.#..#.#..#.#.#.#.#...#',
      '#............................................#',
      '#............................................#',
      '##############################################'
    ],
  };

  function machineSVG(name) {
    var art = MACHINES[name];
    return art ? artSVG(art, 'machine-art') : '';
  }

  /* Unlike setSprite there is no fallback: a theme with no machine drawing
     shows nothing rather than another machine's picture, because a wrong
     machine beside the right boot screen is worse than no picture at all. */
  function setMachine(el, name) {
    if (!el) return;
    el.innerHTML = machineSVG(name);
  }

  function strokeSVG(name) {
    var d = STROKE_ART[name] || STROKE_ART.cloud;
    var paths = d.split('|').map(function (seg) {
      return '<path d="' + seg + '"/>';
    }).join('');
    return '<svg class="px sprite stroke" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet"' +
      ' fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"' +
      ' stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"' +
      ' focusable="false" aria-hidden="true">' + paths + '</svg>';
  }

  function spriteSVG(name) {
    if (fontMode === 'system') return strokeSVG(name);
    return artSVG(SPRITES[name] || SPRITES.cloud, 'sprite');
  }

  function glyphSVG(name) {
    return artSVG(GLYPHS[name] || GLYPHS.wind, 'glyph');
  }

  function setGlyph(el, name) {
    if (!el) return;
    el.innerHTML = glyphSVG(name);
  }

  function setSprite(el, name) {
    if (!el) return;
    el.innerHTML = spriteSVG(name);
  }

  global.PETSCII = {
    textSVG: textSVG,
    setText: setText,
    setSprite: setSprite,
    setGlyph: setGlyph,
    setFont: setFont,
    fontMode: function () { return fontMode; },
    letterCase: function () { return letterCase; },
    setMachine: setMachine,
    machineNames: Object.keys(MACHINES),
    spriteNames: Object.keys(SPRITES),
    glyphNames: Object.keys(GLYPHS)
  };
})(window);
