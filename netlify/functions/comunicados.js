// Mini-panel de comunicados de Torrevigía.
// Función serverless (Netlify) que verifica usuario/contraseña y guarda los
// comunicados. En producción escribe en el repositorio de GitHub (API de
// contenidos). En local, bajo `netlify dev`, escribe directamente en los
// archivos del proyecto para poder probar sin token ni GitHub.
//
// Variables de entorno (producción): ADMIN_USER, ADMIN_PASSWORD,
// GITHUB_TOKEN, GITHUB_REPO ("usuario/repo"), GITHUB_BRANCH.
// En local basta ADMIN_USER y ADMIN_PASSWORD (p. ej. en un archivo .env).

const fs = require("fs");
const path = require("path");

const GH_API = "https://api.github.com";
const REPO = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || "main";
const COMUNICADOS_DIR = "comunicados";
const PDF_DIR = "img/comunicados";
const CATEGORIES = ["Transparencia", "Urbanismo", "Participación"];

// Modo local: activo cuando corremos bajo `netlify dev`.
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
function toMarkdown(f) {
  const lines = ["---"];
  lines.push(`title: ${esc(f.title)}`);
  if (f.description) lines.push(`description: ${esc(f.description)}`);
  lines.push(`date: ${f.date}`);
  lines.push(`category: ${esc(f.category)}`);
  lines.push(`summary: ${esc(f.summary)}`);
  lines.push(`breadcrumb: ${esc(f.breadcrumb || f.title)}`);
  if (f.documento) lines.push(`documento: ${esc(f.documento)}`);
  if (f.orden !== undefined && f.orden !== null && f.orden !== "" && !isNaN(Number(f.orden))) {
    lines.push(`orden: ${parseInt(f.orden, 10)}`);
  }
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
    for (const line of m[1].split("\n")) {
      const mm = line.match(/^(\w+):\s*(.*)$/);
      if (!mm) continue;
      let v = mm[2].trim();
      if (v.startsWith('"') && v.endsWith('"')) {
        v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      data[mm[1]] = v;
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

/* ---------- Capa de almacenamiento (local o GitHub) ---------- */
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
  const payload = { message, content: buffer.toString("base64"), branch: BRANCH };
  if (sha && sha !== "local") payload.sha = sha;
  const res = await fetch(ghUrl(p), {
    method: "PUT",
    headers: ghHeaders(),
    body: JSON.stringify(payload),
  });
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

// Devuelve un valor de "orden" para colocar un comunicado nuevo arriba del
// todo, si ya hay otros ordenados manualmente; si no, undefined (usa la fecha).
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
          date: data.date || "",
          category: data.category || "",
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
        return a.date < b.date ? 1 : -1;
      });
      return json(200, { comunicados: result, categories: CATEGORIES, mode: USE_LOCAL ? "local" : "github" });
    }

    if (action === "get") {
      const slug = slugify(body.slug);
      const stored = await storeRead(`${COMUNICADOS_DIR}/${slug}.md`);
      if (!stored) return json(404, { error: "Comunicado no encontrado" });
      const { data, body: mdBody } = parseMarkdown(stored.text);
      return json(200, { slug, data, body: mdBody, sha: stored.sha });
    }

    if (action === "save") {
      if (!body.title || !body.date || !body.category || !body.summary) {
        return json(400, { error: "Faltan campos obligatorios (título, fecha, categoría, resumen)" });
      }
      const isEdit = !!body.slug;
      const slug = isEdit ? slugify(body.slug) : slugify(body.title);
      if (!slug) return json(400, { error: "No se pudo generar el identificador del comunicado" });

      let documento = body.documento || "";
      if (body.pdf) {
        const pdfPath = `${PDF_DIR}/${slug}.pdf`;
        const pdfSha = await storeExists(pdfPath);
        await storeWrite(pdfPath, Buffer.from(body.pdf, "base64"), `Subir documento: ${slug}`, pdfSha);
        documento = `/${pdfPath}`;
      }

      const mdPath = `${COMUNICADOS_DIR}/${slug}.md`;
      const existing = await storeRead(mdPath);
      if (existing && !isEdit) {
        return json(409, { error: "Ya existe un comunicado con ese título. Cambia el título o edítalo." });
      }

      // Orden: al editar se conserva el existente; al crear se coloca arriba
      // si ya hay comunicados ordenados manualmente.
      let orden;
      if (existing) orden = parseMarkdown(existing.text).data.orden;
      else orden = await topOrden();

      const md = toMarkdown({
        title: body.title,
        description: body.description,
        date: body.date,
        category: body.category,
        summary: body.summary,
        breadcrumb: body.breadcrumb,
        documento,
        orden,
        body: body.body,
      });
      await storeWrite(mdPath, Buffer.from(md, "utf8"), `${isEdit ? "Editar" : "Crear"} comunicado: ${slug}`, existing ? existing.sha : null);
      return json(200, { ok: true, slug, documento });
    }

    if (action === "delete") {
      const slug = slugify(body.slug);
      const mdPath = `${COMUNICADOS_DIR}/${slug}.md`;
      if (!(await storeExists(mdPath))) return json(404, { error: "Comunicado no encontrado" });
      await storeRemove(mdPath, `Eliminar comunicado: ${slug}`);
      await storeRemove(`${PDF_DIR}/${slug}.pdf`, `Eliminar documento: ${slug}`);
      return json(200, { ok: true });
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
        const md = toMarkdown({ ...data, orden: i, body: mdBody });
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
        const md = toMarkdown({ ...data, orden: undefined, body: mdBody });
        await storeWrite(f.path, Buffer.from(md, "utf8"), `Quitar orden manual: ${f.name}`, stored.sha);
        changed++;
      }
      return json(200, { ok: true, changed });
    }

    return json(400, { error: "Acción desconocida" });
  } catch (e) {
    return json(500, { error: e.message || String(e) });
  }
};
