import React from "react";
import { ArrowUpRight } from "lucide-react";
import { explorerAddress, explorerTx } from "../config";
import { shorten } from "../lib/format";

export function Metric({ title, value, unit, icon, hint }) {
  return (
    <div className="metric-card">
      <div className="metric-icon">{icon}</div>
      <div>
        <div className="metric-label">{title}</div>
        <div className="metric-value">{value}<small>{unit}</small></div>
        {hint && <div className="metric-hint">{hint}</div>}
      </div>
    </div>
  );
}

export function InfoRow({ icon, label, value, title }) {
  return (
    <div className="info-row" title={title}>
      <span className="info-icon">{icon}</span>
      <div><small>{label}</small><strong>{value}</strong></div>
    </div>
  );
}

export function Panel({ title, subtitle, right, className = "", children }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function Badge({ tone = "neutral", children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function TxLink({ hash }) {
  if (!hash) return <span>—</span>;
  const url = explorerTx(hash);
  return url ? (
    <a className="ext-link" href={url} target="_blank" rel="noreferrer">
      {shorten(hash, 8, 6)} <ArrowUpRight size={12} />
    </a>
  ) : (
    <code title={hash}>{shorten(hash, 8, 6)}</code>
  );
}

export function AddressLink({ address, label }) {
  if (!address) return <span>—</span>;
  const url = explorerAddress(address);
  const text = label || shorten(address);
  return url ? (
    <a className="ext-link" href={url} target="_blank" rel="noreferrer" title={address}>{text}</a>
  ) : (
    <code title={address}>{text}</code>
  );
}
