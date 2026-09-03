import type { uk } from './uk';
// The shape every locale must satisfy. `en` is checked against this, so a
// dropped key is a compile error, not a silent runtime fallback.
export type MessageSchema = typeof uk;
