import type { MiddlewareHandler } from "hono";

// L'API locale n'a pas de jeton : sans ce contrôle, une page web tierce pourrait l'appeler
// depuis le navigateur de l'utilisateur (requête inter-origines ou rebinding DNS).

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Découpe une valeur `Host` ; null si elle est mal formée. */
function parseHost(value: string): URL | null {
  return URL.canParse(`http://${value}`) ? new URL(`http://${value}`) : null;
}

function publicHostOf(publicUrl: string | undefined): URL | null {
  return publicUrl && URL.canParse(publicUrl) ? new URL(publicUrl) : null;
}

/** Hôte autorisé : boucle locale sur n'importe quel port, ou hôte de BRIGADE_PUBLIC_URL. */
function isAllowedHost(host: URL, publicHost: URL | null): boolean {
  return LOOPBACK_HOSTNAMES.has(host.hostname) || host.hostname === publicHost?.hostname;
}

/** Une origine n'est acceptée que si elle désigne ce serveur ; `Origin: null` est donc refusé. */
function isAllowedOrigin(origin: string, requestHost: string, publicHost: URL | null): boolean {
  if (!URL.canParse(origin)) return false;
  const originHost = new URL(origin).host;
  return originHost === requestHost || originHost === publicHost?.host;
}

export function localOnly(publicUrl = process.env.BRIGADE_PUBLIC_URL): MiddlewareHandler {
  const publicHost = publicHostOf(publicUrl);
  return async (c, next) => {
    const requestHost = c.req.header("host") ?? "";
    const host = parseHost(requestHost);
    if (!host || !isAllowedHost(host, publicHost)) return c.json({ error: "Hôte non autorisé." }, 403);
    const origin = c.req.header("origin");
    if (origin !== undefined && !isAllowedOrigin(origin, requestHost, publicHost))
      return c.json({ error: "Origine non autorisée." }, 403);
    await next();
  };
}
