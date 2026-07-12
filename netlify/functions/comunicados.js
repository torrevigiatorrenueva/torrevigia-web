// Mini-panel de comunicados de Torrevigía.
// Función serverless (Netlify) que verifica usuario/contraseña y guarda los
// comunicados en el repositorio de GitHub usando la API de contenidos.
// No expone el token ni la contraseña al navegador: viven en variables de
// entorno de Netlify (ADMIN_USER, ADMIN_PASSWORD, GITHUB_TOKEN, GITHUB_REPO,
// GITHUB_BRANCH).

const GH_API = "https://api.github.com";
const REPO = process.env.GITHUB_REPO; // "usuario/repositorio"
const BRANCH = process.env.GITHUB_BRANCH || "main";
const COMUNICADOS_DIR = "comunicados";
const PDF_DIR = "img/comunicados";
const CATEGORIES = ["Transparencia", "Urbanismo", "Participación"];

function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "torrevigia-admin",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

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

async function ghGetFile(path) {
  const res = await fetch(
    `${GH_API}/repos/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${BRANCH}`,
    { headers: ghHeaders() }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ghListDir(path) {
  const res = await fetch(
    `${GH_API}/repos/${REPO}/contents/${path}?ref=${BRANCH}`,
    { headers: ghHeaders() }
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub LIST ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ghPutFile(path, contentBase64, message, sha) {
  const payload = { message, content: contentBase64, branch: BRANCH };
  if (sha) payload.sha = sha;
  const res = await fetch(
    `${GH_API}/repos/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
    { method: "PUT", headers: ghHeaders(), body: JSON.stringify(payload) }
  );
  if (!res.ok) throw new Error(`GitHub PUT ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ghDeleteFile(path, sha, message) {
  const res = await fetch(
    `${GH_API}/repos/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
    {
      method: "DELETE",
      headers: ghHeaders(),
      body: JSON.stringify({ message, sha, branch: BRANCH }),
    }
  );
  if (!res.ok) throw new Error(`GitHub DELETE ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "JSON inválido" });
  }

  if (!checkAuth(body)) return json(401, { error: "Usuario o contraseña incorrectos" });
  if (!REPO || !process.env.GITHUB_TOKEN) {
    return json(500, { error: "Falta configuración del servidor (GITHUB_REPO / GITHUB_TOKEN)" });
  }

  const action = body.action;

  try {
    if (action === "list") {
      const items = await ghListDir(COMUNICADOS_DIR);
      const mdFiles = items.filter((i) => i.type === "file" && i.name.endsWith(".md"));
      const result = [];
      for (const f of mdFiles) {
        const file = await ghGetFile(f.path);
        const text = Buffer.from(file.content, "base64").toString("utf8");
        const { data } = parseMarkdown(text);
        result.push({
          slug: f.name.replace(/\.md$/, ""),
          title: data.title || f.name,
          date: data.date || "",
          category: data.category || "",
        });
      }
      result.sort((a, b) => (a.date < b.date ? 1 : -1));
      return json(200, { comunicados: result, categories: CATEGORIES });
    }

    if (action === "get") {
      const slug = slugify(body.slug);
      const file = await ghGetFile(`${COMUNICADOS_DIR}/${slug}.md`);
      if (!file) return json(404, { error: "Comunicado no encontrado" });
      const text = Buffer.from(file.content, "base64").toString("utf8");
      const { data, body: mdBody } = parseMarkdown(text);
      return json(200, { slug, data, body: mdBody, sha: file.sha });
    }

    if (action === "save") {
      if (!body.title || !body.date || !body.category || !body.summary) {
        return json(400, { error: "Faltan campos obligatorios (título, fecha, categoría, resumen)" });
      }
      const isEdit = !!body.slug;
      const slug = isEdit ? slugify(body.slug) : slugify(body.title);
      if (!slug) return json(400, { error: "No se pudo generar el identificador del comunicado" });

      let documento = body.documento || "";

      // PDF nuevo (base64) opcional
      if (body.pdf) {
        const pdfPath = `${PDF_DIR}/${slug}.pdf`;
        const existingPdf = await ghGetFile(pdfPath);
        await ghPutFile(
          pdfPath,
          body.pdf,
          `Subir documento de comunicado: ${slug}`,
          existingPdf ? existingPdf.sha : undefined
        );
        documento = `/${pdfPath}`;
      }

      const mdPath = `${COMUNICADOS_DIR}/${slug}.md`;
      const existing = await ghGetFile(mdPath);
      if (existing && !isEdit) {
        return json(409, { error: "Ya existe un comunicado con ese título. Cambia el título o edítalo." });
      }
      const md = toMarkdown({
        title: body.title,
        description: body.description,
        date: body.date,
        category: body.category,
        summary: body.summary,
        breadcrumb: body.breadcrumb,
        documento,
        body: body.body,
      });
      const contentBase64 = Buffer.from(md, "utf8").toString("base64");
      await ghPutFile(
        mdPath,
        contentBase64,
        `${isEdit ? "Editar" : "Crear"} comunicado: ${slug}`,
        existing ? existing.sha : undefined
      );
      return json(200, { ok: true, slug, documento });
    }

    if (action === "delete") {
      const slug = slugify(body.slug);
      const mdPath = `${COMUNICADOS_DIR}/${slug}.md`;
      const existing = await ghGetFile(mdPath);
      if (!existing) return json(404, { error: "Comunicado no encontrado" });
      await ghDeleteFile(mdPath, existing.sha, `Eliminar comunicado: ${slug}`);
      // Borrar el PDF asociado si existe
      const pdf = await ghGetFile(`${PDF_DIR}/${slug}.pdf`);
      if (pdf) await ghDeleteFile(`${PDF_DIR}/${slug}.pdf`, pdf.sha, `Eliminar documento: ${slug}`);
      return json(200, { ok: true });
    }

    return json(400, { error: "Acción desconocida" });
  } catch (e) {
    return json(500, { error: e.message || String(e) });
  }
};
