import { createRequire } from 'node:module';

/**
 * Records the mount path of every router layer so tests can list the routes the API really
 * registers (Express 5 does not keep mount paths on layers). Must be imported before the app.
 */
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Router = require('router') as {
  prototype: { use: (...args: unknown[]) => unknown; stack: Layer[] };
};

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
  __mount?: string;
}

const original = Router.prototype.use;
Router.prototype.use = function patchedUse(this: { stack: Layer[] }, ...args: unknown[]) {
  const before = this.stack.length;
  const result = original.apply(this, args);
  const path = typeof args[0] === 'string' ? args[0] : '/';
  for (const layer of this.stack.slice(before)) layer.__mount = path;
  return result;
};

/** All "METHOD /path" routes below a router stack, with {param} placeholders. */
export function listRoutes(stack: Layer[], prefix = ''): string[] {
  const out: string[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const path = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}` || '/';
      for (const [method, on] of Object.entries(layer.route.methods)) {
        if (on && method !== '_all') {
          out.push(
            `${method.toUpperCase()} ${path.replace(/\\\$/g, '$').replace(/:(\w+)/g, '{$1}')}`,
          );
        }
      }
    } else if (layer.handle?.stack) {
      const mount = layer.__mount && layer.__mount !== '/' ? layer.__mount : '';
      out.push(...listRoutes(layer.handle.stack, prefix + mount));
    }
  }
  return out;
}
