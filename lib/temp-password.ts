/**
 * Mot de passe temporaire lisible (sans caractères ambigus : 0/O, 1/l/I).
 * Utilisé à la création d'un utilisateur par un admin (POST /api/admin/users,
 * POST /api/admin/bots/[dashboardId]/access). Renvoyé UNE fois, jamais stocké en clair.
 */
export function generateTempPassword(length = 16): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  for (const b of buf) out += chars[b % chars.length];
  return out;
}
