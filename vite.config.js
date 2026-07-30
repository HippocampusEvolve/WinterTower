import { defineConfig } from 'vite';

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
}));
