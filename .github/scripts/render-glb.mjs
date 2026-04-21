// Рендер GLB модели через puppeteer + headless chromium в GitHub Actions.
// Читает assembly_figures из Supabase (service role), рендерит 6 ракурсов
// на каждую фигуру, сохраняет PNG в 3d_renders/{model_code}/{figure_id}/,
// опционально шлёт в analyze-figure-renders для записи в figure_vision_trials.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Buffer } from "node:buffer";
import { createClient } from "@supabase/supabase-js";
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
  SUPABASE_SERVICE_ROLE_KEY,
  MODEL_CODE,
  RUN_LABEL,
  DO_ANALYZE,
  REPO_ROOT,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY secrets");
  process.exit(1);
}
if (!MODEL_CODE) {
  console.error("Missing MODEL_CODE input");
  process.exit(1);
}

const repoRoot = REPO_ROOT ? resolve(REPO_ROOT) : resolve(__dirname, "..", "..");
const renderRootOut = join(repoRoot, "3d_renders", MODEL_CODE);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function loadFigures() {
  const { data: model, error: mErr } = await supabase
    .from("assembly_models")
    .select("code, offer_id, name, universe, race")
    .eq("code", MODEL_CODE)
    .maybeSingle();
  if (mErr) throw new Error(`assembly_models: ${mErr.message}`);
  if (!model) throw new Error(`model ${MODEL_CODE} not found`);

  const { data: figs, error: fErr } = await supabase
    .from("assembly_figures")
    .select("figure_id, name, glb_url, sort_order")
    .eq("model_code", MODEL_CODE)
    .order("sort_order");
  if (fErr) throw new Error(`assembly_figures: ${fErr.message}`);
  if (!figs?.length) throw new Error(`no figures for ${MODEL_CODE}`);

  return { model, figures: figs };
}

async function postAnalyze({ figure, renders, modelName }) {
  // scan-figure-renders: копия analyze-miniature-images с ТЕМ ЖЕ UNIFIED_PROMPT,
  // но пишет в figure_vision_trials (sandbox) и считает embedding.
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
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    throw new Error(`analyze ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
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
      // WebGL в headless chromium на Linux: SwiftShader даёт stable software rendering
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
      let renders;
      try {
        renders = await page.evaluate(
          (url, angles, size) => window.renderGLB(url, angles, size),
          fig.glb_url,
          ANGLES,
          1024,
        );
      } catch (e) {
        console.error(`  render failed: ${e.message ?? e}`);
        summary.push({ figure: fig.figure_id, state: "render_error", error: String(e.message ?? e) });
        continue;
      }
      console.log(`  rendered ${renders.length} angles in ${Date.now() - t0} ms`);

      // Сохраняем PNG в файлы для коммита
      const figureDir = join(renderRootOut, fig.figure_id);
      await mkdir(figureDir, { recursive: true });
      for (const r of renders) {
        const buf = Buffer.from(r.base64, "base64");
        await writeFile(join(figureDir, `angle-${r.angle}.png`), buf);
      }
      console.log(`  saved to ${figureDir}`);

      if (shouldAnalyze) {
        try {
          const res = await postAnalyze({ figure: fig, renders, modelName: model.name });
          const s = res.result_summary ?? {};
          console.log(`  analyzed: system=${s.system} faction=${s.faction} race=${s.race} class=${s.class} trial=${res.trial_id} embed=${res.embedding_dims}`);
          summary.push({
            figure: fig.figure_id,
            state: "ok",
            trial_id: res.trial_id,
            system: s.system,
            faction: s.faction,
            race: s.race,
            class: s.class,
            weapons: s.weapons,
            embed_dims: res.embedding_dims,
          });
        } catch (e) {
          console.error(`  analyze failed: ${e.message ?? e}`);
          summary.push({ figure: fig.figure_id, state: "analyze_error", error: String(e.message ?? e) });
        }
      } else {
        summary.push({ figure: fig.figure_id, state: "rendered_only" });
      }
    }
  } finally {
    await browser.close();
  }

  // Сводка в GH step summary
  const gh = process.env.GITHUB_STEP_SUMMARY;
  if (gh) {
    const { appendFile } = await import("node:fs/promises");
    const lines = [
      "",
      "### Per-figure results",
      "| figure_id | state | system | faction | race | class | embed | trial_id |",
      "| --- | --- | --- | --- | --- | --- | ---: | ---: |",
      ...summary.map((s) =>
        `| ${s.figure} | ${s.state} | ${s.system ?? "-"} | ${s.faction ?? "-"} | ${s.race ?? "-"} | ${s.class ?? "-"} | ${s.embed_dims ?? "-"} | ${s.trial_id ?? "-"} |`,
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
