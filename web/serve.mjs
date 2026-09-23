/**
 * Раздатчик статики для лендинга — только для разработки.
 *
 * Запуск из корня проекта:  node web/serve.mjs
 * Открыть:                  http://localhost:5173
 *
 * Зачем он нужен. Файлы из web/ нельзя открыть двойным щелчком: модули ES
 * (`<script type="module">`) по протоколу file:// не грузятся.
 *
 * К API он не прикасается: запросы идут прямо на его порт, а разрешение
 * на это выписывает сам сервер — переменная WEB_ORIGINS, по умолчанию
 * в разработке как раз http://localhost:5173.
 *
 * В прод это не едет: там статику раздаёт nginx.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.WEB_PORT ?? 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

createServer((req, res) => {
  // Адрес разбирается в try: строка вроде `//` — это протокол-относительный
  // адрес с пустым хостом, и new URL на ней бросает. Один такой запрос
  // не должен ронять раздатчик целиком.
  let url;
  try {
    url = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Неверный адрес');
    return;
  }

  // Раздел администратора открывается по чистому адресу /admin, а не
  // по имени файла — так его попросили сделать (см. web/routes.js,
  // SCREENS.A2). Здесь это тот же приём, что и для «/» → index.html.
  const pathname = url.pathname === '/admin' || url.pathname === '/admin/'
    ? '/admin.html'
    : url.pathname === '/' ? '/index.html' : url.pathname;

  // normalize срезает ../ до join: иначе адресом можно было бы выйти из web/.
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel);

  readFile(file).then(
    (body) => {
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    },
    () => {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Не найдено');
    },
  );
}).listen(PORT, () => {
  console.log(`Лендинг: http://localhost:${PORT}`);
});
