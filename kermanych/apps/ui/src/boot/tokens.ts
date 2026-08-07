import { defineBoot } from '#q-app/wrappers';

// Kermanych design tokens: fonts (Archivo + JetBrains Mono) and CSS variables.
// Imported here so they are bundled into the app entry.
import '@kermanych/tokens/fonts.css';
import '@kermanych/tokens/tokens.css';

export default defineBoot(() => {
  // Side-effect imports above wire the base theme; nothing else to do here yet.
});
