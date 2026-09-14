/**
 * Serves `api/*` from the Vite dev server, so `npm run dev` alone runs the whole
 * app — frontend and API — with no Vercel in the loop.
 *
 * The handlers were written against Vercel's file-based routing, but the
 * signature they actually use is plain Node: `(req, res)`, a body read off the
 * request stream (see api/_http.js), and `req.query` for the `[id]` segment.
 * Vite's dev server is connect middleware, which is the same `(req, res)`, so
 * the only things missing are the two conventions Vercel supplied: mapping a URL
 * to a file, and filling in `req.query`. That's all this plugin does.
 *
 * Amplify serves the built SPA only — it has no equivalent of these functions,
 * so a deployed build still needs them rehosted (Lambda + API Gateway or an
 * Amplify Function). This covers local development, not that gap.
 */
/* global process */
import fs from 'node:fs';
import path from 'node:path';

const API_DIR = 'api';
const ROUTE_PREFIX = '/api/';

/** `[id]` in a path segment — Vercel's dynamic-segment spelling. */
const DYNAMIC_SEGMENT = /^\[(.+)\]$/;

/**
 * Files under api/ that aren't routes: `_`-prefixed shared helpers
 * (_auth, _db, _http, _s3, …) and colocated tests.
 */
function isRouteFile(relativePath) {
  const basename = path.basename(relativePath);
  if (!basename.endsWith('.js')) return false;
  if (basename.startsWith('_')) return false;
  if (basename.endsWith('.test.js')) return false;
  return true;
}

/**
 * Turn a list of api/-relative file paths into matchable route descriptors.
 * `customers/index.js` serves /api/customers, `customers/[id]/card.js` serves
 * /api/customers/<anything>/card.
 * @param {string[]} files
 * @returns {{ file: string, segments: ({ literal: string } | { param: string })[] }[]}
 */
export function buildRoutes(files) {
  const routes = [];

  for (const file of files) {
    if (!isRouteFile(file)) continue;

    const parts = file.split('/');
    parts[parts.length - 1] = parts[parts.length - 1].replace(/\.js$/, '');
    // `index` names its parent directory rather than a segment of its own.
    if (parts[parts.length - 1] === 'index') parts.pop();

    routes.push({
      file,
      segments: parts.map((part) => {
        const dynamic = part.match(DYNAMIC_SEGMENT);
        return dynamic ? { param: dynamic[1] } : { literal: part };
      }),
    });
  }

  // A literal route always beats a dynamic one that would also match, so try
  // the least dynamic first: /api/customers/index over /api/customers/[id].
  return routes.sort((a, b) => {
    const dynamicA = a.segments.filter((s) => s.param).length;
    const dynamicB = b.segments.filter((s) => s.param).length;
    return dynamicA - dynamicB;
  });
}

/**
 * Find the route serving `pathname` and pull out its dynamic segments.
 * @param {ReturnType<typeof buildRoutes>} routes
 * @param {string} pathname e.g. "/api/customers/12/card"
 * @returns {{ file: string, params: Record<string, string> } | null}
 */
export function matchRoute(routes, pathname) {
  if (!pathname.startsWith(ROUTE_PREFIX)) return null;

  const parts = pathname.slice(ROUTE_PREFIX.length).split('/').filter(Boolean);
  if (!parts.length) return null;

  for (const route of routes) {
    if (route.segments.length !== parts.length) continue;

    const params = {};
    let matched = true;
    for (const [index, segment] of route.segments.entries()) {
      if (segment.param) {
        params[segment.param] = decodeURIComponent(parts[index]);
      } else if (segment.literal !== parts[index]) {
        matched = false;
        break;
      }
    }

    if (matched) return { file: route.file, params };
  }

  return null;
}

/** Every .js file under `dir`, as paths relative to it, depth-first. */
function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, base);
    return [path.relative(base, full).split(path.sep).join('/')];
  });
}

/**
 * @param {{ apiDir?: string }} [options]
 * @returns {import('vite').Plugin}
 */
export default function apiRoutes({ apiDir = API_DIR } = {}) {
  return {
    name: 'ensight-api-routes',
    apply: 'serve',

    configResolved(config) {
      // The handlers read secrets off process.env (SESSION_JWT_SECRET, DB_*,
      // AWS_*). Vite only exposes VITE_-prefixed vars to the client bundle and
      // never touches process.env, so .env.local has to be lifted across by
      // hand or every handler 503s on a missing credential.
      const root = config.root;
      for (const file of ['.env', '.env.local', `.env.${config.mode}`, `.env.${config.mode}.local`]) {
        const full = path.join(root, file);
        if (!fs.existsSync(full)) continue;
        for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
          const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
          if (!match) continue;
          const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
          // Later files win, but a real shell variable always wins over a file.
          if (process.env[match[1]] === undefined) process.env[match[1]] = value;
        }
      }
    },

    configureServer(server) {
      const root = server.config.root;
      const apiRoot = path.join(root, apiDir);

      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (!pathname.startsWith(ROUTE_PREFIX)) return next();

        // Rebuilt per request so a new route file is picked up without a restart.
        const match = matchRoute(buildRoutes(listFiles(apiRoot)), pathname);
        if (!match) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: `No API route for ${pathname}.` }));
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        req.query = { ...Object.fromEntries(url.searchParams), ...match.params };

        try {
          // ssrLoadModule runs the handler through Vite's transform pipeline,
          // so edits to api/* take effect without restarting the dev server.
          const module = await server.ssrLoadModule(path.join(apiRoot, match.file));
          const handler = module.default;
          if (typeof handler !== 'function') {
            throw new Error(`${match.file} has no default-exported handler.`);
          }
          await handler(req, res);
        } catch (err) {
          server.ssrFixStacktrace?.(err);
          console.error(`[api] ${pathname} failed:`, err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message || 'API handler failed.' }));
          }
        }
      });
    },
  };
}
