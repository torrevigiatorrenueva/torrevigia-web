// Mini-panel de comunicados de Torrevigía.
// En producción guarda en el repositorio de GitHub (API de contenidos); en
// local, bajo `netlify dev`, escribe en los archivos del proyecto.
//
// Modelo de comunicado (frontmatter):
//   title, fecha_inicio, fecha_fin (opcional), documentos (lista, opcional),
//   orden (opcional), publicado:false (opcional) + cuerpo Markdown.

const fs = require("fs");
const path = require("path");

const GH_API = "https://api.github.com";
// .trim() por si el valor se pegó con un espacio o salto de línea de más al
// configurar la variable en Netlify: un token o repo así de "sucio" provoca
// peticiones HTTP mal formadas que GitHub rechaza con un 400 genérico.
const REPO = (process.env.GITHUB_REPO || "").trim();
const BRANCH = (process.env.GITHUB_BRANCH || "main").trim();
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || "").trim();
const COMUNICADOS_DIR = "comunicados";
const PDF_DIR = "img/comunicados";

const USE_LOCAL = process.env.NETLIFY_DEV === "true";

function findRoot() {
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, "..", ".."),
    path.resolve(__dirname, "..", "..", ".."),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, COMUNICADOS_DIR))) return c;
  }
  return process.cwd();
}
const ROOT = USE_LOCAL ? findRoot() : process.cwd();

