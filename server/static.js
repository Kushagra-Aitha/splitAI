import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './http.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

export async function createStaticFiles(directory) {
  // Fail at startup when the build is missing. Resolve symlinks before serving.
  const root = await realpath(directory);
  const index = await readFile(path.join(root, 'index.html'));
  const hashes = [...index.toString().matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
  const csp = `default-src 'self'; script-src 'self' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;

  return async (req, res, pathname) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use GET or HEAD for app files.');
    }
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch {
      throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
    }
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some((part) => part.startsWith('.'))) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested file was not found.');
    }
    const requested = ['/', '/bank', '/bank/'].includes(decoded) ? 'index.html' : decoded.slice(1);
    let file;
    try {
      file = await realpath(path.resolve(root, requested));
      if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) throw new Error();
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'The requested file was not found.');
    }
    const type = TYPES[path.extname(file)];
    if (!type) throw new HttpError(404, 'NOT_FOUND', 'The requested file was not found.');
    const content = file === path.join(root, 'index.html') ? index : await readFile(file);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': content.length,
      'Content-Security-Policy': csp,
      'Cache-Control': requested.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  };
}
