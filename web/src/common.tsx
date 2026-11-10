import { href } from "./router";

export function Crumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav className="crumbs">
      <a href={href.home()}>Brigade</a>
      {items.map((i) => (
        <span key={i.label}>
          {" / "}
          {i.to ? <a href={i.to}>{i.label}</a> : i.label}
        </span>
      ))}
    </nav>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return <p className="error box">{message}</p>;
}

export function Progress({ answered, total }: { answered: number; total: number }) {
  return (
    <span className="progress" title={`${answered} répondue(s) sur ${total}`}>
      <span className="bar">
        <span style={{ width: total ? `${(answered / total) * 100}%` : 0 }} />
      </span>
      {answered}/{total}
    </span>
  );
}