/* ---------- Utilidades ---------- */
function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}
function slugify(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
function sanitizeName(name) {
  const dot = String(name).lastIndexOf(".");
  const ext = dot >= 0 ? String(name).slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, "") : "";
  const base =
    (dot >= 0 ? String(name).slice(0, dot) : String(name))
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "documento";
  return base + (ext || ".pdf");
}
function checkAuth(body) {
  const pass = process.env.ADMIN_PASSWORD;
  const user = process.env.ADMIN_USER;
  if (!pass) return false;
  if (!body || body.password !== pass) return false;
  if (user && body.username !== user) return false;
  return true;
}
function esc(s) {
  return `"${String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function getDocs(data) {
  if (Array.isArray(data.documentos)) return data.documentos;
  if (data.documento) return [data.documento];
  return [];
}
function toMarkdown(f) {
  const lines = ["---"];
  lines.push(`title: ${esc(f.title)}`);
  lines.push(`fecha_inicio: ${esc(String(f.fecha_inicio || "").slice(0, 10))}`);
  if (f.fecha_fin) lines.push(`fecha_fin: ${esc(String(f.fecha_fin).slice(0, 10))}`);
  if (Array.isArray(f.documentos) && f.documentos.length) {
    lines.push("documentos:");
    for (const d of f.documentos) lines.push(`  - ${esc(d)}`);
  }
  if (f.orden !== undefined && f.orden !== null && f.orden !== "" && !isNaN(Number(f.orden))) {
    lines.push(`orden: ${parseInt(f.orden, 10)}`);
  }
  if (f.publicado === false || f.publicado === "false") lines.push("publicado: false");
  lines.push("---");
  lines.push((f.body || "").replace(/\r\n/g, "\n").trim());
  lines.push("");
  return lines.join("\n");
}
function parseMarkdown(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const data = {};
  let body = text;
  if (m) {
    body = m[2];
    const lines = m[1].split("\n");
    let i = 0;
    const unquote = (v) =>
      v.startsWith('"') && v.endsWith('"')
        ? v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
        : v;
    while (i < lines.length) {
      const kv = lines[i].match(/^(\w+):\s*(.*)$/);
      if (kv) {
        const key = kv[1];
        const val = kv[2].trim();
        if (val === "") {
          const list = [];
          let j = i + 1;
          while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
            list.push(unquote(lines[j].replace(/^\s*-\s+/, "").trim()));
            j++;
          }
          if (list.length) {
            data[key] = list;
            i = j;
            continue;
          }
          data[key] = "";
        } else {
          data[key] = unquote(val);
        }
      }
      i++;
    }
  }
  return { data, body: body.replace(/^\n+/, "") };
}

/* ---------- GitHub API ---------- */
function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "torrevigia-admin",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
function ghUrl(p) {
  return `${GH_API}/repos/${REPO}/contents/${encodeURIComponent(p).replace(/%2F/g, "/")}`;
}
// Traduce un fallo de la API de GitHub a un mensaje entendible para quien
// gestiona el panel (en vez del JSON crudo de GitHub).
async function ghFail(accion, objetivo, res) {
  const raw = await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `El token de GitHub no tiene permiso para ${accion} (${res.status}). ` +
      `Revisa en GitHub que el token tenga el permiso "Contents: Read and write" sobre el repositorio, ` +
      `y que la variable GITHUB_TOKEN esté actualizada en Netlify (Site configuration → Environment variables).`
    );
  }
  throw new Error(`Error de GitHub al ${accion} (${res.status}): ${raw}`);
}
async function ghGetFile(p) {
  const res = await fetch(`${ghUrl(p)}?ref=${BRANCH}`, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) await ghFail(`leer "${p}"`, p, res);
  return res.json();
}
// Llamada genérica a la Git Data API (para archivos grandes que la Contents
// API no admite: su límite es ~1 MB por archivo).
async function ghApi(method, apiPath, body) {
  const res = await fetch(`${GH_API}/repos/${REPO}${apiPath}`, {
    method,
    headers: ghHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) await ghFail(`escribir en el repositorio (${method} ${apiPath})`, apiPath, res);
  return res.json();
}
// UN commit para TODOS los cambios de una acción (crea/actualiza y borra),
// vía Git Data API. Así Netlify hace UN SOLO build por acción (ahorra cuota),
// y además soporta archivos grandes (la Contents API se limita a ~1 MB).
async function ghCommit(changes, message) {
  const ref = await ghApi("GET", `/git/ref/heads/${BRANCH}`);
  const baseSha = ref.object.sha;
  const baseCommit = await ghApi("GET", `/git/commits/${baseSha}`);
  const tree = [];
  for (const c of changes) {
    if (c.delete) {
      tree.push({ path: c.path, mode: "100644", type: "blob", sha: null });
    } else {
      const blob = await ghApi("POST", "/git/blobs", {
        content: c.buffer.toString("base64"),
        encoding: "base64",
      });
      tree.push({ path: c.path, mode: "100644", type: "blob", sha: blob.sha });
    }
  }
  const newTree = await ghApi("POST", "/git/trees", { base_tree: baseCommit.tree.sha, tree });
  const commit = await ghApi("POST", "/git/commits", { message, tree: newTree.sha, parents: [baseSha] });
  await ghApi("PATCH", `/git/refs/heads/${BRANCH}`, { sha: commit.sha });
}

/* ---------- Almacenamiento (local o GitHub) ---------- */
async function storeListMd(dir) {
  if (USE_LOCAL) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    return fs
      .readdirSync(abs)
      .filter((n) => n.endsWith(".md"))
      .map((n) => ({ name: n, path: `${dir}/${n}` }));
  }
  const res = await fetch(`${ghUrl(dir)}?ref=${BRANCH}`, { headers: ghHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) await ghFail(`listar "${dir}"`, dir, res);
  const items = await res.json();
  return items
    .filter((i) => i.type === "file" && i.name.endsWith(".md"))
    .map((i) => ({ name: i.name, path: i.path }));
}
async function storeRead(p) {
  if (USE_LOCAL) {
    const abs = path.join(ROOT, p);
    if (!fs.existsSync(abs)) return null;
    return { text: fs.readFileSync(abs, "utf8"), sha: null };
  }
  const f = await ghGetFile(p);
  if (!f) return null;
  return { text: Buffer.from(f.content, "base64").toString("utf8"), sha: f.sha };
}
/* ---------- Escritura por lotes (1 acción = 1 commit) ---------- */
function newBatch() {
  return [];
}
function batchWrite(batch, p, buffer) {
  batch.push({ path: p, buffer });
}
function batchDelete(batch, p) {
  batch.push({ path: p, delete: true });
}
async function commitBatch(batch, message) {
  if (!batch.length) return;
  if (USE_LOCAL) {
    for (const c of batch) {
      const abs = path.join(ROOT, c.path);
      if (c.delete) {
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, c.buffer);
      }
    }
    return;
  }
  await ghCommit(batch, message);
}

// Valor de "orden" para colocar un comunicado nuevo arriba, si ya hay otros
// ordenados manualmente; si no, undefined (se usa la fecha).
async function topOrden() {
  const files = await storeListMd(COMUNICADOS_DIR);
  let min = null;
  for (const f of files) {
    const s = await storeRead(f.path);
    if (!s) continue;
    const o = parseMarkdown(s.text).data.orden;
    if (o !== undefined && o !== null && o !== "" && !isNaN(Number(o))) {
      const n = Number(o);
      if (min === null || n < min) min = n;
    }
  }
  return min === null ? undefined : min - 1;
}

/* ---------- Handler ---------- */
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "JSON inválido" });
  }

  if (!checkAuth(body)) return json(401, { error: "Usuario o contraseña incorrectos" });
  if (!USE_LOCAL && (!REPO || !GITHUB_TOKEN)) {
    return json(500, { error: "Falta configuración del servidor (GITHUB_REPO / GITHUB_TOKEN)" });
  }

  const action = body.action;
  try {
    if (action === "list") {
      const files = await storeListMd(COMUNICADOS_DIR);
      const result = [];
      for (const f of files) {
        const stored = await storeRead(f.path);
        const { data } = parseMarkdown(stored.text);
        result.push({
          slug: f.name.replace(/\.md$/, ""),
          title: data.title || f.name,
          fecha_inicio: data.fecha_inicio || data.date || "",
          fecha_fin: data.fecha_fin || "",
          publicado: data.publicado,
          orden: data.orden,
        });
      }
      result.sort((a, b) => {
        const oa = a.orden, ob = b.orden;
        const ha = oa !== undefined && oa !== null && oa !== "";
        const hb = ob !== undefined && ob !== null && ob !== "";
        if (ha && hb) return Number(oa) - Number(ob);
        if (ha) return -1;
        if (hb) return 1;
        return a.fecha_inicio < b.fecha_inicio ? 1 : -1;
      });
      return json(200, { comunicados: result, mode: USE_LOCAL ? "local" : "github" });
    }

    if (action === "get") {
      const slug = slugify(body.slug);
      const stored = await storeRead(`${COMUNICADOS_DIR}/${slug}.md`);
      if (!stored) return json(404, { error: "Comunicado no encontrado" });
      const { data, body: mdBody } = parseMarkdown(stored.text);
      return json(200, {
        slug,
        data: {
          title: data.title || "",
          fecha_inicio: data.fecha_inicio || data.date || "",
          fecha_fin: data.fecha_fin || "",
          documentos: getDocs(data),
          publicado: data.publicado,
        },
        body: mdBody,
        sha: stored.sha,
      });
    }

    if (action === "save") {
      if (!body.title || !body.fecha_inicio || !body.body || !String(body.body).trim()) {
        return json(400, { error: "Faltan campos obligatorios (título, fecha inicio, contenido)" });
      }
      const isEdit = !!body.slug;
      const slug = isEdit ? slugify(body.slug) : slugify(body.title);
      if (!slug) return json(400, { error: "No se pudo generar el identificador del comunicado" });

      const mdPath = `${COMUNICADOS_DIR}/${slug}.md`;
      const existing = await storeRead(mdPath);
      if (existing && !isEdit) {
        return json(409, { error: "Ya existe un comunicado con ese título. Cambia el título o edítalo." });
      }
      const prev = existing ? parseMarkdown(existing.text).data : {};
      const prevDocs = getDocs(prev);

      // Documentos que se conservan (los que el usuario no ha quitado)
      const kept = Array.isArray(body.documentos) ? body.documentos.filter(Boolean) : [];
      // Subir documentos nuevos
      const nuevos = Array.isArray(body.nuevos) ? body.nuevos : [];
      // Guardarraíl: Netlify limita la petición a ~6 MB. Cortamos antes con mensaje claro.
      const totalB64 = nuevos.reduce((s, f) => s + ((f && f.data && f.data.length) || 0), 0);
      if (totalB64 > 5.5 * 1024 * 1024) {
        return json(413, {
          error: "Los documentos adjuntos superan el máximo (~4 MB en total por envío). Comprime los PDF (por ejemplo en ilovepdf.com/compress) e inténtalo de nuevo.",
        });
      }
      const batch = newBatch();
      const nuevasPaths = [];
      for (const f of nuevos) {
        if (!f || !f.data || !f.name) continue;
        const name = sanitizeName(f.name);
        const p = `${PDF_DIR}/${slug}/${name}`;
        batchWrite(batch, p, Buffer.from(f.data, "base64"));
        nuevasPaths.push(`/${p}`);
      }
      const documentos = [...kept, ...nuevasPaths];
      // Borrar (en el mismo commit) los documentos que se han quitado
      for (const d of prevDocs) {
        if (!documentos.includes(d)) {
          const dp = d.replace(/^\//, "");
          if (dp.startsWith(PDF_DIR + "/")) batchDelete(batch, dp);
        }
      }

      const md = toMarkdown({
        title: body.title,
        fecha_inicio: body.fecha_inicio,
        fecha_fin: body.fecha_fin || "",
        documentos,
        orden: isEdit ? prev.orden : await topOrden(),
        publicado: prev.publicado,
        body: body.body,
      });
      batchWrite(batch, mdPath, Buffer.from(md, "utf8"));
      await commitBatch(batch, `${isEdit ? "Editar" : "Crear"} comunicado: ${slug}`);
      return json(200, { ok: true, slug, documentos });
    }

    if (action === "toggle") {
      const slug = slugify(body.slug);
      const p = `${COMUNICADOS_DIR}/${slug}.md`;
      const stored = await storeRead(p);
      if (!stored) return json(404, { error: "Comunicado no encontrado" });
      const { data, body: mdBody } = parseMarkdown(stored.text);
      const isPub = !(data.publicado === false || data.publicado === "false");
      const md = toMarkdown({
        ...data,
        documentos: getDocs(data),
        publicado: isPub ? false : undefined,
        body: mdBody,
      });
      const batch = newBatch();
      batchWrite(batch, p, Buffer.from(md, "utf8"));
      await commitBatch(batch, `${isPub ? "Desactivar" : "Activar"} comunicado: ${slug}`);
      return json(200, { ok: true, publicado: !isPub });
    }

    if (action === "setOrder") {
      const order = Array.isArray(body.order) ? body.order : [];
      const batch = newBatch();
      let changed = 0;
      for (let i = 0; i < order.length; i++) {
        const slug = slugify(order[i]);
        const p = `${COMUNICADOS_DIR}/${slug}.md`;
        const stored = await storeRead(p);
        if (!stored) continue;
        const { data, body: mdBody } = parseMarkdown(stored.text);
        if (String(data.orden) === String(i)) continue;
        const md = toMarkdown({ ...data, documentos: getDocs(data), orden: i, body: mdBody });
        batchWrite(batch, p, Buffer.from(md, "utf8"));
        changed++;
      }
      await commitBatch(batch, "Reordenar comunicados");
      return json(200, { ok: true, changed });
    }

    if (action === "clearOrder") {
      const files = await storeListMd(COMUNICADOS_DIR);
      const batch = newBatch();
      let changed = 0;
      for (const f of files) {
        const stored = await storeRead(f.path);
        if (!stored) continue;
        const { data, body: mdBody } = parseMarkdown(stored.text);
        if (data.orden === undefined || data.orden === null || data.orden === "") continue;
        const md = toMarkdown({ ...data, documentos: getDocs(data), orden: undefined, body: mdBody });
        batchWrite(batch, f.path, Buffer.from(md, "utf8"));
        changed++;
      }
      await commitBatch(batch, "Quitar orden manual de los comunicados");
      return json(200, { ok: true, changed });
    }

    if (action === "delete") {
      const slug = slugify(body.slug);
      const mdPath = `${COMUNICADOS_DIR}/${slug}.md`;
      const stored = await storeRead(mdPath);
      if (!stored) return json(404, { error: "Comunicado no encontrado" });
      const { data } = parseMarkdown(stored.text);
      const batch = newBatch();
      batchDelete(batch, mdPath);
      // Borrar todos los documentos adjuntos del comunicado (mismo commit)
      for (const d of getDocs(data)) {
        const dp = d.replace(/^\//, "");
        if (dp.startsWith(PDF_DIR + "/")) batchDelete(batch, dp);
      }
      await commitBatch(batch, `Eliminar comunicado: ${slug}`);
      return json(200, { ok: true });
    }

    return json(400, { error: "Acción desconocida" });
  } catch (e) {
    return json(500, { error: e.message || String(e) });
  }
};
