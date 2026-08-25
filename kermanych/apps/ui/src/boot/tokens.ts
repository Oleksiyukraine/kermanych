import { defineBoot } from '#q-app/wrappers';

// Kermanych design tokens: fonts (JetBrains Mono) and CSS variables.
// Imported here so they are bundled into the app entry.
import '@kermanych/tokens/fonts.css';
import '@kermanych/tokens/tokens.css';
import { initTheme } from 'src/lib/theme';

export default defineBoot(() => {
  // Boot runs before the app mounts, so the stored theme is on <html> before
  // the first paint — a light-theme user never sees the dark default flash.
  initTheme();
});
