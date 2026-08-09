import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { defineConfig } from 'vite';

// ---------------------------------------------------------------------------
// Штампы версий для файлов из public/
//
// У бандла Vite имя меняется вместе с содержимым, у карты камня — нет: модели
// и текстуры уезжают в сборку под своими именами. А nginx отдаёт их с
// `Cache-Control: immutable` на год, и immutable означает не «храни подольше»,
// а «даже не переспрашивай». Правка такого файла до вернувшегося игрока не
// доезжает вовсе — адрес-то прежний.
//
// Плагин считает хэш каждого файла в public/ и отдаёт таблицу бандлу, а
// src/asset.ts приклеивает штамп к адресу. Ключ браузерного кэша меняется
// вместе с файлом, и обновляется ровно то, что изменилось.
//
// В dev таблица пустая: там свои правила кэша, а хэш всё равно устаревал бы до
// перезапуска сервера.
// ---------------------------------------------------------------------------
const VIRTUAL = 'virtual:asset-stamps';

function stampsOf(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path).split(sep).join('/')] =
        createHash('sha1').update(readFileSync(path)).digest('hex').slice(0, 8);
    }
  };
  walk(dir);
  return out;
}

export function assetStamps(dir = 'public') {
  let stamps = {};
  let live = false;
  return {
    name: 'asset-stamps',
    configResolved(config) {
      live = config.command === 'build';
    },
    buildStart() {
      stamps = live ? stampsOf(dir) : {};
      if (live) console.log(`[stamps] ${Object.keys(stamps).length} файлов из ${dir}/`);
    },
    resolveId(id) {
      return id === VIRTUAL ? `\0${VIRTUAL}` : null;
    },
    load(id) {
      return id === `\0${VIRTUAL}` ? `export default ${JSON.stringify(stamps)}` : null;
    },
  };
}

// base: прод-сборка живёт на https://find-the-end.fun/wintertower/, dev - на
// корне, чтобы localhost открывался без хвоста в адресе.
//
// Этот же путь прописан в сниппете nginx (ops/hardening/16-wintertower.sh
// в репозитории find-the-end.fun) и в ссылке на карточке витрины: разойдутся -
// игра отдаст белый экран.
//
// Текстуры грузятся относительным путём (`textures/<имя>/` в world/materials.ts),
// то есть считаются от адреса страницы и переезжают вместе с ней сами.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/wintertower/' : '/',
  build: {
    rollupOptions: {
      output: {
        // Движок отдельным файлом от кода мира. Раньше они лежали вместе, и
        // правка одной строки в игре меняла имя всего бандла: вернувшийся
        // игрок перекачивал девятьсот килобайт three и postprocessing,
        // которые не менялись месяцами.
        //
        // Функцией, а не таблицей: сборка идёт на rolldown, там таблица не
        // принимается вовсе (`manualChunks is not a function`).
        manualChunks(id) {
          const p = id.replace(/\\/g, '/');
          return p.includes('/node_modules/three/') ||
            p.includes('/node_modules/postprocessing/')
            ? 'three'
            : undefined;
        },
      },
    },
  },
  plugins: [assetStamps()],
}));
