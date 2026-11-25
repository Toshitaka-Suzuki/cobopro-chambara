import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({
  root,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    write: false,
    lib: { entry: 'tools/standalone-guide.tsx', name: 'ChambaraGuide', formats: ['iife'] },
  },
});
const files = [result].flat().flatMap(bundle => bundle.output);
const script = files.find(file => file.type === 'chunk').code;
const stylesheet = files.find(file => file.fileName.endsWith('.css')).source;
const license = await readFile(new URL('../node_modules/react/LICENSE', import.meta.url), 'utf8');

// Inline the two build outputs so file:// works on an offline exhibition PC.
const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>チャンバラの遊び方</title>
  <style>${stylesheet}</style>
</head>
<body>
  <div id="root"></div>
  <!-- React, React DOM, Scheduler
${license}-->
  <script>${script.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>
`;
await writeFile(new URL('../docs/game-guide.html', import.meta.url), html);
