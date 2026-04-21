// Рендер GLB модели через puppeteer + headless chromium в GitHub Actions.
// Читает список фигур через публичный endpoint get-model-figures,
// рендерит 6 ракурсов на каждую фигуру, сохраняет PNG в
// 3d_renders/{model_code}/{figure_id}/, опционально шлёт в scan-figure-renders.
//
// scan-figure-renders использует тот же UNIFIED_PROMPT что analyze-miniature-images
// v75 и пишет в sandbox-таблицу figure_vision_trials с embedding 3072d.
// Прод-таблицы (assembly_figures, product_catalog_data, product_embeddings)
// не трогаются.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Buffer as NodeBuffer } from "node:buffer";

// Fetch GLB binary, parse header + JSON chunk в Node (без браузерного CORS).
// Возвращает parsed gltf.json или null при ошибке.
async function fetchGlbJsonNode(url) {
  try {
    const resp = await fetch(url);
    console.log(`  glb fetch: status=${resp.status} ok=${resp.ok} len=${resp.headers.get("content-length")}`);
    if (!resp.ok) return null;
    const buf = NodeBuffer.from(await resp.arrayBuffer());
    const magic = buf.slice(0, 4).toString("ascii");
    console.log(`  glb bytes=${buf.length} magic='${magic}' hex4=${buf.slice(0, 4).toString("hex")}`);
    if (magic !== "glTF") return null;
    const version = buf.readUInt32LE(4);
    const totalLen = buf.readUInt32LE(8);
    const chunkLen = buf.readUInt32LE(12);
    const chunkType = buf.slice(16, 20).toString("ascii");
    console.log(`  glb version=${version} total=${totalLen} chunk0: type='${chunkType}' len=${chunkLen}`);
    const jsonStr = buf.slice(20, 20 + chunkLen).toString("utf8");
    const parsed = JSON.parse(jsonStr);
    console.log(`  glb json: nodes=${parsed.nodes?.length} meshes=${parsed.meshes?.length}`);
    return parsed;
  } catch (e) {
    console.warn(`  fetchGlbJsonNode: ${e.message}`);
    return null;
  }
}

// Regex matches:
//   - exact 'base', 'Base'
//   - '60_base', '232_base.001', 'figure_base'
//   - 'base_60', 'base.001', 'base mesh'
// Does NOT match: 'baseball', 'databases'
// Причина: \b (word boundary) в JS не работает рядом с '_' т.к. оба \w.
const BASE_NAME_PATTERNS = [
  /(^|[_\-\.\s])base([_\-\.\s]|$)/i,
  /подставк/i,
  /основани/i,
];

function findBaseFromGltfJson(gltfJson) {
  if (!gltfJson) return null;
  const nodes = gltfJson.nodes ?? [];
  const meshes = gltfJson.meshes ?? [];
  const accessors = gltfJson.accessors ?? [];
  const candidates = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const name = node.name ?? "";
    if (!BASE_NAME_PATTERNS.some((p) => p.test(name))) continue;
    const meshIdx = node.mesh;
    if (meshIdx === undefined) continue;
    const prim = meshes[meshIdx]?.primitives?.[0];
    const accIdx = prim?.attributes?.POSITION;
    if (accIdx === undefined) continue;
    const acc = accessors[accIdx];
    if (!acc?.min || !acc?.max) continue;
    const sx = Math.abs(node.scale?.[0] ?? 1);
    const sy = Math.abs(node.scale?.[1] ?? 1);
    const sz = Math.abs(node.scale?.[2] ?? 1);
    candidates.push({
      name,
      node_idx: i,
      mesh_idx: meshIdx,
      range_x: (acc.max[0] - acc.min[0]) * sx,
      range_y: (acc.max[1] - acc.min[1]) * sy,
      range_z: (acc.max[2] - acc.min[2]) * sz,
      t_y: node.translation?.[1] ?? 0,
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.t_y - b.t_y);
  return {
    winner: candidates[0],
    all_candidates: candidates,
  };
}
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Buffer } from "node:buffer";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ANGLES = [
  { name: "front",   position: [0,   1,  3.6] },
  { name: "back",    position: [0,   1, -3.6] },
  { name: "34r",     position: [2.8, 1.2, 2.8] },
  { name: "34l",     position: [-2.8, 1.2, 2.8] },
  { name: "top",     position: [0,  4, 1.2] },
  { name: "closeup", position: [0.6, 1.0, 2.1] },
];

const {
  SUPABASE_URL,
  MODEL_CODE,
  RUN_LABEL,
  DO_ANALYZE,
  REPO_ROOT,
} = process.env;

if (!SUPABASE_URL) {
  console.error("Missing SUPABASE_URL secret");
  process.exit(1);
}
if (!MODEL_CODE) {
  console.error("Missing MODEL_CODE input");
  process.exit(1);
}

const repoRoot = REPO_ROOT ? resolve(REPO_ROOT) : resolve(__dirname, "..", "..");
const renderRootOut = join(repoRoot, "3d_renders", MODEL_CODE);

