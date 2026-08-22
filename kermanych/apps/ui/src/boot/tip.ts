import { defineBoot } from '#q-app/wrappers';

import { tip } from '../lib/tip';

// Registered app-wide: glyph-only controls exist in the panel header, the board's
// actions column and the kit gallery, and all three want the same bubble.
export default defineBoot(({ app }) => {
  app.directive('tip', tip);
});
