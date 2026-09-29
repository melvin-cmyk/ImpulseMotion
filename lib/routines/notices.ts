/**
 * Routines — sentences said to the person before going on, shared by the
 * step that finds them, the routes that hand them over and the interface.
 * Pure and client-safe.
 */

/** Rows a change of ad set creates again: said in clear, by the dry run and by the card of the proposal. */
export function adsetChangeNotice(rows: number, done = false): string | null {
  if (rows <= 0) return null;
  const one = rows === 1;
  return `L'ensemble de publicités a changé : ${one ? "la ligne déjà traitée" : `les ${rows} lignes déjà traitées`} dans l'ancien ensemble ${done ? (one ? "a été créée" : "ont été créées") : (one ? "sera créée" : "seront créées")} à nouveau dans le nouveau.`;
}