async function loadFigures() {
  const url = `${SUPABASE_URL}/functions/v1/get-model-figures`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model_code: MODEL_CODE }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    throw new Error(`get-model-figures ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  if (!data.figures?.length) throw new Error(`no figures for model ${MODEL_CODE}`);
  return { model: data.model, figures: data.figures };
}

async function postAnalyze({ figure, renders, measurements, modelName }) {
  // scan-figure-renders: копия analyze-miniature-images с тем же UNIFIED_PROMPT,
  // пишет в figure_vision_trials (sandbox) и считает embedding 3072d.
  const url = `${SUPABASE_URL}/functions/v1/scan-figure-renders`;
  const body = {
    model_code: MODEL_CODE,
    figure_id: figure.figure_id,
    run_label: RUN_LABEL,
    source: "glb_render",
    name_hint: figure.name,
    model_name: modelName,
    angles: renders.map((r) => r.angle),
    images_base64: renders.map((r) => r.base64),
    measurements, // { height_mm, height_with_base_mm, base_mm, base_standard_mm, raw_bbox, glb_unit_used }
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    throw new Error(`scan-figure-renders ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function main() {
  const { model, figures } = await loadFigures();
  console.log(`Model ${model.code} "${model.name}" — ${figures.length} figures`);

  const templatePath = join(__dirname, "render-template.html");
  const templateHtml = await readFile(templatePath, "utf8");

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--use-gl=swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
    ],
  });

  const shouldAnalyze = String(DO_ANALYZE ?? "true").toLowerCase() === "true";
  const summary = [];

  try {
    const page = await browser.newPage();
    page.on("console", (msg) => {
      const t = msg.type();
      if (t === "error" || t === "warning") console.log(`[browser ${t}]`, msg.text());
    });
    page.on("pageerror", (err) => console.log("[pageerror]", err.message));

    await page.setContent(templateHtml, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__READY__ === true, { timeout: 15000 });

    for (const fig of figures) {
      console.log(`\n== ${fig.figure_id} ${fig.name}`);
      const t0 = Date.now();
      // Парсим GLB metadata в node (минуя браузерный CORS).
      const gltfJson = await fetchGlbJsonNode(fig.glb_url);
      const preparsedBase = findBaseFromGltfJson(gltfJson);
      if (preparsedBase) {
        const w = preparsedBase.winner;
        const unitToMm = fig.glb_unit === "cm" ? 10 : fig.glb_unit === "mm" ? 1 : 1000;
        console.log(
          `  preparsed base: name='${w.name}' size ${(w.range_x * unitToMm).toFixed(1)}×${(w.range_y * unitToMm).toFixed(1)}×${(w.range_z * unitToMm).toFixed(1)}mm  all=${JSON.stringify(preparsedBase.all_candidates.map((c) => c.name))}`,
        );
      } else {
        console.log(`  preparsed base: NOT FOUND in GLB metadata`);
      }

      let renderResult;
      try {
        renderResult = await page.evaluate(
          (url, angles, size, glbUnit, assembledAt, preparsed) =>
            window.renderGLB(url, angles, size, glbUnit, assembledAt, preparsed),
          fig.glb_url,
          ANGLES,
          1024,
          fig.glb_unit ?? "m",
          fig.assembled_at ?? "end",
          preparsedBase,
        );
      } catch (e) {
        console.error(`  render failed: ${e.message ?? e}`);
        summary.push({ figure: fig.figure_id, state: "render_error", error: String(e.message ?? e) });
        continue;
      }
      const renders = renderResult.images;
      const measurements = renderResult.measurements;
      console.log(`  rendered ${renders.length} angles in ${Date.now() - t0} ms`);
      console.log(
        `  measured: total=${measurements.height_with_base_mm}mm body=${measurements.height_mm}mm base=${measurements.base_mm}mm std=${measurements.base_standard_mm ?? "-"}mm unit=${measurements.glb_unit_used}`,
      );

      const figureDir = join(renderRootOut, fig.figure_id);
      await mkdir(figureDir, { recursive: true });
      for (const r of renders) {
        const buf = Buffer.from(r.base64, "base64");
        await writeFile(join(figureDir, `angle-${r.angle}.png`), buf);
      }
      console.log(`  saved to ${figureDir}`);

      if (shouldAnalyze) {
        try {
          const res = await postAnalyze({ figure: fig, renders, measurements, modelName: model.name });
          const s = res.result_summary ?? {};
          console.log(
            `  analyzed: system=${s.system} race=${s.race} class=${s.class} trial=${res.trial_id} embed=${res.embedding_dims}`,
          );
          summary.push({
            figure: fig.figure_id,
            state: "ok",
            trial_id: res.trial_id,
            system: s.system,
            race: s.race,
            class: s.class,
            base_mm: measurements.base_mm,
            base_std: measurements.base_standard_mm,
            height_with_base_mm: measurements.height_with_base_mm,
            embed_dims: res.embedding_dims,
          });
        } catch (e) {
          console.error(`  analyze failed: ${e.message ?? e}`);
          summary.push({ figure: fig.figure_id, state: "analyze_error", error: String(e.message ?? e) });
        }
      } else {
        summary.push({
          figure: fig.figure_id,
          state: "rendered_only",
          base_mm: measurements.base_mm,
          base_std: measurements.base_standard_mm,
          height_with_base_mm: measurements.height_with_base_mm,
        });
      }
    }
  } finally {
    await browser.close();
  }

  const gh = process.env.GITHUB_STEP_SUMMARY;
  if (gh) {
    const { appendFile } = await import("node:fs/promises");
    const lines = [
      "",
      "### Per-figure results",
      "| figure_id | state | race | class | base mm | base std | total mm | trial_id |",
      "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
      ...summary.map((s) =>
        `| ${s.figure} | ${s.state} | ${s.race ?? "-"} | ${s.class ?? "-"} | ${s.base_mm ?? "-"} | ${s.base_std ?? "-"} | ${s.height_with_base_mm ?? "-"} | ${s.trial_id ?? "-"} |`,
      ),
      "",
    ];
    await appendFile(gh, lines.join("\n"));
  }

  console.log("\n=== summary ===");
  console.log(JSON.stringify(summary, null, 2));

  const failed = summary.filter((s) => s.state !== "ok" && s.state !== "rendered_only");
  if (failed.length) {
    console.error(`${failed.length} of ${summary.length} failed`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
