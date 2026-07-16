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
const REPO = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || "main";
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
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "torrevigia-admin",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
function ghUrl(p) {
  return `${GH_API}/repos/${REPO}/contents/${encodeURIComponent(p).replace(/%2F/g, "/")}`;
}
async function ghGetFile(p) {
  const res = await fetch(`${ghUrl(p)}?ref=${BRANCH}`, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${p}: ${res.status} ${await res.text()}`);
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
  if (!res.ok) throw new Error(`GitHub ${method} ${apiPath}: ${res.status} ${await res.text()}`);
  return res.json();
}
// Escribe un archivo mediante blob + tree + commit (soporta archivos grandes).
async function ghWriteLarge(p, buffer, message) {
  const ref = await ghApi("GET", `/git/ref/heads/${BRANCH}`);
  const baseSha = ref.object.sha;
  const baseCommit = await ghApi("GET", `/git/commits/${baseSha}`);
  const blob = await ghApi("POST", "/git/blobs", {
    content: buffer.toString("base64"),
    encoding: "base64",
  });
  const tree = await ghApi("POST", "/git/trees", {
    base_tree: baseCommit.tree.sha,
    tree: [{ path: p, mode: "100644", type: "blob", sha: blob.sha }],
  });
  const commit = await ghApi("POST", "/git/commits", {
    message,
    tree: tree.sha,
    parents: [baseSha],
  });
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
  if (!res.ok) throw new Error(`GitHub LIST ${dir}: ${res.status} ${await res.text()}`);
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
async function storeExists(p) {
  if (USE_LOCAL) return fs.existsSync(path.join(ROOT, p)) ? "local" : null;
  const f = await ghGetFile(p);
  return f ? f.sha : null;
}
async function storeWrite(p, buffer, message, sha) {
  if (USE_LOCAL) {
    const abs = path.join(ROOT, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buffer);
    return;
  }
  // Archivos > ~0.9 MB: la Contents API no los admite → Git Data API.
  if (buffer.length > 900 * 1024) {
    await ghWriteLarge(p, buffer, message);
    return;
  }
  const payload = { message, content: buffer.toString("base64"), branch: BRANCH };
  if (sha && sha !== "local") payload.sha = sha;
  const res = await fetch(ghUrl(p), { method: "PUT", headers: ghHeaders(), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`GitHub PUT ${p}: ${res.status} ${await res.text()}`);
}
async function storeRemove(p, message) {
  if (USE_LOCAL) {
    const abs = path.join(ROOT, p);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
    return;
  }
  const f = await ghGetFile(p);
  if (!f) return;
  const res = await fetch(ghUrl(p), {
    method: "DELETE",
    headers: ghHeaders(),
    body: JSON.stringify({ message, sha: f.sha, branch: BRANCH }),
  });
  if (!res.ok) throw new Error(`GitHub DELETE ${p}: ${res.status} ${await res.text()}`);
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
  if (!USE_LOCAL && (!REPO || !process.env.GITHUB_TOKEN)) {
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
      const nuevasPaths = [];
      for (const f of nuevos) {
        if (!f || !f.data || !f.name) continue;
        const name = sanitizeName(f.name);
        const p = `${PDF_DIR}/${slug}/${name}`;
        const sha = await storeExists(p);
        await storeWrite(p, Buffer.from(f.data, "base64"), `Subir documento: ${name}`, sha);
        nuevasPaths.push(`/${p}`);
      }
      const documentos = [...kept, ...nuevasPaths];
      // Borrar del almacenamiento los documentos que se han quitado
      for (const d of prevDocs) {
        if (!documentos.includes(d)) {
          const dp = d.replace(/^\//, "");
          if (dp.startsWith(PDF_DIR + "/")) await storeRemove(dp, `Eliminar documento: ${d}`);
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
      await storeWrite(mdPath, Buffer.from(md, "utf8"), `${isEdit ? "Editar" : "Crear"} comunicado: ${slug}`, existing ? existing.sha : null);
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
      await storeWrite(p, Buffer.from(md, "utf8"), `${isPub ? "Desactivar" : "Activar"} comunicado: ${slug}`, stored.sha);
      return json(200, { ok: true, publicado: !isPub });
    }

    if (action === "setOrder") {
      const order = Array.isArray(body.order) ? body.order : [];
      let changed = 0;
      for (let i = 0; i < order.length; i++) {
        const slug = slugify(order[i]);
        const p = `${COMUNICADOS_DIR}/${slug}.md`;
        const stored = await storeRead(p);
        if (!stored) continue;
        const { data, body: mdBody } = parseMarkdown(stored.text);
        if (String(data.orden) === String(i)) continue;
        const md = toMarkdown({ ...data, documentos: getDocs(data), orden: i, body: mdBody });
        await storeWrite(p, Buffer.from(md, "utf8"), `Reordenar comunicado: ${slug}`, stored.sha);
        changed++;
      }
      return json(200, { ok: true, changed });
    }

    if (action === "clearOrder") {
      const files = await storeListMd(COMUNICADOS_DIR);
      let changed = 0;
      for (const f of files) {
        const stored = await storeRead(f.path);
        if (!stored) continue;
        const { data, body: mdBody } = parseMarkdown(stored.text);
        if (data.orden === undefined || data.orden === null || data.orden === "") continue;
        const md = toMarkdown({ ...data, documentos: getDocs(data), orden: undefined, body: mdBody });
        await storeWrite(f.path, Buffer.from(md, "utf8"), `Quitar orden manual: ${f.name}`, stored.sha);
        changed++;
      }
      return json(200, { ok: true, changed });
    }

    if (action === "delete") {
      const slug = slugify(body.slug);
      const mdPath = `${COMUNICADOS_DIR}/${slug}.md`;
      const stored = await storeRead(mdPath);
      if (!stored) return json(404, { error: "Comunicado no encontrado" });
      const { data } = parseMarkdown(stored.text);
      await storeRemove(mdPath, `Eliminar comunicado: ${slug}`);
      // Borrar todos los documentos adjuntos del comunicado
      for (const d of getDocs(data)) {
        const dp = d.replace(/^\//, "");
        if (dp.startsWith(PDF_DIR + "/")) await storeRemove(dp, `Eliminar documento: ${d}`);
      }
      return json(200, { ok: true });
    }

    return json(400, { error: "Acción desconocida" });
  } catch (e) {
    return json(500, { error: e.message || String(e) });
  }
};
