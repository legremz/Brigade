import { useEffect, useState } from "react";

export type Route =
  | { page: "home" }
  | { page: "project"; slug: string }
  | { page: "board"; slug: string; task?: string }
  | { page: "agents"; slug: string }
  | { page: "skills"; slug: string }
  | { page: "grill"; slug: string; id: string };

export function parseHash(hash: string): Route {
  const m = /^#\/p\/([^/]+)(?:\/(g|board|agents|skills)(?:\/([^/]+))?)?/.exec(hash);
  if (!m) return { page: "home" };
  const slug = m[1]!;
  if (m[2] === "g" && m[3]) return { page: "grill", slug, id: m[3] };
  if (m[2] === "board") return { page: "board", slug, task: m[3]?.startsWith("t_") ? m[3] : undefined };
  if (m[2] === "agents") return { page: "agents", slug };
  if (m[2] === "skills") return { page: "skills", slug };
  return { page: "project", slug };
}

export function useRoute(): Route {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return parseHash(hash);
}

export const href = {
  home: () => "#/",
  project: (slug: string) => `#/p/${slug}`,
  grill: (slug: string, id: string) => `#/p/${slug}/g/${id}`,
  board: (slug: string, task?: string) => `#/p/${slug}/board${task ? `/${task}` : ""}`,
  agents: (slug: string) => `#/p/${slug}/agents`,
  skills: (slug: string) => `#/p/${slug}/skills`,
};
