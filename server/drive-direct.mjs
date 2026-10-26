/**
 * Google Drive, called directly by the relay (no CLI, no model): the client
 * folders of the agency. Identity: the shared data@ account whose short-lived
 * token server/gws-auth.mjs mints (the same one the gws MCP server uses).
 *
 * Layout in that Drive (created on demand, ids kept by the app):
 *   <DRIVE_CLIENTS_ROOT_NAME>/            « ImpulseMotion – Clients »
 *     <Client>/                           one folder per client (Dashboard)
 *       Designs/<design name>/            exports of a FigCraft design
 *       …                                 whatever the team drops there
 *
 * Every call is scoped to a folder id the app passes; names are cleaned,
 * nothing is ever deleted here.
 */

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const ROOT_NAME = (process.env.DRIVE_CLIENTS_ROOT_NAME || "ImpulseMotion – Clients").trim();
/** Optional: pin the root folder id instead of finding it by name. */
const ROOT_ID = (process.env.DRIVE_CLIENTS_ROOT_ID || "").trim();
/** The domain the root folder is shared with (writer), e.g. impulse-analytics.com. Empty: no sharing step. */
const SHARE_DOMAIN = (process.env.DRIVE_CLIENTS_SHARE_DOMAIN || "impulse-analytics.com").trim();
const ID_RE = /^[A-Za-z0-9_-]{10,128}$/;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export class DriveError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

export function cleanName(name) {
  const s = String(name ?? "").replace(/[\u0000-\u001f/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return s || "Sans nom";
}

function esc(s) { return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

async function call(getToken, method, url, { body = null, headers = {}, raw = false } = {}) {
  const token = await getToken();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && !raw ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body ? { body: raw ? body : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new DriveError(`Drive ${res.status} : ${msg}`, res.status === 404 ? 404 : res.status === 403 ? 403 : 502);
  }
  return json;
}

async function findChildFolder(getToken, parentId, name) {
  const q = `name = '${esc(name)}' and mimeType = '${FOLDER_MIME}' and '${esc(parentId)}' in parents and trashed = false`;
  const out = await call(getToken, "GET", `${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink)&pageSize=5&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  return out?.files?.[0] ?? null;
}

async function createFolder(getToken, parentId, name, description = "") {
  return call(getToken, "POST", `${API}/files?fields=id,name,webViewLink&supportsAllDrives=true`, {
    body: { name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}), ...(description ? { description: description.slice(0, 2000) } : {}) },
  });
}

/** The folder `name` under `parentId`, created when missing. → { id, name, webViewLink, created } */
export async function ensureFolder(getToken, parentId, name, description = "") {
  const clean = cleanName(name);
  if (parentId && !ID_RE.test(parentId)) throw new DriveError("dossier parent invalide", 400);
  const found = await findChildFolder(getToken, parentId || "root", clean);
  if (found) return { ...found, created: false };
  const made = await createFolder(getToken, parentId, clean, description);
  return { ...made, created: true };
}

let rootCache = null;
/** The agency's « Clients » root folder (found by name in the data@ Drive, created once, shared with the domain). */
export async function ensureRoot(getToken) {
  if (rootCache) return rootCache;
  if (ROOT_ID) {
    const f = await call(getToken, "GET", `${API}/files/${ROOT_ID}?fields=id,name,webViewLink&supportsAllDrives=true`);
    rootCache = { ...f, created: false };
    return rootCache;
  }
  const q = `name = '${esc(ROOT_NAME)}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`;
  const out = await call(getToken, "GET", `${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink)&pageSize=5`);
  let root = out?.files?.[0] ?? null;
  let created = false;
  if (!root) {
    root = await createFolder(getToken, null, ROOT_NAME, "Un dossier par client ImpulseMotion : designs, exports, fichiers. Créé par le relay.");
    created = true;
    if (SHARE_DOMAIN) {
      try {
        await call(getToken, "POST", `${API}/files/${root.id}/permissions?supportsAllDrives=true`, { body: { role: "writer", type: "domain", domain: SHARE_DOMAIN, allowFileDiscovery: false } });
      } catch (e) {
        console.error(`[drive] partage du dossier racine avec ${SHARE_DOMAIN} refusé : ${e.message}`);
      }
    }
  }
  rootCache = { ...root, created };
  return rootCache;
}

/** The client's folder (under the root), created when missing. */
export async function ensureClientFolder(getToken, { name, description = "" }) {
  const root = await ensureRoot(getToken);
  const folder = await ensureFolder(getToken, root.id, name, description);
  return { ...folder, rootId: root.id };
}

/** Files and folders directly inside `folderId`, newest first. */
export async function listFolder(getToken, folderId, { limit = 100 } = {}) {
  if (!ID_RE.test(folderId)) throw new DriveError("dossier invalide", 400);
  const q = `'${esc(folderId)}' in parents and trashed = false`;
  const fields = "files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink,thumbnailLink)";
  const out = await call(getToken, "GET", `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&orderBy=folder,modifiedTime desc&pageSize=${Math.min(200, Math.max(1, limit))}&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  return (out?.files ?? []).map((f) => ({
    id: f.id, name: f.name, mimeType: f.mimeType, bytes: f.size ? Number(f.size) : null, modifiedTime: f.modifiedTime ?? null,
    webViewLink: f.webViewLink ?? null, iconLink: f.iconLink ?? null, thumbnailLink: f.thumbnailLink ?? null, isFolder: f.mimeType === FOLDER_MIME,
  }));
}

export async function getFolder(getToken, folderId) {
  if (!ID_RE.test(folderId)) throw new DriveError("dossier invalide", 400);
  const f = await call(getToken, "GET", `${API}/files/${folderId}?fields=id,name,webViewLink,trashed,mimeType&supportsAllDrives=true`);
  if (!f || f.trashed || f.mimeType !== FOLDER_MIME) return null;
  return { id: f.id, name: f.name, webViewLink: f.webViewLink ?? null };
}

/**
 * Uploads (or replaces, same name) a file into `folderId`.
 * → { id, name, webViewLink, bytes, replaced }
 */
export async function uploadFile(getToken, folderId, { name, mimeType, data }) {
  if (!ID_RE.test(folderId)) throw new DriveError("dossier invalide", 400);
  const clean = cleanName(name);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "base64");
  if (!buf.length) throw new DriveError("fichier vide", 400);
  if (buf.length > MAX_UPLOAD_BYTES) throw new DriveError("fichier > 25 Mo", 413);
  const type = typeof mimeType === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ? mimeType : "application/octet-stream";
  // Same name already there → new version of that file (no duplicates in the folder).
  const q = `name = '${esc(clean)}' and '${esc(folderId)}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`;
  const existing = (await call(getToken, "GET", `${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`))?.files?.[0] ?? null;
  const boundary = `im-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const meta = existing ? { name: clean } : { name: clean, parents: [folderId] };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const url = existing
    ? `${UPLOAD_API}/files/${existing.id}?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`
    : `${UPLOAD_API}/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`;
  const out = await call(getToken, existing ? "PATCH" : "POST", url, { body, raw: true, headers: { "Content-Type": `multipart/related; boundary=${boundary}` } });
  return { id: out.id, name: out.name, webViewLink: out.webViewLink ?? null, bytes: buf.length, replaced: !!existing };
}
