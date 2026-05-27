// MailGuard build script — esbuild + 単一 HTML 出力
import * as esbuild from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');
const prod = !watch && !serve;

// Build identity
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
let gitSha = 'nogit';
try {
  gitSha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim();
} catch { /* not a git repo */ }
const buildTime = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const buildId = `${pkg.version}-${gitSha} (${buildTime})`;
console.log(`[build] id: ${buildId}`);

const buildOptions = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'MailGuard',
  outfile: 'dist/mailguard.js',
  target: 'es2020',
  platform: 'browser',
  minify: prod,
  sourcemap: !prod,
  loader: { '.css': 'text' },
  define: {
    'process.env.NODE_ENV': prod ? '"production"' : '"development"',
    __MG_BUILD_ID__: JSON.stringify(buildId),
  },
  // Node-only modules stub (msgreader pulls iconv-lite chain)
  alias: {
    'iconv-lite':     path.resolve('src/lib/_browser-shims.ts'),
    'safer-buffer':   path.resolve('src/lib/_browser-shims.ts'),
    'buffer':         path.resolve('src/lib/_browser-shims.ts'),
    'string_decoder': path.resolve('src/lib/_browser-shims.ts'),
  },
  logLevel: 'info',
};

async function run() {
  if (watch || serve) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[esbuild] watching...');
    if (serve) {
      const port = 5180;
      http.createServer((req, res) => {
        const url = req.url === '/' ? '/dev/index.html' : req.url.split('?')[0];
        const filePath = path.join(process.cwd(), url);
        if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': contentType(filePath) });
        fs.createReadStream(filePath).pipe(res);
      }).listen(port, () => console.log(`[dev] http://localhost:${port}/`));
    }
  } else {
    await esbuild.build(buildOptions);
    console.log('[esbuild] build complete');
    const js = fs.readFileSync('dist/mailguard.js', 'utf8');
    const html = renderHtml(js, buildId);
    fs.writeFileSync('dist/mailguard.html', html);
    const sizeKb = (s) => (fs.statSync(s).size / 1024).toFixed(1);
    console.log(`[html] dist/mailguard.html: ${sizeKb('dist/mailguard.html')} KB`);

    // ── 配布物 を dist/ に集約 ───────────────────────────────────────
    //   利用者は dist/ をそのまま zip して配布 → 解凍 → MailGuard.bat
    //   ダブルクリックで使える。
    //   ファイル構成 (フラット):
    //     dist/
    //       MailGuard.bat            ← 起動用 (= source からコピー)
    //       mailguard.html           ← UI (= esbuild が生成)
    //       mailguard-relay.ps1      ← PowerShell relay (= relay/ からコピー)
    //       .env.example             ← 設定例 (= source からコピー)
    //       SETUP.md                 ← 利用者向け手順 (= source からコピー)
    const distAssets = [
      { from: 'MailGuard.bat',           to: 'dist/MailGuard.bat' },
      { from: 'relay/mailguard-relay.ps1', to: 'dist/mailguard-relay.ps1' },
      { from: '.env.example',            to: 'dist/.env.example' },
      { from: 'SETUP.md',                to: 'dist/SETUP.md' },
    ];
    for (const a of distAssets) {
      if (fs.existsSync(a.from)) {
        fs.copyFileSync(a.from, a.to);
        console.log(`[copy] ${a.from} → ${a.to} (${sizeKb(a.to)} KB)`);
      } else {
        console.warn(`[copy] WARN: ${a.from} が見つかりません`);
      }
    }
    // 中間ファイル (= esbuild の生 .js / .map) を dist から削除
    //  mailguard.html に inline 済みなので、配布には不要。
    for (const intermediate of ['dist/mailguard.js', 'dist/mailguard.js.map']) {
      if (fs.existsSync(intermediate)) {
        fs.unlinkSync(intermediate);
        console.log(`[clean] removed ${intermediate}`);
      }
    }

    console.log('');
    console.log('  ✓ dist/ に配布物を集約しました (= 配布に必要な全ファイル)。');
    console.log('  ▶ 配布手順: dist/ フォルダを zip して共有');
    console.log('  ▶ 利用者: 展開 → MailGuard.bat ダブルクリック (npm 不要)');
    console.log('');

    // dev/index.html (for npm run dev)
    fs.mkdirSync('dev', { recursive: true });
    fs.writeFileSync('dev/index.html', `<!doctype html><html><head><meta charset="utf-8"><title>MailGuard dev</title></head><body><script src="/dist/mailguard.js"></script></body></html>`);
  }
}

function contentType(p) {
  const ext = path.extname(p);
  return { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8' }[ext] || 'text/plain; charset=utf-8';
}

function renderHtml(js, buildId) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MailGuard — メール誤送信検出</title>
<style>
  html, body { margin: 0; padding: 0; background: #fafaf7; font-family: "Meiryo","メイリオ","Hiragino Sans","Yu Gothic UI",-apple-system,"Segoe UI",system-ui,sans-serif; color: #2a2a26; }
  * { box-sizing: border-box; }
</style>
</head>
<body>
<div id="mailguard-root"></div>
<noscript>JavaScript を有効にしてください。</noscript>
<script>
${js}
</script>
<!-- build: ${buildId} -->
</body>
</html>`;
}

run().catch(e => { console.error(e); process.exit(1); });
