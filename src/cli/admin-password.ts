/**
 * npm run admin:password -- <nueva-clave> [usuario]
 *
 * Cambia la contraseña de un usuario local del panel (por defecto el primer
 * admin local). El admin se crea en el primer arranque con
 * LOCAL_ADMIN_PASSWORD; después, la clave solo se cambia con este comando.
 */
import bcrypt from 'bcryptjs';
import { all, get, migrate, run } from '../db/index.js';
import { nowIso } from '../util/async.js';

const [password, username] = process.argv.slice(2);
if (!password || password.length < 8) {
  console.error('Uso: npm run admin:password -- <nueva-clave (mín. 8 caracteres)> [usuario]');
  process.exit(1);
}

migrate();
const user = username
  ? get<{ id: number; username: string | null }>("SELECT id, username FROM users WHERE source = 'local' AND username = ?", username)
  : get<{ id: number; username: string | null }>("SELECT id, username FROM users WHERE source = 'local' ORDER BY id LIMIT 1");

if (!user) {
  const locals = all<{ username: string | null }>("SELECT username FROM users WHERE source = 'local'").map((u) => u.username);
  console.error(`No se encontró el usuario local${username ? ` "${username}"` : ''}. Locales: ${locals.join(', ') || 'ninguno'}`);
  process.exit(1);
}

run('UPDATE users SET password = ?, updated_at = ? WHERE id = ?', bcrypt.hashSync(password, 10), nowIso(), user.id);
console.log(`Contraseña actualizada para "${user.username}".`);
