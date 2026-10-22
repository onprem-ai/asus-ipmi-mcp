// US keyboard layout -> USB HID usage codes.
export const MOD = { CTRL: 0x01, SHIFT: 0x02, ALT: 0x04, GUI: 0x08 };

export const CHARS = {};
'abcdefghijklmnopqrstuvwxyz'.split('').forEach((c, i) => { CHARS[c] = [4 + i, 0]; CHARS[c.toUpperCase()] = [4 + i, MOD.SHIFT]; });
'1234567890'.split('').forEach((c, i) => { CHARS[c] = [30 + i, 0]; });
'!@#$%^&*()'.split('').forEach((c, i) => { CHARS[c] = [30 + i, MOD.SHIFT]; });
Object.assign(CHARS, {
  '\n': [40, 0], ' ': [44, 0], '\t': [43, 0],
  '-': [45, 0], '_': [45, MOD.SHIFT], '=': [46, 0], '+': [46, MOD.SHIFT], '[': [47, 0], '{': [47, MOD.SHIFT],
  ']': [48, 0], '}': [48, MOD.SHIFT], '\\': [49, 0], '|': [49, MOD.SHIFT], ';': [51, 0], ':': [51, MOD.SHIFT],
  "'": [52, 0], '"': [52, MOD.SHIFT], '`': [53, 0], '~': [53, MOD.SHIFT], ',': [54, 0], '<': [54, MOD.SHIFT],
  '.': [55, 0], '>': [55, MOD.SHIFT], '/': [56, 0], '?': [56, MOD.SHIFT],
});

export const NAMED = {
  enter: 40, return: 40, esc: 41, escape: 41, backspace: 42, tab: 43, space: 44, capslock: 57,
  f1: 58, f2: 59, f3: 60, f4: 61, f5: 62, f6: 63, f7: 64, f8: 65, f9: 66, f10: 67, f11: 68, f12: 69,
  printscreen: 70, scrolllock: 71, pause: 72, insert: 73, home: 74, pageup: 75, delete: 76, del: 76,
  end: 77, pagedown: 78, right: 79, left: 80, down: 81, up: 82,
};

/** "ctrl+alt+delete" | "enter" | "a" | "super" -> [usage, modifiers] (usage 0 = modifier only). */
export function parseCombo(s) {
  let mods = 0, key = null;
  for (const raw of String(s).toLowerCase().split('+')) {
    const part = raw.trim();
    if (part === 'ctrl' || part === 'control') mods |= MOD.CTRL;
    else if (part === 'shift') mods |= MOD.SHIFT;
    else if (part === 'alt') mods |= MOD.ALT;
    else if (part === 'win' || part === 'super' || part === 'meta' || part === 'cmd') mods |= MOD.GUI;
    else if (NAMED[part] !== undefined) key = NAMED[part];
    else if (part.length === 1 && CHARS[part]) { key = CHARS[part][0]; mods |= CHARS[part][1]; }
    else throw new Error(`unknown key "${part}" in "${s}"`);
  }
  return [key ?? 0, mods];
}
