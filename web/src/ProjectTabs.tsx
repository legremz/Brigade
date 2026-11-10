import { href } from "./router";

export type Tab = "grills" | "board" | "decisions" | "skills" | "agents";

export function ProjectTabs({ slug, active }: { slug: string; active: Tab }) {
  const tabs: [Tab, string, string][] = [
    ["grills", "Grills", href.project(slug)],
    ["board", "Kanban", href.board(slug)],
    ["decisions", "Décisions", href.decisions(slug)],
    ["skills", "Skills", href.skills(slug)],
    ["agents", "Agents & réglages", href.agents(slug)],
  ];
  return (
    <div className="tabs">
      {tabs.map(([key, label, to]) => (
        <a key={key} href={to} className={key === active ? "tab active" : "tab"}>
          {label}
        </a>
      ))}
    </div>
  );
}
