import React from "react";
import Home from "./Home.tsx";
import Contacts from "./Contacts.tsx";

// Relationships = the old personal CRM in one section: the query/ask surface plus
// reconnect + commitments (Overview), and the full contacts list. Segmented toggle.
export default function Relationships({ subroute }: { subroute: string }) {
  const tab = subroute === "contacts" ? "contacts" : "overview";
  return (
    <div className="h-full flex flex-col">
      <div className="flex justify-center pt-10 pb-1 no-drag">
        <div
          className="inline-flex rounded-full border bg-white p-0.5 text-sm shadow-sm"
          style={{ borderColor: "var(--line)" }}
        >
          {(
            [
              ["overview", "Overview", "#/relationships"],
              ["contacts", "Contacts", "#/relationships/contacts"],
            ] as const
          ).map(([key, label, href]) => (
            <a
              key={key}
              href={href}
              className="px-4 py-1 rounded-full transition-colors"
              style={
                tab === key
                  ? { background: "var(--accent)", color: "white" }
                  : { color: "var(--muted)" }
              }
            >
              {label}
            </a>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0">{tab === "overview" ? <Home /> : <Contacts />}</div>
    </div>
  );
}
